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
// Usage: node --import tsx scripts/analysis/rangekeeper-size-gradient-gas.ts [no_swap|swap|both]
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
const FULL_WIDTH_SPACINGS = 20; // 200-tick width -- matches the NVDA-500 production config's own fullWidthSpacings.
// 25, 100, 250, 500, 1000 USDG: the same 40x span the static gradient covered.
const CAPITALS_USD = [25n, 100n, 250n, 500n, 1000n];
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

  const buildScope = (candidate: RangeKeeperCandidate, pathVersion: string, deployedValue: bigint, sharePpm: bigint, swapKind: 'none' | 'direct_pool_exact_input') => {
    const campaignId = randomUUID();
    const scopeBase = { poolAddress: p.pool, profileHash: registered.profileHash, deployedValue, sharePpm, range, swapKind };
    const candidateHash = rangeKeeperPaperCandidateHash({
      campaignId, revision: 1, profileHash: registered.profileHash, configHash: CONFIG_HASH,
      source: frame.source, referenceProofHash: frame.referenceProofHash, candidate,
    });
    return { ...scopeBase, candidateHash };
  };

  const runSample = async (label: string, candidate: RangeKeeperCandidate, pathVersion: string,
    stages: readonly string[], initialBalances: readonly [bigint, bigint], limits: RangeKeeperLimits) => {
    const sharePpm = candidate.liquidity * PPM / (frame.poolLiquidity + candidate.liquidity);
    const swapKind = candidate.swap ? 'direct_pool_exact_input' as const : 'none' as const;
    const scope = buildScope(candidate, pathVersion, candidate.deployedValue, sharePpm, swapKind);
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

  const noSwapResults: any[] = [];
  if (mode === 'no_swap' || mode === 'both') {
    console.log('=== no-swap open + retain-exit: size gradient ===');
    for (const capUsd of CAPITALS_USD) {
      const capWei = capUsd * WAD;
      const limits = limitsFor(capWei);
      // Ample funds on both legs (4x cap in value each) so the ONLY binding
      // constraint on deployed size is maxDeploymentValue, not token availability.
      const ample0 = capWei * 4n * 10n ** BigInt(decimals0) / frame.price0!;
      const ample1 = capWei * 4n * 10n ** BigInt(decimals1) / frame.price1!;
      const sized = sizeRangeKeeperMint(frame.sqrtPriceX96, range, ample0, ample1,
        frame.price0!, frame.price1!, decimals0, decimals1, capWei);
      if (sized.mint.liquidity === 0n) { console.log(`${capUsd} USDG: infeasible mint (liquidity=0), skipping`); continue; }
      const haircut = 10_000n - BigInt(limits.maxSlippageBps);
      const candidate: RangeKeeperCandidate = {
        kind: 'entry', range, swap: null, amount0Desired: sized.desired0, amount1Desired: sized.desired1,
        amount0Min: sized.mint.amount0 * haircut / 10_000n, amount1Min: sized.mint.amount1 * haircut / 10_000n,
        liquidity: sized.mint.liquidity, deployedValue: sized.deployed,
        sourceBlock: BigInt(frame.source.block), sourceHash: frame.source.hash as `0x${string}`,
        expiresAt: frame.source.timestamp + 90,
      };
      try {
        const result = await runSample(`${capUsd} USDG`, candidate, RANGEKEEPER_PAPER_NO_SWAP_PATH,
          [...RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP, ...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES],
          [sized.desired0, sized.desired1], limits);
        noSwapResults.push(result);
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

  console.log('\nJSON:');
  console.log(JSON.stringify({ pinnedSource: frame.source, tick: frame.tick, range, noSwapResults, swapResults }, null, 1));
  await store.close();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
