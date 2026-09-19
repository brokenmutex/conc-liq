// Run with the workspace Node and --import tsx. Only capture reads PostgreSQL;
// timestamps uses bounded HyperSync queries. No migration, signer or live RPC.
import assert from 'node:assert/strict';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createGzip, createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { FeeReplay } from '../src/research/fee-replay.ts';
import { NativeHyperSync } from '../src/history/hypersync.ts';
import { loadHistoryConfig } from '../src/history/client.ts';
import { screenRanges, nvdaPriceX18 } from '../src/research/range-screen.ts';
import { referenceBand } from '../src/research/reference.ts';

const stream = 'robinhood-v3-rwa-usdg-v1';
const pools = ['0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3', '0xB944cec30Bd4175855215D767ADC81F39e5f7E2B'];
const [command, ...args] = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  assert(['--input', '--output', '--through-block', '--from-block', '--to-block', '--timestamps', '--selection'].includes(args[i]), 'Unknown argument');
  assert(args[i + 1] && !args[i + 1].startsWith('--'), 'Missing argument value');
  assert(!options[args[i]], 'Duplicate argument'); options[args[i]] = args[i + 1];
}
const required = key => { assert(options[key], `Required: ${key}`); return options[key]; };
const blockNumber = key => { const v = Number(required(key)); assert(Number.isSafeInteger(v) && v > 0, `Invalid ${key}`); return v; };
const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const pretty = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
async function outputJson(value) {
  const path = required('--output'); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, pretty(value) + '\n', { flag: 'wx' });
}
async function* source(path) {
  const input = createReadStream(path), gzip = createGunzip();
  const done = pipeline(input, gzip); done.catch(() => {});
  try { for await (const line of createInterface({ input: gzip, crlfDelay: Infinity })) yield JSON.parse(line); await done; }
  finally { input.destroy(); gzip.destroy(); }
}
const eventFromRow = row => ({ poolAddress: row.pool_address, blockNumber: BigInt(row.block_number), blockHash: row.block_hash,
  transactionHash: row.transaction_hash, transactionIndex: row.transaction_index, logIndex: row.log_index, eventName: row.event_name, args: row.event_args });
const coordinate = e => `${e.block_number}:${e.transaction_index}:${e.log_index}`;
function validateManifest(manifest) {
  assert(manifest.schemaVersion === 1 && manifest.executionEligible === false && manifest.referenceTolerancePpm === 50000);
  assert(manifest.stream === stream && manifest.cursor.chain_id === '4663');
  assert(manifest.pools.length === 2 && manifest.snapshots.length === 2);
  assert.deepEqual(manifest.pools.map(p => p.pool_address.toLowerCase()).sort(), pools.map(p => p.toLowerCase()).sort());
  for (const p of manifest.pools) {
    assert(p.chain_id === '4663' && p.enabled && p.target_set_hash === manifest.cursor.target_set_hash);
    assert.equal(p.fee, p.pool_address.toLowerCase() === pools[0].toLowerCase() ? 500 : 3000);
    const snapshot = manifest.snapshots.find(s => s.pool_address.toLowerCase() === p.pool_address.toLowerCase());
    assert(snapshot && snapshot.fee === p.fee && Number(snapshot.block_number) === manifest.throughBlock);
    assert.equal(snapshot.token0.toLowerCase(), '0x5fc5360d0400a0fd4f2af552add042d716f1d168');
    assert.equal(snapshot.token1.toLowerCase(), '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec');
    assert.equal(p.rwa_address.toLowerCase(), snapshot.token1.toLowerCase());
  }
}

async function capture() {
  process.loadEnvFile('.env');
  const through = blockNumber('--through-block'), path = required('--output'), partial = `${path}.partial`;
  assert(!existsSync(path) && !existsSync(partial), 'Source output already exists');
  await mkdir(dirname(path), { recursive: true });
  const gzip = createGzip(), file = createWriteStream(partial, { flags: 'wx' });
  const completion = pipeline(gzip, file); completion.catch(() => {});
  const digest = createHash('sha256');
  const append = async object => { const text = stringify(object) + '\n'; digest.update(text); if (!gzip.write(text)) await once(gzip, 'drain'); };
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'lp_research_capture',
    options: '-c default_transaction_read_only=on -c statement_timeout=25000 -c lock_timeout=3000' });
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const cursor = (await db.query('SELECT * FROM indexer_cursors WHERE stream_key=$1', [stream])).rows[0];
    assert(cursor?.chain_id === '4663' && BigInt(cursor.last_scanned_block) >= BigInt(through), 'Indexer has not scanned research boundary');
    const registered = (await db.query('SELECT * FROM indexer_pools WHERE stream_key=$1 AND pool_address=ANY($2::text[]) ORDER BY fee', [stream, pools])).rows;
    assert(registered.length === 2 && registered.every(p => p.enabled && p.target_set_hash === cursor.target_set_hash && p.rwa_symbol === 'NVDA' && p.chain_id === '4663'));
    const snapshots = (await db.query(`SELECT r.id,r.block_number,r.block_hash,p.* FROM v3_fee_accounting_runs r
      JOIN v3_pool_fee_accounting p ON p.run_id=r.id WHERE r.stream_key=$1 AND r.block_number=$2
      AND lower(p.pool_address)=ANY($3::text[]) ORDER BY p.pool_address`, [stream, through, pools.map(p => p.toLowerCase())])).rows;
    assert(snapshots.length === 2, 'Choose a stored accounting checkpoint covering both NVDA pools');
    const runIds = [...new Set(snapshots.map(s => s.run_id))]; assert(runIds.length === 1);
    const ticks = (await db.query('SELECT * FROM v3_tick_fee_accounting WHERE run_id=$1 AND lower(pool_address)=ANY($2::text[])', [runIds[0], pools.map(p => p.toLowerCase())])).rows;
    const positions = (await db.query('SELECT * FROM v3_position_fee_accounting WHERE run_id=$1 AND lower(pool_address)=ANY($2::text[])', [runIds[0], pools.map(p => p.toLowerCase())])).rows;
    const references = (await db.query(`SELECT min(block_number) AS first_block,min(block_timestamp) AS first_time,
      max(block_number) AS last_block,max(block_timestamp) AS last_time,count(*) AS runs FROM v3_strategy_checkpoint_runs WHERE stream_key=$1`, [stream])).rows[0];
    const manifest = { schemaVersion: 1, executionEligible: false, capturedAt: new Date().toISOString(), stream,
      throughBlock: through, cursor, pools: registered, snapshots, ticks, positions, referenceCoverage: references,
      referenceTolerancePpm: 50000, sourceScope: 'Read-only snapshot; indexer cursor alone is not an independent completeness proof',
      purpose: 'Fee reconstruction audit only beyond development dates; no strategy scoring on holdout' };
    validateManifest(manifest);
    await append({ kind: 'manifest', manifest });
    const counts = {};
    for (const p of registered) {
      await db.query(`DECLARE research_events NO SCROLL CURSOR FOR SELECT pool_address,block_number,block_hash,transaction_hash,
        transaction_index,log_index,event_name,event_args,raw_topics,raw_data FROM v3_pool_events
        WHERE stream_key=$1 AND pool_address=$2 AND block_number <= $3 ORDER BY block_number,transaction_index,log_index`, [stream, p.pool_address, through]);
      let count = 0;
      for (;;) {
        const batch = (await db.query('FETCH 5000 FROM research_events')).rows;
        if (!batch.length) break;
        for (const event of batch) { await append({ kind: 'event', event }); count++; }
        if (count % 100000 === 0) console.log(JSON.stringify({ phase: 'capture', fee: p.fee, events: count }));
      }
      await db.query('CLOSE research_events'); counts[p.pool_address] = count;
    }
    await db.query('COMMIT');
    await append({ kind: 'counts', counts });
    const sha256 = digest.digest('hex'); gzip.end(); await completion; await rename(partial, path);
    await writeFile(`${path}.sha256`, `${sha256}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ phase: 'captured', counts, sourceSha256: sha256, path }));
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); gzip.destroy(); await completion.catch(() => {}); await rm(partial, { force: true }); throw error; }
  finally { await db.end(); }
}

async function reconcile() {
  const path = required('--input'), replays = new Map(), counts = {}, digest = createHash('sha256');
  let manifest, expectedCounts;
  for await (const row of source(path)) {
    digest.update(stringify(row) + '\n');
    if (row.kind === 'manifest') { assert(!manifest); manifest = row.manifest; validateManifest(manifest); for (const p of manifest.pools) replays.set(p.pool_address, new FeeReplay(p.pool_address, p.fee)); }
    if (row.kind === 'counts') expectedCounts = row.counts;
    if (row.kind !== 'event') continue;
    const e = row.event, replay = replays.get(e.pool_address); assert(replay);
    replay.apply(eventFromRow(e)); counts[e.pool_address] = (counts[e.pool_address] ?? 0) + 1;
    if (counts[e.pool_address] % 100000 === 0) console.log(JSON.stringify({ phase: 'replay', fee: replay.pool.fee, events: counts[e.pool_address], crossingSwaps: replay.crossingSwaps }));
  }
  assert.deepEqual(counts, expectedCounts, 'Source file lacks complete count footer');
  const sourceSha256 = digest.digest('hex');
  assert.equal(sourceSha256, (await readFile(`${path}.sha256`, 'utf8')).trim(), 'Source digest mismatch');
  const results = [];
  for (const [address, replay] of replays) {
    const snapshot = manifest.snapshots.find(s => s.pool_address.toLowerCase() === address.toLowerCase()); assert(snapshot);
    const mismatches = [];
    const compare = (field, actual, expected) => { if (String(actual) !== String(expected)) mismatches.push({ field, actual: String(actual), expected: String(expected) }); };
    for (const [field, actual] of [['sqrt_price_x96', replay.pool.sqrtPriceX96], ['tick', replay.pool.tick], ['liquidity', replay.pool.liquidity],
      ['fee_growth_global0_x128', replay.global0], ['fee_growth_global1_x128', replay.global1]]) compare(field, actual, snapshot[field]);
    const ticks = manifest.ticks.filter(t => t.pool_address.toLowerCase() === address.toLowerCase());
    for (const t of ticks) {
      const actual = replay.ticks.get(t.tick); assert(actual, 'Snapshot tick missing from replay');
      for (const [field, a] of [['liquidity_gross', actual.gross], ['liquidity_net', actual.net], ['fee_growth_outside0_x128', actual.outside0], ['fee_growth_outside1_x128', actual.outside1]]) compare(`tick:${t.tick}:${field}`, a, t[field]);
    }
    const positions = manifest.positions.filter(p => p.pool_address.toLowerCase() === address.toLowerCase());
    for (const p of positions) {
      const key = `${p.owner_address.toLowerCase()}:${p.tick_lower}:${p.tick_upper}`, actual = replay.positions.get(key); assert(actual, 'Snapshot position missing from replay');
      for (const [field, a] of [['liquidity', actual.liquidity], ['fee_growth_inside0_last_x128', actual.last0], ['fee_growth_inside1_last_x128', actual.last1], ['tokens_owed0', actual.owed0], ['tokens_owed1', actual.owed1]]) compare(`position:${key}:${field}`, a, p[field]);
    }
    results.push({ pool: address, fee: replay.pool.fee, events: counts[address], swaps: replay.pool.swapCount,
      crossingSwaps: replay.crossingSwaps, swapSteps: replay.swapSteps, flashEvents: replay.pool.flashCount,
      checkpoint: { runId: snapshot.run_id, block: manifest.throughBlock, hash: snapshot.block_hash },
      checkedTicks: ticks.length, checkedPositions: positions.length, matched: mismatches.length === 0, mismatches });
  }
  const report = { methodology: 'observed_v3_swap_step_fee_reconstruction_v1', executionEligible: false, sourceSha256,
    results, complete: results.every(r => r.matched), limitations: ['Reconciles observed chain state; does not establish counterfactual LP profitability',
      'The endpoint checkpoint validates cumulative accounting but does not independently prove all event coverage',
      'No strategy fitting or scoring on validation/holdout dates'] };
  await outputJson(report); console.log(stringify(report)); if (!report.complete) process.exitCode = 2;
}

async function timestamps() {
  process.loadEnvFile('.env');
  const from = blockNumber('--from-block'), to = blockNumber('--to-block'); assert(to >= from && to - from <= 5_000_000, 'Bound enrichment to at most five million blocks');
  const events = new Map(), counts = {}, expectedHeaders = new Map(), digest = createHash('sha256'); let manifest, footer;
  for await (const row of source(required('--input'))) {
    digest.update(stringify(row) + '\n');
    if (row.kind === 'manifest') { manifest = row.manifest; validateManifest(manifest); }
    if (row.kind === 'counts') footer = row.counts;
    if (row.kind === 'event' && Number(row.event.block_number) >= from && Number(row.event.block_number) <= to) {
      events.set(coordinate(row.event), row.event); counts[row.event.pool_address] = (counts[row.event.pool_address] ?? 0) + 1;
      const number = Number(row.event.block_number), hash = row.event.block_hash.toLowerCase();
      assert(!expectedHeaders.has(number) || expectedHeaders.get(number) === hash); expectedHeaders.set(number, hash);
    }
  }
  assert(footer && digest.digest('hex') === (await readFile(`${required('--input')}.sha256`, 'utf8')).trim(), 'Incomplete or modified source file');
  assert(manifest && to <= manifest.throughBlock && events.size > 0);
  const config = loadHistoryConfig(process.env.ROBINHOOD_READ_HTTP_URL ?? process.env.RH_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
  assert.equal(config.source, 'hypersync');
  const native = new NativeHyperSync(config), headers = new Map(); let queries = 0, matched = 0;
  for (let start = from; start <= to; start += 100000) {
    const end = Math.min(to + 1, start + 100000);
    const rows = await native.query(start, end, { logs: [{ address: pools }],
      field_selection: { block: ['number', 'hash', 'parent_hash', 'timestamp'], log: ['block_number', 'block_hash', 'transaction_hash', 'transaction_index', 'log_index', 'address', 'data', 'topic0', 'topic1', 'topic2', 'topic3', 'removed'] } }); queries++;
    for (const log of rows.logs) {
      const key = `${Number(log.block_number)}:${Number(log.transaction_index)}:${Number(log.log_index)}`, expected = events.get(key);
      assert(expected, `HyperSync event absent from snapshot at ${key}`);
      assert.equal(log.removed, false); assert.equal(log.address.toLowerCase(), expected.pool_address.toLowerCase());
      assert.equal(log.block_hash.toLowerCase(), expected.block_hash.toLowerCase());
      assert.equal(log.transaction_hash.toLowerCase(), expected.transaction_hash.toLowerCase());
      assert.equal(log.data.toLowerCase(), expected.raw_data.toLowerCase());
      assert.deepEqual([log.topic0,log.topic1,log.topic2,log.topic3].filter(t => t != null).map(t => t.toLowerCase()), expected.raw_topics.map(t => t.toLowerCase()));
      events.delete(key); matched++;
    }
    for (const block of rows.blocks) {
      const number = Number(block.number), timestamp = Number(BigInt(block.timestamp));
      assert(Number.isSafeInteger(number) && Number.isSafeInteger(timestamp));
      assert(!headers.has(number)); headers.set(number, { number, hash: block.hash, timestamp });
    }
    console.log(JSON.stringify({ phase: 'timestamps', through: end - 1, matched, headers: headers.size }));
  }
  assert.equal(events.size, 0, 'Snapshot events absent from HyperSync interval');
  for (const [number, hash] of expectedHeaders) assert.equal(headers.get(number)?.hash.toLowerCase(), hash, 'Missing or mismatched event timestamp header');
  // Include exact interval endpoints even when no pool log occurs there.
  for (const number of [from, to]) if (!headers.has(number)) {
    const b = await native.block(number); headers.set(number, { number, hash: b.hash, timestamp: Number(BigInt(b.timestamp)) }); queries++;
  }
  const ordered = [...headers.values()].sort((a,b) => a.number - b.number);
  for (let i=1; i<ordered.length; i++) assert(ordered[i].timestamp >= ordered[i-1].timestamp, 'Nonmonotonic historical timestamps');
  const result = { executionEligible: false, sourceSha256: (await readFile(`${required('--input')}.sha256`, 'utf8')).trim(),
    fromBlock: from, toBlock: to, counts, matchedEvents: matched, provider: 'HyperSync', queries,
    completeness: 'Exact raw log set matches the frozen database snapshot in this bounded interval', headers: ordered };
  await outputJson(result);
  console.log(JSON.stringify({ phase: 'timestamps_complete', from: new Date(ordered[0].timestamp*1000).toISOString(), to: new Date(ordered.at(-1).timestamp*1000).toISOString(), matched }));
}

async function screen(sizeSweep = false, tickSweep = false) {
  const input = required('--input'), timestampText = await readFile(required('--timestamps'), 'utf8'), timing = JSON.parse(timestampText);
  const sourceSha256 = (await readFile(`${input}.sha256`, 'utf8')).trim(); assert.equal(timing.sourceSha256, sourceSha256);
  const headers = new Map(timing.headers.map(h => [h.number,h])), start = headers.get(timing.fromBlock).timestamp, end = headers.get(timing.toBlock).timestamp;
  assert(end < Date.parse('2026-08-17T00:00:00Z')/1000, 'Geometry screen is restricted to the frozen development split');
  const plan = { schemaVersion: 1, executionEligible: false, sourceSha256,
    timestampSha256: createHash('sha256').update(timestampText).digest('hex'), fromBlock: timing.fromBlock, toBlock: timing.toBlock,
    from: new Date(start*1000).toISOString(), to: new Date(end*1000).toISOString(),
    decisionSeconds: 60, rangeChangeDelaySeconds: 60, persistenceObservations: 2, cooldownSeconds: 600,
    halfWidthsBps: [50,100,200,400], policies: ['fixed','edge','immediate70','persistent70'],
    capacityScreenBudgetQuote: '1000000000', capacityScreenDeployedQuote: '800000000', referenceTolerancePpm: 50000,
    fees: null, costs: null, predictiveScorer: null, referenceScope: 'No independent references available in this development window; geometry only' };
  if (sizeSweep) {
    const selectionText = await readFile(required('--selection'), 'utf8'), selection = JSON.parse(selectionText);
    assert(selection.executionEligible === false && selection.fromBlock === timing.fromBlock && selection.toBlock === timing.toBlock);
    assert(selection.referenceTolerancePpm === 50000 && selection.deploymentPpm === 800000 && selection.reservePpm === 200000);
    assert.deepEqual(selection.portfolioSizesUsdg, [250,500,1000,2000,3000,4000,5000]);
    if (tickSweep) {
      assert(selection.rangeUnit === 'raw_ticks_total_lower_to_upper');
      assert(Array.isArray(selection.totalWidthsTicks) && selection.totalWidthsTicks.length === 5);
      assert(selection.totalWidthsTicks.every((w,i)=>w===(i+1)*selection.totalWidthsTicks[0] && w%10===0 && w>0 && w<=100));
      if (selection.halfWidthsTicks !== undefined) {
        assert.deepEqual(selection.halfWidthsTicks, [10,20,30,40,50]);
        assert.deepEqual(selection.totalWidthsTicks, selection.halfWidthsTicks.map(w=>w*2));
        plan.halfWidthsTicks=selection.halfWidthsTicks;
      }
      delete plan.halfWidthsBps;
      Object.assign(plan, {totalWidthsTicks:selection.totalWidthsTicks,rangeUnit:selection.rangeUnit,poolFees:[500],
        deferredFee3000:'The focused test uses the fee-500 pool with tick spacing 10; fee-3000 spacing is 60',
        widthSelection:selection.halfWidthsTicks === undefined
          ? 'Historical total-width interpretation, superseded by the user clarification'
          : 'User-confirmed +/-10,+/-20,+/-30,+/-40,+/-50 raw ticks around the price; total widths 20,40,60,80,100 with tick-grid centering'});
    } else assert.deepEqual(selection.halfWidthsBps, plan.halfWidthsBps);
    assert.deepEqual(selection.policies, plan.policies);
    delete plan.capacityScreenBudgetQuote; delete plan.capacityScreenDeployedQuote;
    Object.assign(plan, { schemaVersion: 2, portfolioSizesUsdg: selection.portfolioSizesUsdg, deploymentPpm: 800000, reservePpm: 200000,
      selectionSha256: createHash('sha256').update(selectionText).digest('hex'), referenceScope: 'Continuous independent reference and issuer-risk coverage unavailable; guarded economics blocked',
      capacityScope: 'Constant nominal deployed budget at each geometric placement; no self-financing portfolio simulation',
      diagnosticShareThresholdsPpm: [10000,50000,100000], segmentStatistics: 'Unweighted observed swap segments intersecting the hypothetical range; unchanged price path',
      verifiedEvents: timing.matchedEvents, verifiedEventCounts: timing.counts, verifiedHeaders: timing.headers.length });
  }
  const output = required('--output'); await mkdir(dirname(output), {recursive:true});
  assert(!existsSync(output), 'Output already exists');
  // Save the specification before inspecting candidate results.
  await writeFile(`${output}.manifest.json`, pretty(plan)+'\n', {flag:'wx'});
  const states = new Map(), observations = new Map(), digest = createHash('sha256'); let manifest, footer;
  const emitUntil = (state, until) => {
    while (state.next <= end && state.next < until) {
      assert(state.replay.pool.tick !== null && state.replay.pool.sqrtPriceX96 !== null, 'Pool lacks initialized state at window start');
      state.samples.push({at:state.next,tick:state.replay.pool.tick,price:state.replay.pool.sqrtPriceX96,liquidity:state.replay.pool.liquidity,
        pathMinTick:state.min ?? state.replay.pool.tick,pathMaxTick:state.max ?? state.replay.pool.tick,
        ...(sizeSweep ? {segments:state.segments} : {})});
      state.segments=[];
      state.min=state.replay.pool.tick; state.max=state.replay.pool.tick; state.next+=60;
    }
  };
  for await (const row of source(input)) {
    digest.update(stringify(row)+'\n');
    if (row.kind === 'manifest') {
      manifest = row.manifest;
      validateManifest(manifest);
      assert(Date.parse(manifest.referenceCoverage.first_time)/1000 > end, 'Window has reference data; use a reference-aware replay instead');
      for(const p of manifest.pools) states.set(p.pool_address,{replay:new FeeReplay(p.pool_address,p.fee),next:start,min:null,max:null,samples:[],segments:[]});
    }
    if (row.kind === 'counts') footer=row.counts;
    if (row.kind !== 'event' || Number(row.event.block_number)>timing.toBlock) continue;
    const e=row.event,state=states.get(e.pool_address); assert(state);
    if (Number(e.block_number)>=timing.fromBlock) {
      const header=headers.get(Number(e.block_number)); assert(header && header.hash.toLowerCase()===e.block_hash.toLowerCase(),'Event has no verified timestamp');
      emitUntil(state,header.timestamp);
    }
    const segments = state.replay.apply(eventFromRow(e));
    if(sizeSweep && Number(e.block_number)>=timing.fromBlock) state.segments.push(...segments);
    if(Number(e.block_number)>=timing.fromBlock && state.replay.pool.tick!==null) {
      state.min=state.min===null?state.replay.pool.tick:Math.min(state.min,state.replay.pool.tick);
      state.max=state.max===null?state.replay.pool.tick:Math.max(state.max,state.replay.pool.tick);
    }
  }
  assert(footer && digest.digest('hex')===sourceSha256,'Source digest mismatch');
  const candidates=[],coverage=[];
  for(const [address,state] of states) {
    if(tickSweep && state.replay.pool.fee !== 500) continue;
    emitUntil(state,end+1); observations.set(address,state.samples);
    const samples=state.samples;
    coverage.push({pool:address,fee:state.replay.pool.fee,observations:samples.length,
      initialPriceX18:nvdaPriceX18(samples[0].price),lastPriceX18:nvdaPriceX18(samples.at(-1).price),
      referenceGate:referenceBand(nvdaPriceX18(samples[0].price),samples[0].at,null)});
    for(const budget of sizeSweep ? plan.portfolioSizesUsdg : [null]) for(const width of tickSweep ? plan.totalWidthsTicks : plan.halfWidthsBps) for(const policy of plan.policies) {
      const size = budget === null ? {} : {portfolioSizeUsdg:budget,portfolioQuoteRaw:String(BigInt(budget)*1000000n),
        deployedQuoteRaw:String(BigInt(budget)*800000n),reserveQuoteRaw:String(BigInt(budget)*200000n)};
      if(tickSweep && plan.halfWidthsTicks !== undefined) size.halfWidthTicks=width/2;
      try { candidates.push({...size,...screenRanges(samples,state.replay.pool.fee,policy,tickSweep?0:width,budget===null?undefined:BigInt(budget)*800000n,tickSweep?width:undefined)}); }
      catch(error) {
        if (!(error instanceof Error) || !error.message.includes('No feasible inward-rounded range')) throw error;
        candidates.push({...size,fee:state.replay.pool.fee,policy,halfWidthBps:width,status:'excluded',reason:error.message,
          executionEligible:false,rank:null,netAlphaQuote:null,executionCostsQuote:null,feesQuote:null});
      }
    }
  }
  const result={manifest:plan,coverage,candidates,selectedPolicy:null,
    ...(sizeSweep ? {selectedSize:null,guardedEconomicReplayStatus:'blocked',unavailableEconomicMetrics:
      ['net alpha in USDG and percent','drawdown','inventory exposure and interventions','turnover','size-specific execution costs and impact','matched passive benchmark returns']} : {}),
    unavailable:['Independent historical reference and issuer-risk evidence for the guarded +/-5% policy',
      'Executable rebalance paths and matched historical costs','Validated counterfactual fee income and a frozen predictive scorer'],
    conclusion:tickSweep ? 'Focused raw-tick width and size diagnostics completed; net-optimal width remains unmeasured' : sizeSweep ? 'Seven-size capacity and geometry sweep completed; guarded net-performance comparison unavailable' : 'Structural range/churn comparison only; no guarded-policy performance or profitability ranking'};
  await outputJson(result); console.log(stringify(sizeSweep ? {manifest:plan,candidates:candidates.length,excluded:candidates.filter(c=>c.status==='excluded').length,conclusion:result.conclusion} : result));
}

try {
  if (command === 'capture') await capture();
  else if (command === 'reconcile') await reconcile();
  else if (command === 'timestamps') await timestamps();
  else if (command === 'screen') await screen();
  else if (command === 'sizes') await screen(true);
  else if (command === 'ticks') await screen(true,true);
  else throw new Error('Usage: node --import tsx scripts/lp-research.mjs capture|reconcile|timestamps|screen|sizes|ticks [--input FILE] --output FILE [--through-block N | --from-block N --to-block N | --timestamps FILE] [--selection FILE]');
} catch (error) { console.error(error instanceof Error ? error.message : 'Research failed'); process.exitCode = 1; }
