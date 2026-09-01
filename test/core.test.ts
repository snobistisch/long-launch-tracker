import assert from "node:assert/strict";
import test from "node:test";
import { decodeAssetData, decodeLaunchCreated } from "../src/abi.ts";
import { makeConfig } from "../src/config.ts";
import { TrackerDatabase } from "../src/db.ts";
import { multiplyDecimal } from "../src/pricing.ts";
import type { NormalizedLaunch, RpcLog } from "../src/types.ts";

const config = makeConfig();

test("decodes the observed AI LaunchCreated log", () => {
  const log: RpcLog = {
    address: config.launcherAddresses[1] as `0x${string}`,
    topics: [
      config.launchCreatedTopic0 as `0x${string}`,
      "0x0000000000000000000000002e8c31162b855a2ffa90f6f8634643ad6f111e18",
      "0x0000000000000000000000002e8c31162b855a2ffa90f6f8634643ad6f111e18",
      "0x000000000000000000000000d0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    ],
    data: "0x0000000000000000000000004e3468951d49f2eea976ed0d6e75ffcb44a9a5440000000000000000000000009b1513dfdfc023fa6e576b130066ec05b6f1bfa178dda996de494b599fdb66c8365826df9b80d101d1cea931b5fa3753fca7ab85000000000000000000000000000000000000000000000000000000006a56766f000000000000000000000000000000000000000000000000000000006a57c7ef00000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000024149000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    blockNumber: "0x945659",
    transactionHash:
      "0x7632524cd4cec7cabc574b58c54095a2ca33a2a1b037b1486e8b88b79bd3bf1b",
    transactionIndex: "0x0",
    blockHash: `0x${"0".repeat(64)}`,
    logIndex: "0x10",
    removed: false,
  };

  const decoded = decodeLaunchCreated(log, config.launchCreatedTopic0);
  assert.equal(decoded.asset, "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18");
  assert.equal(decoded.numeraire, "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec");
  assert.equal(decoded.creator, "0x9b1513dfdfc023fa6e576b130066ec05b6f1bfa1");
  assert.equal(decoded.symbol, "AI");
});

test("decodes Airlock getAssetData without assuming the quote leg", () => {
  const value =
    "0x000000000000000000000000d0601ce157db5bdc3162bbac2a2c8af5320d9eec" +
    "000000000000000000000000000000000000000000000000000000000000dead" +
    "000000000000000000000000000000000000000000000000000000000000dead" +
    "000000000000000000000000ba2f330edb16cd8056f5988d8ce19bbc63475a0e" +
    "0000000000000000000000004e3468951d49f2eea976ed0d6e75ffcb44a9a544" +
    "0000000000000000000000002e8c31162b855a2ffa90f6f8634643ad6f111e18" +
    "000000000000000000000000deaddeaddeaddeaddeaddeaddeaddeaddeaddead" +
    "0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000" +
    "0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000" +
    "00000000000000000000000092d435c96e63c43e12d6d0ab28f6b0b04072f765";
  const decoded = decodeAssetData(value);
  assert.equal(decoded.numeraire, "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec");
  assert.equal(decoded.poolInitializer, "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544");
  assert.equal(decoded.totalSupply, 1_000_000_000n * 10n ** 18n);
});

test("applies the currentMultiplier to raw equity USD", () => {
  assert.equal(multiplyDecimal("110.125", "4.000000000000000000"), "440.50000000");
  assert.equal(multiplyDecimal("220.41", "1.000566080061092436"), "220.53476971");
});

test("SQLite deduplicates and preserves venue separately from chain", () => {
  const database = new TrackerDatabase(":memory:");
  const launch: NormalizedLaunch = {
    tokenAddress: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
    name: "Artificial Inu",
    symbol: "AI",
    numeraireAddress: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    numeraireSymbol: "NVDA",
    numeraireMultiplier: "1.0",
    numeraireBidUsd: "220.41000000",
    numeraireAskUsd: "220.45000000",
    numeraireMidUsd: "220.43000000",
    priceGeneratedAt: "2026-09-01T00:00:00Z",
    pricingError: null,
    poolAddress: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
    creator: "0x9b1513dfdfc023fa6e576b130066ec05b6f1bfa1",
    blockNumber: 9_721_433,
    timestamp: "2026-07-14T17:48:31.000Z",
    transactionHash:
      "0x7632524cd4cec7cabc574b58c54095a2ca33a2a1b037b1486e8b88b79bd3bf1b",
    logIndex: 16,
    venueKey: "long-robinhood",
    chainId: 4663,
    source: "rpc:LaunchCreated:test",
  };

  assert.equal(database.insertLaunch(launch), true);
  assert.equal(database.insertLaunch(launch), false);
  assert.equal(database.countLaunches(), 1);
  assert.equal(database.allLaunches()[0].venueKey, "long-robinhood");
  assert.equal(database.allLaunches()[0].chainId, 4663);
  database.close();
});
