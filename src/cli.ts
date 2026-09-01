#!/usr/bin/env node
import { resolve } from "node:path";
import { makeConfig } from "./config.ts";
import { TrackerDatabase } from "./db.ts";
import { loadEnvFile } from "./env.ts";
import { sleep } from "./network.ts";
import { LongTracker } from "./tracker.ts";
import type { NormalizedLaunch, PollResult } from "./types.ts";

interface CliOptions {
  command: "poll" | "watch" | "help";
  since?: number | "earliest" | "latest";
  until?: number;
  dbPath?: string;
  intervalMs?: number;
}

function parseBlock(value: string, flag: string): number | "earliest" | "latest" {
  if (value === "earliest" || value === "latest") return value;
  const parsed = value.startsWith("0x")
    ? Number.parseInt(value.slice(2), 16)
    : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} expects a block number, earliest, or latest`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const first = argv[0];
  const command = first === "poll" || first === "watch" ? first : "help";
  const options: CliOptions = { command };

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--since" && value) {
      options.since = parseBlock(value, "--since");
      index += 1;
    } else if (argument === "--until" && value) {
      const parsed = parseBlock(value, "--until");
      if (typeof parsed !== "number") throw new Error("--until expects a block number");
      options.until = parsed;
      index += 1;
    } else if (argument === "--db" && value) {
      options.dbPath = value;
      index += 1;
    } else if (argument === "--interval" && value) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(parsed) || parsed < 1_000) {
        throw new Error("--interval must be at least 1000 milliseconds");
      }
      options.intervalMs = parsed;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`LONG launch tracker

Usage:
  npm run tracker -- poll [--since BLOCK|earliest|latest] [--until BLOCK] [--db PATH]
  npm run tracker -- watch [--since BLOCK|earliest|latest] [--interval MS] [--db PATH]

The persisted cursor wins after the first successful run. With no cursor and no --since,
the tracker scans a bounded recent lookback. Use --since earliest (block 8145291) for a full
backfill. --until is a diagnostic bound for reproducible one-shot polls.`);
}

function printLaunches(launches: NormalizedLaunch[]): void {
  if (launches.length === 0) return;
  console.table(
    launches.map((launch) => ({
      Venue: launch.venueKey,
      Chain: launch.chainId,
      Block: launch.blockNumber,
      Token: launch.symbol,
      Numeraire: launch.numeraireSymbol,
      "Quote USD": launch.numeraireMidUsd ?? "unavailable",
      Address: launch.tokenAddress,
      Tx: launch.transactionHash,
    })),
  );
}

function printSummary(result: PollResult): void {
  printLaunches(result.launches);
  console.log(
    `scanned=${result.fromBlock}-${result.toBlock} ranges=${result.scannedRanges} ` +
      `detected=${result.detected} new=${result.inserted} head=${result.latestBlock}`,
  );
}

async function main(): Promise<void> {
  loadEnvFile();
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }

  const config = makeConfig({
    ...(options.dbPath ? { dbPath: resolve(options.dbPath) } : {}),
    ...(options.intervalMs ? { watchIntervalMs: options.intervalMs } : {}),
  });
  const database = new TrackerDatabase(config.dbPath);
  const tracker = new LongTracker(config, database);

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  try {
    if (options.command === "poll") {
      printSummary(await tracker.poll({ since: options.since, until: options.until }));
      return;
    }

    let first = true;
    while (!stopping) {
      try {
        printSummary(await tracker.poll({ since: first ? options.since : undefined }));
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      first = false;
      if (!stopping) await sleep(config.watchIntervalMs);
    }
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
