// RangeKeeper size-gradient gas experiment (docs/reviews/rangekeeper-gas-banding-
// 2026-09-30.md). Asks the same question section 4/4b of
// docs/plans/operation-gate-simplification-2026-09-30.md asked for the static
// path: which dimensions actually drive gas on the RangeKeeper paper paths,
// and by how much?
//
// Holds ONE canonical source frame and ONE tick range constant across every
// sample in a gradient, so any spread measured is attributable only to the
// dimension under test (deployed size, or -- in the swap gradient -- swap
// input size at a fixed fraction of capital) and not to pool state moving
// between samples.
//
// Read-only and side-effect-free: it calls sampleRangeKeeperPaperGasStages
// directly (the same function the CLI sampler and the confirmation runner
// use) against an owned local anvil fork. No draft, preview, campaign or
// operation is created; nothing is imported into deployment_calibration_profiles
// (this script's only DB access is a read via DeploymentStore.paperSetupProfile,
// and the connection is closed without any write). No transaction is broadcast
// against the live provider; the live provider is used only for read RPCs
// (frame construction, a canonical quoter simulate call) exactly as the
// existing static gradient script and the CLI sampler already do.
//
// Usage: node --import tsx scripts/analysis/rangekeeper-size-gradient-gas.ts [no_swap|swap|both|range|range_position|swap_position]
// range mode: RK_WIDTHS (comma-separated fullWidthSpacings, default "20,100")
// and RK_CAPITALS_USD (first value used as the fixed capital) sample several
// DIFFERENT tick ranges anchored at the same pinned tick/frame.
//
// range_position mode (docs/reviews/rangekeeper-gas-position-2026-10-01.md):
// holds WIDTH fixed (RK_FULL_WIDTH_SPACINGS) and capital fixed (first of
// RK_CAPITALS_USD) and shifts the range's CENTER by RK_POSITION_SHIFTS
// (comma-separated signed integers, in units of tickSpacing, default
// "-5,-3,-1,0,1,3,5") around the same pinned tick -- the mirror image of
// `range` mode, which shifts width at a fixed center. RK_POSITION_MARGIN_TICKS
// (default 20) is a confound guard: any shift that would leave the pinned
// spot tick within that many raw ticks of either edge is skipped rather than
// sampled, because a range that straddles spot only barely is at risk of
// becoming single-sided from rounding, which is a different code path than
// a comfortably-straddled range and would confound position with sidedness.
//
// swap_position mode: a cheap secondary check on whether the `open_swap`
// step found by `swap` mode between 25 and 100 USDG (gas-banding review
// section 4) is itself position-dependent. Runs the same two swap sizes
// (RK_SWAP_POSITION_CAPITALS, default "25,100") at ONE shifted center
// (RK_SWAP_POSITION_SHIFT spacings, default 5) instead of the tick-centered
// range `swap` mode uses.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

function loadEnv(path: string) {
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
// Credentials loaded in-process from an operator-provided env file so no
// secret (the RPC API key embedded in the URL) ever appears in a shell
// command line, argv, or this script's own output.
loadEnv('/root/conc-liq/data/static-paper-mvp-dashboard-feedback-2026-09-28.env');

import { createRobinhoodClient } from '../../src/client.js';
import { DeploymentStore } from '../../src/deployments/store.js';
import { readCanonicalPaperOpenFrame, type PaperOpenFrame } from '../../src/deployments/paper-preview.js';
import { rangeKeeperRange, sizeRangeKeeperMint } from '../../src/strategy/rangekeeper/planner.js';
import { RangeKeeperChain } from '../../src/strategy/rangekeeper/chain.js';
import { sqrtRatioAtTick } from '../../src/backtest/principal.js';
import { sampleRangeKeeperPaperGasStages } from '../../src/deployments/rangekeeper-paper-gas-sampler.js';
import {
  rangeKeeperPaperCandidateHash, RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP,
  RANGEKEEPER_PAPER_OPEN_STAGES_SWAP, RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES,
  RANGEKEEPER_PAPER_NO_SWAP_PATH, RANGEKEEPER_PAPER_DIRECT_SWAP_PATH,
} from '../../src/deployments/rangekeeper-paper-cost.js';
import type { RangeKeeperCandidate, RangeKeeperLimits } from '../../src/strategy/rangekeeper/domain.js';
import type { RangeKeeperPaperGasProbeRequest } from '../../src/deployments/rangekeeper-paper-gas-evidence.js';

const PROFILE = 'a8e7096f-17c3-452c-a72f-8fa962e586d2'; // AAPL/USD, fee 500, tickSpacing 10 -- same pool the static size-gradient script used, for a like-for-like comparison.
// 200-tick width by default -- matches the NVDA-500 production config's own
// fullWidthSpacings. Overridable via RK_FULL_WIDTH_SPACINGS for the
// range-width comparison (a second dimension, independent of size/share).
const FULL_WIDTH_SPACINGS = Number(process.env.RK_FULL_WIDTH_SPACINGS ?? 20);
// 25, 100, 250, 500, 1000 USDG: the same 40x span the static gradient covered.
// Overridable via RK_CAPITALS_USD (comma-separated) for a single-point run.
const CAPITALS_USD = (process.env.RK_CAPITALS_USD ?? '25,100,250,500,1000')
  .split(',').map(s => BigInt(s.trim()));
const WAD = 10n ** 18n;
const PPM = 1_000_000n;
const CONFIG_HASH = '0'.repeat(64); // Arbitrary fixed placeholder; only used to compute a candidateHash for this script's own bookkeeping, never persisted or compared against a real draft.

function limitsFor(capWei: bigint): RangeKeeperLimits {
  return {
    fullWidthSpacings: FULL_WIDTH_SPACINGS, maxDeploymentValue: capWei, minDeploymentPpm: 400_000,
    maxSwapInputValue: capWei * 2n, maxSwapInputPpm: 1_000_000, maxSwapShortfallValue: capWei / 20n,
    maxSlippageBps: 50, maxActionCost: capWei / 20n, maxRollingCost: capWei / 10n, maxCampaignCost: capWei * 15n / 100n,
    maxExposurePpm: 950_000, maxLossValue: capWei / 20n, maxDrawdownPpm: 100_000, maxRecenters: 4,
    maxLiquiditySharePpm: 1_000_000, maxObservationGapSeconds: 90, exitReserveWei: 1_000_000_000_000_000n,
  };
}

async function main() {
  const mode = process.argv[2] ?? 'both';
  const client = createRobinhoodClient(process.env.ROBINHOOD_READ_HTTP_URL!, 20_000);
  const store = new DeploymentStore(process.env.DATABASE_URL!);
  await store.assertReady();
  const registered = await store.paperSetupProfile(PROFILE);
  if (!registered) throw new Error('profile unavailable');
  const profile: any = registered.profile;
  const p = profile.pool;
  const decimals0 = p.decimals0, decimals1 = p.decimals1;

  // ONE frame, ONE range, for every sample below -- pool state and tick range
  // cannot explain any spread this script measures.
  const frame: PaperOpenFrame = await readCanonicalPaperOpenFrame(client, profile);
  const range = rangeKeeperRange(frame.tick, p.tickSpacing, FULL_WIDTH_SPACINGS);
  console.log(`pinned source block ${frame.source.block} tick ${frame.tick} poolLiquidity ${frame.poolLiquidity}`);
  console.log(`pinned range ${range.tickLower}/${range.tickUpper} (fullWidthSpacings ${FULL_WIDTH_SPACINGS}, spacing ${p.tickSpacing})`);
  console.log(`price0 ${frame.price0} price1 ${frame.price1}\n`);

  // forRange defaults to the module-level pinned `range` so every existing
  // call site (no_swap/swap/range modes) is byte-for-byte unchanged; only
  // the new position modes below ever pass a different range explicitly.
  const buildScope = (candidate: RangeKeeperCandidate, pathVersion: string, deployedValue: bigint, sharePpm: bigint,
    swapKind: 'none' | 'direct_pool_exact_input', forRange: { tickLower: number; tickUpper: number } = range) => {
    const campaignId = randomUUID();
    const scopeBase = { poolAddress: p.pool, profileHash: registered.profileHash, deployedValue, sharePpm, range: forRange, swapKind };
    const candidateHash = rangeKeeperPaperCandidateHash({
      campaignId, revision: 1, profileHash: registered.profileHash, configHash: CONFIG_HASH,
      source: frame.source, referenceProofHash: frame.referenceProofHash, candidate,
    });
    return { ...scopeBase, candidateHash };
  };

  const runSample = async (label: string, candidate: RangeKeeperCandidate, pathVersion: string,
    stages: readonly string[], initialBalances: readonly [bigint, bigint], limits: RangeKeeperLimits,
    forRange: { tickLower: number; tickUpper: number } = range) => {
    const sharePpm = candidate.liquidity * PPM / (frame.poolLiquidity + candidate.liquidity);
    const swapKind = candidate.swap ? 'direct_pool_exact_input' as const : 'none' as const;
    const scope = buildScope(candidate, pathVersion, candidate.deployedValue, sharePpm, swapKind, forRange);
    const request: RangeKeeperPaperGasProbeRequest = {
      kind: 'open', profile, frame, candidate, candidateSource: frame.source,
      candidateReferenceProofHash: frame.referenceProofHash, candidateHash: scope.candidateHash,
      scope, pathVersion, stages, openMarkId: null, openModelHash: null,
    };
    const started = Date.now();
    const rows = await sampleRangeKeeperPaperGasStages(request, {
      rpcUrl: process.env.PAPER_FORK_RPC_URL!, beforeRead: async () => {}, maxRequests: 2000,
      timeoutMs: 280_000, limits, initialBalances,
    });
    const gas: Record<string, string> = {};
    for (const row of rows) gas[row.action] = row.estimate.gas;
    const total = Object.values(gas).reduce((a, b) => a + Number(b), 0);
    const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${label}: deployedValue=${candidate.deployedValue} sharePpm=${sharePpm} liquidity=${candidate.liquidity} total=${total} (${elapsedS}s)`);
    return { label, deployedValue: candidate.deployedValue.toString(), sharePpm: sharePpm.toString(),
      liquidity: candidate.liquidity.toString(), gas, total, elapsedS };
  };

  const buildNoSwapCandidate = (capWei: bigint, forRange: { tickLower: number; tickUpper: number },
    forSqrtPriceX96: bigint, limits: RangeKeeperLimits) => {
    // Ample funds on both legs (4x cap in value each) so the ONLY binding
    // constraint on deployed size is maxDeploymentValue, not token availability.
    const ample0 = capWei * 4n * 10n ** BigInt(decimals0) / frame.price0!;
    const ample1 = capWei * 4n * 10n ** BigInt(decimals1) / frame.price1!;
    const sized = sizeRangeKeeperMint(forSqrtPriceX96, forRange, ample0, ample1,
      frame.price0!, frame.price1!, decimals0, decimals1, capWei);
    if (sized.mint.liquidity === 0n) return null;
    const haircut = 10_000n - BigInt(limits.maxSlippageBps);
    const candidate: RangeKeeperCandidate = {
      kind: 'entry', range: forRange, swap: null, amount0Desired: sized.desired0, amount1Desired: sized.desired1,
      amount0Min: sized.mint.amount0 * haircut / 10_000n, amount1Min: sized.mint.amount1 * haircut / 10_000n,
      liquidity: sized.mint.liquidity, deployedValue: sized.deployed,
      sourceBlock: BigInt(frame.source.block), sourceHash: frame.source.hash as `0x${string}`,
      expiresAt: frame.source.timestamp + 90,
    };
    return { candidate, sized };
  };

  const noSwapResults: any[] = [];
  if (mode === 'no_swap' || mode === 'both') {
    console.log('=== no-swap open + retain-exit: size gradient ===');
    for (const capUsd of CAPITALS_USD) {
      const capWei = capUsd * WAD;
      const limits = limitsFor(capWei);
      const built = buildNoSwapCandidate(capWei, range, frame.sqrtPriceX96, limits);
      if (!built) { console.log(`${capUsd} USDG: infeasible mint (liquidity=0), skipping`); continue; }
      try {
        const result = await runSample(`${capUsd} USDG`, built.candidate, RANGEKEEPER_PAPER_NO_SWAP_PATH,
          [...RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP, ...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES],
          [built.sized.desired0, built.sized.desired1], limits);
        noSwapResults.push(result);
      } catch (error: any) { console.log(`${capUsd} USDG: SAMPLE FAILED ${error?.message}`); }
    }
  }

  // Range-width gradient: ONE pinned frame, ONE fixed capital, multiple
  // DIFFERENT tick ranges (via fullWidthSpacings) anchored at the same
  // current tick. Isolates range/width as the variable under test, the
  // dimension the static path's historical set (not available here -- zero
  // RangeKeeper rows exist) found to be the actual driver.
  const rangeResults: any[] = [];
  if (mode === 'range') {
    const widths = (process.env.RK_WIDTHS ?? '20,100').split(',').map(s => Number(s.trim()));
    const capUsd = CAPITALS_USD[0]!, capWei = capUsd * WAD, limits = limitsFor(capWei);
    console.log(`=== range-width gradient at fixed ${capUsd} USDG, one pinned frame ===`);
    for (const width of widths) {
      const forRange = rangeKeeperRange(frame.tick, p.tickSpacing, width);
      const built = buildNoSwapCandidate(capWei, forRange, frame.sqrtPriceX96, limits);
      if (!built) { console.log(`width=${width}: infeasible mint (liquidity=0), skipping`); continue; }
      try {
        const result: any = await runSample(`width=${width} (${forRange.tickLower}/${forRange.tickUpper})`,
          built.candidate, RANGEKEEPER_PAPER_NO_SWAP_PATH,
          [...RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP, ...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES],
          [built.sized.desired0, built.sized.desired1], limits);
        result.width = width; result.range = forRange;
        rangeResults.push(result);
      } catch (error: any) { console.log(`width=${width}: SAMPLE FAILED ${error?.message}`); }
    }
  }

  // Builds a range of the SAME width (fullWidthSpacings) as rangeKeeperRange
  // would, but centered `shiftSpacings` spacings away from the pinned tick's
  // own rounded anchor, instead of exactly on it. Returns null (a confound
  // guard, not a measurement) if the pinned spot tick would then sit within
  // `marginTicks` raw ticks of either edge -- too close to the edge risks a
  // near-single-sided mint from rounding, which would confound "position"
  // with "sidedness".
  const shiftedRangeFor = (tick: number, spacing: number, fullWidthSpacings: number, shiftSpacings: number, marginTicks: number) => {
    const anchor = Math.round(tick / spacing) * spacing;
    const half = fullWidthSpacings / 2;
    const tickLower = anchor - half * spacing + shiftSpacings * spacing;
    const tickUpper = anchor + half * spacing + shiftSpacings * spacing;
    if (tick - tickLower < marginTicks || tickUpper - tick < marginTicks) return null;
    return { tickLower, tickUpper };
  };

  // Range-POSITION gradient (the primary question of this review): ONE
  // pinned frame, ONE fixed width, ONE fixed capital, multiple shifts of the
  // range's CENTER around the pinned tick. Unlike `range` mode (which varies
  // width at a fixed center), this is the mirror experiment: width is held
  // constant and only the absolute tick position of the (still two-sided)
  // range varies.
  const positionResults: any[] = [];
  if (mode === 'range_position') {
    const shifts = (process.env.RK_POSITION_SHIFTS ?? '-5,-3,-1,0,1,3,5').split(',').map(s => Number(s.trim()));
    const marginTicks = Number(process.env.RK_POSITION_MARGIN_TICKS ?? 20);
    const capUsd = CAPITALS_USD[0]!, capWei = capUsd * WAD, limits = limitsFor(capWei);
    console.log(`=== range-position gradient at fixed ${capUsd} USDG, fixed width ${FULL_WIDTH_SPACINGS} spacings, one pinned frame ===`);
    for (const shift of shifts) {
      const forRange = shiftedRangeFor(frame.tick, p.tickSpacing, FULL_WIDTH_SPACINGS, shift, marginTicks);
      if (!forRange) { console.log(`shift=${shift}: spot within ${marginTicks} ticks of an edge at this shift, skipping (confound guard, not a measurement)`); continue; }
      const built = buildNoSwapCandidate(capWei, forRange, frame.sqrtPriceX96, limits);
      if (!built) { console.log(`shift=${shift}: infeasible mint (liquidity=0), skipping`); continue; }
      if (built.sized.mint.amount0 === 0n || built.sized.mint.amount1 === 0n) {
        console.log(`shift=${shift}: single-sided mint (amount0=${built.sized.mint.amount0} amount1=${built.sized.mint.amount1}), skipping -- confound guard`);
        continue;
      }
      try {
        const result: any = await runSample(`shift=${shift} (${forRange.tickLower}/${forRange.tickUpper})`,
          built.candidate, RANGEKEEPER_PAPER_NO_SWAP_PATH,
          [...RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP, ...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES],
          [built.sized.desired0, built.sized.desired1], limits, forRange);
        result.shift = shift; result.range = forRange;
        positionResults.push(result);
      } catch (error: any) { console.log(`shift=${shift}: SAMPLE FAILED ${error?.message}`); }
    }
  }

  // Secondary check: is the open_swap step (gas-banding review section 4,
  // 4.97% between 25 and 100 USDG) itself position-dependent? Same two swap
  // sizes, but at a shifted (non-centered) range instead of the tick-centered
  // one `swap` mode uses. Cheap (2 samples) and does not displace the
  // primary range_position question above.
  const swapPositionResults: any[] = [];
  if (mode === 'swap_position') {
    const shift = Number(process.env.RK_SWAP_POSITION_SHIFT ?? 5);
    const marginTicks = Number(process.env.RK_POSITION_MARGIN_TICKS ?? 20);
    const capitals = (process.env.RK_SWAP_POSITION_CAPITALS ?? '25,100').split(',').map(s => BigInt(s.trim()));
    const forRange = shiftedRangeFor(frame.tick, p.tickSpacing, FULL_WIDTH_SPACINGS, shift, marginTicks);
    if (!forRange) throw new Error(`shift=${shift}: spot within ${marginTicks} ticks of an edge, cannot run swap_position mode -- choose a smaller RK_SWAP_POSITION_SHIFT`);
    console.log(`=== direct-swap open: step-location check at shift=${shift} spacings (${forRange.tickLower}/${forRange.tickUpper}) ===`);
    const chain = new RangeKeeperChain(client, p);
    const source = { block: BigInt(frame.source.block), hash: frame.source.hash as `0x${string}`, timestamp: frame.source.timestamp };
    for (const capUsd of capitals) {
      const capWei = capUsd * WAD;
      const limits = limitsFor(capWei);
      const wallet1 = capWei * 4n * 10n ** BigInt(decimals1) / frame.price1!;
      const amountIn = wallet1 / 2n;
      let quote;
      try { quote = await chain.quote(source, 1, amountIn, frame.price0!, frame.price1!); }
      catch (error: any) { console.log(`${capUsd} USDG: quote failed ${error?.message}`); continue; }
      if (quote.priceAfter <= sqrtRatioAtTick(forRange.tickLower) || quote.priceAfter >= sqrtRatioAtTick(forRange.tickUpper)) {
        console.log(`${capUsd} USDG: post-swap price leaves the shifted range, skipping`); continue;
      }
      const next0 = quote.amountOut, next1 = wallet1 - amountIn;
      const sized = sizeRangeKeeperMint(quote.priceAfter, forRange, next0, next1,
        frame.price0!, frame.price1!, decimals0, decimals1, capWei);
      if (sized.mint.liquidity === 0n) { console.log(`${capUsd} USDG: infeasible post-swap mint, skipping`); continue; }
      if (sized.mint.amount0 === 0n || sized.mint.amount1 === 0n) {
        console.log(`${capUsd} USDG: single-sided post-swap mint, skipping -- confound guard`); continue;
      }
      const haircut = 10_000n - BigInt(limits.maxSlippageBps);
      const candidate: RangeKeeperCandidate = {
        kind: 'entry', range: forRange,
        swap: { token: 1, amountIn, quotedOut: quote.amountOut, minOut: quote.amountOut * haircut / 10_000n,
          priceAfter: quote.priceAfter, feeValue: quote.feeValue, shortfallValue: quote.shortfallValue },
        amount0Desired: sized.desired0, amount1Desired: sized.desired1,
        amount0Min: sized.mint.amount0 * haircut / 10_000n, amount1Min: sized.mint.amount1 * haircut / 10_000n,
        liquidity: sized.mint.liquidity, deployedValue: sized.deployed,
        sourceBlock: BigInt(frame.source.block), sourceHash: frame.source.hash as `0x${string}`,
        expiresAt: frame.source.timestamp + 90,
      };
      try {
        const result: any = await runSample(`${capUsd} USDG`, candidate, RANGEKEEPER_PAPER_DIRECT_SWAP_PATH,
          [...RANGEKEEPER_PAPER_OPEN_STAGES_SWAP, ...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES],
          [0n, wallet1], limits, forRange);
        result.shift = shift;
        swapPositionResults.push(result);
      } catch (error: any) { console.log(`${capUsd} USDG: SAMPLE FAILED ${error?.message}`); }
    }
  }

  const swapResults: any[] = [];
  if (mode === 'swap' || mode === 'both') {
    console.log('\n=== direct-swap open + retain-exit: size gradient (fixed 50% swap fraction) ===');
    const chain = new RangeKeeperChain(client, p);
    const source = { block: BigInt(frame.source.block), hash: frame.source.hash as `0x${string}`, timestamp: frame.source.timestamp };
    for (const capUsd of CAPITALS_USD) {
      const capWei = capUsd * WAD;
      const limits = limitsFor(capWei);
      // Wallet entirely in token1 (AAPL): forces a swap to fund the token0 leg.
      // amountIn is always 50% of the token1 wallet, so the swap's ABSOLUTE size
      // scales with capital while its FRACTION of capital stays pinned --
      // isolating size as the variable under test, same as the no-swap gradient.
      const wallet1 = capWei * 4n * 10n ** BigInt(decimals1) / frame.price1!;
      const amountIn = wallet1 / 2n;
      let quote;
      try { quote = await chain.quote(source, 1, amountIn, frame.price0!, frame.price1!); }
      catch (error: any) { console.log(`${capUsd} USDG: quote failed ${error?.message}`); continue; }
      if (quote.priceAfter <= sqrtRatioAtTick(range.tickLower) || quote.priceAfter >= sqrtRatioAtTick(range.tickUpper)) {
        console.log(`${capUsd} USDG: post-swap price leaves the pinned range, skipping`); continue;
      }
      const next0 = quote.amountOut, next1 = wallet1 - amountIn;
      const sized = sizeRangeKeeperMint(quote.priceAfter, range, next0, next1,
        frame.price0!, frame.price1!, decimals0, decimals1, capWei);
      if (sized.mint.liquidity === 0n) { console.log(`${capUsd} USDG: infeasible post-swap mint, skipping`); continue; }
      const haircut = 10_000n - BigInt(limits.maxSlippageBps);
      const candidate: RangeKeeperCandidate = {
        kind: 'entry', range,
        swap: { token: 1, amountIn, quotedOut: quote.amountOut, minOut: quote.amountOut * haircut / 10_000n,
          priceAfter: quote.priceAfter, feeValue: quote.feeValue, shortfallValue: quote.shortfallValue },
        amount0Desired: sized.desired0, amount1Desired: sized.desired1,
        amount0Min: sized.mint.amount0 * haircut / 10_000n, amount1Min: sized.mint.amount1 * haircut / 10_000n,
        liquidity: sized.mint.liquidity, deployedValue: sized.deployed,
        sourceBlock: BigInt(frame.source.block), sourceHash: frame.source.hash as `0x${string}`,
        expiresAt: frame.source.timestamp + 90,
      };
      // Initial balances must cover BOTH the swap input (from wallet1) and any
      // idle token0 the candidate assumes -- here token0 starts at 0 and the
      // swap itself produces it, so initial = [0, wallet1].
      try {
        const result = await runSample(`${capUsd} USDG`, candidate, RANGEKEEPER_PAPER_DIRECT_SWAP_PATH,
          [...RANGEKEEPER_PAPER_OPEN_STAGES_SWAP, ...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES],
          [0n, wallet1], limits);
        swapResults.push(result);
      } catch (error: any) { console.log(`${capUsd} USDG: SAMPLE FAILED ${error?.message}`); }
    }
  }

  const report = (label: string, results: any[]) => {
    if (results.length < 2) { console.log(`\n${label}: fewer than 2 successful samples, no spread computable`); return; }
    console.log(`\n=== ${label}: per-stage spread across ${results.length} samples ===`);
    const stageNames = Object.keys(results[0].gas);
    console.log(['stage', ...results.map(r => r.label)].join('\t'));
    for (const stage of stageNames) {
      const vals = results.map(r => Number(r.gas[stage] ?? 0));
      const min = Math.min(...vals), max = Math.max(...vals);
      console.log([stage, ...vals, `spread ${(100 * (max / min - 1)).toFixed(2)}%`].join('\t'));
    }
    const totals = results.map(r => r.total);
    console.log(['TOTAL', ...totals, `spread ${(100 * (Math.max(...totals) / Math.min(...totals) - 1)).toFixed(2)}%`].join('\t'));
  };
  report('no-swap size gradient', noSwapResults);
  report('direct-swap size gradient', swapResults);
  report('range-width gradient', rangeResults);
  report('range-position gradient', positionResults);
  report('swap-position step check', swapPositionResults);

  console.log('\nJSON:');
  console.log(JSON.stringify({ pinnedSource: frame.source, tick: frame.tick, range, noSwapResults, swapResults, rangeResults, positionResults, swapPositionResults }, null, 1));
  await store.close();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
