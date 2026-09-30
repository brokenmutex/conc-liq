// eth_simulateV1 gas-validation probe (docs/plans/operation-gate-simplification-
// 2026-09-30.md section 4c / section 5 item 4). Read-only: it reproduces the
// six static/no-swap paper-open stages that
// src/deployments/paper-gas-sampler.ts samples on an owned anvil fork
// (approve_token0, approve_token1, mint, withdraw_collect, cleanup_token0,
// cleanup_token1) as eth_simulateV1 sequences against the live provider, with
// storage overrides for token balances instead of a funded fork account. It
// also runs the UNMODIFIED sampleStaticPaperGas once, on the same candidate
// and source frame, so both methods are compared at literally the same
// state -- not against a possibly different historical band.
//
// No src/ file is modified. No transaction is broadcast: eth_simulateV1,
// eth_call, eth_getStorageAt, eth_getBlockByNumber and eth_blockNumber are
// the only RPC methods this script calls against the live provider; the fork
// baseline is the ordinary anvil-forked owned-fork path the sampler already
// uses. No draft, preview or operation is created; nothing is imported into
// deployment_calibration_profiles (DB access in this script is SELECT-only).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256,
  parseAbiParameters, stringToBytes, toHex,
} from 'viem';

// ---------------------------------------------------------------------------
// Credentials: loaded in-process from the operator-provided env file so no
// secret (the RPC API key embedded in the URL) ever appears in a shell
// command line, argv, or this script's own output.
function loadEnv(path = '/root/conc-liq/data/static-paper-mvp-dashboard-feedback-2026-09-28.env') {
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
loadEnv();

const { createRobinhoodClient } = await import('../../src/client.js');
const { DeploymentStore } = await import('../../src/deployments/store.js');
const { readCanonicalPaperOpenFrame, buildIndicativePaperOpenPreview } =
  await import('../../src/deployments/paper-preview.js');
const { buildStaticPaperSetupPreflight } = await import('../../src/deployments/paper-setup-preflight.js');
const { verifyCanonicalPaperAnchors } = await import('../../src/deployments/paper-canonical-anchors.js');
const { sampleStaticPaperGas } = await import('../../src/deployments/paper-gas-sampler.js');
const { contentHash, staticManualParameters } = await import('../../src/deployments/contracts.js');
const { PAPER_STATIC_GAS_STAGES } = await import('../../src/deployments/paper-cost.js');
const { PAPER_ACCOUNT, paperTokenAbi } = await import('../../src/paper/execution-abi.js');
const { guardedCanaryPositionManagerAbi } = await import('../../src/canary-plan/abi.js');
const { canaryExitAbi } = await import('../../src/canary-plan/exit.js');
const { poolAbi } = await import('../../src/abi.js');
const { principalAmounts } = await import('../../src/backtest/principal.js');

const PROFILE = 'a8e7096f-17c3-452c-a72f-8fa962e586d2';
const HALF_WIDTH = 60;
const CAPITAL_QUOTE_RAW = '250000000'; // 250 USDG -- irrelevant to gas per section 4, kept for a like-for-like fork run
const UINT128_MAX = (1n << 128n) - 1n;

const limitsFor = (capitalQuoteRaw) => {
  const usdX18 = BigInt(capitalQuoteRaw) * 10n ** 12n;
  return {
    maxDeploymentValue: String(usdX18), minDeploymentValue: '1000000000000000000',
    maxExposurePpm: 950000, maxLossValue: String(usdX18 / 20n), maxDrawdownPpm: 100000,
    maxActionCost: String(usdX18 / 20n), maxRollingCost: String(usdX18 / 10n),
    maxCampaignCost: String(usdX18 * 15n / 100n), exitReserveWei: '1000000000000000', maxSlippageBps: 50,
  };
};

// --- eth_simulateV1 helper --------------------------------------------------
async function simulateV1(client, blockTag, stateOverrides, calls) {
  const payload = [{
    blockStateCalls: [{
      stateOverrides,
      calls: calls.map(c => ({ from: PAPER_ACCOUNT, to: c.to, data: c.data })),
    }],
    validation: false, traceTransfers: false, returnFullTransactionObjects: false,
  }, blockTag];
  const result = await client.request({ method: 'eth_simulateV1', params: payload });
  const block = result[0];
  return {
    number: block.number, parentHash: block.parentHash, hash: block.hash,
    calls: block.calls.map(c => ({ status: c.status, gasUsed: BigInt(c.gasUsed), returnData: c.returnData })),
  };
}

// --- ERC20 balance storage-slot discovery -----------------------------------
// Tries the classic sequential-mapping layout first (balances at a low slot
// index, as most of the codebase's own fixtures assume), then the OpenZeppelin
// v5 ERC-7201 namespaced layout (used by upgradeable/proxy tokens). Verified
// experimentally against both pool tokens before this script was written:
// token0 matched the classic layout at slot 1, token1 only matched the
// ERC-7201 namespace ("openzeppelin.storage.ERC20", field 0).
function erc7201Base(id) {
  const h = BigInt(keccak256(stringToBytes(id)));
  const minus1 = toHex(h - 1n, { size: 32 });
  const full = BigInt(keccak256(minus1));
  return full & ~0xffn;
}
const mappingKey = (holder, slot) =>
  keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [holder, slot]));

async function findBalanceSlotKey(client, token, holder, blockNumber, blockTag) {
  const actual = await client.readContract({
    address: token, abi: paperTokenAbi, functionName: 'balanceOf', args: [holder], blockNumber,
  });
  if (actual === 0n) throw new Error(`Slot-discovery holder has zero balance of ${token}`);
  let requests = 0;
  for (let i = 0; i < 60; i++) {
    requests++;
    const key = mappingKey(holder, BigInt(i));
    const raw = await client.request({ method: 'eth_getStorageAt', params: [token, key, blockTag] });
    if (BigInt(raw) === actual) return { key, method: `classic_slot_${i}`, requests };
  }
  for (const ns of ['openzeppelin.storage.ERC20', 'openzeppelin.storage.ERC20Upgradeable']) {
    const base = erc7201Base(ns);
    for (let offset = 0; offset < 4; offset++) {
      requests++;
      const slot = base + BigInt(offset);
      const key = mappingKey(holder, slot);
      const raw = await client.request({ method: 'eth_getStorageAt', params: [token, key, blockTag] });
      if (BigInt(raw) === actual) return { key, method: `erc7201_${ns}_offset${offset}`, requests };
    }
  }
  throw new Error(`Could not locate the balance mapping slot for token ${token} (classic 0-59 and ERC-7201 scanned)`);
}

async function main() {
  const t0 = Date.now();
  let simulateRpcCount = 0;
  const countingClient = createRobinhoodClient(process.env.ROBINHOOD_READ_HTTP_URL, 20000);
  const originalRequest = countingClient.request.bind(countingClient);
  countingClient.request = async (args) => { simulateRpcCount++; return originalRequest(args); };

  const store = new DeploymentStore(process.env.DATABASE_URL);
  await store.assertReady();
  const registered = await store.paperSetupProfile(PROFILE);
  if (!registered) throw new Error('paper setup profile unavailable');
  const profile = registered.profile;
  const p = profile.pool;

  console.log('=== eth_simulateV1 gas-validation probe ===');
  console.log(`profile ${PROFILE} pool ${p.pool}`);

  // Token balance storage slots depend only on contract layout, not on the
  // frame/candidate, so they are discovered once up front (against the
  // current tip) and reused across retries below.
  const discoveryBlockNumber = await countingClient.getBlockNumber();
  const discoveryBlockTag = toHex(discoveryBlockNumber);
  const slot0 = await findBalanceSlotKey(countingClient, p.token0, p.pool, discoveryBlockNumber, discoveryBlockTag);
  const slot1 = await findBalanceSlotKey(countingClient, p.token1, p.pool, discoveryBlockNumber, discoveryBlockTag);
  console.log(`token0 balance slot: ${slot0.method} (${slot0.requests} probe requests)`);
  console.log(`token1 balance slot: ${slot1.method} (${slot1.requests} probe requests)`);

  const limits = limitsFor(CAPITAL_QUOTE_RAW);
  const config = staticManualParameters.parse({ halfWidthTicks: HALF_WIDTH, limits });
  const strategyId = 'static_manual_v1', strategyVersion = '1.0.0', stateSchemaVersion = 1;
  const bps = BigInt(config.limits.maxSlippageBps);

  // buildIndicativePaperOpenPreview's candidate amounts are derived from an
  // INDEPENDENT reference price, not the pool's own AMM price; the two can
  // differ by enough that the ACTUAL amounts Uniswap's mint consumes at the
  // pinned block fall outside the slippage floor built from the predicted
  // amounts, and the mint call in the prediction sequence reverts -- a real
  // economic condition (the same risk a live "open" click carries at that
  // block), not a defect in this script. Retry with a fresh live frame.
  const simStart = Date.now();
  let attempt = 0, frame, draft, preview, candidate, blockNumber, blockTag, canonicalBlock;
  let predict, predictedTokenId, predictedLiquidity, postMintSqrtPriceX96, predictElapsedMs;
  let stateOverrides, approve0Data, approve1Data, mintData;
  const MAX_ATTEMPTS = 5;
  for (; attempt < MAX_ATTEMPTS; attempt++) {
    frame = await readCanonicalPaperOpenFrame(countingClient, profile);
    console.log(`\n[attempt ${attempt + 1}] frame source block ${frame.source.block} tick ${frame.tick}`);

    const preflightInput = { profileId: PROFILE, capitalQuoteRaw: CAPITAL_QUOTE_RAW, halfWidthTicks: HALF_WIDTH, limits };
    const preflight = await buildStaticPaperSetupPreflight(preflightInput, {
      loadProfile: (id) => store.paperSetupProfile(id),
      readFrame: async () => frame,
      verifyCanonical: (chainId, source) => verifyCanonicalPaperAnchors(countingClient, chainId, [source]),
      readGasProfiles: async () => [], readGasPrice: async () => 1n,
      now: () => frame.source.timestamp * 1000 + 30_000,
    }, frame.source);
    if (!preflight.requirements) throw new Error(`preflight has no requirements: ${JSON.stringify(preflight.missing)}`);

    draft = {
      id: randomUUID(), revision: 1, profile, profileHash: registered.profileHash,
      configHash: contentHash({ ...config, strategyId, strategyVersion, stateSchemaVersion }),
      strategyId, strategyVersion, stateSchemaVersion, parameters: config,
      allocation: {
        token0Raw: preflight.requirements.token0Raw, token1Raw: preflight.requirements.token1Raw,
        nativeWei: limits.exitReserveWei,
      },
    };

    // Reproduce the sampler's own first step, unmodified, so the candidate
    // (tick range, mint amounts, minimums) is identical to what the fork
    // sampler will build from the same draft/frame.
    preview = buildIndicativePaperOpenPreview(draft, frame);
    if (preview.status !== 'indicative' || !preview.candidate) {
      console.log(`  preview unavailable (${preview.reason}), retrying`);
      continue;
    }
    candidate = preview.candidate;
    console.log(`  candidate range ${candidate.range.tickLower}/${candidate.range.tickUpper} `
      + `deployedValue ${candidate.deployedValue} sharePpm ${candidate.dilutedSharePpm}`);

    blockNumber = BigInt(frame.source.block);
    blockTag = toHex(blockNumber);
    canonicalBlock = await countingClient.getBlock({ blockNumber });
    if (canonicalBlock.hash.toLowerCase() !== frame.source.hash.toLowerCase()) {
      console.log('  canonical block hash drifted between frame read and probe, retrying');
      continue;
    }

    const amount0 = BigInt(candidate.amount0Desired), amount1 = BigInt(candidate.amount1Desired);
    stateOverrides = {
      [p.token0]: { stateDiff: { [slot0.key]: toHex(amount0, { size: 32 }) } },
      [p.token1]: { stateDiff: { [slot1.key]: toHex(amount1, { size: 32 }) } },
      [PAPER_ACCOUNT]: { balance: toHex(10n ** 18n) },
    };

    const sourceTimestamp = BigInt(frame.source.timestamp);
    const deadline = sourceTimestamp + 300n;
    const min0 = BigInt(candidate.amount0Minted) * (10_000n - bps) / 10_000n;
    const min1 = BigInt(candidate.amount1Minted) * (10_000n - bps) / 10_000n;

    approve0Data = encodeFunctionData({ abi: paperTokenAbi, functionName: 'approve', args: [p.positionManager, amount0] });
    approve1Data = encodeFunctionData({ abi: paperTokenAbi, functionName: 'approve', args: [p.positionManager, amount1] });
    mintData = encodeFunctionData({
      abi: guardedCanaryPositionManagerAbi, functionName: 'mint', args: [{
        token0: p.token0, token1: p.token1, fee: p.fee,
        tickLower: candidate.range.tickLower, tickUpper: candidate.range.tickUpper,
        amount0Desired: amount0, amount1Desired: amount1, amount0Min: min0, amount1Min: min1,
        recipient: PAPER_ACCOUNT, deadline,
      }],
    });
    const slot0ReadData = encodeFunctionData({ abi: poolAbi, functionName: 'slot0', args: [] });

    // Round trip A: predict the minted tokenId, liquidity and minted amounts,
    // and the post-mint pool price, from the sequence's own return data --
    // nothing here is assumed from the fork or the DB.
    const predictStart = Date.now();
    predict = await simulateV1(countingClient, blockTag, stateOverrides, [
      { to: p.token0, data: approve0Data },
      { to: p.token1, data: approve1Data },
      { to: p.positionManager, data: mintData },
      { to: p.pool, data: slot0ReadData },
    ]);
    predictElapsedMs = Date.now() - predictStart;
    const [predictApprove0, predictApprove1, predictMint, predictSlot0] = predict.calls;
    if (predictApprove0.status !== '0x1' || predictApprove1.status !== '0x1' || predictMint.status !== '0x1' || predictSlot0.status !== '0x1') {
      console.log(`  prediction sequence had a non-success call `
        + `${JSON.stringify(predict.calls.map(c => c.status))}, retrying with a fresh frame`);
      continue;
    }
    [predictedTokenId, predictedLiquidity] = decodeFunctionResult({
      abi: guardedCanaryPositionManagerAbi, functionName: 'mint', data: predictMint.returnData,
    });
    [postMintSqrtPriceX96] = decodeFunctionResult({ abi: poolAbi, functionName: 'slot0', data: predictSlot0.returnData });
    console.log(`  predicted tokenId ${predictedTokenId} liquidity ${predictedLiquidity} `
      + `(round trip A: ${predictElapsedMs}ms)`);
    break;
  }
  if (attempt >= MAX_ATTEMPTS) throw new Error(`could not get a viable candidate/prediction in ${MAX_ATTEMPTS} attempts`);
  const mintRevertRetries = attempt;

  // --- Ground truth: run the UNMODIFIED owned-fork sampler on this exact
  // draft/frame, so the comparison is against the same candidate and the
  // same canonical source, not a historical band that may differ in range. ---
  console.log('\n--- running unmodified sampleStaticPaperGas (owned anvil fork) for ground truth ---');
  const forkStart = Date.now();
  let forkReport = null, forkError = null;
  try {
    forkReport = await sampleStaticPaperGas({
      rpcUrl: process.env.PAPER_FORK_RPC_URL, draft, frame,
      beforeRead: async () => {}, maxRequests: 1200, timeoutMs: 240_000,
    });
  } catch (error) {
    forkError = error;
  }
  const forkElapsedMs = Date.now() - forkStart;
  if (forkReport) {
    console.log(`fork sample OK in ${(forkElapsedMs / 1000).toFixed(1)}s, `
      + `readBudget ${forkReport.readBudget.requests} requests`);
  } else {
    console.log(`fork sample FAILED after ${(forkElapsedMs / 1000).toFixed(1)}s: ${forkError?.message ?? forkError}`);
  }

  console.log('\n--- eth_simulateV1 probe: round trip B ---');

  const principal = principalAmounts({
    liquidity: predictedLiquidity, tickLower: candidate.range.tickLower, tickUpper: candidate.range.tickUpper,
    sqrtPriceX96: postMintSqrtPriceX96,
  });
  const withdrawMin0 = principal.amount0 * (10_000n - bps) / 10_000n;
  const withdrawMin1 = principal.amount1 * (10_000n - bps) / 10_000n;
  const withdrawCalls = [
    encodeFunctionData({
      abi: canaryExitAbi, functionName: 'decreaseLiquidity', args: [{
        tokenId: predictedTokenId, liquidity: predictedLiquidity, amount0Min: withdrawMin0, amount1Min: withdrawMin1, deadline,
      }],
    }),
    encodeFunctionData({
      abi: canaryExitAbi, functionName: 'collect', args: [{
        tokenId: predictedTokenId, recipient: PAPER_ACCOUNT, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX,
      }],
    }),
  ];
  const withdrawCollectData = encodeFunctionData({ abi: canaryExitAbi, functionName: 'multicall', args: [withdrawCalls] });
  const cleanup0Data = encodeFunctionData({ abi: paperTokenAbi, functionName: 'approve', args: [p.positionManager, 0n] });
  const cleanup1Data = encodeFunctionData({ abi: paperTokenAbi, functionName: 'approve', args: [p.positionManager, 0n] });

  // Round trip B: the full six-stage sequence, in PAPER_STATIC_GAS_STAGES
  // order, using the tokenId/liquidity/price predicted in round trip A. This
  // is the measurement that is reported below.
  const finalStart = Date.now();
  const final = await simulateV1(countingClient, blockTag, stateOverrides, [
    { to: p.token0, data: approve0Data },
    { to: p.token1, data: approve1Data },
    { to: p.positionManager, data: mintData },
    { to: p.positionManager, data: withdrawCollectData },
    { to: p.token0, data: cleanup0Data },
    { to: p.token1, data: cleanup1Data },
  ]);
  const finalElapsedMs = Date.now() - finalStart;
  const simElapsedMs = Date.now() - simStart;

  const [cApprove0, cApprove1, cMint, cWithdraw, cCleanup0, cCleanup1] = final.calls;
  const [confirmedTokenId, confirmedLiquidity] = decodeFunctionResult({
    abi: guardedCanaryPositionManagerAbi, functionName: 'mint', data: cMint.returnData,
  });
  const tokenIdDeterministic = confirmedTokenId === predictedTokenId && confirmedLiquidity === predictedLiquidity;

  const statuses = { approve_token0: cApprove0.status, approve_token1: cApprove1.status, mint: cMint.status,
    withdraw_collect: cWithdraw.status, cleanup_token0: cCleanup0.status, cleanup_token1: cCleanup1.status };
  const allOk = Object.values(statuses).every(s => s === '0x1');
  const simGas = { approve_token0: cApprove0.gasUsed, approve_token1: cApprove1.gasUsed, mint: cMint.gasUsed,
    withdraw_collect: cWithdraw.gasUsed, cleanup_token0: cCleanup0.gasUsed, cleanup_token1: cCleanup1.gasUsed };

  // --- Block provenance test: can eth_simulateV1 prove which block state it
  // used, the way the fork's `first.hash===source.hash` assertion does? ---
  const provenanceMatches = final.parentHash.toLowerCase() === canonicalBlock.hash.toLowerCase();

  // --- Compare against DB calibration bands at the SAME tick range, if any
  // exist (per instruction #3; likely none for a brand-new live range, per
  // section 4b's own finding that ranges rarely recur between consecutive
  // opens -- reported honestly either way). Uses the store's own public,
  // read-only, bounded lookup rather than an ad hoc query. ---
  const bandRows = await store.paperGasProfiles(p.pool, candidate.range.tickLower, candidate.range.tickUpper);
  const dbBandByStage = new Map();
  for (const row of bandRows) {
    const prior = dbBandByStage.get(row.stage);
    if (!prior || row.version > prior.version) dbBandByStage.set(row.stage, row);
  }

  // --- Report ---------------------------------------------------------------
  console.log(`\nblock provenance: sim parentHash ${final.parentHash} vs canonical block hash ${canonicalBlock.hash}`);
  console.log(`provenance match: ${provenanceMatches}`);
  console.log(`tokenId determinism across the two round trips: ${tokenIdDeterministic} `
    + `(predicted ${predictedTokenId}, confirmed ${confirmedTokenId})`);
  console.log(`all six calls succeeded: ${allOk} (${JSON.stringify(statuses)})`);

  console.log('\n=== per-stage comparison ===');
  console.log(['stage', 'sim_gas', 'fork_gas', 'delta_pct', 'db_same_range_gas', 'db_delta_pct'].join('\t'));
  const rows = [];
  for (const stage of PAPER_STATIC_GAS_STAGES) {
    const sim = simGas[stage];
    const forkStage = forkReport?.stageProfiles.find(s => s.stage === stage);
    const forkGas = forkStage ? BigInt(forkStage.model.gasUnitsExpected) : null;
    const forkDelta = forkGas ? (Number(sim - forkGas) / Number(forkGas) * 100).toFixed(2) : 'n/a';
    const dbRow = dbBandByStage.get(stage);
    const dbGas = dbRow ? BigInt(dbRow.model.gasUnitsExpected) : null;
    const dbDelta = dbGas ? (Number(sim - dbGas) / Number(dbGas) * 100).toFixed(2) : 'n/a';
    console.log([stage, sim.toString(), forkGas?.toString() ?? 'n/a', forkDelta, dbGas?.toString() ?? 'n/a', dbDelta].join('\t'));
    rows.push({ stage, simGas: sim.toString(), forkGas: forkGas?.toString() ?? null, forkDeltaPct: forkGas ? Number(forkDelta) : null,
      dbGas: dbGas?.toString() ?? null, dbDeltaPct: dbGas ? Number(dbDelta) : null,
      dbBlock: dbRow?.model.source.block ?? null, dbEstimatedAt: dbRow?.model.source.estimatedAt ?? null });
  }

  console.log(`\ntiming: eth_simulateV1 total ${simElapsedMs}ms (round trip A ${predictElapsedMs}ms, `
    + `round trip B ${finalElapsedMs}ms, slot discovery ${slot0.requests + slot1.requests} requests) `
    + `vs owned-fork ${forkReport ? (forkElapsedMs / 1000).toFixed(1) + 's' : 'FAILED after ' + (forkElapsedMs / 1000).toFixed(1) + 's'}`);
  console.log(`total RPC requests against the live provider (this script's client): ${simulateRpcCount}`);
  console.log(`fork read budget (owned local fork, separate provider budget): ${forkReport ? forkReport.readBudget.requests : 'n/a'}`);

  console.log('\nJSON_RESULT_START');
  console.log(JSON.stringify({
    profile: PROFILE, pool: p.pool, source: frame.source,
    candidate: { range: candidate.range, deployedValue: candidate.deployedValue, dilutedSharePpm: candidate.dilutedSharePpm },
    slotDiscovery: { token0: slot0.method, token1: slot1.method },
    provenance: { simParentHash: final.parentHash, canonicalBlockHash: canonicalBlock.hash, matches: provenanceMatches },
    tokenIdDeterminism: { predicted: predictedTokenId.toString(), confirmed: confirmedTokenId.toString(), matches: tokenIdDeterministic },
    statuses, rows,
    timing: { simTotalMs: simElapsedMs, roundTripAMs: predictElapsedMs, roundTripBMs: finalElapsedMs,
      forkMs: forkReport ? forkElapsedMs : null, forkFailed: forkReport ? false : true, forkError: forkError ? String(forkError.message ?? forkError) : null },
    requestCounts: { simulateProbeClient: simulateRpcCount, forkReadBudget: forkReport ? forkReport.readBudget.requests : null },
    totalScriptElapsedMs: Date.now() - t0,
  }, null, 1));
  console.log('JSON_RESULT_END');

  await store.close();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
