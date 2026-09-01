import { decodeAbiString, decodeAssetData, decodeLaunchCreated, encodeAddressCall } from "./abi.ts";
import type { TrackerConfig } from "./config.ts";
import { TrackerDatabase } from "./db.ts";
import { JsonHttpClient, mapLimited } from "./network.ts";
import { RobinhoodPricing } from "./pricing.ts";
import { fromQuantity, RpcClient } from "./rpc.ts";
import type { NormalizedLaunch, PollResult, RpcLog } from "./types.ts";

const GET_ASSET_DATA_SELECTOR = "0x1652e7b7";
const NAME_SELECTOR = "0x06fdde03";
const SYMBOL_SELECTOR = "0x95d89b41";

export interface PollOptions {
  since?: number | "earliest" | "latest";
  until?: number;
}

export class LongTracker {
  private readonly rpc: RpcClient;
  private readonly pricing: RobinhoodPricing;
  private readonly cursorKey: string;
  private readonly config: TrackerConfig;
  private readonly database: TrackerDatabase;

  constructor(
    config: TrackerConfig,
    database: TrackerDatabase,
    http?: JsonHttpClient,
  ) {
    this.config = config;
    this.database = database;
    const sharedHttp =
      http ?? new JsonHttpClient(config.concurrency, config.requestsPerSecond);
    this.rpc = new RpcClient(config.rpcUrl, sharedHttp);
    this.pricing = new RobinhoodPricing(
      config.robinhoodRhjBaseUrl,
      config.chainId,
      sharedHttp,
    );
    this.cursorKey = `${config.venueKey}:${config.chainId}:launch-created`;
  }

  async poll(options: PollOptions = {}): Promise<PollResult> {
    const latestBlock = await this.rpc.blockNumber();
    const safeHead = Math.max(0, latestBlock - this.config.confirmations);
    const toBlock = Math.min(options.until ?? safeHead, safeHead);
    const persistedCursor = this.database.getCursor(this.cursorKey);
    const requestedStart = this.resolveSince(options.since, toBlock);
    const fromBlock =
      persistedCursor ??
      requestedStart ??
      Math.max(this.config.firstLaunchBlock, toBlock - this.config.defaultLookbackBlocks + 1);

    if (fromBlock > toBlock) {
      return {
        fromBlock,
        toBlock,
        latestBlock,
        scannedRanges: 0,
        detected: 0,
        inserted: 0,
        launches: [],
      };
    }

    // Refresh once per run/watch TTL. A failure is visible on each launch via pricingError,
    // while on-chain discovery and persistence continue to work.
    let directoryError: string | null = null;
    try {
      await this.pricing.refreshDirectory();
    } catch (error) {
      directoryError = error instanceof Error ? error.message : String(error);
    }

    let scannedRanges = 0;
    let detected = 0;
    const launches: NormalizedLaunch[] = [];

    for (let rangeStart = fromBlock; rangeStart <= toBlock; rangeStart += this.config.blockSpan) {
      const rangeEnd = Math.min(toBlock, rangeStart + this.config.blockSpan - 1);
      const groups = await mapLimited(
        this.config.launcherAddresses,
        this.config.concurrency,
        (address) =>
          this.rpc.getLogs({
            address,
            topic0: this.config.launchCreatedTopic0,
            fromBlock: rangeStart,
            toBlock: rangeEnd,
            maximumSpan: this.config.blockSpan,
          }),
      );
      const logs = groups.flat().sort(compareLogs);
      detected += logs.length;

      const normalized = await mapLimited(logs, this.config.concurrency, (log) =>
        this.normalize(log, directoryError),
      );
      for (const launch of normalized) {
        if (this.database.insertLaunch(launch)) launches.push(launch);
      }

      // Advance only after every launcher query, enrichment call and database write for the
      // range succeeded. A retry can safely encounter already-inserted rows.
      this.database.setCursor(this.cursorKey, rangeEnd + 1);
      scannedRanges += 1;
    }

    return {
      fromBlock,
      toBlock,
      latestBlock,
      scannedRanges,
      detected,
      inserted: launches.length,
      launches,
    };
  }

  private resolveSince(
    since: PollOptions["since"],
    toBlock: number,
  ): number | null {
    if (since === undefined) return null;
    if (since === "earliest") return this.config.firstLaunchBlock;
    if (since === "latest") return toBlock;
    return Math.max(this.config.firstLaunchBlock, since);
  }

  private async normalize(log: RpcLog, directoryError: string | null): Promise<NormalizedLaunch> {
    const event = decodeLaunchCreated(log, this.config.launchCreatedTopic0);
    const blockNumber = fromQuantity(log.blockNumber);
    const [assetDataResult, nameResult, symbolResult, block] = await Promise.all([
      this.rpc.ethCall(
        this.config.airlockAddress,
        encodeAddressCall(GET_ASSET_DATA_SELECTOR, event.asset),
      ),
      this.rpc.ethCall(event.asset, NAME_SELECTOR),
      this.rpc.ethCall(event.asset, SYMBOL_SELECTOR),
      this.rpc.getBlock(blockNumber),
    ]);
    const assetData = decodeAssetData(assetDataResult);

    if (assetData.numeraire !== event.numeraire) {
      throw new Error(`Airlock numeraire mismatch for ${event.asset}`);
    }
    if (assetData.poolInitializer !== event.initializer) {
      throw new Error(`Airlock initializer mismatch for ${event.asset}`);
    }

    const metadata = this.pricing.metadata(assetData.numeraire);
    let numeraireSymbol = metadata?.symbol ?? "";
    if (!numeraireSymbol) {
      numeraireSymbol = decodeAbiString(await this.rpc.ethCall(assetData.numeraire, SYMBOL_SELECTOR));
    }

    let price = null;
    let pricingError = directoryError;
    if (metadata) {
      try {
        price = await this.pricing.price(metadata.symbol, metadata.currentMultiplier);
        pricingError = null;
      } catch (error) {
        pricingError = error instanceof Error ? error.message : String(error);
      }
    } else if (!pricingError) {
      pricingError = `Numeraire ${assetData.numeraire} is absent from /rhj/assets`;
    }

    const launcher = log.address.toLowerCase();
    const timestampSeconds = fromQuantity(block.timestamp);
    return {
      tokenAddress: event.asset,
      name: decodeAbiString(nameResult),
      symbol: decodeAbiString(symbolResult) || event.symbol,
      numeraireAddress: assetData.numeraire,
      numeraireSymbol,
      numeraireMultiplier: metadata?.currentMultiplier ?? null,
      numeraireBidUsd: price?.adjustedBidUsd ?? null,
      numeraireAskUsd: price?.adjustedAskUsd ?? null,
      numeraireMidUsd: price?.adjustedMidUsd ?? null,
      priceGeneratedAt: price?.generatedAt ?? null,
      pricingError,
      poolAddress: assetData.pool,
      creator: event.creator,
      blockNumber,
      timestamp: new Date(timestampSeconds * 1_000).toISOString(),
      transactionHash: log.transactionHash.toLowerCase(),
      logIndex: fromQuantity(log.logIndex),
      venueKey: this.config.venueKey,
      chainId: this.config.chainId,
      source: `rpc:LaunchCreated:${launcher}`,
    };
  }
}

function compareLogs(left: RpcLog, right: RpcLog): number {
  return (
    fromQuantity(left.blockNumber) - fromQuantity(right.blockNumber) ||
    fromQuantity(left.logIndex) - fromQuantity(right.logIndex)
  );
}
