import { getAddress, type Hash, type Hex } from "viem";
import type { RawActionTransaction } from "../action-cost/domain.js";
import { createHistoryFetch, historyRequestTarget, pace, type HistoryConfig } from "./client.js";

type Row = Record<string, unknown>;
interface NativePage {
  next_block: number;
  data: { blocks?: Row[]; logs?: Row[]; transactions?: Row[] }[];
  rollback_guard?: {
    block_number: number; hash: string; first_block_number: number; first_parent_hash: string;
  } | null;
}
const blockFields = ["number", "hash", "parent_hash", "timestamp"];
const logFields = ["block_number", "block_hash", "transaction_hash", "transaction_index", "log_index",
  "address", "data", "topic0", "topic1", "topic2", "topic3", "removed"];
const transactionFields = ["hash", "chain_id", "block_number", "block_hash", "transaction_index", "from",
  "to", "input", "status", "gas_used", "effective_gas_price", "gas_used_for_l1"];

function integer(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/iu.test(value)) return BigInt(value);
  throw new Error("HyperSync returned an invalid unsigned integer");
}
function number(value: unknown): number {
  const result = integer(value);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("HyperSync integer exceeds safe range");
  return Number(result);
}
function hex(value: unknown): Hex { return `0x${integer(value).toString(16)}`; }
function hash(value: unknown): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/iu.test(value)) throw new Error("HyperSync returned an invalid hash");
  return value as Hash;
}
function address(value: unknown) {
  if (typeof value !== "string") throw new Error("HyperSync returned an invalid address");
  return getAddress(value);
}

export class NativeHyperSync {
  private chainCheck: Promise<void> | undefined;
  public constructor(private readonly config: HistoryConfig, private readonly fetcher: typeof fetch = fetch) {
    if (config.source !== "hypersync" || !config.historyUrl || !config.apiToken) {
      throw new Error("Native HyperSync requires its endpoint and API token");
    }
  }

  private async request(path: string, body?: unknown, signal?: AbortSignal | null): Promise<unknown> {
    const requestSignal = signal ?? AbortSignal.timeout(this.config.timeoutMs ?? 60_000);
    let response: Response;
    try {
      await pace(this.config.historyUrl!, this.config.requestIntervalMs ?? 0, requestSignal);
      response = await this.fetcher(`${this.config.historyUrl!.replace(/\/$/u, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${this.config.apiToken}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal, redirect: "error",
      });
    } catch { throw new Error("HyperSync transport failed"); }
    if (!response.ok) throw new Error(`HyperSync HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error("HyperSync returned invalid JSON"); }
  }

  public async chainId(signal?: AbortSignal | null): Promise<number> {
    if (!this.chainCheck) {
      this.chainCheck = (async () => {
        const body = await this.request("/chain_id", undefined, signal) as { chain_id?: unknown };
        if (body?.chain_id !== 4663) throw new Error("HyperSync chain ID mismatch");
      })();
      this.chainCheck.catch(() => { this.chainCheck = undefined; });
    }
    await this.chainCheck;
    return 4663;
  }

  public async query(from: number, toExclusive: number, selection: Row, signal?: AbortSignal | null): Promise<{
    blocks: Row[]; logs: Row[]; transactions: Row[];
  }> {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(toExclusive) || from < 0 ||
        toExclusive <= from || toExclusive - from > 100_000) throw new Error("HyperSync requires a bounded block range");
    await this.chainId(signal);
    const rows = { blocks: [] as Row[], logs: [] as Row[], transactions: [] as Row[] };
    let next = from;
    let previousGuard: NativePage["rollback_guard"];
    while (next < toExclusive) {
      const page = await this.request("/query", {
        ...selection, from_block: next, to_block: toExclusive,
      }, signal) as NativePage;
      if (!Number.isSafeInteger(page?.next_block) || page.next_block <= next || page.next_block > toExclusive ||
          !Array.isArray(page.data)) throw new Error("HyperSync pagination did not advance within the requested range");
      const guard = page.rollback_guard;
      if (guard && (guard.first_block_number !== next || guard.block_number !== page.next_block - 1)) {
        throw new Error("HyperSync rollback guard does not match the page range");
      }
      if (previousGuard && guard && previousGuard.hash.toLowerCase() !== guard.first_parent_hash.toLowerCase()) {
        throw new Error("HyperSync reorg detected between pages");
      }
      for (const group of page.data) {
        for (const kind of ["blocks", "logs", "transactions"] as const) {
          const values = group[kind] ?? [];
          if (!Array.isArray(values)) throw new Error("Malformed HyperSync data group");
          for (const row of values) {
            const block = number(kind === "blocks" ? row.number : row.block_number);
            if (block < next || block >= page.next_block) throw new Error("HyperSync row is outside its page range");
          }
          rows[kind].push(...values);
        }
      }
      previousGuard = guard;
      next = page.next_block;
    }
    return rows;
  }

  public async block(blockNumber: unknown, signal?: AbortSignal | null): Promise<Row> {
    const block = number(blockNumber);
    const result = await this.query(block, block + 1, {
      include_all_blocks: true, field_selection: { block: blockFields },
    }, signal);
    if (result.blocks.length !== 1) throw new Error("HyperSync block metadata is unavailable");
    const row = result.blocks[0]!;
    return { number: hex(row.number), hash: hash(row.hash), parentHash: hash(row.parent_hash), timestamp: hex(row.timestamp) };
  }

  public async logs(filter: Row, signal?: AbortSignal | null): Promise<Row[]> {
    if (filter.blockHash !== undefined || filter.fromBlock === undefined || filter.toBlock === undefined) {
      throw new Error("HyperSync logs require an explicit numbered range");
    }
    const topics = filter.topics === undefined ? [] : filter.topics;
    if (!Array.isArray(topics) || topics.length > 4) throw new Error("Invalid HyperSync topic filter");
    const selections = {
      address: filter.address === undefined ? [] : Array.isArray(filter.address) ? filter.address : [filter.address],
      topics: topics.map((topic: unknown) => topic === null ? [] : Array.isArray(topic) ? topic : [topic]),
    };
    const from = number(filter.fromBlock);
    const to = number(filter.toBlock);
    const result = await this.query(from, to + 1, {
      logs: [selections], field_selection: { log: logFields },
    }, signal);
    return result.logs.map((row) => {
      if (row.removed !== false) throw new Error("HyperSync log removal state is invalid");
      if (typeof row.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/iu.test(row.data)) {
        throw new Error("HyperSync log data is invalid");
      }
      return {
        address: address(row.address), blockNumber: hex(row.block_number), blockHash: hash(row.block_hash),
        transactionHash: hash(row.transaction_hash), transactionIndex: hex(row.transaction_index),
        logIndex: hex(row.log_index), data: row.data,
        topics: [row.topic0, row.topic1, row.topic2, row.topic3].filter((topic) => topic !== undefined && topic !== null).map(hash),
        removed: false,
      };
    });
  }

  public async transaction(transactionHash: Hash, blockNumber: bigint): Promise<RawActionTransaction> {
    const block = number(blockNumber.toString());
    const result = await this.query(block, block + 1, {
      transactions: [{}], field_selection: { transaction: transactionFields },
    });
    const matches = result.transactions.filter((row) => hash(row.hash).toLowerCase() === transactionHash.toLowerCase());
    if (matches.length !== 1) throw new Error("HyperSync transaction is unavailable or duplicated in the requested block");
    const row = matches[0]!;
    if (number(row.chain_id) !== 4663) throw new Error("HyperSync transaction chain ID mismatch");
    if (row.status !== 0 && row.status !== 1) throw new Error("HyperSync transaction status is invalid");
    if (typeof row.input !== "string" || !/^0x(?:[0-9a-f]{2})*$/iu.test(row.input)) throw new Error("HyperSync calldata is invalid");
    return {
      blockHash: hash(row.block_hash), blockNumber: integer(row.block_number), chainId: 4663,
      transactionHash: hash(row.hash), transactionIndex: number(row.transaction_index),
      from: address(row.from), to: row.to === null ? null : address(row.to), input: row.input as Hex,
      gasUsed: integer(row.gas_used), effectiveGasPrice: integer(row.effective_gas_price),
      gasUsedForL1: row.gas_used_for_l1 === undefined || row.gas_used_for_l1 === null ? null : integer(row.gas_used_for_l1),
      status: row.status === 1 ? "success" : "reverted",
    };
  }
}

/** Compatibility surface for existing block-metadata/log readers, not a general RPC. */
export function createHyperSyncFetch(config: HistoryConfig, fetcher: typeof fetch = fetch): typeof fetch {
  const native = new NativeHyperSync(config, fetcher);
  const archive = createHistoryFetch({ ...config, source: "envio" }, fetcher);
  return async (url, init) => {
    if (typeof init?.body !== "string") throw new Error("HyperSync adapter requires a JSON body");
    const request = JSON.parse(init.body) as { method: string; params?: unknown[]; id: unknown };
    if (Array.isArray(request)) throw new Error("HyperSync metadata adapter does not accept RPC batches");
    const params = request.params ?? [];
    let result: unknown;
    switch (request.method) {
      case "eth_chainId": result = hex(await native.chainId(init.signal)); break;
      case "eth_getBlockByNumber":
        if (params[1] === true) throw new Error("HyperSync metadata adapter does not return full blocks");
        result = await native.block(params[0], init.signal); break;
      case "eth_getLogs": result = await native.logs(params[0] as Row, init.signal); break;
      case "eth_call": case "eth_getCode": case "eth_getBalance": case "eth_getStorageAt":
        historyRequestTarget(config, request);
        return archive(url, init);
      default: throw new Error("Unsupported native HyperSync metadata method");
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
}
