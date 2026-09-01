import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NormalizedLaunch } from "./types.ts";

export class TrackerDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS launches (
        id INTEGER PRIMARY KEY,
        token_address TEXT NOT NULL,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        numeraire_address TEXT NOT NULL,
        numeraire_symbol TEXT NOT NULL,
        numeraire_multiplier TEXT,
        numeraire_bid_usd TEXT,
        numeraire_ask_usd TEXT,
        numeraire_mid_usd TEXT,
        price_generated_at TEXT,
        pricing_error TEXT,
        pool_address TEXT NOT NULL,
        creator TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_timestamp TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        venue_key TEXT NOT NULL CHECK(length(venue_key) > 0),
        chain_id INTEGER NOT NULL CHECK(chain_id > 0),
        source TEXT NOT NULL,
        observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(venue_key, chain_id, transaction_hash, log_index)
      );

      CREATE INDEX IF NOT EXISTS launches_block_idx
        ON launches(venue_key, chain_id, block_number);

      CREATE TABLE IF NOT EXISTS cursors (
        source_key TEXT PRIMARY KEY,
        next_block INTEGER NOT NULL CHECK(next_block >= 0),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  getCursor(sourceKey: string): number | null {
    const row = this.db
      .prepare("SELECT next_block AS nextBlock FROM cursors WHERE source_key = ?")
      .get(sourceKey) as { nextBlock: number } | undefined;
    return row?.nextBlock ?? null;
  }

  setCursor(sourceKey: string, nextBlock: number): void {
    this.db
      .prepare(`
        INSERT INTO cursors(source_key, next_block, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source_key) DO UPDATE SET
          next_block = excluded.next_block,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(sourceKey, nextBlock);
  }

  insertLaunch(launch: NormalizedLaunch): boolean {
    if (!launch.venueKey || !Number.isInteger(launch.chainId)) {
      throw new Error("Every launch must carry venueKey and chainId");
    }
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO launches (
          token_address, name, symbol,
          numeraire_address, numeraire_symbol, numeraire_multiplier,
          numeraire_bid_usd, numeraire_ask_usd, numeraire_mid_usd,
          price_generated_at, pricing_error,
          pool_address, creator, block_number, block_timestamp,
          transaction_hash, log_index, venue_key, chain_id, source
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `)
      .run(
        launch.tokenAddress,
        launch.name,
        launch.symbol,
        launch.numeraireAddress,
        launch.numeraireSymbol,
        launch.numeraireMultiplier,
        launch.numeraireBidUsd,
        launch.numeraireAskUsd,
        launch.numeraireMidUsd,
        launch.priceGeneratedAt,
        launch.pricingError,
        launch.poolAddress,
        launch.creator,
        launch.blockNumber,
        launch.timestamp,
        launch.transactionHash,
        launch.logIndex,
        launch.venueKey,
        launch.chainId,
        launch.source,
      );
    return Number(result.changes) === 1;
  }

  countLaunches(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM launches").get() as {
      count: number;
    };
    return Number(row.count);
  }

  allLaunches(): NormalizedLaunch[] {
    const rows = this.db
      .prepare(`
        SELECT
          token_address AS tokenAddress,
          name,
          symbol,
          numeraire_address AS numeraireAddress,
          numeraire_symbol AS numeraireSymbol,
          numeraire_multiplier AS numeraireMultiplier,
          numeraire_bid_usd AS numeraireBidUsd,
          numeraire_ask_usd AS numeraireAskUsd,
          numeraire_mid_usd AS numeraireMidUsd,
          price_generated_at AS priceGeneratedAt,
          pricing_error AS pricingError,
          pool_address AS poolAddress,
          creator,
          block_number AS blockNumber,
          block_timestamp AS timestamp,
          transaction_hash AS transactionHash,
          log_index AS logIndex,
          venue_key AS venueKey,
          chain_id AS chainId,
          source
        FROM launches
        ORDER BY block_number, log_index
      `)
      .all();
    return rows as unknown as NormalizedLaunch[];
  }

  close(): void {
    this.db.close();
  }
}
