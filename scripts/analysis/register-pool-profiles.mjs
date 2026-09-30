// Builds and verifies a deployment market profile for every pool in the
// indexer registry, so the operator setup form can offer more than the single
// pool registered by hand on 2026-09-27. Verification is the existing
// verifyMarketProfile contract: canonical contract identity plus an eligible
// independent reference for both tokens and the native asset. A pool whose
// asset has no usable oracle fails here, which is the intended outcome and not
// something this script works around.
//
// Read-only without --apply. With --apply it inserts verified profiles, which
// is additive: no existing profile is modified or retired.
import { readFileSync } from 'node:fs';
import { keccak256 } from 'viem';
import { createRobinhoodClient } from '../../src/client.ts';
import { poolAbi } from '../../src/abi.ts';
import { paperTokenAbi, PAPER_QUOTER, PAPER_ROUTER } from '../../src/paper/execution-abi.ts';
import { NONFUNGIBLE_POSITION_MANAGER, UNISWAP_V3_FACTORY, USDG } from '../../src/constants.ts';
import { verifyMarketProfile } from '../../src/deployments/market-profile.ts';
import { DeploymentStore } from '../../src/deployments/store.ts';

const apply = process.argv.includes('--apply');
const env = Object.fromEntries(readFileSync(
  '/root/conc-liq/data/static-paper-mvp-dashboard-feedback-2026-09-28.env', 'utf8')
  .split('\n').filter(line => line.includes('='))
  .map(line => [line.slice(0, line.indexOf('=')).trim(),
    line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]));

const client = createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL, 20000);
const store = new DeploymentStore(env.DATABASE_URL);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const codeHash = async address =>
  keccak256(await client.getBytecode({ address }) ?? '0x');

const stablecoin = { kind: 'stablecoin', session: 'verified_24_7',
  maxAgeSeconds: 86400, corporateAction: 'reject_pending' };
const stockToken = { kind: 'stock_token', session: 'latest_equity_session',
  maxAgeSeconds: 345600, corporateAction: 'reject_pending' };

async function buildProfile(entry) {
  const pool = entry.address;
  const [token0, token1, fee, tickSpacing] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token0' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token1' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'fee' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'tickSpacing' }),
  ]);
  const [decimals0, decimals1] = await Promise.all([
    client.readContract({ address: token0, abi: paperTokenAbi, functionName: 'decimals' }),
    client.readContract({ address: token1, abi: paperTokenAbi, functionName: 'decimals' }),
  ]);
  // The quote side is whichever position USDG occupies; the reference policy
  // is assigned by position, not by name, so a pool with USDG as token1 is
  // described correctly rather than silently mislabelled.
  const quoteToken = same(token0, USDG) ? 0 : same(token1, USDG) ? 1 : null;
  if (quoteToken === null) throw new Error('pool has no USDG side');
  const rwa = `${entry.rwaSymbol}/USD`;
  const [poolCodeHash, token0CodeHash, token1CodeHash, managerCodeHash, quoterCodeHash] =
    await Promise.all([codeHash(pool), codeHash(token0), codeHash(token1),
      codeHash(NONFUNGIBLE_POSITION_MANAGER), codeHash(PAPER_QUOTER)]);
  return {
    pool: { chainId: 4663, factory: UNISWAP_V3_FACTORY, pool, token0, token1,
      quoteToken, decimals0: Number(decimals0), decimals1: Number(decimals1),
      fee: Number(fee), tickSpacing: Number(tickSpacing),
      positionManager: NONFUNGIBLE_POSITION_MANAGER, router: PAPER_ROUTER, quoter: PAPER_QUOTER,
      poolCodeHash, token0CodeHash, token1CodeHash, managerCodeHash, quoterCodeHash,
      reference0: quoteToken === 0 ? 'USDG/USD' : rwa,
      reference1: quoteToken === 0 ? rwa : 'USDG/USD',
      nativeReference: 'ETH/USD', numeraire: 'USD' },
    referencePolicy: {
      token0: quoteToken === 0 ? stablecoin : stockToken,
      token1: quoteToken === 0 ? stockToken : stablecoin,
      nativeMaxAgeSeconds: 86400, maxPoolDeviationPpm: 50000 },
  };
}

const registry = JSON.parse(readFileSync('/root/conc-liq/config/indexer-pools.json', 'utf8'));
await store.assertReady();
const existing = new Set((await store.listMarketProfiles())
  .map(row => String(row.pool ?? row.poolAddress ?? '').toLowerCase()));
const results = [];
for (const entry of registry.pools) {
  const label = `${entry.rwaSymbol}/${entry.fee}`;
  if (existing.has(entry.address.toLowerCase())) {
    results.push({ label, pool: entry.address, state: 'already registered' });
    continue;
  }
  try {
    const proof = await verifyMarketProfile(client, await buildProfile(entry), env.INDEXER_STREAM_KEY);
    if (!apply) { results.push({ label, pool: entry.address, state: 'verifies' }); continue; }
    const row = await store.registerVerifiedMarketProfile(proof);
    results.push({ label, pool: entry.address, state: row.created ? 'registered' : 'existed', id: row.id });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    results.push({ label, pool: entry.address, state: 'rejected', reason: reason.slice(0, 120) });
  }
}
await store.close();
for (const r of results)
  console.log(`${r.label.padEnd(14)} ${r.state.padEnd(20)} ${r.reason ?? r.id ?? ''}`);
const counted = results.reduce((acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }), {});
console.log('\n' + JSON.stringify(counted));
if (!apply) console.log('dry run — pass --apply to register the verifying profiles');
