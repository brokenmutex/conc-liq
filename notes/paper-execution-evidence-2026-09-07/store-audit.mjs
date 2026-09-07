import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { PaperStore } from '../../src/paper/store.ts';
import { DEFAULT_PAPER_POLICY, PAPER_NVDA, PAPER_POOL } from '../../src/paper/engine.ts';
import { paperExecutionEvidenceValid } from '../../src/paper/evidence.ts';
import { readPaperDashboard } from '../../src/dashboard/paper.ts';
import { sqrtRatioAtTick } from '../../src/backtest/principal.ts';
import { USDG } from '../../src/constants.ts';
const schema=`paper_execution_audit_${process.pid}_${Date.now()}`;
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
const entryArtifact=JSON.parse(await readFile(new URL('round-trip.json',import.meta.url),'utf8'));
const exitArtifact=JSON.parse(await readFile(new URL('restored-exit.json',import.meta.url),'utf8')).result;
const policy={...DEFAULT_PAPER_POLICY,mode:'research'}; // Isolated mechanics fixture; never a live session.
const stream='paper-execution-fixture';
const calls={quote:0,entry:0,exit:0};
const valuation=cp=>({sourceBlock:cp.block,sourceHash:cp.hash,computedAt:new Date().toISOString(),ethUsdAnswer:'200000000000',ethUsdDecimals:8,quoteUsdAnswer:'100000000',quoteUsdDecimals:8});
let failExit=true;
const executor={
 async quote(cp) { calls.quote++; return {...entryArtifact.range,sourceBlock:cp.block,sourceHash:cp.hash,quotedAt:new Date().toISOString(),swapAmountQuote:entryArtifact.entrySwap.amountIn,minRwaOut:entryArtifact.entrySwap.amountOutMinimum}; },
 async enter(cp,p,intent) { calls.entry++; assert.equal(intent.swapAmountQuote,entryArtifact.entrySwap.amountIn); return {result:{...entryArtifact,source:{block:cp.block,hash:cp.hash},policy:p},valuation:valuation(cp)}; },
 async exit(cp,p,inventory) { calls.exit++; if(failExit) { failExit=false; throw new Error('fixture rejected preflight'); } return {result:{...exitArtifact,source:{block:cp.block,hash:cp.hash},policy:p,inventory},valuation:valuation(cp)}; },
};
await client.connect();
let store;
const insert=async(table,row)=>client.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},$1::jsonb)).*`,[JSON.stringify(row)]);
try {
 await client.query(`CREATE SCHEMA ${schema}`);
 await client.query(`SET search_path=${schema},public`);
 for(const table of ['v3_strategy_checkpoint_runs','v3_strategy_pool_checkpoints','risk_snapshot_canonicality','asset_risk_snapshots','indexer_cursors','v3_replay_cursors','indexer_pools','rpc_health_samples','v3_pool_events','risk_snapshot_runs','risk_snapshot_attempts'])
  await client.query(`CREATE TABLE ${schema}.${table} AS SELECT * FROM public.${table} WITH NO DATA`);
 const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
 store=new PaperStore(url.toString(),executor); await store.migrate();
 const id=await store.start(stream,policy);
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
  await client.query('DELETE FROM rpc_health_samples');
  for(let i=0;i<34;i++) {
   const observed=now-1000-(33-i)*10000,observedAt=new Date(observed).toISOString(),head=10000+i*100,anchor=head-64;
   const probe={chainId:4663,error:null,anchorError:null,anchorBlock:String(anchor),anchorHash:hash,headBlock:String(head),headHash:hash,headTimestamp:String(Math.floor(observed/1000))};
   const snapshot={observedAt,state:'healthy',allowBulk:true,reasons:[],privateSyncing:false,anchorBlock:String(anchor),anchorHash:hash,privateAnchorHash:hash,privateHead:String(head),privateHeadTimestamp:probe.headTimestamp,probes:[{...probe,role:'private',name:'fixture-private'},{...probe,role:'reference',name:'fixture-ref-a'},{...probe,role:'reference',name:'fixture-ref-b'}]};
   await insert('rpc_health_samples',{id:String(i+1),observed_at:observedAt,snapshot});
  }
 };
 await checkpoint(1);
 assert.equal((await store.tick(stream)).action,'signal_entry');
 assert.deepEqual(calls,{quote:1,entry:0,exit:0});
 await store.close(); store=new PaperStore(url.toString(),executor);
 assert.equal((await store.tick(stream)).action,'wait');
 assert.deepEqual(calls,{quote:1,entry:0,exit:0});
 await checkpoint(2);
 assert.equal((await store.tick(stream)).action,'enter');
 const row=async()=> (await client.query('SELECT * FROM paper_sessions WHERE id=$1',[id])).rows[0];
 let open=await row();
 assert.equal(await paperExecutionEvidenceValid(client,open),true);
 assert.equal(open.state.execution.gasSpentWei,entryArtifact.entryGasWei);
 assert.equal(open.state.position.idle0,entryArtifact.balances.afterMint.quote);
 assert.equal((await store.tick(stream)).action,'wait');
 assert.deepEqual(calls,{quote:1,entry:1,exit:0});
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
 const result={observedAt:new Date().toISOString(),scope:'isolated PostgreSQL lifecycle with stub executor and synthetic health; not performance',passed:[
  'one active session per stream','quote frozen before a later checkpoint','restart retains quote without duplicate calls','entry uses simulation balances and gas','idle ticks do not repeat fills','failed exit preflight retains position and charges no gas','later exit replaces reserve with fresh gas exactly once','successful and failed execution evidence persists','cost evidence revocation hides economics','missing canonical hash hides economics'],calls,journalRows:4,executionRuns:runs,fixtureSchemaRemoved:true};
 await writeFile(new URL('store-audit.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally { await store?.close();await client.query('SET search_path=public');await client.query(`DROP SCHEMA ${schema} CASCADE`);await client.end(); }
