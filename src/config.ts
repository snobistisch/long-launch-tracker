export interface TrackerConfig {
  venueKey: string;
  chainId: number;
  rpcUrl: string;
  airlockAddress: string;
  launcherAddresses: string[];
  launchCreatedTopic0: string;
  firstLaunchBlock: number;
  blockSpan: number;
  concurrency: number;
  requestsPerSecond: number;
  confirmations: number;
  defaultLookbackBlocks: number;
  watchIntervalMs: number;
  dbPath: string;
  robinhoodRhjBaseUrl: string;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function assertAddress(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} is not an EVM address: ${value}`);
  }
  return normalized;
}

export function makeConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  const base: TrackerConfig = {
    venueKey: "long-robinhood",
    chainId: 4663,
    rpcUrl: process.env.LONG_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
    airlockAddress: "0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862",
    launcherAddresses: [
      "0x9c88f06b72fcd3cedbef3be7521ee5abd72d0845",
      "0x22e99278308b393ea1260859b181ad7e78f5eeed",
    ],
    launchCreatedTopic0:
      "0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b",
    firstLaunchBlock: 8_145_291,
    blockSpan: envInt("LONG_RPC_BLOCK_SPAN", 20_000, 1, 100_000),
    concurrency: envInt("LONG_RPC_CONCURRENCY", 2, 1, 8),
    requestsPerSecond: envInt("LONG_RPC_REQUESTS_PER_SECOND", 8, 1, 60),
    confirmations: envInt("LONG_CONFIRMATIONS", 64, 0, 10_000),
    defaultLookbackBlocks: envInt(
      "LONG_DEFAULT_LOOKBACK_BLOCKS",
      100_000,
      1,
      5_000_000,
    ),
    watchIntervalMs: envInt("LONG_WATCH_INTERVAL_MS", 15_000, 1_000, 3_600_000),
    dbPath: process.env.LONG_DB_PATH ?? "./data/long-tracker.sqlite",
    robinhoodRhjBaseUrl:
      process.env.ROBINHOOD_RHJ_BASE_URL ?? "https://api.robinhood.com/rhj",
  };

  const config = { ...base, ...overrides };
  config.airlockAddress = assertAddress(config.airlockAddress, "airlockAddress");
  config.launcherAddresses = config.launcherAddresses.map((address, index) =>
    assertAddress(address, `launcherAddresses[${index}]`),
  );
  if (!/^0x[0-9a-f]{64}$/.test(config.launchCreatedTopic0)) {
    throw new Error("launchCreatedTopic0 must be a 32-byte topic");
  }
  return config;
}
