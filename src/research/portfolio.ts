import assert from "node:assert/strict";
import { sqrtRatioAtTick } from "../backtest/principal.js";
import { rawTickRange, nvdaPriceX18 } from "./range-screen.js";
import type { FeeSegment, SwapSource } from "./swap.js";
import { positionAmounts, nvdaValueQuote, historicalSwapQuote, modeledFeeGrowth, type TickRange } from "./portfolio-math.js";

const Q128 = 1n << 128n;
export interface PortfolioMarket extends SwapSource {
  at: number; referenceX18: bigint | null; referenceMode: string; tokenSafe: boolean;
}
interface Position extends TickRange { liquidity: bigint; centerPrice: bigint; fee0X128: bigint; fee1X128: bigint }
export interface PortfolioPolicy { halfWidthTicks: number; mode: "fixed" | "persistent70"; transactionCostQuote: bigint; feeIncomePpm: number }
export class ResearchPortfolio {
  cash: bigint;
  nvda: bigint;
  position: Position | null = null;
  readonly initialCash: bigint;
  readonly initialNvda: bigint;
  readonly actions: Record<string, unknown>[] = [];
  readonly marks: Record<string, unknown>[] = [];
  private pending: { at: number; range: TickRange; center: bigint; reason: string } | null = null;
  private originalRange: TickRange | null = null;
  private originalCenter = 0n;
  private persistence = 0;
  private lastMove = -Infinity;
  private lastDecision = -Infinity;
  private peakNav: bigint;
  private maxDrawdownPpm = 0n;
  private maxExposurePpm = 0n;
  private peakSharePpm = 0n;
  private cost = 0n;
  private collected0 = 0n;
  private collected1 = 0n;
  private feesEarned0 = 0n;
  private feesEarned1 = 0n;
  private turnoverQuote = 0n;
  private observed = 0;
  private unvalued = 0;
  private inactive = 0;
  private outOfRange = 0;
  private exposureBreaches = 0;
  private skipped = 0;
  private expired = 0;
  private riskSales = 0;
  private guardExits = 0;
  private riskExits = 0;
  private routineMoves = 0;
  private swapsRejected = 0;
  private costFailures = 0;
  private finished = false;
  constructor(readonly budgetQuote: bigint, openingReferenceX18: bigint, readonly policy: PortfolioPolicy) {
    assert(budgetQuote > 0n && openingReferenceX18 > 0n && policy.transactionCostQuote >= 0n);
    assert([10,20,30,40,50].includes(policy.halfWidthTicks));
    assert(policy.feeIncomePpm >= 0 && policy.feeIncomePpm <= 1000000);
    this.nvda = (budgetQuote * 40n / 100n) * 10n ** 30n / openingReferenceX18;
    this.cash = budgetQuote - nvdaValueQuote(this.nvda, openingReferenceX18);
    this.initialCash = this.cash; this.initialNvda = this.nvda; this.peakNav = budgetQuote;
  }
  balances(price: bigint) {
    const p = this.position;
    const amounts = p ? positionAmounts(price, p, p.liquidity, false) : { amount0: 0n, amount1: 0n };
    return { amount0: this.cash + amounts.amount0 + (p ? p.fee0X128 / Q128 : 0n),
      amount1: this.nvda + amounts.amount1 + (p ? p.fee1X128 / Q128 : 0n) };
  }
  private nav(m: PortfolioMarket): bigint | null {
    if (m.referenceX18 === null) return null;
    const b = this.balances(m.price); return b.amount0 + nvdaValueQuote(b.amount1, m.referenceX18);
  }
  private exposure(m: PortfolioMarket): bigint | null {
    const nav = this.nav(m); return nav === null || nav === 0n ? null : nvdaValueQuote(this.balances(m.price).amount1, m.referenceX18!) * 1000000n / nav;
  }
  private inside(price: bigint, range: TickRange) { return price >= sqrtRatioAtTick(range.tickLower) && price < sqrtRatioAtTick(range.tickUpper); }
  private inBand(price: bigint, reference: bigint) {
    const p = nvdaPriceX18(price); return p * 100n >= reference * 95n && p * 100n <= reference * 105n;
  }
  private allowed(m: PortfolioMarket, range?: TickRange) {
    return m.referenceX18 !== null && m.tokenSafe && this.inBand(m.price, m.referenceX18) && (!range ||
      (this.inBand(sqrtRatioAtTick(range.tickLower), m.referenceX18) && this.inBand(sqrtRatioAtTick(range.tickUpper), m.referenceX18)));
  }
  private record(m: PortfolioMarket, action: string, reason: string, extra: Record<string, unknown> = {}) {
    assert(this.cash >= 0n && this.nvda >= 0n);
    this.actions.push({ at: m.at, action, reason, cashQuoteRaw: this.cash.toString(), nvdaRaw: this.nvda.toString(),
      liquidity: this.position?.liquidity.toString() ?? "0", navQuoteRaw: this.nav(m)?.toString() ?? null, ...extra });
  }
  private charge() {
    if (this.cash < this.policy.transactionCostQuote) { this.costFailures++; return false; }
    this.cash -= this.policy.transactionCostQuote; this.cost += this.policy.transactionCostQuote; return true;
  }
  private remove(m: PortfolioMarket, reason: string) {
    if (!this.position) return true;
    if (!this.charge()) return false;
    const p = this.position, amounts = positionAmounts(m.price, p, p.liquidity, false), fee0 = p.fee0X128 / Q128, fee1 = p.fee1X128 / Q128;
    this.cash += amounts.amount0 + fee0; this.nvda += amounts.amount1 + fee1;
    this.collected0 += fee0; this.collected1 += fee1; this.position = null;
    this.record(m, "remove_collect", reason, { principal0Raw: amounts.amount0.toString(), principal1Raw: amounts.amount1.toString(), fee0Raw: fee0.toString(), fee1Raw: fee1.toString() }); return true;
  }
  private mint(m: PortfolioMarket, range: TickRange, center: bigint, reason: string) {
    assert(this.position === null);
    if (!this.allowed(m, range) || !this.inside(m.price, range) || this.cash < this.policy.transactionCostQuote) { this.skipped++; return false; }
    const nav = this.nav(m)! - this.policy.transactionCostQuote;
    const reserve = (nav * 20n + 99n) / 100n, spend0 = this.cash - this.policy.transactionCostQuote - reserve, maximum = nav * 80n / 100n;
    if (spend0 < 0n) { this.skipped++; return false; }
    const feasible = (liquidity: bigint) => {
      const a = positionAmounts(m.price, range, liquidity, true);
      return a.amount0 <= spend0 && a.amount1 <= this.nvda && a.amount0 + nvdaValueQuote(a.amount1, m.referenceX18!) <= maximum;
    };
    let low = 0n, high = Q128 - 1n;
    while (low < high) { const mid = low + (high - low + 1n) / 2n; if (feasible(mid)) low = mid; else high = mid - 1n; }
    if (low === 0n) { this.skipped++; return false; }
    const a = positionAmounts(m.price, range, low, true);
    if (a.amount0 + nvdaValueQuote(a.amount1, m.referenceX18!) < 1000000n) { this.skipped++; return false; } // frozen one-USDG minimum placement
    assert(this.charge()); this.cash -= a.amount0; this.nvda -= a.amount1;
    this.position = { ...range, liquidity: low, centerPrice: center, fee0X128: 0n, fee1X128: 0n }; this.lastMove = m.at;
    const share = low * 1000000n / (low + m.liquidity); if (share > this.peakSharePpm) this.peakSharePpm = share;
    this.record(m, "mint", reason, { ...range, principal0Raw: a.amount0.toString(), principal1Raw: a.amount1.toString(), sharePpm: share.toString() }); return true;
  }
  private reduceInventory(m: PortfolioMarket): PortfolioMarket {
    assert(this.position === null && m.referenceX18 !== null);
    if ((this.exposure(m) ?? 0n) < 600000n) return m;
    if (this.cash < this.policy.transactionCostQuote) { this.costFailures++; return m; }
    const cashAfterCost = this.cash - this.policy.transactionCostQuote;
    const predicate = (amount: bigint) => {
      const q = historicalSwapQuote(m, amount, 1);
      const value = nvdaValueQuote(this.nvda - amount, m.referenceX18!);
      return { q, reached: value * 2n <= cashAfterCost + q.amountOut + value };
    };
    let low = 0n, high = this.nvda;
    while (low < high) { const mid = low + (high - low) / 2n; if (predicate(mid).reached) high = mid; else low = mid + 1n; }
    const { q } = predicate(low);
    if (!q.fullyFilled || !q.passesSlippage || !this.inBand(q.sqrtPriceAfter, m.referenceX18)) { this.swapsRejected++; return m; }
    assert(this.charge()); this.nvda -= low; this.cash += q.amountOut; this.riskSales++;
    this.turnoverQuote += nvdaValueQuote(low, m.referenceX18);
    const after = { ...m, price: q.sqrtPriceAfter, tick: q.tickAfter, liquidity: q.liquidityAfter };
    this.record(after, "sell_nvda", "inventory_60_to_50", { soldNvdaRaw: low.toString(), receivedQuoteRaw: q.amountOut.toString(),
      swapFeeNvdaRaw: q.feeInput.toString(), impactAndFeeShortfallQuoteRaw: q.outputShortfall.toString() });
    return after;
  }
  accrue(segment: FeeSegment, protocolDivisor: number) {
    const p = this.position; if (!p) return;
    const growth = modeledFeeGrowth(segment, p, p.liquidity, protocolDivisor);
    if (growth === 0n) return;
    const credit = p.liquidity * growth * BigInt(this.policy.feeIncomePpm) / 1000000n;
    if (segment.token === 0) { const before = p.fee0X128 / Q128; p.fee0X128 += credit; this.feesEarned0 += p.fee0X128 / Q128 - before; }
    else { const before = p.fee1X128 / Q128; p.fee1X128 += credit; this.feesEarned1 += p.fee1X128 / Q128 - before; }
    const share = p.liquidity * 1000000n / (p.liquidity + segment.liquidity); if (share > this.peakSharePpm) this.peakSharePpm = share;
  }
  decision(m: PortfolioMarket) {
    assert(!this.finished && m.at > this.lastDecision); this.lastDecision = m.at; this.observed++;
    const nav = this.nav(m), exposure = this.exposure(m);
    if (nav === null) this.unvalued++;
    else {
      if (nav > this.peakNav) this.peakNav = nav;
      const dd = this.peakNav ? (this.peakNav - nav) * 1000000n / this.peakNav : 0n; if (dd > this.maxDrawdownPpm) this.maxDrawdownPpm = dd;
      if (exposure! > this.maxExposurePpm) this.maxExposurePpm = exposure!;
      if (exposure! >= 600000n) this.exposureBreaches++;
    }
    if (!this.position) this.inactive++; else if (!this.inside(m.price, this.position)) this.outOfRange++;
    this.marks.push({ at: m.at, navQuoteRaw: nav?.toString() ?? null, exposurePpm: exposure?.toString() ?? null,
      referenceMode: m.referenceMode, positionOpen: this.position !== null });
    if (!this.originalRange && this.allowed(m)) { this.originalRange = rawTickRange(m.price, this.policy.halfWidthTicks * 2, m.spacing); this.originalCenter = m.price; }
    if (!this.allowed(m, this.position ?? undefined)) {
      this.persistence = 0;
      if (!this.position) this.pending = null;
      else if (this.pending?.reason !== "guard") this.pending = { at: m.at + 60, range: this.position, center: m.price, reason: "guard" };
      else if (m.at >= this.pending.at && this.remove(m, "reference_or_token_guard")) { this.guardExits++; this.pending = null; }
      return;
    }
    if (this.pending?.reason === "guard") this.pending = null;
    if (this.pending?.reason === "inventory" && exposure !== null && exposure < 600000n) this.pending = null;
    if ((exposure ?? 0n) >= 600000n) {
      if (!this.pending || this.pending.reason !== "inventory") this.pending = { at: m.at + 60,
        range: this.originalRange!, center: m.price, reason: "inventory" };
    }
    if (this.pending && m.at >= this.pending.at) {
      const pending = this.pending; this.pending = null; this.persistence = 0;
      if (pending.reason === "inventory") {
        const hadPosition = this.position !== null;
        if (!this.remove(m, "inventory")) return;
        if (hadPosition) this.riskExits++; const after = this.reduceInventory(m);
        if ((this.exposure(after) ?? 1000000n) >= 600000n) return;
        const range = this.policy.mode === "fixed" ? this.originalRange! : rawTickRange(after.price, this.policy.halfWidthTicks * 2, m.spacing);
        this.mint(after, range, this.policy.mode === "fixed" ? this.originalCenter : after.price, "inventory_redeploy");
      } else {
        if (!this.allowed(m, pending.range) || !this.inside(m.price, pending.range)) { this.expired++; return; }
        if (!this.remove(m, "routine_recenter")) return;
        if (this.mint(m, pending.range, pending.center, "routine_recenter")) this.routineMoves++;
      }
      return;
    }
    if (this.pending) return;
    if (!this.position) {
      if ((exposure ?? 0n) >= 600000n) return;
      const range = this.policy.mode === "fixed" ? this.originalRange! : rawTickRange(m.price, this.policy.halfWidthTicks * 2, m.spacing);
      this.mint(m, range, this.policy.mode === "fixed" ? this.originalCenter : m.price, "entry_or_resume"); return;
    }
    if (this.policy.mode === "fixed") return;
    const now = nvdaPriceX18(m.price), center = nvdaPriceX18(this.position.centerPrice);
    const down = now < center, boundary = nvdaPriceX18(sqrtRatioAtTick(down ? this.position.tickUpper : this.position.tickLower));
    const distance = down ? center - now : now - center, width = down ? center - boundary : boundary - center;
    if (distance <= 0n || distance * 100n < width * 70n) { this.persistence = 0; return; }
    this.persistence++;
    if (this.persistence >= 2 && m.at - this.lastMove >= 600) this.pending = { at: m.at + 60,
      range: rawTickRange(m.price, this.policy.halfWidthTicks * 2, m.spacing), center: m.price, reason: "routine" };
  }
  finish(m: PortfolioMarket) {
    assert(!this.finished); this.finished = true; this.pending = null;
    const removed = this.remove(m, "terminal");
    const nav = this.nav(m), passive = m.referenceX18 === null ? null : this.initialCash + nvdaValueQuote(this.initialNvda, m.referenceX18);
    const alpha = nav === null || passive === null || !removed ? null : nav - passive;
    if (nav !== null && nav < this.peakNav) { const dd = (this.peakNav - nav) * 1000000n / this.peakNav; if (dd > this.maxDrawdownPpm) this.maxDrawdownPpm = dd; }
    return { budgetQuoteRaw: this.budgetQuote.toString(), ...this.policy, transactionCostQuote: this.policy.transactionCostQuote.toString(),
      evidenceClass: "self_financing_modeled_historical_path", executionEligible: false, measuredNetAlphaQuoteRaw: null, rank: null,
      initialCashQuoteRaw: this.initialCash.toString(), initialNvdaRaw: this.initialNvda.toString(), finalCashQuoteRaw: this.cash.toString(), finalNvdaRaw: this.nvda.toString(),
      terminalRemovalCompleted: removed, modeledNavQuoteRaw: nav?.toString() ?? null, passiveNavQuoteRaw: passive?.toString() ?? null,
      modeledNetAlphaQuoteRaw: alpha?.toString() ?? null, modeledNetAlphaPpm: alpha === null ? null : (alpha * 1000000n / this.budgetQuote).toString(),
      modeledAbsolutePnlQuoteRaw: nav === null ? null : (nav - this.budgetQuote).toString(), modeledTransactionCostsQuoteRaw: this.cost.toString(),
      modeledFees0Raw: this.feesEarned0.toString(), modeledFees1Raw: this.feesEarned1.toString(), collectedFees0Raw: this.collected0.toString(), collectedFees1Raw: this.collected1.toString(),
      maxDrawdownPpm: this.maxDrawdownPpm.toString(), maxExposurePpm: this.maxExposurePpm.toString(), peakLiquiditySharePpm: this.peakSharePpm.toString(),
      swapTurnoverQuoteRaw: this.turnoverQuote.toString(), observations: this.observed, unvaluedObservations: this.unvalued,
      noPositionObservations: this.inactive, outOfRangeObservations: this.outOfRange, exposureThresholdObservations: this.exposureBreaches,
      routineMoves: this.routineMoves, riskExits: this.riskExits, riskSales: this.riskSales, guardExits: this.guardExits,
      expiredRoutineChanges: this.expired, skippedPlacements: this.skipped, swapsRejected: this.swapsRejected, costFailures: this.costFailures,
      actions: this.actions, marks: this.marks };
  }
}
