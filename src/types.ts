export type Hex = `0x${string}`;

export interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  blockHash: Hex;
  logIndex: Hex;
  removed: boolean;
}

export interface PriceSnapshot {
  rawBidUsd: string;
  rawAskUsd: string;
  currentMultiplier: string;
  adjustedBidUsd: string;
  adjustedAskUsd: string;
  adjustedMidUsd: string;
  generatedAt: string;
}

export interface NormalizedLaunch {
  tokenAddress: string;
  name: string;
  symbol: string;
  numeraireAddress: string;
  numeraireSymbol: string;
  numeraireMultiplier: string | null;
  numeraireBidUsd: string | null;
  numeraireAskUsd: string | null;
  numeraireMidUsd: string | null;
  priceGeneratedAt: string | null;
  pricingError: string | null;
  poolAddress: string;
  creator: string;
  blockNumber: number;
  timestamp: string;
  transactionHash: string;
  logIndex: number;
  venueKey: string;
  chainId: number;
  source: string;
}

export interface PollResult {
  fromBlock: number;
  toBlock: number;
  latestBlock: number;
  scannedRanges: number;
  detected: number;
  inserted: number;
  launches: NormalizedLaunch[];
}
