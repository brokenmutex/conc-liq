import assert from "node:assert/strict";
import { subtractUint256 } from "../accounting/math.js";
import { principalAmounts } from "../backtest/principal.js";
import { convertWeiToQuoteRaw } from "../action-cost/valuation.js";
import { USDG } from "../constants.js";
import { quoteValue } from "../simulator/math.js";
import { invalidatePaper, PAPER_NVDA, type PaperInput, type PaperState, type TransactionPaperPolicy } from "./engine.js";
import type { PaperGasValuation } from "./execution-domain.js";
import { boundaryInside, boundaryFeeIncrement } from "./boundary-fees.js";
import { creditDilutedFees,initializeDilutedFees } from './diluted-fees.js';
import { liquidityShare,liquidityShareAllowed } from './liquidity-share.js';
import { advanceRecenter } from './recenter.js';

export function paperGasQuote(feeWei: string, valuation: PaperGasValuation): bigint {
  return convertWeiToQuoteRaw({ feeWei: BigInt(feeWei), quoteDecimals: 6,
    ethUsdAnswer: BigInt(valuation.ethUsdAnswer), ethUsdDecimals: valuation.ethUsdDecimals,
    quoteUsdAnswer: BigInt(valuation.quoteUsdAnswer), quoteUsdDecimals: valuation.quoteUsdDecimals });
}
const seconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;
export function advanceTransactionPaper(previous: PaperState, state: PaperState, policy: TransactionPaperPolicy, input: PaperInput): PaperState {
  const cp = input.checkpoint;
  const value = (amount0: bigint, amount1: bigint) => quoteValue({ amount0, amount1, token0: USDG, token1: PAPER_NVDA, quoteToken: USDG, sqrtPriceX96: BigInt(cp.sqrtPriceX96) });
  const proofMatches = (source: { block: string; hash: string }, valuation: PaperGasValuation) => {
    assert(source.block === cp.block && source.hash.toLowerCase() === cp.hash.toLowerCase(), "Paper execution source differs from accounting checkpoint");
    assert(valuation.sourceBlock === cp.block && valuation.sourceHash.toLowerCase() === cp.hash.toLowerCase(), "Paper gas valuation source mismatch");
  };
  const ledger = state.execution ??= { intent: null, entryRunId: null, exitRunId: null, gasSpentWei: "0", holdGasQuote: "0",
    exitReserveWei: "0", allowances: [], earnedFee0: "0", earnedFee1: "0", lastValuation: null };
  if (state.position && !previous.execution?.entryRunId) return invalidatePaper(previous, input.now, ["paper_entry_execution_evidence_missing"]);
  if (!input.execution?.available) {
    if (state.position) return invalidatePaper(previous, input.now, ["paper_transaction_simulation_unavailable"]);
    return { ...state, status: "waiting", reasons: [...state.reasons, "paper_transaction_simulation_unavailable"] };
  }
  if (!state.position) {
    if (!input.chainHealthy || state.reasons.includes("paper_reentry_cooldown") || state.reasons.includes('paper_off_hours_entry_closed') || (policy.mode === "guarded" && state.reasons.length)) {
      ledger.intent = null; state.pendingSince = null; state.entryRange = null; state.status = "waiting"; return state;
    }
    if (input.execution.error) {
      ledger.intent = null; state.pendingSince = null; state.entryRange = null;
      return { ...state, status: "waiting", reasons: [...state.reasons, "paper_entry_preflight_failed", input.execution.error] };
    }
    if (!ledger.intent || previous.status !== "entry_pending") {
      const quote = input.execution.quote;
      if (!quote) return { ...state, status: "waiting", reasons: [...state.reasons, "paper_entry_quote_required"] };
      assert(quote.sourceBlock === cp.block && quote.sourceHash.toLowerCase() === cp.hash.toLowerCase(), "Paper entry quote source mismatch");
      assert(BigInt(quote.swapAmountQuote) > 0n && BigInt(quote.swapAmountQuote) < BigInt(policy.budgetQuote) && BigInt(quote.minRwaOut) > 0n);
      ledger.intent = quote; state.entryRange = { tickLower: quote.tickLower, tickUpper: quote.tickUpper };
      return { ...state, status: "entry_pending", action: "signal_entry", pendingSince: input.now };
    }
    if (!state.pendingSince || Date.parse(cp.blockTimestamp) <= Date.parse(state.pendingSince)) return state;
    if (seconds(state.pendingSince, input.now) > policy.maxGapSeconds || cp.tick < ledger.intent.tickLower || cp.tick >= ledger.intent.tickUpper) {
      ledger.intent = null; state.pendingSince = null; state.entryRange = null;
      return { ...state, status: "waiting", reasons: [...state.reasons, "paper_entry_intent_expired_or_outside_range"] };
    }
    const fill = input.execution.entry;
    if (!fill) return { ...state, reasons: [...state.reasons, "paper_entry_simulation_required"] };
    proofMatches(fill.result.source, fill.valuation);
    const r = fill.result;
    assert(r.policy.budgetQuote === policy.budgetQuote && r.range.tickLower === ledger.intent.tickLower && r.range.tickUpper === ledger.intent.tickUpper);
    assert(r.entrySwap.amountIn === ledger.intent.swapAmountQuote && BigInt(r.entrySwap.actualOut) >= BigInt(ledger.intent.minRwaOut));
    assert(BigInt(r.liquidity) > 0n && liquidityShareAllowed(BigInt(r.liquidity),BigInt(cp.liquidity),policy));
    assert(BigInt(r.entryGasWei) + BigInt(r.exitGasWei) <= 10n ** 18n, "Paper native gas fixture budget exhausted");
    ledger.entryRunId = fill.runId; ledger.gasSpentWei = r.entryGasWei; ledger.exitReserveWei = r.exitGasWei;
    ledger.allowances = r.allowances; ledger.lastValuation = fill.valuation;
    const buyIndex = r.transactions.findIndex(tx => tx.action === "buy_nvda");
    assert(buyIndex >= 0, "Paper entry has no inventory acquisition");
    ledger.holdGasQuote = String(paperGasQuote(String(r.transactions.slice(0, buyIndex + 1).reduce((sum, tx) => sum + BigInt(tx.estimate.totalFeeWei), 0n)), fill.valuation));
    state.position = { liquidity: r.liquidity, ...r.range, idle0: r.balances.afterMint.quote, idle1: r.balances.afterMint.rwa,
      fee0: "0", fee1: "0", hold0: r.balances.inventory.quote, hold1: r.balances.inventory.rwa, enteredAt: cp.blockTimestamp };
    if(policy.feeAccounting){
      assert(input.boundaryFees,"Paper entry boundary fee proof missing");
      assert(input.boundaryFees.tickLower===r.range.tickLower&&input.boundaryFees.tickUpper===r.range.tickUpper);
      boundaryInside(cp,input.boundaryFees);state.position.boundaryFees=input.boundaryFees;
      state.position.feeRemainder0="0";state.position.feeRemainder1="0";
    }
    if(policy.feeAccounting==='diluted_segments_v1')initializeDilutedFees(state,cp);
    state.costsPaidQuote = String(paperGasQuote(r.entryGasWei, fill.valuation));
    state.exitReserveQuote = String(paperGasQuote(r.exitGasWei, fill.valuation));
    state.status = "open"; state.action = "enter"; state.pendingSince = null;
  } else {
    const last = previous.last;
    assert(last, "Open paper position has no accounting baseline");
    const gap = seconds(last.blockTimestamp, cp.blockTimestamp);
    if (!Number.isFinite(gap) || gap <= 0 || gap > policy.maxGapSeconds) return invalidatePaper(previous, input.now, ["checkpoint_gap_prevents_forward_decision_proof"]);
    const p = state.position;
    assert(input.pathMinTick <= Math.min(last.tick, cp.tick) && input.pathMaxTick >= Math.max(last.tick, cp.tick), "Paper swap path omits an endpoint");
    if (!policy.feeAccounting && (input.pathMinTick < p.tickLower || input.pathMaxTick >= p.tickUpper)) return invalidatePaper(previous, input.now, ["range_crossed_fee_coverage_incomplete"]);
    if (input.swapCount === "0" && cp.sqrtPriceX96 !== last.sqrtPriceX96) return invalidatePaper(previous, input.now, ["price_change_without_swap_coverage"]);
    if(policy.feeAccounting){
      if(!input.boundaryFees||!p.boundaryFees||input.boundaryContinuity!==true)return invalidatePaper(previous,input.now,["paper_boundary_fee_continuity_unproven"]);
      if(policy.feeAccounting==='diluted_segments_v1')creditDilutedFees(state,last,cp,input.boundaryFees,input.dilutedFees);
      else {
      const fees=boundaryFeeIncrement(last,cp,p.boundaryFees,input.boundaryFees,BigInt(p.liquidity),BigInt(p.feeRemainder0??"0"),BigInt(p.feeRemainder1??"0"));
      p.fee0=String(BigInt(p.fee0)+fees.fee0);p.fee1=String(BigInt(p.fee1)+fees.fee1);
      p.feeRemainder0=String(fees.remainder0);p.feeRemainder1=String(fees.remainder1);p.boundaryFees=input.boundaryFees;
      }
    }else{
      p.fee0 = String(BigInt(p.fee0) + subtractUint256(BigInt(cp.feeGrowth0), BigInt(last.feeGrowth0)) * BigInt(p.liquidity) / (1n << 128n));
      p.fee1 = String(BigInt(p.fee1) + subtractUint256(BigInt(cp.feeGrowth1), BigInt(last.feeGrowth1)) * BigInt(p.liquidity) / (1n << 128n));
    }
    ledger.earnedFee0 = String(BigInt(ledger.earnedFee0) + BigInt(p.fee0) - BigInt(previous.position!.fee0));
    ledger.earnedFee1 = String(BigInt(ledger.earnedFee1) + BigInt(p.fee1) - BigInt(previous.position!.fee1));
    state.intervals++; state.observedSwaps = String(BigInt(state.observedSwaps) + BigInt(input.swapCount)); state.action = "mark";
    if (previous.status === "exit_pending" && input.chainHealthy && state.pendingSince && Date.parse(cp.blockTimestamp) > Date.parse(state.pendingSince)) {
      const fill = input.execution.exit;
      if (!fill) {
        state.reasons = [...state.reasons, input.execution.error ? "paper_exit_preflight_failed" : "paper_exit_simulation_required", ...(input.execution.error ? [input.execution.error] : [])];
        state.status = "exit_pending";
      } else {
        proofMatches(fill.result.source, fill.valuation);
        const r = fill.result;
        assert(r.inventory.liquidity === p.liquidity && r.inventory.tickLower === p.tickLower && r.inventory.tickUpper === p.tickUpper);
        assert(r.inventory.idle0 === p.idle0 && r.inventory.idle1 === p.idle1 && r.inventory.fee0 === p.fee0 && r.inventory.fee1 === p.fee1, "Exit inventory differs from the forward paper ledger");
        ledger.exitRunId = fill.runId; ledger.gasSpentWei = String(BigInt(ledger.gasSpentWei) + BigInt(r.totalGasWei));
        assert(BigInt(ledger.gasSpentWei) <= 10n ** 18n, "Paper native gas fixture budget exhausted");
        ledger.exitReserveWei = "0"; ledger.lastValuation = fill.valuation;
        state.costsPaidQuote = String(BigInt(state.costsPaidQuote) + paperGasQuote(r.totalGasWei, fill.valuation));
        state.exitReserveQuote = "0"; state.status = "closed"; state.action = "exit"; state.pendingSince = null;
        p.liquidity = "0"; p.idle0 = r.balances.afterExit.quote; p.idle1 = "0"; p.fee0 = "0"; p.fee1 = "0";
      }
    } else if (previous.status === "exit_pending" || (policy.maxHoldingSeconds !== null && seconds(p.enteredAt, input.now) >= policy.maxHoldingSeconds) ||
      (policy.mode === "guarded" && state.reasons.some(reason => reason !== "checkpoint_not_latest_risk_snapshot"))) {
      state.status = "exit_pending"; state.action = "signal_exit"; state.pendingSince ??= input.now;
    }
  }
  // Recenter never resets campaign time, passive inventory or earned fees.
  // This policy disallows an inventory cap, so scheduled/risk exits above win.
  if (previous.position) advanceRecenter(state,policy,input);
  const p = state.position!;
  if(policy.liquidityShareMode)state.liquidityShare=liquidityShare(BigInt(p.liquidity),BigInt(cp.liquidity),policy);
  const principal = principalAmounts({ liquidity: BigInt(p.liquidity), tickLower: p.tickLower, tickUpper: p.tickUpper, sqrtPriceX96: BigInt(cp.sqrtPriceX96) });
  const nav = value(principal.amount0 + BigInt(p.idle0) + BigInt(p.fee0), principal.amount1 + BigInt(p.idle1) + BigInt(p.fee1)) - BigInt(state.costsPaidQuote) - BigInt(state.exitReserveQuote);
  const hold = value(BigInt(p.hold0), BigInt(p.hold1)) - BigInt(ledger.holdGasQuote);
  state.navQuote = String(nav); state.holdQuote = String(hold);
  state.pnlQuote = String(nav - BigInt(policy.budgetQuote)); state.alphaQuote = String(nav - hold);
  state.feeValueQuote = String(value(BigInt(ledger.earnedFee0), BigInt(ledger.earnedFee1)));
  const previousPeak = previous.position ? BigInt(state.peakNavQuote) : BigInt(policy.budgetQuote);
  const peak = previousPeak > nav ? previousPeak : nav;
  const drawdown = peak > 0n ? (peak - nav) * 1000000n / peak : 0n;
  state.peakNavQuote = String(peak); state.maxDrawdownPpm = String(drawdown > BigInt(state.maxDrawdownPpm) ? drawdown : BigInt(state.maxDrawdownPpm));
  if(policy.inventoryExitPpm&&state.status==="open"){
    const reference=input.reference?.eligible?input.reference.referencePriceX18:null;
    if(reference){
      const rwaValue=(principal.amount1+BigInt(p.idle1)+BigInt(p.fee1))*BigInt(reference)/10n**30n;
      const total=principal.amount0+BigInt(p.idle0)+BigInt(p.fee0)+rwaValue-BigInt(state.costsPaidQuote)-BigInt(state.exitReserveQuote);
      if(total<=0n||rwaValue*1000000n>=total*BigInt(policy.inventoryExitPpm)){
        state.status="exit_pending";state.action="signal_exit";state.pendingSince=input.now;
        state.reasons=[...state.reasons,"paper_inventory_threshold_exit_to_cash"];
      }
    }
  }
  return state;
}
