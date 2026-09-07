import assert from "node:assert/strict";
import { encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, parseAbi, toHex, type Address, type Hash, type Hex } from "viem";
import { principalAmounts } from "../backtest/principal.js";
import { NONFUNGIBLE_POSITION_MANAGER, USDG } from "../constants.js";
import { guardedCanaryPositionManagerAbi } from "../canary-plan/abi.js";
import { buildCanaryExit, decodeCanaryExit, readCanaryPosition } from "../canary-plan/exit.js";
import { nonfungiblePositionManagerReadAbi } from "../nft/abi.js";
import { PAPER_NVDA, PAPER_POOL } from "./engine.js";
import { PAPER_ACCOUNT, PAPER_ROUTER, paperTokenAbi } from "./execution-abi.js";
import { prestateOverrides, type PaperTransaction } from "./execution-gas.js";
import { createPaperExecutionContext, fixtureSend, fundPaperFixture, type PaperExecutionPolicy } from "./execution.js";
import type { PaperFork } from "./fork.js";

const NVDA = PAPER_NVDA as Address;
const POOL = PAPER_POOL as Address;
const Q128 = 1n << 128n;
const UINT256 = 1n << 256n;
const coreAbi = parseAbi(["function positions(bytes32 key) view returns(uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)"]);
export interface PaperExitInventory {
  liquidity: string; tickLower: number; tickUpper: number;
  idle0: string; idle1: string; fee0: string; fee1: string;
  allowances: readonly { token: Address; spender: Address; amount: string }[];
  nativeBalanceWei?: string;
}
const slotAt = (base: bigint, offset: bigint) => toHex((base + offset) % UINT256, { size: 32 });
export function locateMappingSlot(key: Hex, storage: Record<Hex, Hex>, matches: (read: (offset: bigint) => bigint) => boolean): bigint {
  const matchesAt: bigint[] = [];
  for (let slot = 0n; slot < 128n; slot++) {
    const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [key, slot])));
    const read = (offset: bigint) => BigInt(storage[slotAt(base, offset)] ?? "0x0");
    if ((storage[slotAt(base, 0n)] || storage[slotAt(base, 1n)]) && matches(read)) matchesAt.push(base);
  }
  assert.equal(matchesAt.length, 1, "Position storage layout cannot be uniquely verified from its getter trace");
  return matchesAt[0]!;
}
export function priorGrowthForFee(growth: bigint, liquidity: bigint, fee: bigint): bigint {
  assert(liquidity > 0n && liquidity < Q128 && fee >= 0n && fee < Q128, "Invalid paper fee restoration");
  const delta = (fee * Q128 + liquidity - 1n) / liquidity;
  assert(delta < UINT256 && delta * liquidity / Q128 === fee, "Paper fee cannot be represented exactly");
  return (growth - delta + UINT256) % UINT256;
}

// The paper NFT does not exist on mainnet. Restore its exact liquidity and
// separately estimated fees on a fresh owned fork, then price/execute the real
// exit calls on Nitro with that prestate. Restoration is never strategy income
// or a charged transaction. No stale entry-time pool storage is copied forward.
export async function simulatePaperExit(fork: PaperFork, policy: PaperExecutionPolicy, inventory: PaperExitInventory,
  onTransaction?: (tx: PaperTransaction) => void) {
  const context = await createPaperExecutionContext(fork, policy, onTransaction);
  const { local, sourceSlot, balances, send, approve, quoteSwap, swap, transactions } = context;
  const liquidity = BigInt(inventory.liquidity);
  assert(liquidity > 0n && liquidity < Q128);
  const principal = principalAmounts({ liquidity, tickLower: inventory.tickLower, tickUpper: inventory.tickUpper, sqrtPriceX96: sourceSlot[0] });
  const desired = { quote: principal.amount0 + 1n, rwa: principal.amount1 + 1n };
  const donor = await fundPaperFixture(context, desired);
  for (const [token, amount] of [[USDG, desired.quote], [NVDA, desired.rwa]] as const) {
    await fixtureSend(context, PAPER_ACCOUNT, token, encodeFunctionData({ abi: paperTokenAbi, functionName: "approve", args: [NONFUNGIBLE_POSITION_MANAGER, amount] }));
  }
  const params = { token0: USDG, token1: NVDA, fee: 500, tickLower: inventory.tickLower, tickUpper: inventory.tickUpper,
    amount0Desired: desired.quote, amount1Desired: desired.rwa, amount0Min: 0n, amount1Min: 0n,
    recipient: PAPER_ACCOUNT, deadline: fork.source.timestamp + BigInt(policy.transactionTtlSeconds) };
  const preview = await local.simulateContract({ account: PAPER_ACCOUNT, address: NONFUNGIBLE_POSITION_MANAGER,
    abi: guardedCanaryPositionManagerAbi, functionName: "mint", args: [params] });
  const tokenId = preview.result[0];
  assert(preview.result[1] >= liquidity, "Position restoration minted too little liquidity");
  await fixtureSend(context, PAPER_ACCOUNT, NONFUNGIBLE_POSITION_MANAGER, encodeFunctionData({ abi: guardedCanaryPositionManagerAbi, functionName: "mint", args: [params] }));
  let position = await readCanaryPosition(local, tokenId, await local.getBlockNumber({ cacheTime: 0 }));
  // Raw token rounding can mint a few additional liquidity units. Remove them
  // during setup so the priced exit burns exactly the original paper amount.
  if (position.liquidity > liquidity) {
    const excess = buildCanaryExit({ operator: PAPER_ACCOUNT, owner: PAPER_ACCOUNT, tokenId,
      source: { rwaSymbol: "NVDA", rwaAddress: NVDA, fee: 500, token0: USDG, token1: NVDA },
      position: { ...position, liquidity: position.liquidity - liquidity }, sqrtPriceX96: sourceSlot[0],
      blockTimestamp: fork.source.timestamp, slippageBps: policy.maxSlippageBps, ttlSeconds: policy.transactionTtlSeconds });
    await fixtureSend(context, PAPER_ACCOUNT, NONFUNGIBLE_POSITION_MANAGER, excess.calldata);
  }
  position = await readCanaryPosition(local, tokenId, await local.getBlockNumber({ cacheTime: 0 }));
  assert.equal(position.liquidity, liquidity);
  assert(position.tokensOwed0 === 0n && position.tokensOwed1 === 0n);
  const getter = encodeFunctionData({ abi: nonfungiblePositionManagerReadAbi, functionName: "positions", args: [tokenId] });
  const nftState = await local.readContract({ address: NONFUNGIBLE_POSITION_MANAGER, abi: nonfungiblePositionManagerReadAbi, functionName: "positions", args: [tokenId] });
  const traceStorage = async (to: Address, data: Hex) => {
    const trace = prestateOverrides(await fork.rpc("debug_traceCall", [{ from: PAPER_ACCOUNT, to, data }, "latest", { tracer: "prestateTracer" }]));
    const storage = Object.entries(trace).find(([address]) => address.toLowerCase() === to.toLowerCase())?.[1].stateDiff;
    assert(storage, "Position getter trace has no storage");
    return storage;
  };
  const nftStorage = await traceStorage(NONFUNGIBLE_POSITION_MANAGER, getter);
  const nftBase = locateMappingSlot(toHex(tokenId, { size: 32 }), nftStorage, read =>
    read(1n) >> 128n === liquidity && (read(1n) & ((1n << 80n) - 1n)) > 0n &&
    Number(BigInt.asIntN(24, read(1n) >> 80n)) === inventory.tickLower &&
    Number(BigInt.asIntN(24, read(1n) >> 104n)) === inventory.tickUpper &&
    read(2n) === nftState[8] && read(3n) === nftState[9]);
  const key = keccak256(encodePacked(["address", "int24", "int24"], [NONFUNGIBLE_POSITION_MANAGER, inventory.tickLower, inventory.tickUpper]));
  const core = await local.readContract({ address: POOL, abi: coreAbi, functionName: "positions", args: [key] });
  const coreStorage = await traceStorage(POOL, encodeFunctionData({ abi: coreAbi, functionName: "positions", args: [key] }));
  const coreBase = locateMappingSlot(key, coreStorage, read => read(0n) === core[0] && read(1n) === core[1] && read(2n) === core[2] && read(3n) === core[3] + (core[4] << 128n));
  const fees = [BigInt(inventory.fee0), BigInt(inventory.fee1)] as const;
  assert(core[3] + fees[0] < Q128 && core[4] + fees[1] < Q128, "Restored fee claim overflows uint128");
  for (const [offset, growth, fee] of [[2n, nftState[8], fees[0]], [3n, nftState[9], fees[1]]] as const) {
    await fork.rpc("anvil_setStorageAt", [NONFUNGIBLE_POSITION_MANAGER, slotAt(nftBase, offset), toHex(priorGrowthForFee(growth, liquidity, fee), { size: 32 })]);
  }
  await fork.rpc("anvil_setStorageAt", [POOL, slotAt(coreBase, 3n), toHex(core[3] + fees[0] + ((core[4] + fees[1]) << 128n), { size: 32 })]);
  for (const [token, fee] of [[USDG, fees[0]], [NVDA, fees[1]]] as const) {
    if (fee > 0n) await fixtureSend(context, donor, token, encodeFunctionData({ abi: paperTokenAbi, functionName: "transfer", args: [POOL, fee] }));
  }
  const setupBalances = await balances();
  for (const [token, current, target] of [[USDG, setupBalances.quote, inventory.idle0], [NVDA, setupBalances.rwa, inventory.idle1]] as const) {
    const difference = BigInt(target) - BigInt(current);
    if (difference !== 0n) await fixtureSend(context, difference > 0n ? donor : PAPER_ACCOUNT, token,
      encodeFunctionData({ abi: paperTokenAbi, functionName: "transfer", args: [difference > 0n ? PAPER_ACCOUNT : donor, difference > 0n ? difference : -difference] }));
  }
  assert.equal(inventory.allowances.length, 4, "Incomplete paper allowance ledger");
  const allowanceKeys = new Set<string>();
  for (const item of inventory.allowances) {
    assert([USDG, NVDA].some(t => t.toLowerCase() === item.token.toLowerCase()) &&
      [PAPER_ROUTER, NONFUNGIBLE_POSITION_MANAGER].some(s => s.toLowerCase() === item.spender.toLowerCase()), "Unexpected paper allowance");
    allowanceKeys.add(`${item.token.toLowerCase()}:${item.spender.toLowerCase()}`);
    await fixtureSend(context, PAPER_ACCOUNT, item.token, encodeFunctionData({ abi: paperTokenAbi, functionName: "approve", args: [item.spender, BigInt(item.amount)] }));
  }
  assert.equal(allowanceKeys.size, 4, "Duplicate paper allowance ledger entry");
  const nativeBalance = BigInt(inventory.nativeBalanceWei ?? "1000000000000000000");
  assert(nativeBalance > 0n && nativeBalance <= 10n ** 18n, "Invalid remaining paper gas balance");
  await fork.rpc("anvil_setBalance", [PAPER_ACCOUNT, toHex(nativeBalance)]);
  const before = await balances();
  assert.equal(before.quote, inventory.idle0); assert.equal(before.rwa, inventory.idle1);
  const exit = buildCanaryExit({ operator: PAPER_ACCOUNT, owner: PAPER_ACCOUNT, tokenId,
    source: { rwaSymbol: "NVDA", rwaAddress: NVDA, fee: 500, token0: USDG, token1: NVDA }, position,
    sqrtPriceX96: sourceSlot[0], blockTimestamp: fork.source.timestamp, slippageBps: policy.maxSlippageBps, ttlSeconds: policy.transactionTtlSeconds });
  const tx = await send("decrease_and_collect", NONFUNGIBLE_POSITION_MANAGER, exit.calldata);
  const released = decodeCanaryExit(tx.returnData);
  assert.equal(released.decreased0, principal.amount0); assert.equal(released.decreased1, principal.amount1);
  assert.equal(released.collected0 - released.decreased0, fees[0]);
  assert.equal(released.collected1 - released.decreased1, fees[1]);
  const afterCollect = await balances();
  assert.equal(BigInt(afterCollect.quote) - BigInt(before.quote), released.collected0);
  assert.equal(BigInt(afterCollect.rwa) - BigInt(before.rwa), released.collected1);
  let exitSwap = null;
  if (BigInt(afterCollect.rwa) > 0n) {
    const quoted = await quoteSwap(NVDA, USDG, BigInt(afterCollect.rwa));
    await approve(NVDA, PAPER_ROUTER, BigInt(afterCollect.rwa), "approve_exit_swap");
    exitSwap = await swap("sell_nvda", NVDA, USDG, quoted);
  }
  for (const item of inventory.allowances) {
    const amount = await local.readContract({ address: item.token, abi: paperTokenAbi, functionName: "allowance", args: [PAPER_ACCOUNT, item.spender] });
    if (amount > 0n) await send("revoke_exit_allowance", item.token, encodeFunctionData({ abi: paperTokenAbi, functionName: "approve", args: [item.spender, 0n] }));
    assert.equal(await local.readContract({ address: item.token, abi: paperTokenAbi, functionName: "allowance", args: [PAPER_ACCOUNT, item.spender] }), 0n);
  }
  const afterExit = await balances();
  assert.equal(afterExit.rwa, "0");
  assert.equal(BigInt(afterExit.quote) - BigInt(afterCollect.quote), BigInt(exitSwap?.actualOut ?? "0"));
  const final = await readCanaryPosition(local, tokenId, await local.getBlockNumber({ cacheTime: 0 }));
  assert(final.liquidity === 0n && final.tokensOwed0 === 0n && final.tokensOwed1 === 0n);
  const localGas = transactions.reduce((sum, entry) => sum + BigInt(entry.localGasUsed) * BigInt(entry.localEffectiveGasPriceWei), 0n);
  assert.equal(BigInt(before.native) - BigInt(afterExit.native), localGas);
  const block = await fork.read("eth_getBlockByNumber", [fork.blockTag, false]) as { hash: Hash };
  assert.equal(block.hash.toLowerCase(), fork.source.hash.toLowerCase());
  return { schemaVersion: 1, scope: "paper_restored_position_exit" as const, executionEligible: false as const,
    broadcastAuthorized: false as const, computedAt: new Date().toISOString(),
    source: { block: String(fork.source.number), hash: fork.source.hash, timestamp: String(fork.source.timestamp) },
    policy, inventory, restoredTokenId: String(tokenId), restoredLiquidity: String(liquidity),
    storageProof: { nftBase: String(nftBase), coreBase: String(coreBase) },
    balances: { before, afterCollect, afterExit }, exitSwap, transactions, upstream: fork.budget,
    totalGasWei: String(transactions.reduce((sum, entry) => sum + BigInt(entry.estimate.totalFeeWei), 0n)),
    limitations: ["NFT, idle balances and allowances restored on the local fork only",
      "Fee inputs remain estimates from observed fee growth; restoring them does not turn them into realized mainnet income",
      "Gas and token proceeds are simulations at the source block; no intervening third-party transactions"],
  };
}
export type PaperExitSimulation = Awaited<ReturnType<typeof simulatePaperExit>>;
