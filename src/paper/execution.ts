import assert from "node:assert/strict";
import { decodeFunctionResult, encodeFunctionData, keccak256, type Address, type Hash, type Hex } from "viem";
import { factoryAbi, poolAbi } from "../abi.js";
import { createRobinhoodClient } from "../client.js";
import { NONFUNGIBLE_POSITION_MANAGER, UNISWAP_V3_FACTORY, USDG } from "../constants.js";
import { guardedCanaryPositionManagerAbi } from "../canary-plan/abi.js";
import { buildCanaryExit, decodeCanaryExit, readCanaryPosition } from "../canary-plan/exit.js";
import { centeredRange, quoteValue, sizeLiquidityForQuoteBudget } from "../simulator/math.js";
import { PAPER_NVDA, PAPER_POOL, paperEntryRange } from "./engine.js";
import { PAPER_ACCOUNT, PAPER_ROUTER, PAPER_ROUTER_CODE_HASH, PAPER_QUOTER, paperTokenAbi, paperRouterAbi, paperQuoterAbi } from "./execution-abi.js";
import { localReceipt, simulatePaperTransaction, type PaperTransaction } from "./execution-gas.js";
import type { PaperFork } from "./fork.js";
import { sanitizeRiskError } from "../risk/evaluate.js";

export interface PaperExecutionPolicy {
  budgetQuote: string;
  halfWidthSpacings: number;
  maxLiquiditySharePpm: number;
  maxSlippageBps: number;
  transactionTtlSeconds: number;
  lpAllocationPpm?: number;
  feeAccounting?: "initialized_boundaries_v1";
  recenter?: {readonly kind:'outside_range_v1';readonly maxQuoteAgeSeconds:90};
}
const NVDA = PAPER_NVDA as Address;
const POOL = PAPER_POOL as Address;
const nativeFixture = 10n ** 18n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const decimal = (value: bigint) => String(value);
const totalGas = (transactions: readonly PaperTransaction[]) => transactions.reduce((sum, tx) => sum + BigInt(tx.estimate.totalFeeWei), 0n);

export async function createPaperExecutionContext(fork: PaperFork, policy: PaperExecutionPolicy, onTransaction?: (tx: PaperTransaction) => void) {
  assert(BigInt(policy.budgetQuote) > 0n && BigInt(policy.budgetQuote) <= 10_000_000_000n, "Paper token budget must be in (0, 10000] USDG");
  assert(Number.isSafeInteger(policy.maxSlippageBps) && policy.maxSlippageBps >= 1 && policy.maxSlippageBps <= 500, "Invalid paper slippage limit");
  assert(Number.isSafeInteger(policy.transactionTtlSeconds) && policy.transactionTtlSeconds >= 60 && policy.transactionTtlSeconds <= 1800, "Invalid paper transaction deadline");
  assert(Number.isSafeInteger(policy.maxLiquiditySharePpm) && policy.maxLiquiditySharePpm > 0 &&
    policy.maxLiquiditySharePpm <= (policy.recenter?.kind==='outside_range_v1'?20000:10000), "Invalid paper liquidity share cap");
  const local = createRobinhoodClient(fork.localUrl, 60_000, { retryCount: 0 });
  const transactions: PaperTransaction[] = [];
  async function send(action: string, to: Address, calldata: Hex) {
    let result: PaperTransaction;
    try { result = await simulatePaperTransaction(fork, { action, to, calldata }); }
    catch (error) { throw new Error(`${action}: ${sanitizeRiskError(error)}`); }
    transactions.push(result);
    onTransaction?.(result);
    return result;
  }
  async function balances() {
    const [quote, rwa, native] = await Promise.all([
      local.readContract({ address: USDG, abi: paperTokenAbi, functionName: "balanceOf", args: [PAPER_ACCOUNT] }),
      local.readContract({ address: NVDA, abi: paperTokenAbi, functionName: "balanceOf", args: [PAPER_ACCOUNT] }),
      local.getBalance({ address: PAPER_ACCOUNT }),
    ]);
    return { quote: decimal(quote), rwa: decimal(rwa), native: decimal(native) };
  }
  async function approve(token: Address, spender: Address, amount: bigint, action: string) {
    const allowance = await local.readContract({ address: token, abi: paperTokenAbi, functionName: "allowance", args: [PAPER_ACCOUNT, spender] });
    if (allowance >= amount) return;
    await send(action, token, encodeFunctionData({ abi: paperTokenAbi, functionName: "approve", args: [spender, amount] }));
  }
  async function quoteSwap(tokenIn: Address, tokenOut: Address, amountIn: bigint) {
    const result = await local.simulateContract({ address: PAPER_QUOTER, abi: paperQuoterAbi, functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, fee: 500, amountIn, sqrtPriceLimitX96: 0n }] });
    assert(result.result[0] > 0n, "Paper swap has no output");
    return { amountIn: decimal(amountIn), amountOut: decimal(result.result[0]), sqrtPriceAfter: decimal(result.result[1]), ticksCrossed: result.result[2] };
  }
  async function swap(action: string, tokenIn: Address, tokenOut: Address, quoted: Awaited<ReturnType<typeof quoteSwap>>, frozenMinimum?: string) {
    const freshMinimum = BigInt(quoted.amountOut) * (10000n - BigInt(policy.maxSlippageBps)) / 10000n;
    const amountOutMinimum = frozenMinimum && BigInt(frozenMinimum) > freshMinimum ? BigInt(frozenMinimum) : freshMinimum;
    assert(amountOutMinimum > 0n, "Paper minimum swap output rounds to zero");
    const deadline = fork.source.timestamp + BigInt(policy.transactionTtlSeconds);
    const call = encodeFunctionData({ abi: paperRouterAbi, functionName: "exactInputSingle", args: [{
      tokenIn, tokenOut, fee: 500, recipient: PAPER_ACCOUNT, amountIn: BigInt(quoted.amountIn), amountOutMinimum, sqrtPriceLimitX96: 0n,
    }] });
    const tx = await send(action, PAPER_ROUTER, encodeFunctionData({ abi: paperRouterAbi, functionName: "multicall", args: [deadline, [call]] }));
    const calls = decodeFunctionResult({ abi: paperRouterAbi, functionName: "multicall", data: tx.returnData });
    assert.equal(calls.length, 1);
    const actual = decodeFunctionResult({ abi: paperRouterAbi, functionName: "exactInputSingle", data: calls[0]! });
    assert.equal(actual, BigInt(quoted.amountOut), "Quoter and router amounts differ on the same state");
    return { ...quoted, actualOut: decimal(actual), amountOutMinimum: decimal(amountOutMinimum) };
  }
  const routerCode = await local.getBytecode({ address: PAPER_ROUTER });
  assert(routerCode && keccak256(routerCode) === PAPER_ROUTER_CODE_HASH, "Unverified paper router runtime");
  const [factoryPool, routerFactory, quoterFactory, managerFactory, quoteDecimals, rwaDecimals, token0, token1, fee, spacing] = await Promise.all([
    local.readContract({ address: UNISWAP_V3_FACTORY, abi: factoryAbi, functionName: "getPool", args: [USDG, NVDA, 500] }),
    local.readContract({ address: PAPER_ROUTER, abi: paperRouterAbi, functionName: "factory" }),
    local.readContract({ address: PAPER_QUOTER, abi: paperQuoterAbi, functionName: "factory" }),
    local.readContract({ address: NONFUNGIBLE_POSITION_MANAGER, abi: guardedCanaryPositionManagerAbi, functionName: "factory" }),
    local.readContract({ address: USDG, abi: paperTokenAbi, functionName: "decimals" }),
    local.readContract({ address: NVDA, abi: paperTokenAbi, functionName: "decimals" }),
    local.readContract({ address: POOL, abi: poolAbi, functionName: "token0" }),
    local.readContract({ address: POOL, abi: poolAbi, functionName: "token1" }),
    local.readContract({ address: POOL, abi: poolAbi, functionName: "fee" }),
    local.readContract({ address: POOL, abi: poolAbi, functionName: "tickSpacing" }),
  ]);
  assert(same(factoryPool, POOL) && [routerFactory, quoterFactory, managerFactory].every(f => same(f, UNISWAP_V3_FACTORY)), "Paper deployment/factory mismatch");
  assert(same(token0, USDG) && same(token1, NVDA) && quoteDecimals === 6 && rwaDecimals === 18 && fee === 500 && spacing === 10, "Paper pool/token identity mismatch");
  const sourceSlot = await local.readContract({ address: POOL, abi: poolAbi, functionName: "slot0" });
  assert(sourceSlot[6], "Paper pool is locked");
  return { fork, policy, local, transactions, send, balances, approve, quoteSwap, swap, sourceSlot };
}
export type PaperExecutionContext = Awaited<ReturnType<typeof createPaperExecutionContext>>;

export async function fixtureSend(context: PaperExecutionContext, from: Address, to: Address, data: Hex) {
  const hash = await context.fork.rpc<Hash>("eth_sendTransaction", [{ from, to, data, gas: "0x7a1200" }]);
  assert.equal((await localReceipt(context.fork, hash)).status, "0x1", "Paper state restoration failed");
}

export async function fundPaperFixture(context: PaperExecutionContext, amounts: { quote: bigint; rwa: bigint }) {
  const { local, fork, balances } = context;
  const empty = await balances();
  assert(empty.quote === "0" && empty.rwa === "0" && empty.native === "0", "Paper fixture account is not empty on the source chain");
  const donor = await local.readContract({ address: UNISWAP_V3_FACTORY, abi: factoryAbi, functionName: "getPool", args: [USDG, NVDA, 3000] });
  assert(!same(donor, POOL) && !/^0x0{40}$/iu.test(donor), "No separate fixture donor");
  await fork.rpc("anvil_impersonateAccount", [donor]);
  await fork.rpc("anvil_impersonateAccount", [PAPER_ACCOUNT]);
  await fork.rpc("anvil_setBalance", [donor, `0x${nativeFixture.toString(16)}`]);
  await fork.rpc("anvil_setBalance", [PAPER_ACCOUNT, `0x${nativeFixture.toString(16)}`]);
  for (const [token, amount] of [[USDG, amounts.quote], [NVDA, amounts.rwa]] as const) {
    if (amount > 0n) await fixtureSend(context, donor, token, encodeFunctionData({ abi: paperTokenAbi, functionName: "transfer", args: [PAPER_ACCOUNT, amount] }));
  }
  return donor;
}

export async function simulatePaperRoundTrip(fork: PaperFork, policy: PaperExecutionPolicy, onTransaction?: (tx: PaperTransaction) => void,
  intent?: { tickLower: number; tickUpper: number; swapAmountQuote: string; minRwaOut: string }) {
  const context = await createPaperExecutionContext(fork, policy, onTransaction);
  const { local, transactions, send, balances, approve, quoteSwap, swap, sourceSlot } = context;
  const range = intent ? { tickLower: intent.tickLower, tickUpper: intent.tickUpper }
    : paperEntryRange({tick:sourceSlot[1],sqrtPriceX96:String(sourceSlot[0])},policy);
  const lpBudget = BigInt(policy.budgetQuote)*BigInt(policy.lpAllocationPpm??1000000)/1000000n;
  const reserve = BigInt(policy.budgetQuote)-lpBudget;
  const sized = sizeLiquidityForQuoteBudget({ budgetQuote: lpBudget, quoteToken: USDG, token0: USDG, token1: NVDA,
    sqrtPriceX96: sourceSlot[0], ...range });
  const swapAmount = intent ? BigInt(intent.swapAmountQuote) : lpBudget - sized.amount0 - sized.idleQuote;
  assert(swapAmount > 0n && swapAmount < BigInt(policy.budgetQuote), "Paper entry needs both token sides");
  const quotedEntry = await quoteSwap(USDG, NVDA, swapAmount);
  if (intent) assert(BigInt(quotedEntry.amountOut) >= BigInt(intent.minRwaOut), "Entry quote exceeds the previously recorded slippage limit");
  await fundPaperFixture(context, { quote: BigInt(policy.budgetQuote), rwa: 0n });
  const before = await balances();
  assert.equal(before.quote, policy.budgetQuote); assert.equal(before.rwa, "0");
  await approve(USDG, PAPER_ROUTER, swapAmount, "approve_entry_swap");
  const entrySwap = await swap("buy_nvda", USDG, NVDA, quotedEntry, intent?.minRwaOut);
  const inventory = await balances();
  assert.equal(BigInt(before.quote) - BigInt(inventory.quote), swapAmount);
  assert.equal(inventory.rwa, entrySwap.actualOut);
  await approve(USDG, NONFUNGIBLE_POSITION_MANAGER, BigInt(inventory.quote), "approve_mint_usdg");
  await approve(NVDA, NONFUNGIBLE_POSITION_MANAGER, BigInt(inventory.rwa), "approve_mint_nvda");
  const beforeMintSlot = await local.readContract({ address: POOL, abi: poolAbi, functionName: "slot0" });
  assert(beforeMintSlot[1] >= range.tickLower && beforeMintSlot[1] < range.tickUpper, "Entry swap left the fixed LP range");
  const poolLiquidity = await local.readContract({ address: POOL, abi: poolAbi, functionName: "liquidity" });
  const params = { token0: USDG, token1: NVDA, fee: 500, ...range,
    amount0Desired: BigInt(inventory.quote)-reserve, amount1Desired: BigInt(inventory.rwa), amount0Min: 0n, amount1Min: 0n,
    recipient: PAPER_ACCOUNT, deadline: fork.source.timestamp + BigInt(policy.transactionTtlSeconds) };
  const preview = await local.simulateContract({ account: PAPER_ACCOUNT, address: NONFUNGIBLE_POSITION_MANAGER,
    abi: guardedCanaryPositionManagerAbi, functionName: "mint", args: [params] });
  assert(preview.result[1] > 0n && preview.result[1] * 1_000_000n <= poolLiquidity * BigInt(policy.maxLiquiditySharePpm), "Paper mint exceeds active liquidity share cap");
  params.amount0Min = preview.result[2] * (10000n - BigInt(policy.maxSlippageBps)) / 10000n;
  params.amount1Min = preview.result[3] * (10000n - BigInt(policy.maxSlippageBps)) / 10000n;
  const mint = await send("mint", NONFUNGIBLE_POSITION_MANAGER, encodeFunctionData({ abi: guardedCanaryPositionManagerAbi, functionName: "mint", args: [params] }));
  const [tokenId, liquidity, amount0, amount1] = decodeFunctionResult({ abi: guardedCanaryPositionManagerAbi, functionName: "mint", data: mint.returnData });
  const afterMint = await balances();
  assert(BigInt(afterMint.quote)>=reserve,"Paper mint spent reserved USDG");
  assert.equal(BigInt(inventory.quote) - BigInt(afterMint.quote), amount0);
  assert.equal(BigInt(inventory.rwa) - BigInt(afterMint.rwa), amount1);
  const position = await readCanaryPosition(local, tokenId, await local.getBlockNumber({ cacheTime: 0 }));
  assert.equal(position.liquidity, liquidity); assert(same(position.owner, PAPER_ACCOUNT));
  const allowances: { token: Address; spender: Address; amount: string }[] = [];
  for (const token of [USDG, NVDA]) for (const spender of [PAPER_ROUTER, NONFUNGIBLE_POSITION_MANAGER]) {
    allowances.push({ token, spender, amount: decimal(await local.readContract({ address: token, abi: paperTokenAbi, functionName: "allowance", args: [PAPER_ACCOUNT, spender] })) });
  }
  const entryTransactions = transactions.length;
  const exit = buildCanaryExit({ operator: PAPER_ACCOUNT, owner: PAPER_ACCOUNT, tokenId,
    source: { rwaSymbol: "NVDA", rwaAddress: NVDA, fee: 500, token0: USDG, token1: NVDA }, position,
    sqrtPriceX96: beforeMintSlot[0], blockTimestamp: fork.source.timestamp,
    slippageBps: policy.maxSlippageBps, ttlSeconds: policy.transactionTtlSeconds });
  const exited = await send("decrease_and_collect", NONFUNGIBLE_POSITION_MANAGER, exit.calldata);
  const released = decodeCanaryExit(exited.returnData);
  const afterCollect = await balances();
  assert.equal(BigInt(afterCollect.quote) - BigInt(afterMint.quote), released.collected0);
  assert.equal(BigInt(afterCollect.rwa) - BigInt(afterMint.rwa), released.collected1);
  const quotedExit = await quoteSwap(NVDA, USDG, BigInt(afterCollect.rwa));
  await approve(NVDA, PAPER_ROUTER, BigInt(afterCollect.rwa), "approve_exit_swap");
  const exitSwap = await swap("sell_nvda", NVDA, USDG, quotedExit);
  for (const token of [USDG, NVDA]) for (const spender of [PAPER_ROUTER, NONFUNGIBLE_POSITION_MANAGER]) {
    const allowance = await local.readContract({ address: token, abi: paperTokenAbi, functionName: "allowance", args: [PAPER_ACCOUNT, spender] });
    if (allowance !== 0n) await send(`revoke_${same(token, USDG) ? "usdg" : "nvda"}_${same(spender, PAPER_ROUTER) ? "router" : "manager"}`, token,
      encodeFunctionData({ abi: paperTokenAbi, functionName: "approve", args: [spender, 0n] }));
    assert.equal(await local.readContract({ address: token, abi: paperTokenAbi, functionName: "allowance", args: [PAPER_ACCOUNT, spender] }), 0n);
  }
  const afterExit = await balances();
  assert.equal(afterExit.rwa, "0");
  assert.equal(BigInt(afterExit.quote) - BigInt(afterCollect.quote), BigInt(exitSwap.actualOut));
  const finalPosition = await readCanaryPosition(local, tokenId, await local.getBlockNumber({ cacheTime: 0 }));
  assert(finalPosition.liquidity === 0n && finalPosition.tokensOwed0 === 0n && finalPosition.tokensOwed1 === 0n, "Incomplete paper LP exit");
  const localGasWei = transactions.reduce((sum, tx) => sum + BigInt(tx.localGasUsed) * BigInt(tx.localEffectiveGasPriceWei), 0n);
  assert.equal(BigInt(before.native) - BigInt(afterExit.native), localGasWei, "Local native balance does not reconcile to operator receipts");
  const terminal = await fork.read("eth_getBlockByNumber", [fork.blockTag, false]) as { hash: string };
  assert(same(terminal.hash, fork.source.hash), "Paper source reorged during simulation");
  return {
    schemaVersion: 1, scope: "paper_cash_swap_mint_exit_cash" as const,
    executionEligible: false as const, broadcastAuthorized: false as const,
    computedAt: new Date().toISOString(), source: { block: decimal(fork.source.number), hash: fork.source.hash, timestamp: decimal(fork.source.timestamp) },
    policy, pool: POOL, router: PAPER_ROUTER, routerCodeHash: PAPER_ROUTER_CODE_HASH, account: PAPER_ACCOUNT,
    range, entrySwap, exitSwap, tokenId: decimal(tokenId), liquidity: decimal(liquidity), allowances,
    minted0: decimal(amount0), minted1: decimal(amount1), balances: { before, inventory, afterMint, afterCollect, afterExit },
    entryGasWei: decimal(totalGas(transactions.slice(0, entryTransactions))),
    exitGasWei: decimal(totalGas(transactions.slice(entryTransactions))), totalGasWei: decimal(totalGas(transactions)),
    localGasWei: decimal(localGasWei), cashDeltaQuote: decimal(BigInt(afterExit.quote) - BigInt(before.quote)),
    entryInventoryMarkQuote: decimal(quoteValue({ amount0: BigInt(inventory.quote), amount1: BigInt(inventory.rwa), token0: USDG, token1: NVDA, quoteToken: USDG, sqrtPriceX96: sourceSlot[0] })),
    transactions, upstream: fork.budget,
    limitations: ["Current-state local round trip; no forward holding interval or LP fee-income result",
      "Gas uses pinned Nitro estimates with paper account state, not mainnet receipts",
      "1 ETH is local gas fixture funding; token budget and native gas charges are separate",
      "No intervening third-party transactions within the simulated sequence"],
  };
}
export type PaperRoundTrip = Awaited<ReturnType<typeof simulatePaperRoundTrip>>;
