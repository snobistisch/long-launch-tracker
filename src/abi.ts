import type { RpcLog } from "./types.ts";

const textDecoder = new TextDecoder();

function hexBody(value: string): string {
  if (!value.startsWith("0x")) throw new Error(`Expected 0x-prefixed hex: ${value}`);
  const body = value.slice(2);
  if (!/^[0-9a-f]*$/i.test(body) || body.length % 2 !== 0) {
    throw new Error(`Invalid hex: ${value.slice(0, 24)}`);
  }
  return body.toLowerCase();
}

function wordAt(value: string, index: number): string {
  const body = hexBody(value);
  const word = body.slice(index * 64, (index + 1) * 64);
  if (word.length !== 64) throw new Error(`Missing ABI word ${index}`);
  return word;
}

function addressFromWord(word: string): string {
  const address = `0x${word.slice(24)}`;
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`Invalid ABI address: ${address}`);
  return address;
}

export function addressFromTopic(topic: string): string {
  return addressFromWord(wordAt(topic, 0));
}

export function decodeAbiString(value: string): string {
  const body = hexBody(value);
  if (body.length === 64) {
    const bytes = Buffer.from(body.replace(/(00)+$/, ""), "hex");
    return textDecoder.decode(bytes);
  }
  const offset = Number(BigInt(`0x${wordAt(value, 0)}`));
  const lengthWord = body.slice(offset * 2, offset * 2 + 64);
  if (lengthWord.length !== 64) throw new Error("Invalid ABI string offset");
  const length = Number(BigInt(`0x${lengthWord}`));
  const data = body.slice(offset * 2 + 64, offset * 2 + 64 + length * 2);
  return textDecoder.decode(Buffer.from(data, "hex"));
}

export interface LaunchCreatedData {
  asset: string;
  poolOrHook: string;
  numeraire: string;
  initializer: string;
  creator: string;
  symbol: string;
}

export function decodeLaunchCreated(log: RpcLog, expectedTopic0: string): LaunchCreatedData {
  if (log.topics[0]?.toLowerCase() !== expectedTopic0.toLowerCase() || log.topics.length !== 4) {
    throw new Error(`Unexpected LaunchCreated topics in ${log.transactionHash}`);
  }
  // Verified receipts show word 1 equals the launcher caller/creator; it is not Airlock's
  // integrator (getAssetData returns a different address for the same launch).
  return {
    asset: addressFromTopic(log.topics[1]),
    poolOrHook: addressFromTopic(log.topics[2]),
    numeraire: addressFromTopic(log.topics[3]),
    initializer: addressFromWord(wordAt(log.data, 0)),
    creator: addressFromWord(wordAt(log.data, 1)),
    symbol: decodeDynamicString(log.data, 5),
  };
}

function decodeDynamicString(data: string, offsetWordIndex: number): string {
  const body = hexBody(data);
  const offset = Number(BigInt(`0x${wordAt(data, offsetWordIndex)}`));
  const lengthHex = body.slice(offset * 2, offset * 2 + 64);
  if (lengthHex.length !== 64) return "";
  const length = Number(BigInt(`0x${lengthHex}`));
  return textDecoder.decode(
    Buffer.from(body.slice(offset * 2 + 64, offset * 2 + 64 + length * 2), "hex"),
  );
}

export interface AssetData {
  numeraire: string;
  timelock: string;
  governance: string;
  liquidityMigrator: string;
  poolInitializer: string;
  pool: string;
  migrationPool: string;
  numTokensToSell: bigint;
  totalSupply: bigint;
  integrator: string;
}

export function decodeAssetData(value: string): AssetData {
  return {
    numeraire: addressFromWord(wordAt(value, 0)),
    timelock: addressFromWord(wordAt(value, 1)),
    governance: addressFromWord(wordAt(value, 2)),
    liquidityMigrator: addressFromWord(wordAt(value, 3)),
    poolInitializer: addressFromWord(wordAt(value, 4)),
    pool: addressFromWord(wordAt(value, 5)),
    migrationPool: addressFromWord(wordAt(value, 6)),
    numTokensToSell: BigInt(`0x${wordAt(value, 7)}`),
    totalSupply: BigInt(`0x${wordAt(value, 8)}`),
    integrator: addressFromWord(wordAt(value, 9)),
  };
}

export function encodeAddressCall(selector: string, address: string): string {
  if (!/^0x[0-9a-f]{8}$/i.test(selector)) throw new Error(`Invalid selector: ${selector}`);
  if (!/^0x[0-9a-f]{40}$/i.test(address)) throw new Error(`Invalid address: ${address}`);
  return `${selector}${address.slice(2).toLowerCase().padStart(64, "0")}`;
}
