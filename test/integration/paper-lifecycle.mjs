import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PaperStore } from '../../src/paper/store.ts';
import { DEFAULT_PAPER_POLICY, PAPER_NVDA, PAPER_POOL } from '../../src/paper/engine.ts';
import { paperExecutionEvidenceValid } from '../../src/paper/evidence.ts';
import { readPaperDashboard } from '../../src/dashboard/paper.ts';
import { sqrtRatioAtTick } from '../../src/backtest/principal.ts';
import { USDG } from '../../src/constants.ts';
import { migrateDatabase } from '../../src/storage/migrations.ts';
import { PAPER_SCHEMA_SQL } from '../../src/paper/schema.ts';
if (!process.env.TEST_DATABASE_URL) throw Error('TEST_DATABASE_URL is required for isolated tests');
const identity={buildId:'a'.repeat(64),configHash:'b'.repeat(64),nodeVersion:process.version};
const schema=`paper_execution_audit_${process.pid}_${Date.now()}`;
const client=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});
const entryArtifact=JSON.parse(await readFile(new URL('../../notes/paper-execution-evidence-2026-09-07/round-trip.json',import.meta.url),'utf8'));
const exitArtifact=JSON.parse(await readFile(new URL('../../notes/paper-execution-evidence-2026-09-07/restored-exit.json',import.meta.url),'utf8')).result;
const holdingMode=process.env.PAPER_TEST_HOLDING==='1';
const riskFixture=JSON.parse(await readFile(new URL('../fixtures/paper-risk-snapshot.json',import.meta.url),'utf8'));
const boundaryMode=process.env.PAPER_TEST_BOUNDARIES==='1';
const policy={...DEFAULT_PAPER_POLICY,mode:'research',referencePolicy:undefined,...(boundaryMode?{feeAccounting:'initialized_boundaries_v1'}:{}),...(holdingMode?{mode:'guarded',referencePolicy:{...DEFAULT_PAPER_POLICY.referencePolicy,maxDeviationPpm:50000},holdingPolicy:{kind:'bounded_infrastructure_v1',maxLagBlocks:30,chainPauseSeconds:60,riskPauseSeconds:30}}:{})}; // Isolated mechanics fixture; never a live session.
const stream='paper-execution-fixture';
const calls={quote:0,entry:0,exit:0};
const valuation=cp=>({sourceBlock:cp.block,sourceHash:cp.hash,computedAt:new Date().toISOString(),ethUsdAnswer:'200000000000',ethUsdDecimals:8,quoteUsdAnswer:'100000000',quoteUsdDecimals:8});
let failExit=true;
let deferCoverageDuringExit=false;
let cancelDuringEntry=false;
let invalidateDuringEntry=false;
let concurrentStore;
let boundaryReads=0;let mismatchedBoundary=false;
const executor={
 async refreshRisk(runId,validationOnly){assert(validationOnly);await client.query('UPDATE risk_snapshot_canonicality SET validated_at=clock_timestamp() WHERE risk_run_id=$1',[runId]);},
 async boundaryFees(cp,range) {boundaryReads++;assert.equal(await concurrentStore.tick(stream),null);
  await client.query("SET statement_timeout='2s'");await client.query("ALTER TABLE risk_snapshot_runs ADD COLUMN IF NOT EXISTS boundary_audit_marker boolean");await client.query('SET statement_timeout=0');
  return {block:mismatchedBoundary?'0':cp.block,hash:cp.hash,tickLower:range.tickLower,tickUpper:range.tickUpper,lower:{gross:'100',outside0:'0',outside1:'0'},upper:{gross:'100',outside0:'0',outside1:'0'}};},
 async quote(cp) { calls.quote++; return {...entryArtifact.range,sourceBlock:cp.block,sourceHash:cp.hash,quotedAt:new Date().toISOString(),swapAmountQuote:entryArtifact.entrySwap.amountIn,minRwaOut:entryArtifact.entrySwap.amountOutMinimum}; },
 async enter(cp,p,intent) { calls.entry++; assert.equal(await concurrentStore.tick(stream),null); if(cancelDuringEntry)await concurrentStore.stop(stream); if(invalidateDuringEntry)await client.query('UPDATE risk_snapshot_canonicality SET observed_hash=NULL WHERE risk_run_id=$1',[cp.id]); await client.query("SET statement_timeout='2s'"); await client.query("ALTER TABLE risk_snapshot_runs ADD COLUMN IF NOT EXISTS paper_audit_marker boolean"); await client.query('SET statement_timeout=0'); assert.equal(intent.swapAmountQuote,entryArtifact.entrySwap.amountIn); const balances=structuredClone(entryArtifact.balances);const delta=BigInt(p.budgetQuote)-BigInt(entryArtifact.policy.budgetQuote);
  balances.afterMint.quote=String(BigInt(balances.afterMint.quote)+delta);balances.inventory.quote=String(BigInt(balances.inventory.quote)+delta);
  return {result:{...entryArtifact,balances,source:{block:cp.block,hash:cp.hash},policy:p},valuation:valuation(cp)}; },
 async exit(cp,p,inventory) { calls.exit++; if(deferCoverageDuringExit)await client.query("UPDATE indexer_cursors SET last_scanned_block=0"); if(failExit) { failExit=false; throw new Error('fixture rejected preflight'); } const balances=structuredClone(exitArtifact.balances);balances.afterExit.quote=String(BigInt(balances.afterExit.quote)+BigInt(p.budgetQuote)-BigInt(entryArtifact.policy.budgetQuote));return {result:{...exitArtifact,balances,source:{block:cp.block,hash:cp.hash},policy:p,inventory},valuation:valuation(cp)}; },
};
await client.connect();
let store;
const insert=async(table,row)=>client.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},$1::jsonb)).*`,[JSON.stringify(row)]);
try {
 await client.query(`CREATE SCHEMA ${schema}_template`);
 await client.query(`SET search_path=${schema}_template`);
 await migrateDatabase(client);
 await client.query(`CREATE SCHEMA ${schema}`);
 await client.query(`SET search_path=${schema}`);
 for(const table of ['v3_strategy_checkpoint_runs','v3_strategy_pool_checkpoints','risk_snapshot_canonicality','asset_risk_snapshots','indexer_cursors','v3_replay_cursors','indexer_pools','rpc_health_samples','v3_pool_events','risk_snapshot_runs','risk_snapshot_attempts','schema_migrations'])
  await client.query(`CREATE TABLE ${schema}.${table} AS SELECT * FROM ${schema}_template.${table} WITH NO DATA`);
 const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
 store=new PaperStore(url.toString(),executor,identity); concurrentStore=new PaperStore(url.toString(),executor,identity); await client.query(PAPER_SCHEMA_SQL);
 await client.query('ALTER TABLE paper_sessions ADD COLUMN runtime_identity jsonb');
 await client.query('ALTER TABLE paper_execution_runs ADD COLUMN runtime_identity jsonb');
 await client.query(`INSERT INTO schema_migrations SELECT * FROM ${schema}_template.schema_migrations`);
 await store.assertReady();
 const id=await store.start(stream,policy);
 const mismatched=new PaperStore(url.toString(),executor,{...identity,buildId:'c'.repeat(64)});
 try{await assert.rejects(mismatched.tick(stream),/runtime differs/);}finally{await mismatched.close();}
 assert.deepEqual(calls,{quote:0,entry:0,exit:0});
 await assert.rejects(store.start(stream,policy),/duplicate key/);
 await insert('indexer_cursors',{stream_key:stream,last_scanned_block:'10000',chain_id:4663,target_set_hash:'fixture'});
 await insert('v3_replay_cursors',{stream_key:stream,complete_through_block:'10000',chain_id:4663,target_set_hash:'fixture'});
 await insert('indexer_pools',{stream_key:stream,pool_address:PAPER_POOL,rwa_address:PAPER_NVDA,chain_id:4663,fee:500,target_set_hash:'fixture',enabled:true,created_block:'0'});
 const checkpoint=async index=>{
  await new Promise(resolve=>setTimeout(resolve,1100));
  const now=Date.now(),at=new Date(now-1).toISOString();
  const block=String(index*1000),hash=`0x${String(index).repeat(64)}`;
  await insert('v3_strategy_checkpoint_runs',{id:String(index),stream_key:stream,chain_id:4663,block_number:block,block_hash:hash,block_timestamp:at,captured_at:at,target_set_hash:'fixture',risk_run_id:String(index)});
  await insert('v3_strategy_pool_checkpoints',{checkpoint_run_id:String(index),pool_address:PAPER_POOL,rwa_address:PAPER_NVDA,rwa_symbol:'NVDA',fee:500,tick:221830,sqrt_price_x96:String(sqrtRatioAtTick(221830)),liquidity:'100000000000000000000',fee_growth_global0_x128:'0',fee_growth_global1_x128:'0',token0:USDG,token1:PAPER_NVDA,token_decimals:18,pool_unlocked:true,status:'valid',reasons:[],deviation_ppm:'0'});
  await insert('risk_snapshot_canonicality',{risk_run_id:String(index),canonical:true,block_number:block,expected_hash:hash,observed_hash:hash,validated_at:at});
  if(holdingMode){
   const snapshot=structuredClone(riskFixture);
   snapshot.blockNumber=block;snapshot.blockHash=hash;snapshot.blockTimestamp=at;snapshot.observedAt=at;
   for(const oracle of [snapshot.quoteOracle,...snapshot.assets.map(a=>a.oracle)])if(oracle?.state)oracle.state.updatedAt=String(Math.floor((now-5000)/1000));
   await insert('risk_snapshot_runs',{id:String(index),chain_id:4663,block_number:block,block_hash:hash,snapshot});
   await insert('risk_snapshot_attempts',{id:String(index),status:'succeeded',attempted_at:at,completed_at:at,risk_run_id:String(index)});
  }
  await client.query('DELETE FROM rpc_health_samples');
  for(let i=0;i<34;i++) {
   const observed=now-1000-(33-i)*10000,observedAt=new Date(observed).toISOString(),head=100000+i*100,anchor=head-64;
   const probe={chainId:4663,error:null,anchorError:null,anchorBlock:String(anchor),anchorHash:hash,headBlock:String(head),headHash:hash,headTimestamp:String(Math.floor(observed/1000))};
   const snapshot={observedAt,state:'healthy',allowBulk:true,reasons:[],warnings:[],lagBlocks:'0',privateSyncing:false,anchorBlock:String(anchor),anchorHash:hash,privateAnchorHash:hash,privateHead:String(head),privateHeadTimestamp:probe.headTimestamp,probes:[{...probe,role:'private',name:'fixture-private'},{...probe,role:'reference',name:'fixture-ref-a'},{...probe,role:'reference',name:'fixture-ref-b'}]};
   await insert('rpc_health_samples',{id:String(i+1),observed_at:observedAt,snapshot});
  }
 };
 await checkpoint(1);
 const savedHealth=(await client.query('SELECT * FROM rpc_health_samples')).rows;
 for(const row of savedHealth) {
  const snapshot=structuredClone(row.snapshot);snapshot.anchorBlock='1';
  await client.query('UPDATE rpc_health_samples SET snapshot=$2 WHERE id=$1',[row.id,JSON.stringify(snapshot)]);
 }
 assert.deepEqual((await store.tick(stream)).reasons,['awaiting_checkpoint_confirmation']);
 assert.deepEqual(calls,{quote:0,entry:0,exit:0});
 assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM paper_observations')).rows[0].n,0);
 for(const row of savedHealth)await client.query('UPDATE rpc_health_samples SET snapshot=$2 WHERE id=$1',[row.id,JSON.stringify(row.snapshot)]);
 assert.equal((await store.tick(stream)).action,'signal_entry');
 assert.deepEqual(calls,{quote:1,entry:0,exit:0});
 await store.close(); store=new PaperStore(url.toString(),executor,identity);
 assert.equal((await store.tick(stream)).action,'wait');
 assert.deepEqual(calls,{quote:1,entry:0,exit:0});
 await checkpoint(2);
 if(boundaryMode){mismatchedBoundary=true;const before=(await client.query('SELECT state FROM paper_sessions WHERE id=$1',[id])).rows[0].state;
  assert.deepEqual((await store.tick(stream)).reasons,['awaiting_boundary_fee_evidence']);
  assert.deepEqual((await client.query('SELECT state FROM paper_sessions WHERE id=$1',[id])).rows[0].state,before);assert.equal(calls.entry,0);mismatchedBoundary=false;}
 assert.equal((await store.tick(stream)).action,'enter');
 const row=async()=> (await client.query('SELECT * FROM paper_sessions WHERE id=$1',[id])).rows[0];
 let open=await row();
 assert.equal(await paperExecutionEvidenceValid(client,open),true);
 assert.deepEqual(open.runtime_identity,identity);
 assert.deepEqual((await client.query("SELECT runtime_identity FROM paper_execution_runs WHERE action='entry'")).rows[0].runtime_identity,identity);
 assert.equal(open.state.execution.gasSpentWei,entryArtifact.entryGasWei);
 assert.equal(open.state.position.idle0,entryArtifact.balances.afterMint.quote);
 assert.equal((await store.tick(stream)).action,'wait');
 assert.deepEqual(calls,{quote:1,entry:1,exit:0});
 if(holdingMode){
  const saved=structuredClone((await row()).state),readsBefore=boundaryReads;
  const health=(await client.query('SELECT * FROM rpc_health_samples ORDER BY observed_at DESC LIMIT 1')).rows[0];
  const fault={...health.snapshot,observedAt:new Date().toISOString(),state:'open',allowBulk:false,reasons:['private_reports_syncing'],warnings:[],lagBlocks:'7'};
  await client.query('UPDATE rpc_health_samples SET snapshot=$1,observed_at=$2 WHERE id=$3',[fault,fault.observedAt,health.id]);
  assert.equal((await store.tick(stream)).action,'wait');
  let paused=(await row()).state;
  assert(paused.holding.paused);assert.equal(paused.status,'open');
  assert.deepEqual(paused.position,saved.position);assert.equal(paused.navQuote,saved.navQuote);
  assert.equal(boundaryReads,readsBefore,'No boundary RPC during pause');
  const since=paused.holding.chainSince;
  await store.close();store=new PaperStore(url.toString(),executor,identity);
  assert.equal((await store.tick(stream)).action,'wait');assert.equal((await row()).state.holding.chainSince,since);
  await checkpoint(3);
  await client.query(`UPDATE rpc_health_samples SET snapshot=snapshot || '{"state":"half_open","allowBulk":false,"reasons":["recovery_hysteresis"]}'::jsonb WHERE id=10`);
  const resumed=await store.tick(stream);assert.equal(resumed.action,'mark',JSON.stringify(resumed));
  let resumedState=(await row()).state;
  assert.equal(resumedState.status,'open');assert.equal(resumedState.holding.lastResume.fromBlock,'2000');
  assert.equal(resumedState.holding.lastResume.toBlock,'3000');assert.equal(resumedState.holding.resumeFromPause,false);
  assert.equal(resumedState.costsPaidQuote,saved.costsPaidQuote);assert.deepEqual(calls,{quote:1,entry:1,exit:0});
  await client.query("UPDATE risk_snapshot_canonicality SET validated_at=clock_timestamp()-interval '31 seconds' WHERE risk_run_id=3");
  assert((await store.tick(stream)).reasons.includes('paper_holding_risk_pause'));
  assert.equal((await row()).state.status,'open');
  // The stub performs an actual isolated DB refresh only when explicitly requested.
  assert.equal((await store.tick(stream)).action,'wait');
  assert.equal((await row()).state.holding.riskSince,null);
  await checkpoint(4);assert.equal((await store.tick(stream)).action,'mark');
  await client.query("UPDATE risk_snapshot_runs SET snapshot=jsonb_set(snapshot,'{assets,0,onchain,oraclePaused}','true') WHERE id=4");
  await checkpoint(5);
  await client.query("UPDATE risk_snapshot_runs SET snapshot=jsonb_set(snapshot,'{assets,0,onchain,oraclePaused}','true') WHERE id=5");
  assert.equal((await store.tick(stream)).action,'signal_exit');
  assert((await row()).state.holding.exitReasons.includes('paper_token_safety_check_failed'));
  const exitPending=structuredClone((await row()).state);
  await client.query('UPDATE risk_snapshot_canonicality SET canonical=false WHERE risk_run_id=2');
  assert.equal((await store.tick(stream)).status,'invalid','Revoked accounting cannot be hidden by a pause');
  // Restore only this isolated fixture to exercise the complete held-position
  // exit. Nested holding evidence gets reordered by PostgreSQL jsonb on write.
  await client.query('UPDATE risk_snapshot_canonicality SET canonical=true WHERE risk_run_id=2');
  await client.query("UPDATE paper_sessions SET state=$2,status='exit_pending' WHERE id=$1",[id,JSON.stringify(exitPending)]);
  await checkpoint(6);assert((await store.tick(stream)).reasons.includes('paper_exit_preflight_failed'));
  await checkpoint(7);assert.equal((await store.tick(stream)).action,'exit');
  assert.equal(await paperExecutionEvidenceValid(client,await row()),true);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM paper_execution_runs WHERE snapshot->>'error'='paper_session_changed_during_preflight'")).rows[0].n,0);
  console.log(JSON.stringify({passed:['holding pause before RPC','unchanged accounting','persisted first-failure time across restart','exact interval resume','no duplicate fills or costs','explicit validation retry','hard issuer exit','history revocation'],scope:'isolated DB with stub executor',calls}));
 } else {
 assert.equal(await store.stop(stream),id);
 await checkpoint(3);
 const failed=await store.tick(stream);
 assert(failed.reasons.includes('paper_exit_preflight_failed'));
 assert.equal((await row()).state.execution.gasSpentWei,entryArtifact.entryGasWei);
 await checkpoint(4);
 assert.equal((await store.tick(stream)).action,'exit');
 const closed=await row();
 assert.equal(closed.state.exitReserveQuote,'0');
 assert.equal(closed.state.execution.gasSpentWei,String(BigInt(entryArtifact.entryGasWei)+BigInt(exitArtifact.totalGasWei)));
 assert.equal(await paperExecutionEvidenceValid(client,closed),true);
 await client.query("UPDATE paper_execution_runs SET runtime_identity=NULL WHERE action='entry'");
 assert.equal(await paperExecutionEvidenceValid(client,closed),false);
 await client.query("UPDATE paper_execution_runs SET runtime_identity=$1 WHERE action='entry'",[JSON.stringify(identity)]);
 assert.deepEqual(calls,{quote:1,entry:1,exit:2});
 assert.equal(await store.tick(stream),null);
 const runs=(await client.query('SELECT action,status FROM paper_execution_runs ORDER BY id')).rows;
 assert.deepEqual(runs.map(r=>`${r.action}:${r.status}`),['quote:succeeded','entry:succeeded','exit:failed','exit:succeeded']);
 assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM paper_observations')).rows[0].n,4);
 await client.query("UPDATE paper_execution_runs SET status='failed' WHERE action='entry'");
 assert.equal(await paperExecutionEvidenceValid(client,closed),false);
 let dashboard=await readPaperDashboard(client,stream);
 assert.equal(dashboard.state.pnlQuote,null); assert.equal(dashboard.points.length,0);
 await client.query("UPDATE paper_execution_runs SET status='succeeded' WHERE action='entry'");
 await client.query('UPDATE risk_snapshot_canonicality SET observed_hash=NULL WHERE risk_run_id=2');
 assert.equal(await paperExecutionEvidenceValid(client,closed),false);
 dashboard=await readPaperDashboard(client,stream);
 assert.equal(dashboard.state.pnlQuote,null); assert.equal(dashboard.points.length,0);
 cancelDuringEntry=true;
 const cancelledId=await store.start(stream,policy);
 await checkpoint(5);assert.equal((await store.tick(stream)).action,'signal_entry');
 await checkpoint(6);assert.equal((await store.tick(stream)).status,'closed');
 const cancelled=(await client.query('SELECT * FROM paper_sessions WHERE id=$1',[cancelledId])).rows[0];
 assert.equal(cancelled.state.position,null);assert.equal(cancelled.state.costsPaidQuote,'0');
 const cancelledRun=(await client.query("SELECT status,snapshot->>'error' AS error FROM paper_execution_runs WHERE session_id=$1 AND action='entry'",[cancelledId])).rows[0];
 assert.equal(cancelledRun.status,'failed');assert.equal(cancelledRun.error,'paper_session_changed_during_preflight');
 cancelDuringEntry=false;invalidateDuringEntry=true;
 const revokedId=await store.start(stream,policy);
 await checkpoint(7);assert.equal((await store.tick(stream)).action,'signal_entry');
 await checkpoint(8);assert.equal((await store.tick(stream)).status,'invalid');
 const revoked=(await client.query('SELECT state FROM paper_sessions WHERE id=$1',[revokedId])).rows[0].state;
 assert.equal(revoked.position,null);assert.equal(revoked.pnlQuote,null);assert.equal(revoked.costsPaidQuote,'0');
 assert.deepEqual(revoked.reasons,['paper_source_changed_during_preflight']);
 const allRuns=(await client.query("SELECT action,status,snapshot->>'error' AS error FROM paper_execution_runs ORDER BY id")).rows;
 const journalRows=(await client.query('SELECT COUNT(*)::int AS n FROM paper_observations')).rows[0].n;
 assert.equal(journalRows,6);assert.equal(allRuns.length,8);
 if(boundaryMode)assert(boundaryReads>=4);
 let reentryAudit=null;
 if(process.env.PAPER_TEST_REENTRY==='1') {
  invalidateDuringEntry=false;
  await client.query("UPDATE indexer_cursors SET last_scanned_block='50000'");
  await client.query("UPDATE v3_replay_cursors SET complete_through_block='50000'");
  const continuous={...policy,maxHoldingSeconds:60,reentry:{cooldownSeconds:600}};
  const rootId=await store.start(stream,continuous);
  await checkpoint(9);assert.equal((await store.tick(stream)).action,'signal_entry');
  await checkpoint(10);assert.equal((await store.tick(stream)).action,'enter');
  const session=async id=>(await client.query('SELECT * FROM paper_sessions WHERE id=$1',[id])).rows[0];
  // Advance only the isolated fixture's holding clock; never wait a real minute.
  await client.query("UPDATE paper_sessions SET state=jsonb_set(state,'{position,enteredAt}',to_jsonb((clock_timestamp()-interval '61 seconds')::text)) WHERE id=$1",[rootId]);
  await checkpoint(11);assert.equal((await store.tick(stream)).action,'signal_exit');
  await checkpoint(12);assert.equal((await store.tick(stream)).action,'exit');
  const root=await session(rootId);
  assert.equal(root.state.reentryStoppedAt,undefined);
  const incompatible=new PaperStore(url.toString(),executor,{...identity,buildId:'c'.repeat(64)});
  try{await assert.rejects(incompatible.tick(stream),/runtime differs/);}finally{await incompatible.close();}
  await Promise.all([store.tick(stream),concurrentStore.tick(stream)]);
  let rows=(await client.query('SELECT * FROM paper_sessions WHERE id >= $1 ORDER BY id',[rootId])).rows;
  assert.equal(rows.length,2);
  const childId=rows[1].id;
  assert.equal(rows[1].policy.budgetQuote,root.state.navQuote);
  assert.equal(rows[1].policy.reentry.previousSessionId,rootId);
  await store.close();store=new PaperStore(url.toString(),executor,identity);
  const quotesBefore=calls.quote;
  await checkpoint(13);assert((await store.tick(stream)).reasons.includes('paper_reentry_cooldown'));
  assert.equal(calls.quote,quotesBefore);
  await client.query("UPDATE paper_observations SET observed_at=clock_timestamp()-interval '601 seconds' WHERE session_id=$1 AND action='exit'",[rootId]);
  await checkpoint(14);
  await client.query(`UPDATE rpc_health_samples SET snapshot=jsonb_set(snapshot,'{state}','"open"') WHERE id=33`);
  assert((await store.tick(stream)).reasons.includes('chain_recovery_not_continuously_healthy'));
  assert.equal(calls.quote,quotesBefore);
  await checkpoint(15);assert.equal((await store.tick(stream)).action,'signal_entry');
  await checkpoint(16);assert.equal((await store.tick(stream)).action,'enter');
  const child=await session(childId);
  assert.equal(child.state.position.idle0,String(BigInt(entryArtifact.balances.afterMint.quote)+BigInt(root.state.navQuote)-BigInt(entryArtifact.policy.budgetQuote)));
  const campaign=(await readPaperDashboard(client,stream)).campaign;
  assert.equal(campaign.valid,true);
  assert.deepEqual(campaign.sessionIds,[rootId,childId]);
  assert.equal(campaign.pnlQuote,String(BigInt(child.state.navQuote)-BigInt(continuous.budgetQuote)));
  assert.equal(campaign.costsPaidQuote,String(BigInt(root.state.costsPaidQuote)+BigInt(child.state.costsPaidQuote)));
  await store.stop(stream);
  await checkpoint(17);assert.equal((await store.tick(stream)).action,'exit');
  assert((await session(childId)).state.reentryStoppedAt);
  assert.equal(await store.tick(stream),null);
  await store.stop(stream); // Stopping an already-closed campaign must not reopen it.
  assert.equal(await store.tick(stream),null);
  const grandchildId=await store.start(stream,continuous,childId); // Explicit recovery from manual stop.
  await client.query("UPDATE paper_execution_runs SET status='failed' WHERE id=$1",[root.state.execution.entryRunId]);
  assert.equal((await store.tick(stream)).status,'invalid');
  assert.equal(await store.tick(stream),null);
  assert.equal((await readPaperDashboard(client,stream)).campaign.valid,false);
  await assert.rejects(store.start(stream,continuous,grandchildId),/evidence invalid/);
  rows=(await client.query('SELECT id,status FROM paper_sessions WHERE id >= $1 ORDER BY id',[rootId])).rows;
  assert.equal(rows.length,3);
  reentryAudit={passed:['automatic successor created once under concurrent ticks','runtime pin enforced before automatic continuation','net cash and gas carried across restart','cooldown prevents quotes','unhealthy recovery prevents quotes','fresh healthy checkpoint quotes then enters later','cumulative performance retains original budget and all costs','manual stop survives exit and idle ticks','explicit continuation after manual stop','revoked ancestor evidence invalidates descendants and stops reentry'],sessions:rows};
 }
 await client.query('UPDATE indexer_cursors SET last_scanned_block=1000000');
 await client.query('UPDATE v3_replay_cursors SET complete_through_block=1000000');
 cancelDuringEntry=false;invalidateDuringEntry=false;failExit=false;
 // Cross a digit boundary: ORDER BY a text-cast output alias would select an
 // earlier session and make stop spin while holding the actual latest row.
 await client.query("SELECT setval(pg_get_serial_sequence('paper_sessions','id'),99)");
 const deferredId=await store.start(stream,policy);
 assert.equal(deferredId,'100');
 await checkpoint(30);assert.equal((await store.tick(stream)).action,'signal_entry');
 await checkpoint(31);assert.equal((await store.tick(stream)).action,'enter');
 assert.equal(await store.stop(stream),deferredId);
 const beforeDeferred=(await client.query('SELECT state FROM paper_sessions WHERE id=$1',[deferredId])).rows[0].state;
 deferCoverageDuringExit=true;
 await checkpoint(32);assert.deepEqual((await store.tick(stream)).reasons,['paper_event_coverage_deferred']);
 assert.deepEqual((await client.query('SELECT state FROM paper_sessions WHERE id=$1',[deferredId])).rows[0].state,beforeDeferred);
 const exitsAtDeferral=calls.exit;
 await client.query('UPDATE indexer_cursors SET last_scanned_block=1000000');
 deferCoverageDuringExit=false;
 assert.equal((await store.tick(stream)).action,'wait');assert.equal(calls.exit,exitsAtDeferral);
 await checkpoint(33);assert.equal((await store.tick(stream)).action,'exit');
 assert.equal((await client.query("SELECT count(*)::int AS n FROM paper_execution_runs WHERE session_id=$1 AND status='failed' AND snapshot->>'error'='paper_event_coverage_deferred'",[deferredId])).rows[0].n,1);
 const result={observedAt:new Date().toISOString(),scope:'isolated PostgreSQL lifecycle with stub executor and synthetic health; not performance',passed:[
  'temporary preflight coverage retraction preserves state and costs, skips duplicate simulation and exits at the next fresh checkpoint','runtime mismatch rejects before execution','session and execution identities persist','execution identity mismatch revokes evidence','one active session per stream','unconfirmed checkpoint waits without being consumed','quote frozen before a later checkpoint','restart retains quote without duplicate calls','entry uses simulation balances and gas','network preflight holds no transaction lock blocking schema maintenance','idle ticks do not repeat fills','failed exit preflight retains position and charges no gas','later exit replaces reserve with fresh gas exactly once','successful and failed execution evidence persists','concurrent tick is excluded during unlocked preflight','operator cancellation during preflight cannot become a fill','cost evidence revocation hides economics','missing canonical hash hides economics','source revoked during unlocked simulation cannot become a fill'],calls,journalRows,executionRuns:allRuns,fixtureSchemaRemoved:true};
 console.log(JSON.stringify({...result,boundaryMode,boundaryReads,reentryAudit}));
 }
} finally { await store?.close();await concurrentStore?.close();await client.query('SET search_path=public');await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await client.query(`DROP SCHEMA IF EXISTS ${schema}_template CASCADE`);await client.end(); }
