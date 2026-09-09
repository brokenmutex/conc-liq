import { createHash } from "node:crypto";
import { subtractUint256 } from "../accounting/math.js";
import { principalAmounts, sqrtRatioAtTick } from "../backtest/principal.js";
import { USDG } from "../constants.js";
import { centeredRange, quoteValue, sizeLiquidityForQuoteBudget, validateTickAndSqrtPrice } from "../simulator/math.js";
import { advanceTransactionPaper } from "./transaction-engine.js";
import type { PaperExecutionInput, PaperExecutionLedger } from "./execution-domain.js";
import type { ContinuousPaperReferencePolicy, PaperReferenceDecision, PaperReferenceEvidence } from "./reference.js";
import type { BoundaryFeeProof } from "./boundary-fees.js";

export const PAPER_POOL = "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3";
export const PAPER_NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
interface PaperStrategy {
  readonly mode: "guarded" | "research";
  readonly budgetQuote: string;
  readonly halfWidthSpacings: number;
  readonly maxHoldingSeconds: number;
  readonly maxSourceAgeSeconds: number;
  readonly maxGapSeconds: number;
  readonly maxLiquiditySharePpm: number;
}
// Retain the old shape only to read/reproduce the first illustrative session.
export interface IllustrativePaperPolicy extends PaperStrategy {
  readonly entryCostQuote: string;
  readonly exitCostQuote: string;
  readonly slippageBps: number;
}
export interface ExecutionPaperPolicy extends PaperStrategy {
  readonly executionBasis: "transaction_simulation";
}
export interface TransactionPaperPolicy extends PaperStrategy {
  readonly executionBasis: "nitro_fork_v1";
  readonly maxSlippageBps: number;
  readonly transactionTtlSeconds: number;
  readonly referencePolicy?: ContinuousPaperReferencePolicy;
  readonly feeAccounting?: "initialized_boundaries_v1";
  readonly lpAllocationPpm?: number;
  readonly inventoryExitPpm?: number;
  readonly reentry?: { readonly cooldownSeconds: number; readonly previousSessionId?: string };
}
export type PaperPolicy = IllustrativePaperPolicy | ExecutionPaperPolicy | TransactionPaperPolicy;
export const DEFAULT_PAPER_POLICY: TransactionPaperPolicy = {
  mode: "guarded", budgetQuote: "1000000000", halfWidthSpacings: 20,
  executionBasis: "nitro_fork_v1", maxSlippageBps: 50, transactionTtlSeconds: 300,
  maxHoldingSeconds: 21_600, maxSourceAgeSeconds: 180, maxGapSeconds: 900,
  maxLiquiditySharePpm: 10_000,
  referencePolicy: { kind: "continuous_bounded_v1", maxHeldAgeSeconds: 345600, maxDeviationPpm: 30000, maxGasPriceAgeSeconds: 86400 },
};
export function paperEntryRange(cp: Pick<PaperCheckpoint,"tick"|"sqrtPriceX96">, policy: {halfWidthSpacings:number;feeAccounting?:string}) {
  if(!policy.feeAccounting)return centeredRange({currentTick:cp.tick,halfWidthSpacings:policy.halfWidthSpacings,tickSpacing:10});
  const base=Math.floor(cp.tick/10)*10,half=policy.halfWidthSpacings*10,price=BigInt(cp.sqrtPriceX96);
  const candidates=[base,base+10].map(center=>({tickLower:center-half,tickUpper:center+half}));
  const distance=(r:typeof candidates[number])=>{const middle=sqrtRatioAtTick(r.tickLower)*sqrtRatioAtTick(r.tickUpper),now=price*price;return middle>now?middle-now:now-middle;};
  return candidates.reduce((best,r)=>distance(r)<distance(best)?r:best);
}
export function policyHash(policy: PaperPolicy): string {
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(policy).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
}
export interface PaperCheckpoint {
  readonly id: string;
  readonly block: string;
  readonly hash: string;
  readonly blockTimestamp: string;
  readonly capturedAt: string;
  readonly tick: number;
  readonly sqrtPriceX96: string;
  readonly liquidity: string;
  readonly feeGrowth0: string;
  readonly feeGrowth1: string;
  readonly targetSetHash: string;
}
export interface PaperInput {
  readonly now: string;
  readonly checkpoint: PaperCheckpoint;
  readonly dataReasons: readonly string[];
  readonly entryReasons: readonly string[];
  readonly chainHealthy: boolean;
  readonly pathMinTick: number;
  readonly pathMaxTick: number;
  readonly swapCount: string;
  readonly execution?: PaperExecutionInput;
  readonly reference?: PaperReferenceDecision | null;
  readonly referenceEvidence?: PaperReferenceEvidence;
  readonly boundaryFees?: BoundaryFeeProof;
  readonly boundaryContinuity?: boolean;
}
export interface PaperPosition {
  liquidity: string; tickLower: number; tickUpper: number;
  idle0: string; idle1: string; fee0: string; fee1: string;
  hold0: string; hold1: string; enteredAt: string;
  boundaryFees?: BoundaryFeeProof;
  feeRemainder0?: string; feeRemainder1?: string;
}
export interface PaperState {
  status: "waiting" | "entry_pending" | "open" | "exit_pending" | "closed" | "invalid";
  action: "wait" | "signal_entry" | "enter" | "mark" | "signal_exit" | "exit" | "invalidate";
  reasons: readonly string[];
  last: PaperCheckpoint | null;
  position: PaperPosition | null;
  navQuote: string | null;
  holdQuote: string | null;
  pnlQuote: string | null;
  alphaQuote: string | null;
  feeValueQuote: string | null;
  costsPaidQuote: string;
  exitReserveQuote: string;
  peakNavQuote: string;
  maxDrawdownPpm: string;
  intervals: number;
  observedSwaps: string;
  invalidatedAt: string | null;
  pendingSince: string | null;
  entryRange: { tickLower: number; tickUpper: number } | null;
  execution?: PaperExecutionLedger;
  reference?: PaperReferenceDecision | null;
  referenceEvidence?: PaperReferenceEvidence;
  reentryStoppedAt?: string;
}
export function initialPaperState(): PaperState {
  return { status: "waiting", action: "wait", reasons: [], last: null, position: null,
    navQuote: null, holdQuote: null, pnlQuote: null, alphaQuote: null, feeValueQuote: null,
    costsPaidQuote: "0", exitReserveQuote: "0", peakNavQuote: "0", maxDrawdownPpm: "0",
    intervals: 0, observedSwaps: "0", invalidatedAt: null, pendingSince: null, entryRange: null };
}
export function invalidatePaper(state: PaperState, now: string, reasons: readonly string[]): PaperState {
  return { ...state, status: "invalid", action: "invalidate", reasons,
    navQuote: null, holdQuote: null, pnlQuote: null, alphaQuote: null, feeValueQuote: null,
    invalidatedAt: now };
}
function value(amount0: bigint, amount1: bigint, checkpoint: PaperCheckpoint): bigint {
  return quoteValue({ amount0, amount1, token0: USDG, token1: PAPER_NVDA,
    quoteToken: USDG, sqrtPriceX96: BigInt(checkpoint.sqrtPriceX96) });
}
function age(then: string, now: string): number {
  return (Date.parse(now) - Date.parse(then)) / 1000;
}
export function advancePaper(previous: PaperState, policy: PaperPolicy, input: PaperInput): PaperState {
  if (previous.status === "closed" || previous.status === "invalid") return previous;
  const cp = input.checkpoint;
  const last = previous.last;
  if (last && BigInt(cp.block) <= BigInt(last.block)) throw new Error("Paper checkpoints must advance strictly");
  const state = structuredClone(previous);
  state.action = "wait";
  state.entryRange ??= null;
  const dataReasons = [...input.dataReasons];
  if (last && last.targetSetHash !== cp.targetSetHash) dataReasons.push("target_set_changed");
  if (dataReasons.length) return previous.position
    ? invalidatePaper(previous, input.now, dataReasons)
    : { ...state, status: "waiting", last: cp, reasons: dataReasons };
  validateTickAndSqrtPrice({ tick: cp.tick, sqrtPriceX96: BigInt(cp.sqrtPriceX96) });
  const stale = [cp.capturedAt, cp.blockTimestamp].some(at => !Number.isFinite(age(at, input.now)) || age(at, input.now) < 0 || age(at, input.now) > policy.maxSourceAgeSeconds);
  // A delayed worker cannot retroactively fill orders or overlook missed exit decisions.
  if (stale) return previous.position
    ? invalidatePaper(previous, input.now, ["source_stale_or_worker_missed_decision"])
    : { ...state, status: "waiting", last: cp, reasons: ["source_stale"] };
  const gates = [...input.entryReasons];
  if (!input.chainHealthy) gates.push("chain_recovery_unproven");
  if (BigInt(cp.liquidity) <= 0n) gates.push("pool_liquidity_zero");
  state.reasons = [...new Set(gates)];
  state.last = cp;
  state.reference = input.reference ?? state.reference;
  if (input.referenceEvidence) state.referenceEvidence = structuredClone(input.referenceEvidence);
  if ("executionBasis" in policy && policy.executionBasis === "nitro_fork_v1") {
    return advanceTransactionPaper(previous, state, policy, input);
  }
  if ("executionBasis" in policy) {
    // The DB checkpoint runner cannot produce transaction-specific gas, swaps,
    // or exit proceeds. Never silently fall back to the illustrative v1 fill.
    // A fresh execution simulator must supply that evidence before this path
    // can open a paper position. Historical receipt averages are not fills.
    const reasons = [...state.reasons, "paper_transaction_simulation_unavailable"];
    if (state.position) return invalidatePaper(previous, input.now, reasons);
    return { ...state, status: "waiting", reasons, pendingSince: null, entryRange: null,
      navQuote: null, holdQuote: null, pnlQuote: null, alphaQuote: null, feeValueQuote: null };
  }
  if (!state.position) {
    if (!input.chainHealthy || (policy.mode === "guarded" && gates.length)) {
      state.status = "waiting";
      return state;
    }
    if (previous.status !== "entry_pending") {
      state.status = "entry_pending"; state.action = "signal_entry"; state.pendingSince = input.now;
      state.entryRange = centeredRange({ currentTick: cp.tick, halfWidthSpacings: policy.halfWidthSpacings, tickSpacing: 10 });
      return state;
    }
    if (!state.pendingSince || Date.parse(cp.blockTimestamp) <= Date.parse(state.pendingSince)) return state;
    const range = state.entryRange;
    if (!range || cp.tick < range.tickLower || cp.tick >= range.tickUpper) {
      state.status = "waiting"; state.pendingSince = null; state.entryRange = null;
      state.reasons = [...state.reasons, "entry_range_no_longer_contains_price"];
      return state;
    }
    const entryCost = BigInt(policy.entryCostQuote) + BigInt(policy.budgetQuote) * BigInt(policy.slippageBps) / 10_000n;
    // Cash is retained to pay the modeled exit. It is not deployed twice.
    const exitCost = BigInt(policy.exitCostQuote);
    const sized = sizeLiquidityForQuoteBudget({ budgetQuote: BigInt(policy.budgetQuote) - entryCost - exitCost,
      ...range,
      quoteToken: USDG, token0: USDG, token1: PAPER_NVDA, sqrtPriceX96: BigInt(cp.sqrtPriceX96) });
    if (sized.liquidity <= 0n || sized.liquidity * 1_000_000n > BigInt(cp.liquidity) * BigInt(policy.maxLiquiditySharePpm)) {
      state.status = "waiting"; state.reasons = [...state.reasons, "paper_size_exceeds_pool_share_or_is_zero"]; return state;
    }
    state.position = { ...range,
      liquidity: String(sized.liquidity), idle0: String(sized.idleQuote + exitCost), idle1: "0",
      fee0: "0", fee1: "0", hold0: String(sized.amount0 + sized.idleQuote + exitCost), hold1: String(sized.amount1), enteredAt: input.now };
    state.costsPaidQuote = String(entryCost); state.exitReserveQuote = String(exitCost);
    state.status = "open"; state.action = "enter"; state.pendingSince = null;
  } else {
    if (!last) throw new Error("Open paper position has no source checkpoint");
    if (age(last.blockTimestamp, cp.blockTimestamp) > policy.maxGapSeconds || !Number.isFinite(age(last.blockTimestamp, cp.blockTimestamp)) || age(last.blockTimestamp, cp.blockTimestamp) <= 0) {
      return invalidatePaper(previous, input.now, ["checkpoint_gap_prevents_forward_decision_proof"]);
    }
    const p = state.position;
    if (input.pathMinTick > Math.min(last.tick, cp.tick) || input.pathMaxTick < Math.max(last.tick, cp.tick)) throw new Error("Paper path omits an endpoint");
    if (input.pathMinTick < p.tickLower || input.pathMaxTick >= p.tickUpper) return invalidatePaper(previous, input.now, ["range_crossed_fee_coverage_incomplete"]);
    const delta0 = subtractUint256(BigInt(cp.feeGrowth0), BigInt(last.feeGrowth0));
    const delta1 = subtractUint256(BigInt(cp.feeGrowth1), BigInt(last.feeGrowth1));
    if (BigInt(input.swapCount) === 0n && (cp.sqrtPriceX96 !== last.sqrtPriceX96)) return invalidatePaper(previous, input.now, ["fee_or_price_change_without_swap_coverage"]);
    // Canonical observed growth is a zero-impact estimate for this hypothetical LP.
    p.fee0 = String(BigInt(p.fee0) + delta0 * BigInt(p.liquidity) / (1n << 128n));
    p.fee1 = String(BigInt(p.fee1) + delta1 * BigInt(p.liquidity) / (1n << 128n));
    state.intervals += 1;
    state.observedSwaps = String(BigInt(state.observedSwaps) + BigInt(input.swapCount));
    state.action = "mark";
    if (previous.status === "exit_pending" && input.chainHealthy && state.pendingSince !== null && Date.parse(cp.blockTimestamp) > Date.parse(state.pendingSince)) {
      state.status = "closed"; state.action = "exit"; state.pendingSince = null;
      const released = principalAmounts({ liquidity: BigInt(p.liquidity), tickLower: p.tickLower, tickUpper: p.tickUpper, sqrtPriceX96: BigInt(cp.sqrtPriceX96) });
      p.idle0 = String(BigInt(p.idle0) + released.amount0 - BigInt(policy.exitCostQuote));
      p.idle1 = String(BigInt(p.idle1) + released.amount1);
      p.liquidity = "0";
      state.costsPaidQuote = String(BigInt(state.costsPaidQuote) + BigInt(policy.exitCostQuote));
      state.exitReserveQuote = "0";
    } else if (previous.status === "exit_pending" || age(p.enteredAt, input.now) >= policy.maxHoldingSeconds || (policy.mode === "guarded" && gates.some(reason => reason !== "checkpoint_not_latest_risk_snapshot"))) {
      state.status = "exit_pending"; state.action = "signal_exit"; state.pendingSince ??= input.now;
    }
  }
  const p = state.position!;
  const principal = principalAmounts({ liquidity: BigInt(p.liquidity), tickLower: p.tickLower, tickUpper: p.tickUpper, sqrtPriceX96: BigInt(cp.sqrtPriceX96) });
  const nav = value(principal.amount0 + BigInt(p.idle0) + BigInt(p.fee0), principal.amount1 + BigInt(p.idle1) + BigInt(p.fee1), cp) - BigInt(state.exitReserveQuote);
  const hold = value(BigInt(p.hold0), BigInt(p.hold1), cp);
  state.navQuote = String(nav); state.holdQuote = String(hold);
  state.pnlQuote = String(nav - BigInt(policy.budgetQuote)); state.alphaQuote = String(nav - hold);
  state.feeValueQuote = String(value(BigInt(p.fee0), BigInt(p.fee1), cp));
  const previousPeak = previous.position ? BigInt(state.peakNavQuote) : BigInt(policy.budgetQuote);
  const peak = previousPeak > nav ? previousPeak : nav;
  const drawdown = peak > 0n ? (peak - nav) * 1_000_000n / peak : 0n;
  state.peakNavQuote = String(peak);
  state.maxDrawdownPpm = String(drawdown > BigInt(state.maxDrawdownPpm) ? drawdown : BigInt(state.maxDrawdownPpm));
  return state;
}
