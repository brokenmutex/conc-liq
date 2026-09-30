// eth_simulateV1 swap-validation probe (docs/plans/rangekeeper-dashboard-integration-
// 2026-09-30.md section 1 / section 3 item 1). Read-only: it reproduces the
// swap-involving RangeKeeper open stages (RANGEKEEPER_PAPER_OPEN_STAGES_SWAP
// plus the retain-exit stages that follow it in the same owned-fork sequence)
// as eth_simulateV1 call sequences against the live provider, with a storage
// override funding only the swap's INPUT token (the acquired leg arrives from
// the swap itself, exactly as production funds it). It also runs the
// UNMODIFIED sampleRangeKeeperPaperGasStages (owned anvil fork) once, on the
// identical candidate and source frame, so both methods are compared at
// literally the same state, not against a possibly different historical band.
//
// No src/ file is modified. No transaction is broadcast against the live
// provider: eth_simulateV1, eth_call, eth_getStorageAt and eth_getBlockByNumber
// are the RPC methods this script calls directly against it for the probe
// mechanics. Reused production helpers (readCanonicalPaperOpenFrame's
// RangeKeeperChain.verify, RangeKeeperChain.quote) also make ordinary
// read-only eth_getCode / eth_chainId / eth_gasPrice calls as part of
// existing, already-reviewed canonical-source verification -- flagged here
// rather than reimplemented, since avoiding that verification would make the
// pinned source itself unproven. The fork baseline runs the ordinary
// anvil-forked owned-fork sampler (src/deployments/rangekeeper-paper-gas-sampler.js)
// unmodified; its own sends happen only against the LOCAL anvil fork it
// spawns, never against the live provider. DB access in this script is
// SELECT-only (DeploymentStore's public read methods).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256,
  parseAbiParameters, toHex,
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
const { readCanonicalPaperOpenFrame } = await import('../../src/deployments/paper-preview.js');
const { RangeKeeperChain } = await import('../../src/strategy/rangekeeper/chain.js');
const { encodeRangeKeeperTx } = await import('../../src/strategy/rangekeeper/calldata.js');
const { planRangeKeeper, rawValue } = await import('../../src/strategy/rangekeeper/planner.js');
const { sampleRangeKeeperPaperGasStages } = await import('../../src/deployments/rangekeeper-paper-gas-sampler.js');
const { rangeKeeperPaperCandidateHash, rangeKeeperPaperPathVersion,
  RANGEKEEPER_PAPER_OPEN_STAGES_SWAP, RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES } =
  await import('../../src/deployments/rangekeeper-paper-cost.js');
const { contentHash } = await import('../../src/deployments/contracts.js');
const { principalAmounts } = await import('../../src/backtest/principal.js');
const { PAPER_ACCOUNT, paperTokenAbi, paperRouterAbi } = await import('../../src/paper/execution-abi.js');
const { guardedCanaryPositionManagerAbi } = await import('../../src/canary-plan/abi.js');
const { canaryExitAbi } = await import('../../src/canary-plan/exit.js');
const { poolAbi } = await import('../../src/abi.js');

const PPM = 1_000_000n;

// Policy limits for this probe only -- not a src/ change. fullWidthSpacings=4
// and the value/slippage/exposure ceilings mirror the real, currently
// disabled RangeKeeper operator config (config/rangekeeper-v1-aapl-disabled.json)
// so the candidate this probe builds is representative of a real campaign,
// not an artificial one. maxSlippageBps is capped at 50 by rangeKeeperParameters
// AND by sampleRangeKeeperPaperGasStages's own assertion -- unlike the static
// probe's 500bps schema ceiling, there is no wider tolerance available here;
// if a mint/swap reverts at this ceiling, it is reported, not routed around.
function limitsFor() {
  return {
    fullWidthSpacings: 4,
    maxDeploymentValue: 250_000_000_000_000_000_000n, // 250 USD x 1e18
    minDeploymentPpm: 980_000,
    maxSwapInputValue: 150_000_000_000_000_000_000n,
    maxSwapInputPpm: 600_000,
    maxSwapShortfallValue: 2_000_000_000_000_000_000n,
    maxSlippageBps: 50,
    maxActionCost: 5_000_000_000_000_000_000n,
    maxRollingCost: 10_000_000_000_000_000_000n,
    maxCampaignCost: 15_000_000_000_000_000_000n,
    maxExposurePpm: 950_000,
    maxLossValue: 20_000_000_000_000_000_000n,
    maxDrawdownPpm: 100_000,
    maxRecenters: 4,
    maxLiquiditySharePpm: 20_000,
    maxObservationGapSeconds: 90,
    exitReserveWei: 1_000_000_000_000_000n,
  };
}

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
// Same bounded scan as src/deployments/paper-gas-simulation-sampler.ts: classic
// sequential mapping slots first, then OpenZeppelin's ERC-7201 namespaced
// layout. Only the swap's INPUT token needs funding here -- the acquired leg
// starts at zero and arrives from the swap itself, same as production.
function erc7201Base(id) {
  const h = BigInt(keccak256(new TextEncoder().encode(id)));
  const minus1 = toHex(h - 1n, { size: 32 });
  const full = BigInt(keccak256(minus1));
  return full & ~0xffn;
}
const mappingKey = (holder, slot) =>
  keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [holder, slot]));

async function findBalanceSlot(client, token, holder, blockNumber, blockTag) {
  const actual = await client.readContract({
    address: token, abi: paperTokenAbi, functionName: 'balanceOf', args: [holder], blockNumber,
  });
  if (actual === 0n) throw new Error(`Slot-discovery holder has zero balance of ${token}`);
  let requests = 0;
  for (let i = 0; i < 60; i++) {
    requests++;
    const key = mappingKey(holder, BigInt(i));
    const raw = await client.request({ method: 'eth_getStorageAt', params: [token, key, blockTag] });
    if (BigInt(raw) === actual) return { slot: BigInt(i), method: `classic_slot_${i}`, requests };
  }
  for (const ns of ['openzeppelin.storage.ERC20', 'openzeppelin.storage.ERC20Upgradeable']) {
    const base = erc7201Base(ns);
    for (let offset = 0; offset < 4; offset++) {
      requests++;
      const slot = base + BigInt(offset);
      const key = mappingKey(holder, slot);
      const raw = await client.request({ method: 'eth_getStorageAt', params: [token, key, blockTag] });
      if (BigInt(raw) === actual) return { slot, method: `erc7201_${ns}_offset${offset}`, requests };
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
  const registeredProfiles = await store.listMarketProfiles();
  const candidates = registeredProfiles.filter(row => row.draftAvailable && row.pool);
  if (candidates.length === 0) throw new Error('No draft-available registered market profile found');

  console.log('=== eth_simulateV1 RangeKeeper swap-validation probe ===');
  console.log(`${candidates.length} draft-available registered profile(s) to try`);

  const limits = limitsFor();
  let chosen = null, frame = null, profileRow = null, profileHash = null;
  for (const row of candidates) {
    const loaded = await store.paperSetupProfile(row.id);
    if (!loaded) continue;
    const f = await readCanonicalPaperOpenFrame(countingClient, loaded.profile);
    console.log(`profile ${row.id} pool ${loaded.profile.pool.pool} reference0 ${loaded.profile.pool.reference0} `
      + `reference1 ${loaded.profile.pool.reference1} eligible=${f.referenceEligible} reasons=${f.referenceReasons.join(',') || 'none'}`);
    if (f.referenceEligible) { chosen = loaded; frame = f; profileRow = row; profileHash = loaded.profileHash; break; }
  }
  if (!chosen) throw new Error('No registered profile currently has eligible independent references');
  const profile = chosen.profile, p = profile.pool;
  console.log(`\nselected profile ${profileRow.id} pool ${p.pool} (${p.reference0}/${p.reference1}) `
    + `source block ${frame.source.block} tick ${frame.tick}`);

  // Token balance storage slot for the swap's input token (the quote/stable
  // leg -- funded entirely one-sided on purpose, below, to force a swap-path
  // candidate rather than a no-swap one).
  const inputTokenGuess = p.quoteToken === 0 ? p.token0 : p.token1;
  const discoveryBlockNumber = await countingClient.getBlockNumber();
  const discoveryBlockTag = toHex(discoveryBlockNumber);
  const inputSlot = await findBalanceSlot(countingClient, inputTokenGuess, p.pool, discoveryBlockNumber, discoveryBlockTag);
  console.log(`input token (${inputTokenGuess}) balance slot: ${inputSlot.method} (${inputSlot.requests} probe requests)`);

  const chain = new RangeKeeperChain(countingClient, p);
  const source = { block: BigInt(frame.source.block), hash: frame.source.hash, timestamp: frame.source.timestamp };
  const quote = (token, amountIn) => chain.quote(source, token, amountIn, frame.price0, frame.price1);

  // One-sided funding (all capital in the quote leg) so construct() in
  // strategy/rangekeeper/planner.js must take the swap branch to fund a
  // full-width mint -- this is the representative real-world case (a fresh
  // paper campaign funded in USDG only), not a contrived one.
  const decimalsIn = p.quoteToken === 0 ? p.decimals0 : p.decimals1;
  const capitalRaw = 300n * 10n ** BigInt(decimalsIn); // ~300 USD-equivalent, under maxDeploymentValue after mint sizing
  const wallet0 = p.quoteToken === 0 ? capitalRaw : 0n;
  const wallet1 = p.quoteToken === 1 ? capitalRaw : 0n;
  const strategyValue = rawValue(wallet0, frame.price0, p.decimals0) + rawValue(wallet1, frame.price1, p.decimals1);

  const state = { schemaVersion: 1, policyId: 'rangekeeper_v1', strategyVersion: '1.0.0',
    configHash: `0x${contentHash({ probe: 'swap-simulation-2026-09-30' })}`, buildId: 'swap-simulation-probe',
    lastEligible: null, exit: null, confirmation: null };
  const observation = { block: source.block, hash: source.hash, timestamp: source.timestamp,
    tick: frame.tick, sqrtPriceX96: frame.sqrtPriceX96, continuity: 'canonical',
    wallet0, wallet1, released0: 0n, released1: 0n, nativeWei: 10n ** 18n,
    requiredExitReserveWei: limits.exitReserveWei, price0: frame.price0, price1: frame.price1,
    nativePrice: frame.nativePrice, position: null, pending: false, entryAllowed: true,
    safeExitRequired: false, executionReady: true, liquiditySharePpm: 0,
    actionCost: limits.maxActionCost, actionGasWei: 0n, reservedCost: 0n, rollingSpentCost: 0n,
    campaignSpentCost: 0n, campaignStartValue: strategyValue, highWaterValue: strategyValue, recenters: 0 };
  const kernelInput = { state, observation, limits, spacing: p.tickSpacing, decimals0: p.decimals0,
    decimals1: p.decimals1, quoteToken: p.quoteToken, maxPoolDeviationPpm: profile.referencePolicy.maxPoolDeviationPpm,
    quote, simulate: async () => true };

  const probe = await planRangeKeeper(kernelInput);
  console.log(`\nplanRangeKeeper: action=${probe.action} reason=${probe.reason} hasCandidate=${!!probe.candidate} `
    + `hasSwap=${!!probe.candidate?.swap}`);
  if (!probe.candidate) throw new Error(`No candidate constructed: ${probe.reason}`);
  if (!probe.candidate.swap) throw new Error('Candidate has no swap leg -- one-sided funding should force one; investigate planner sizing');
  const candidate = probe.candidate;
  console.log(`candidate range ${candidate.range.tickLower}/${candidate.range.tickUpper} `
    + `swap token${candidate.swap.token} amountIn ${candidate.swap.amountIn} quotedOut ${candidate.swap.quotedOut} `
    + `priceAfter ${candidate.swap.priceAfter} deployedValue ${candidate.deployedValue}`);

  const candidateAndPredictMs = Date.now() - t0;

  // --- Ground truth: run the UNMODIFIED owned-fork sampler on this exact
  // candidate/frame, so the comparison is against the same state, not a
  // historical band that may differ in range/size. ---
  const pathVersion = rangeKeeperPaperPathVersion(candidate);
  const stages = [...RANGEKEEPER_PAPER_OPEN_STAGES_SWAP, ...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES];
  const campaignId = randomUUID();
  const candidateHash = rangeKeeperPaperCandidateHash({ campaignId, revision: 1, profileHash,
    configHash: state.configHash.slice(2), source: frame.source, referenceProofHash: frame.referenceProofHash, candidate });
  const denominator = frame.poolLiquidity + candidate.liquidity;
  const sharePpm = candidate.liquidity * PPM / denominator;
  const scope = { poolAddress: p.pool, profileHash, candidateHash, deployedValue: candidate.deployedValue,
    sharePpm, range: candidate.range, swapKind: 'direct_pool_exact_input' };
  const request = { kind: 'open', profile, frame, candidate, candidateSource: frame.source,
    candidateReferenceProofHash: frame.referenceProofHash, candidateHash, scope, pathVersion, stages,
    openMarkId: null, openModelHash: null };

  console.log('\n--- running unmodified sampleRangeKeeperPaperGasStages (owned anvil fork) for ground truth ---');
  const forkStart = Date.now();
  let forkRows = null, forkError = null;
  try {
    forkRows = await sampleRangeKeeperPaperGasStages(request, { rpcUrl: process.env.PAPER_FORK_RPC_URL,
      beforeRead: async () => {}, maxRequests: 1600, timeoutMs: 300_000, limits, initialBalances: [wallet0, wallet1] });
  } catch (error) { forkError = error; }
  const forkElapsedMs = Date.now() - forkStart;
  if (forkRows) console.log(`fork sample OK in ${(forkElapsedMs / 1000).toFixed(1)}s, ${forkRows.length} stages`);
  else console.log(`fork sample FAILED after ${(forkElapsedMs / 1000).toFixed(1)}s: ${forkError?.message ?? forkError}`);

  // --- eth_simulateV1 probe ---------------------------------------------------
  console.log('\n--- eth_simulateV1 probe: round trip A (predict) ---');
  const blockNumber = BigInt(frame.source.block), blockTag = toHex(blockNumber);
  const canonicalBlock = await countingClient.getBlock({ blockNumber });
  if (canonicalBlock.hash.toLowerCase() !== frame.source.hash.toLowerCase())
    throw new Error('Canonical block hash drifted between frame read and probe');

  const paperAccountInputSlotKey = mappingKey(PAPER_ACCOUNT, inputSlot.slot);
  const stateOverrides = {
    [inputTokenGuess]: { stateDiff: { [paperAccountInputSlotKey]: toHex(wallet0 || wallet1, { size: 32 }) } },
    [PAPER_ACCOUNT]: { balance: toHex(10n ** 18n) },
  };

  const inputToken = candidate.swap.token, acquired = inputToken === 0 ? 1 : 0;
  const initial = [wallet0, wallet1];
  const acquiredPrice = acquired === 0 ? frame.price0 : frame.price1;
  const acquiredDecimals = acquired === 0 ? p.decimals0 : p.decimals1;
  const acquiredCap = limits.maxDeploymentValue * 10n ** BigInt(acquiredDecimals) / acquiredPrice;
  const futureCap = initial[acquired] > acquiredCap ? initial[acquired] : acquiredCap;
  const deadline = BigInt(frame.source.timestamp) + 300n;

  const approveManagerInput = encodeRangeKeeperTx(p, PAPER_ACCOUNT,
    { kind: 'approve', token: inputToken, spender: 'positionManager', amount: initial[inputToken] });
  const approveManagerAcquired = encodeRangeKeeperTx(p, PAPER_ACCOUNT,
    { kind: 'approve', token: acquired, spender: 'positionManager', amount: futureCap });
  const approveRouterInput = encodeRangeKeeperTx(p, PAPER_ACCOUNT,
    { kind: 'approve', token: inputToken, spender: 'router', amount: initial[inputToken] });
  const swapCall = encodeRangeKeeperTx(p, PAPER_ACCOUNT,
    { kind: 'swap', token: candidate.swap.token, amountIn: candidate.swap.amountIn, minOut: candidate.swap.minOut, deadline });
  const mintCall = encodeRangeKeeperTx(p, PAPER_ACCOUNT, { kind: 'mint', candidate, deadline });
  const slot0Data = encodeFunctionData({ abi: poolAbi, functionName: 'slot0', args: [] });

  const predictStart = Date.now();
  const predict = await simulateV1(countingClient, blockTag, stateOverrides, [
    approveManagerInput, approveManagerAcquired, approveRouterInput, swapCall, mintCall,
    { to: p.pool, data: slot0Data },
  ]);
  const predictElapsedMs = Date.now() - predictStart;
  const [pApproveInput, pApproveAcquired, pApproveRouter, pSwap, pMint, pSlot0] = predict.calls;
  const roundAStatuses = { open_approve_manager_input: pApproveInput.status, open_approve_manager_acquired: pApproveAcquired.status,
    open_approve_router_input: pApproveRouter.status, open_swap: pSwap.status, open_mint: pMint.status, slot0_probe: pSlot0.status };
  console.log(`round trip A statuses: ${JSON.stringify(roundAStatuses)}`);
  if (Object.values(roundAStatuses).some(s => s !== '0x1'))
    throw new Error(`Round trip A had a non-success call: ${JSON.stringify(roundAStatuses)}`);

  // Decode the swap's actual output through the router's multicall wrapper,
  // and the pool's post-mint price -- this is the direct test of the hazard
  // named in the brief: does eth_simulateV1 apply the swap's price impact to
  // the state the LATER mint call in the same sequence sees?
  const swapMulticallResult = decodeFunctionResult({ abi: paperRouterAbi, functionName: 'multicall', data: pSwap.returnData });
  const actualSwapOut = decodeFunctionResult({ abi: paperRouterAbi, functionName: 'exactInputSingle', data: swapMulticallResult[0] });
  const [predictedTokenId, predictedLiquidity, predictedMinted0, predictedMinted1] = decodeFunctionResult({
    abi: guardedCanaryPositionManagerAbi, functionName: 'mint', data: pMint.returnData });
  const [postMintSqrtPriceX96, postMintTick] = decodeFunctionResult({ abi: poolAbi, functionName: 'slot0', data: pSlot0.returnData });
  console.log(`predicted tokenId ${predictedTokenId} liquidity ${predictedLiquidity} `
    + `actualSwapOut ${actualSwapOut} (quoted ${candidate.swap.quotedOut}) `
    + `postMintTick ${postMintTick} (pre-swap tick ${frame.tick}) (round trip A: ${predictElapsedMs}ms)`);
  const priceKnowinglyMoved = postMintTick !== frame.tick;

  console.log('\n--- eth_simulateV1 probe: round trip B (full 10-stage sequence) ---');
  const principal = principalAmounts({ liquidity: predictedLiquidity, tickLower: candidate.range.tickLower,
    tickUpper: candidate.range.tickUpper, sqrtPriceX96: postMintSqrtPriceX96 });
  const haircut = 10_000n - BigInt(limits.maxSlippageBps);
  const withdrawCall = encodeRangeKeeperTx(p, PAPER_ACCOUNT, { kind: 'withdraw', tokenId: predictedTokenId,
    liquidity: predictedLiquidity, min0: principal.amount0 * haircut / 10_000n, min1: principal.amount1 * haircut / 10_000n, deadline });
  const cleanupRouter0 = encodeRangeKeeperTx(p, PAPER_ACCOUNT, { kind: 'approve', token: 0, spender: 'router', amount: 0n });
  const cleanupRouter1 = encodeRangeKeeperTx(p, PAPER_ACCOUNT, { kind: 'approve', token: 1, spender: 'router', amount: 0n });
  const cleanupManager0 = encodeRangeKeeperTx(p, PAPER_ACCOUNT, { kind: 'approve', token: 0, spender: 'positionManager', amount: 0n });
  const cleanupManager1 = encodeRangeKeeperTx(p, PAPER_ACCOUNT, { kind: 'approve', token: 1, spender: 'positionManager', amount: 0n });

  const finalStart = Date.now();
  const final = await simulateV1(countingClient, blockTag, stateOverrides, [
    approveManagerInput, approveManagerAcquired, approveRouterInput, swapCall, mintCall,
    withdrawCall, cleanupRouter0, cleanupRouter1, cleanupManager0, cleanupManager1,
  ]);
  const finalElapsedMs = Date.now() - finalStart;
  const gasSamplingOnlyMs = predictElapsedMs + finalElapsedMs;
  const simElapsedMs = candidateAndPredictMs + finalElapsedMs;

  const statuses = {}; stages.forEach((stage, i) => { statuses[stage] = final.calls[i].status; });
  const allOk = Object.values(statuses).every(s => s === '0x1');
  console.log(`round trip B statuses: ${JSON.stringify(statuses)}`);
  if (!allOk) throw new Error(`Round trip B had a non-success call: ${JSON.stringify(statuses)}`);

  const [fApproveInput, fApproveAcquired, fApproveRouter, fSwap, fMint, fWithdraw, fCleanupR0, fCleanupR1, fCleanupM0, fCleanupM1] = final.calls;
  const [confirmedTokenId, confirmedLiquidity] = decodeFunctionResult({
    abi: guardedCanaryPositionManagerAbi, functionName: 'mint', data: fMint.returnData });
  const tokenIdDeterministic = confirmedTokenId === predictedTokenId && confirmedLiquidity === predictedLiquidity;

  const withdrawMulticallResult = decodeFunctionResult({ abi: canaryExitAbi, functionName: 'multicall', data: fWithdraw.returnData });
  const decreased = decodeFunctionResult({ abi: canaryExitAbi, functionName: 'decreaseLiquidity', data: withdrawMulticallResult[0] });
  const collected = decodeFunctionResult({ abi: canaryExitAbi, functionName: 'collect', data: withdrawMulticallResult[1] });
  const collectionCoversPrincipal = collected[0] >= decreased[0] && collected[1] >= decreased[1];

  const provenanceMatches = final.parentHash.toLowerCase() === canonicalBlock.hash.toLowerCase();

  const simGas = { open_approve_manager_input: fApproveInput.gasUsed, open_approve_manager_acquired: fApproveAcquired.gasUsed,
    open_approve_router_input: fApproveRouter.gasUsed, open_swap: fSwap.gasUsed, open_mint: fMint.gasUsed,
    exit_withdraw_collect: fWithdraw.gasUsed, exit_cleanup_router_token0: fCleanupR0.gasUsed,
    exit_cleanup_router_token1: fCleanupR1.gasUsed, exit_cleanup_manager_token0: fCleanupM0.gasUsed,
    exit_cleanup_manager_token1: fCleanupM1.gasUsed };

  console.log(`\nblock provenance: sim parentHash ${final.parentHash} vs canonical block hash ${canonicalBlock.hash} match=${provenanceMatches}`);
  console.log(`tokenId determinism across round trips: ${tokenIdDeterministic} (predicted ${predictedTokenId}, confirmed ${confirmedTokenId})`);
  console.log(`withdraw collection covers decreased principal: ${collectionCoversPrincipal} `
    + `(decreased ${decreased[0]}/${decreased[1]}, collected ${collected[0]}/${collected[1]})`);
  console.log(`pool price moved between swap and later reads: ${priceKnowinglyMoved} (pre-swap tick ${frame.tick}, post-mint tick ${postMintTick})`);

  console.log('\n=== per-stage comparison ===');
  console.log(['stage', 'sim_gas', 'fork_estimate_gas', 'fork_local_gas_used', 'delta_vs_estimate_pct', 'delta_vs_local_pct'].join('\t'));
  const rows = [];
  for (const stage of stages) {
    const sim = simGas[stage];
    const forkRow = forkRows?.find(r => r.action === stage);
    const forkEstimate = forkRow ? BigInt(forkRow.estimate.gas) : null;
    const forkLocal = forkRow ? BigInt(forkRow.localGasUsed) : null;
    const deltaEstimate = forkEstimate ? (Number(sim - forkEstimate) / Number(forkEstimate) * 100).toFixed(2) : 'n/a';
    const deltaLocal = forkLocal ? (Number(sim - forkLocal) / Number(forkLocal) * 100).toFixed(2) : 'n/a';
    console.log([stage, sim.toString(), forkEstimate?.toString() ?? 'n/a', forkLocal?.toString() ?? 'n/a', deltaEstimate, deltaLocal].join('\t'));
    rows.push({ stage, simGas: sim.toString(), forkEstimateGas: forkEstimate?.toString() ?? null,
      forkLocalGasUsed: forkLocal?.toString() ?? null,
      deltaVsEstimatePct: forkEstimate ? Number(deltaEstimate) : null, deltaVsLocalPct: forkLocal ? Number(deltaLocal) : null });
  }

  console.log(`\ntiming: gas-sampling-only (round trip A + round trip B) = ${gasSamplingOnlyMs}ms `
    + `(A ${predictElapsedMs}ms + B ${finalElapsedMs}ms) vs owned-fork sampling `
    + `${forkRows ? (forkElapsedMs / 1000).toFixed(1) + 's' : 'FAILED after ' + (forkElapsedMs / 1000).toFixed(1) + 's'}`);
  console.log(`timing: eth_simulateV1 total including shared candidate/frame construction = ${simElapsedMs}ms`);
  console.log(`slot discovery: ${inputSlot.requests} requests (one-off per token, not per sample)`);
  console.log(`total RPC requests against the live provider (this script's client, includes slot discovery, `
    + `candidate/frame construction and verification reads): ${simulateRpcCount}`);

  console.log('\nJSON_RESULT_START');
  console.log(JSON.stringify({
    profile: profileRow.id, pool: p.pool, reference0: p.reference0, reference1: p.reference1, source: frame.source,
    candidate: { range: candidate.range, deployedValue: String(candidate.deployedValue),
      swap: { token: candidate.swap.token, amountIn: String(candidate.swap.amountIn), quotedOut: String(candidate.swap.quotedOut),
        actualOut: String(actualSwapOut), minOut: String(candidate.swap.minOut) } },
    slotDiscovery: { inputToken: inputSlot.method },
    provenance: { simParentHash: final.parentHash, canonicalBlockHash: canonicalBlock.hash, matches: provenanceMatches },
    tokenIdDeterminism: { predicted: predictedTokenId.toString(), confirmed: confirmedTokenId.toString(), matches: tokenIdDeterministic },
    priceMovedWithinSequence: priceKnowinglyMoved, preSwapTick: frame.tick, postMintTick,
    collectionCoversPrincipal, statuses, rows,
    timing: { simTotalMs: simElapsedMs, candidateAndFrameConstructionMs: candidateAndPredictMs,
      gasSamplingOnlyMs, roundTripAMs: predictElapsedMs, roundTripBMs: finalElapsedMs,
      forkMs: forkRows ? forkElapsedMs : null, forkFailed: forkRows ? false : true,
      forkError: forkError ? String(forkError.message ?? forkError) : null },
    requestCounts: { simulateProbeClient: simulateRpcCount, slotDiscoveryRequests: inputSlot.requests },
    totalScriptElapsedMs: Date.now() - t0,
  }, null, 1));
  console.log('JSON_RESULT_END');

  await store.close();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
