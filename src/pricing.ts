import { JsonHttpClient } from "./network.ts";
import type { PriceSnapshot } from "./types.ts";

interface RhDeployment {
  contractAddress: string;
  chainId: number;
}

interface RhAsset {
  tokenSymbol: string;
  tokenName: string;
  currentMultiplier: string;
  tokenDecimals: number;
  deployments: RhDeployment[];
}

interface RhAssetsResponse {
  assets: RhAsset[];
}

interface RhQuote {
  tokenSymbol: string;
  bid: string;
  ask: string;
  currency: string;
  generatedAt: string;
}

interface RhPricesResponse {
  quotes: RhQuote[];
}

export interface NumeraireMetadata {
  symbol: string;
  name: string;
  currentMultiplier: string;
  decimals: number;
}

function parseDecimal(value: string): { integer: bigint; scale: number } {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error(`Invalid decimal: ${value}`);
  const fraction = match[3] ?? "";
  const integer = BigInt(`${match[1]}${match[2]}${fraction}`);
  return { integer, scale: fraction.length };
}

function formatFixed(integer: bigint, scale: number): string {
  const negative = integer < 0n;
  const absolute = negative ? -integer : integer;
  const raw = absolute.toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? raw : raw.slice(0, -scale);
  const fraction = scale === 0 ? "" : raw.slice(-scale);
  return `${negative ? "-" : ""}${whole}${scale === 0 ? "" : `.${fraction}`}`;
}

function rescaleRounded(integer: bigint, fromScale: number, toScale: number): bigint {
  if (fromScale === toScale) return integer;
  if (fromScale < toScale) return integer * 10n ** BigInt(toScale - fromScale);
  const divisor = 10n ** BigInt(fromScale - toScale);
  const half = divisor / 2n;
  return (integer + (integer >= 0n ? half : -half)) / divisor;
}

export function multiplyDecimal(left: string, right: string, outputScale = 8): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const product = a.integer * b.integer;
  return formatFixed(rescaleRounded(product, a.scale + b.scale, outputScale), outputScale);
}

function midpoint(left: string, right: string, scale = 8): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const aScaled = rescaleRounded(a.integer, a.scale, scale);
  const bScaled = rescaleRounded(b.integer, b.scale, scale);
  return formatFixed((aScaled + bScaled + 1n) / 2n, scale);
}

export class RobinhoodPricing {
  private byAddress = new Map<string, NumeraireMetadata>();
  private directoryExpiresAt = 0;
  private readonly quoteCache = new Map<string, { expiresAt: number; value: PriceSnapshot }>();
  private readonly baseUrl: string;
  private readonly chainId: number;
  private readonly http: JsonHttpClient;

  constructor(
    baseUrl: string,
    chainId: number,
    http: JsonHttpClient,
  ) {
    this.baseUrl = baseUrl;
    this.chainId = chainId;
    this.http = http;
  }

  async refreshDirectory(force = false): Promise<void> {
    if (!force && this.directoryExpiresAt > Date.now()) return;
    const response = await this.http.request<RhAssetsResponse>(`${this.baseUrl}/assets`);
    const next = new Map<string, NumeraireMetadata>();
    for (const asset of response.assets) {
      for (const deployment of asset.deployments) {
        if (deployment.chainId !== this.chainId) continue;
        next.set(deployment.contractAddress.toLowerCase(), {
          symbol: asset.tokenSymbol,
          name: asset.tokenName,
          currentMultiplier: asset.currentMultiplier,
          decimals: asset.tokenDecimals,
        });
      }
    }
    this.byAddress = next;
    this.directoryExpiresAt = Date.now() + 15 * 60_000;
  }

  metadata(address: string): NumeraireMetadata | null {
    return this.byAddress.get(address.toLowerCase()) ?? null;
  }

  async price(symbol: string, currentMultiplier: string): Promise<PriceSnapshot> {
    const cacheKey = `${symbol}:${currentMultiplier}`;
    const cached = this.quoteCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const response = await this.http.request<RhPricesResponse>(
      `${this.baseUrl}/prices/${encodeURIComponent(symbol)}`,
    );
    const quote = response.quotes.find((candidate) => candidate.tokenSymbol === symbol);
    if (!quote) throw new Error(`No Robinhood quote returned for ${symbol}`);
    if (quote.currency !== "USD") throw new Error(`Unexpected quote currency for ${symbol}`);

    // `/prices` is raw-equity USD; the token value is raw price × currentMultiplier.
    const adjustedBidUsd = multiplyDecimal(quote.bid, currentMultiplier);
    const adjustedAskUsd = multiplyDecimal(quote.ask, currentMultiplier);
    const value: PriceSnapshot = {
      rawBidUsd: quote.bid,
      rawAskUsd: quote.ask,
      currentMultiplier,
      adjustedBidUsd,
      adjustedAskUsd,
      adjustedMidUsd: midpoint(adjustedBidUsd, adjustedAskUsd),
      generatedAt: quote.generatedAt,
    };
    this.quoteCache.set(cacheKey, { expiresAt: Date.now() + 15_000, value });
    return value;
  }
}
