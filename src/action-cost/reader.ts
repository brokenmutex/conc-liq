import { getAddress, type Address, type Hash, type Hex } from "viem";
import type { BulkRpcHealthGate } from "../rpc-health/store.js";
import type { RawActionTransaction } from "./domain.js";

interface RpcEnvelope {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
  readonly id?: unknown;
  readonly result?: unknown;
}

function sanitizedError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.replace(/https?:\/\/[^\s]+/gu, "<rpc-url>").slice(0, 500);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`RPC ${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

function quantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value)) {
    throw new Error(`RPC ${field} is not a hex quantity`);
  }
  return BigInt(value);
}

function safeNumber(value: unknown, field: string): number {
  const parsed = quantity(value, field);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`RPC ${field} exceeds the safe integer range`);
  }
  return Number(parsed);
}

function hash(value: unknown, field: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/iu.test(value)) {
    throw new Error(`RPC ${field} is not a hash`);
  }
  return value as Hash;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string") throw new Error(`RPC ${field} is not an address`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`RPC ${field} is not an address`);
  }
}

function inputData(value: unknown): Hex {
  if (
    typeof value !== "string" ||
    !/^0x(?:[0-9a-f]{2})*$/iu.test(value)
  ) {
    throw new Error("RPC transaction input is not byte-aligned hex data");
  }
  return value as Hex;
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export interface ActionCostReader {
  read(transactionHash: Hash): Promise<RawActionTransaction>;
}

export class JsonRpcActionCostReader implements ActionCostReader {
  public constructor(private readonly input: {
    readonly gate: BulkRpcHealthGate;
    readonly rpcUrl: string;
    readonly timeoutMs: number;
  }) {}

  private async request(transactionHash: Hash): Promise<readonly RpcEnvelope[]> {
    await this.input.gate.assertBulkAllowed();
    try {
      const response = await fetch(this.input.rpcUrl, {
        body: JSON.stringify([
          {
            id: 1,
            jsonrpc: "2.0",
            method: "eth_getTransactionByHash",
            params: [transactionHash],
          },
          {
            id: 2,
            jsonrpc: "2.0",
            method: "eth_getTransactionReceipt",
            params: [transactionHash],
          },
        ]),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(this.input.timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error("RPC batch response is not an array");
      return body.map((entry) => record(entry, "batch entry") as RpcEnvelope);
    } catch (error) {
      throw new Error(
        `Action-cost RPC request failed: ${sanitizedError(error)}`,
      );
    }
  }

  public async read(transactionHash: Hash): Promise<RawActionTransaction> {
    const responses = await this.request(transactionHash);
    const byId = new Map<number, RpcEnvelope>();
    for (const response of responses) {
      if (typeof response.id === "number") byId.set(response.id, response);
    }
    const transactionResponse = byId.get(1);
    const receiptResponse = byId.get(2);
    if (transactionResponse === undefined || receiptResponse === undefined) {
      throw new Error("Action-cost RPC batch response is incomplete");
    }
    for (const response of [transactionResponse, receiptResponse]) {
      if (response.error !== undefined) {
        const code = typeof response.error.code === "number"
          ? response.error.code
          : "unknown";
        const message = typeof response.error.message === "string"
          ? response.error.message
          : "JSON-RPC error";
        throw new Error(`Action-cost RPC ${code}: ${message}`);
      }
    }
    const transaction = record(transactionResponse.result, "transaction");
    const receipt = record(receiptResponse.result, "receipt");
    const parsedTransactionHash = hash(transaction.hash, "transaction hash");
    const receiptTransactionHash = hash(receipt.transactionHash, "receipt transaction hash");
    if (
      !same(parsedTransactionHash, transactionHash) ||
      !same(receiptTransactionHash, transactionHash)
    ) {
      throw new Error("RPC returned a different action-cost transaction");
    }
    const blockHash = hash(transaction.blockHash, "transaction block hash");
    const receiptBlockHash = hash(receipt.blockHash, "receipt block hash");
    const blockNumber = quantity(transaction.blockNumber, "transaction block number");
    const receiptBlockNumber = quantity(receipt.blockNumber, "receipt block number");
    const transactionIndex = safeNumber(
      transaction.transactionIndex,
      "transaction index",
    );
    const receiptTransactionIndex = safeNumber(
      receipt.transactionIndex,
      "receipt transaction index",
    );
    if (
      !same(blockHash, receiptBlockHash) ||
      blockNumber !== receiptBlockNumber ||
      transactionIndex !== receiptTransactionIndex
    ) {
      throw new Error("Transaction and receipt inclusion fields disagree");
    }
    const status = quantity(receipt.status, "receipt status");
    if (status !== 0n && status !== 1n) {
      throw new Error("RPC receipt status is invalid");
    }
    const to = transaction.to === null
      ? null
      : address(transaction.to, "transaction recipient");
    return {
      blockHash,
      blockNumber,
      chainId: safeNumber(transaction.chainId, "transaction chain ID"),
      effectiveGasPrice: quantity(
        receipt.effectiveGasPrice,
        "effective gas price",
      ),
      from: address(transaction.from, "transaction sender"),
      gasUsed: quantity(receipt.gasUsed, "receipt gas used"),
      gasUsedForL1: receipt.gasUsedForL1 === undefined ||
          receipt.gasUsedForL1 === null
        ? null
        : quantity(receipt.gasUsedForL1, "receipt L1 gas used"),
      input: inputData(transaction.input),
      status: status === 1n ? "success" : "reverted",
      to,
      transactionHash: parsedTransactionHash,
      transactionIndex,
    };
  }
}
