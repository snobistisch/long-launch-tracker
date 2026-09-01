import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeConfig } from "../src/config.ts";
import { TrackerDatabase } from "../src/db.ts";
import { JsonHttpClient, mapLimited } from "../src/network.ts";
import { RobinhoodPricing } from "../src/pricing.ts";
import { LongTracker } from "../src/tracker.ts";
import type { NormalizedLaunch, PriceSnapshot } from "../src/types.ts";

interface DashboardPayload {
  meta: {
    generatedAt: string;
    indexedThroughBlock: number;
    nextBlock: number;
    source: string;
  };
  quotes?: Record<string, PriceSnapshot>;
  launches: NormalizedLaunch[];
}

type BackfillTuple = [
  tokenAddress: string,
  name: string,
  symbol: string,
  numeraireAddress: string,
  numeraireSymbol: string,
  creator: string,
  blockNumber: number,
  timestamp: string,
  transactionHash: string,
];

interface BackfillIndex {
  nextBlock: number;
  parts: string[];
}

const rebuild = process.argv.includes("--rebuild");
const dataPath = resolve("dashboard/data/launches.json");
const graphqlBackfillDirectory = resolve("data/graphql-backfill");
const graphqlBackfillPath = resolve(graphqlBackfillDirectory, "index.json");
const databasePath = resolve("data/dashboard-update.sqlite");
if (rebuild) rmSync(databasePath, { force: true });

const config = makeConfig({
  dbPath: databasePath,
  // Robinhood's public backend currently caps recent eth_getLogs ranges at 2,000 blocks.
  blockSpan: Number.parseInt(process.env.LONG_RPC_BLOCK_SPAN ?? "2000", 10),
});
const cursorKey = `${config.venueKey}:${config.chainId}:launch-created`;
const database = new TrackerDatabase(config.dbPath);

try {
  let seedNextBlock = 0;
  if (!rebuild && database.countLaunches() === 0 && existsSync(dataPath)) {
    const prior = JSON.parse(readFileSync(dataPath, "utf8")) as DashboardPayload;
    for (const launch of prior.launches) database.insertLaunch(launch);
    seedNextBlock = Math.max(seedNextBlock, prior.meta.nextBlock ?? 0);
  }

  // The public RPC rate-limits deep historical scans. This checked-in, one-time GraphQL
  // snapshot closes that gap; all subsequent blocks continue from the canonical RPC.
  if (!rebuild && existsSync(graphqlBackfillPath)) {
    const backfill = JSON.parse(readFileSync(graphqlBackfillPath, "utf8")) as BackfillIndex;
    const knownTokens = new Set(
      database.allLaunches().map((launch) => launch.tokenAddress.toLowerCase()),
    );
    for (const part of backfill.parts) {
      const rows = JSON.parse(
        readFileSync(resolve(graphqlBackfillDirectory, part), "utf8"),
      ) as BackfillTuple[];
      for (const row of rows) {
        const [
          tokenAddress,
          name,
          symbol,
          numeraireAddress,
          numeraireSymbol,
          creator,
          blockNumber,
          timestamp,
          transactionHash,
        ] = row;
        if (knownTokens.has(tokenAddress.toLowerCase())) continue;
        database.insertLaunch({
          tokenAddress,
          name,
          symbol,
          numeraireAddress,
          numeraireSymbol,
          numeraireMultiplier: null,
          numeraireBidUsd: null,
          numeraireAskUsd: null,
          numeraireMidUsd: null,
          priceGeneratedAt: null,
          pricingError: null,
          poolAddress: tokenAddress,
          creator,
          blockNumber,
          timestamp,
          transactionHash,
          logIndex: -1,
          venueKey: config.venueKey,
          chainId: config.chainId,
          source: "graphql:api.long.xyz:Asset",
        });
        knownTokens.add(tokenAddress.toLowerCase());
      }
    }
    seedNextBlock = Math.max(seedNextBlock, backfill.nextBlock ?? 0);
  }
  if (!rebuild && seedNextBlock > (database.getCursor(cursorKey) ?? 0)) {
    database.setCursor(cursorKey, seedNextBlock);
  }

  const http = new JsonHttpClient(config.concurrency, config.requestsPerSecond);
  const tracker = new LongTracker(config, database, http);
  let inserted = 0;
  try {
    const result = await tracker.poll({ since: rebuild ? "earliest" : undefined });
    inserted = result.inserted;
  } catch (error) {
    // A public RPC quota must not discard ranges that were already verified and committed.
    // Export the durable partial cursor; the next scheduled run resumes from that exact block.
    console.warn(`Poll paused; exporting verified progress: ${error instanceof Error ? error.message : error}`);
  }
  const launches = database.allLaunches();

  const pricing = new RobinhoodPricing(config.robinhoodRhjBaseUrl, config.chainId, http);
  await pricing.refreshDirectory(true);
  const addresses = [...new Set(launches.map((launch) => launch.numeraireAddress.toLowerCase()))];
  const quoteEntries = await mapLimited(addresses, config.concurrency, async (address) => {
    const metadata = pricing.metadata(address);
    if (!metadata) return null;
    try {
      return [address, await pricing.price(metadata.symbol, metadata.currentMultiplier)] as const;
    } catch (error) {
      console.warn(`Quote unavailable for ${metadata.symbol}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  });
  const quotes = Object.fromEntries(quoteEntries.filter((entry) => entry !== null));
  const nextBlock = database.getCursor(cursorKey) ?? config.firstLaunchBlock;
  const payload: DashboardPayload = {
    meta: {
      generatedAt: new Date().toISOString(),
      indexedThroughBlock: nextBlock - 1,
      nextBlock,
      source: "LONG GraphQL backfill + Robinhood Chain RPC + Robinhood /rhj",
    },
    quotes,
    launches,
  };
  writeFileSync(dataPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `dashboard launches=${launches.length} new=${inserted} ` +
      `quotes=${Object.keys(quotes).length} indexedThrough=${payload.meta.indexedThroughBlock}`,
  );
} finally {
  database.close();
}
