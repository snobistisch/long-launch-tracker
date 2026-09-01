import type { Hex, RpcLog } from "./types.ts";
import { JsonHttpClient, sleep } from "./network.ts";

interface RpcEnvelope<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export function toQuantity(value: number): Hex {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid JSON-RPC quantity: ${value}`);
  }
  return `0x${value.toString(16)}`;
}

export function fromQuantity(value: string): number {
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid JSON-RPC result: ${value}`);
  return parsed;
}

export class RpcClient {
  private id = 0;
  private readonly url: string;
  private readonly http: JsonHttpClient;

  constructor(url: string, http: JsonHttpClient) {
    this.url = url;
    this.http = http;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const envelope = await this.http.request<RpcEnvelope<T>>(this.url, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      });
      if (!envelope.error && "result" in envelope) return envelope.result as T;
      lastError = new Error(
        `RPC ${method} failed (${envelope.error?.code ?? "unknown"}): ${envelope.error?.message ?? "missing result"}`,
      );
      if (attempt < 3) await sleep(250 * 2 ** attempt);
    }
    throw lastError ?? new Error(`RPC ${method} failed`);
  }

  blockNumber(): Promise<number> {
    return this.call<Hex>("eth_blockNumber", []).then(fromQuantity);
  }

  async getLogs(input: {
    address: string;
    topic0: string;
    fromBlock: number;
    toBlock: number;
    maximumSpan: number;
  }): Promise<RpcLog[]> {
    const span = input.toBlock - input.fromBlock + 1;
    if (span < 1 || span > input.maximumSpan) {
      throw new Error(`Refusing eth_getLogs span ${span}; configured maximum is ${input.maximumSpan}`);
    }
    if (!/^0x[0-9a-f]{40}$/i.test(input.address)) throw new Error("Log address is required");
    if (!/^0x[0-9a-f]{64}$/i.test(input.topic0)) throw new Error("Exact topic0 is required");

    return this.call<RpcLog[]>("eth_getLogs", [
      {
        address: input.address,
        topics: [input.topic0],
        fromBlock: toQuantity(input.fromBlock),
        toBlock: toQuantity(input.toBlock),
      },
    ]);
  }

  ethCall(to: string, data: string): Promise<Hex> {
    return this.call<Hex>("eth_call", [{ to, data }, "latest"]);
  }

  getBlock(blockNumber: number): Promise<{ number: Hex; timestamp: Hex }> {
    return this.call("eth_getBlockByNumber", [toQuantity(blockNumber), false]);
  }

  getTransaction(hash: string): Promise<{ from: Hex }> {
    return this.call("eth_getTransactionByHash", [hash]);
  }
}
