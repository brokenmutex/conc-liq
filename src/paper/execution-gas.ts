import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeFunctionResult, encodeFunctionData, type Address, type Hash, type Hex } from "viem";
import { NODE_INTERFACE, PAPER_ACCOUNT, nodeInterfaceAbi } from "./execution-abi.js";
import type { PaperFork } from "./fork.js";

type Override = { balance?: Hex; nonce?: Hex; stateDiff?: Record<Hex, Hex> };
export type PaperOverrides = Record<Address, Override>;
function quantity(value: unknown): Hex {
  assert((typeof value === "string" && /^0x[0-9a-f]+$/iu.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0), "Invalid prestate quantity");
  return `0x${BigInt(value as string | number).toString(16)}`;
}
function word(value: unknown): Hex {
  assert(typeof value === "string" && /^0x[0-9a-f]{1,64}$/iu.test(value), "Invalid prestate storage word");
  return `0x${value.slice(2).padStart(64, "0")}` as Hex;
}
export function prestateOverrides(value: unknown): PaperOverrides {
  assert(value && typeof value === "object" && !Array.isArray(value), "Missing prestate trace");
  const output: PaperOverrides = {};
  let slots = 0;
  for (const [address, raw] of Object.entries(value)) {
    assert(/^0x[0-9a-f]{40}$/iu.test(address) && raw && typeof raw === "object", "Malformed prestate account");
    const account = raw as { balance?: unknown; nonce?: unknown; storage?: Record<string, unknown> };
    const override: Override = {};
    if (account.balance !== undefined) override.balance = quantity(account.balance);
    if (account.nonce !== undefined) override.nonce = quantity(account.nonce);
    if (account.storage) {
      const entries = Object.entries(account.storage);
      slots += entries.length;
      assert(slots <= 2000, "Paper prestate slot budget exceeded");
      override.stateDiff = Object.fromEntries(entries.map(([key, entry]) => [word(key), word(entry)]));
    }
    // Keep deployed code intact; stateDiff preserves untouched canonical slots.
    output[address as Address] = override;
  }
  assert(Object.keys(output).length <= 64 && Object.keys(output).length > 0, "Paper prestate account budget exceeded");
  return output;
}
export function gasComponents(values: readonly [bigint, bigint, bigint, bigint]) {
  const [gas, parentGas, baseFee, parentBaseFee] = values;
  assert(gas > 0n && baseFee > 0n && parentGas >= 0n && parentGas <= gas && parentBaseFee >= 0n, "Invalid node gas components");
  return {
    gas: String(gas), parentGas: String(parentGas), baseFeeWei: String(baseFee), parentBaseFeeWei: String(parentBaseFee),
    totalFeeWei: String(gas * baseFee), parentFeeWei: String(parentGas * baseFee),
    executionFeeWei: String((gas - parentGas) * baseFee),
    basis: "node_estimateGas_with_paper_prestate_and_parent_component" as const,
  };
}
export interface PaperTransaction {
  action: string; to: Address; calldata: Hex; returnData: Hex;
  localHash: Hash; localGasUsed: string; localEffectiveGasPriceWei: string;
  sourceBlock: string; sourceHash: Hash;
  estimate: ReturnType<typeof gasComponents>;
  stateOverrideHash: string;
  stateOverrides: PaperOverrides;
}

export async function simulatePaperTransaction(fork: PaperFork, input: { action: string; to: Address; calldata: Hex }): Promise<PaperTransaction> {
  const tx = { from: PAPER_ACCOUNT, to: input.to, data: input.calldata, value: "0x0", gas: "0x7a1200" };
  const overrides = prestateOverrides(await fork.rpc("debug_traceCall", [tx, "latest", { tracer: "prestateTracer", tracerConfig: { diffMode: false } }]));
  const localReturn = await fork.rpc<Hex>("eth_call", [tx, "latest"]);
  // Validate identical results on Nitro with the prestate touched by the local
  // execution. This catches unsupported local precompiles or context drift.
  const liveReturn = await fork.read("eth_call", [tx, fork.blockTag, overrides]) as Hex;
  assert.equal(liveReturn.toLowerCase(), localReturn.toLowerCase(), `Local/Nitro ${input.action} result mismatch`);
  const fullGas = BigInt(await fork.read("eth_estimateGas", [tx, fork.blockTag, overrides]) as Hex);
  const data = encodeFunctionData({ abi: nodeInterfaceAbi, functionName: "gasEstimateL1Component", args: [input.to, false, input.calldata] });
  const result = await fork.read("eth_call", [{ ...tx, to: NODE_INTERFACE, data }, fork.blockTag, overrides]) as Hex;
  const [parentGas, baseFee, parentBaseFee] = decodeFunctionResult({ abi: nodeInterfaceAbi, functionName: "gasEstimateL1Component", data: result });
  const estimate = gasComponents([fullGas, parentGas, baseFee, parentBaseFee]);
  const hash = await fork.rpc<Hash>("eth_sendTransaction", [tx]);
  const receipt = await localReceipt(fork, hash);
  assert.equal(receipt.status, "0x1", `Local ${input.action} reverted after simulation`);
  return { ...input, returnData: localReturn, localHash: hash, localGasUsed: String(BigInt(receipt.gasUsed)),
    localEffectiveGasPriceWei: String(BigInt(receipt.effectiveGasPrice)),
    sourceBlock: String(fork.source.number), sourceHash: fork.source.hash, estimate,
    stateOverrideHash: createHash("sha256").update(JSON.stringify(overrides)).digest("hex"), stateOverrides: overrides };
}

export async function localReceipt(fork: PaperFork, hash: Hash) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = await fork.rpc<{ status: Hex; gasUsed: Hex; effectiveGasPrice: Hex } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Local paper receipt timed out");
}
