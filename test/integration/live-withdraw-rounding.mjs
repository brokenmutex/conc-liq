// Exact live receipt, isolated database schema, no signer or network broadcaster.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PilotStore} from '../../src/live-pilot/store.ts';
import {PilotController} from '../../src/live-pilot/controller.ts';
import {livePilotConfig} from '../../src/live-pilot/config.ts';
import {json} from '../../src/live-pilot/domain.ts';
assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');
const f=JSON.parse(readFileSync('test/fixtures/live-withdraw-rounding-2026-09-14.json','utf8'));
for(const key of ['blockNumber','gasUsed','effectiveGasPrice'])f.receipt[key]=BigInt(f.receipt[key]);
const base=JSON.parse(readFileSync('config/live-pilot-nvda-250.json','utf8'));
base.execution.allowancePolicy=f.state.allowancePolicy;
const config=livePilotConfig(base),schema=`withdraw_rounding_test_${process.pid}_${Date.now()}`;
let store=new PilotStore(process.env.TEST_DATABASE_URL,schema),sends=0,signs=0;
const forbidden=async()=>{sends++;throw Error('No broadcast allowed');};
const chain={client:{getTransactionReceipt:async({hash})=>{assert.equal(hash,f.action.hash);return f.receipt;},
 getBlock:async()=>({number:f.receipt.blockNumber,hash:f.receipt.blockHash,timestamp:BigInt(f.after.timestamp)}),sendRawTransaction:forbidden},
 snapshot:async()=>structuredClone(f.after),broadcast:forbidden,mark:async()=>{throw Error('injected_after_commit');}};
const signer={address:f.state.operator,signIntent:async()=>{signs++;throw Error('No signing allowed');}};
const guard=async()=>({source:{block:f.after.block,hash:f.after.hash,timestamp:f.after.timestamp},entryAllowed:false,reasons:['fixture_only']});
try{
 await store.initialize();
 await store.locked(f.state.operator,async db=>{
  await store.create(db,f.state,config);
  // Non-broadcastable placeholder satisfies the journal's persisted-state constraint.
  await db.query(`INSERT INTO ${schema}.actions(id,campaign_id,nonce,intent,plan,before_state,status,raw,hash)
   VALUES($1,$2,$3,$4,$5,$6,'signed','0x01',$7)`,[f.action.id,f.state.id,f.action.before.nonce,json(f.action.intent),json(f.action.plan),json(f.action.before),f.action.hash]);
 });
 let controller=new PilotController(store,chain,config,signer,guard,async()=>{throw Error('injected_before_commit');});
 await assert.rejects(()=>controller.tick(),/injected_before_commit/);
 assert.equal((await store.pool.query(`SELECT status FROM ${schema}.actions`)).rows[0].status,'signed');
 assert.equal((await store.pool.query(`SELECT count(*) FROM ${schema}.marks`)).rows[0].count,'0');
 await store.close();store=new PilotStore(process.env.TEST_DATABASE_URL,schema);
 controller=new PilotController(store,chain,config,signer,guard);
 await assert.rejects(()=>controller.tick(),/injected_after_commit/);
 await store.close();store=new PilotStore(process.env.TEST_DATABASE_URL,schema);
 await store.locked(f.state.operator,async db=>{
  assert.equal(await store.pending(db,f.state.id),undefined);
  const {state}=await store.current(db,f.state.operator);
  assert.equal(BigInt(state.collectedFee0)-BigInt(f.state.collectedFee0),145718n);
  assert.equal(BigInt(state.gasSpentWei)-BigInt(f.state.gasSpentWei),13738601980000n);
  const row=(await db.query(`SELECT status,hash,receipt FROM ${schema}.actions`)).rows[0];
  assert.equal(row.status,'confirmed');assert.equal(row.hash,f.action.hash);
  assert.deepEqual(row.receipt.facts.collectionProof.roundingDifference,{amount0:'2',amount1:'0'});
  await assert.rejects(()=>store.finish(db,f.action,state,row.receipt,'confirmed'));
  assert.deepEqual((await store.current(db,f.state.operator)).state,state);
  assert.equal((await db.query(`SELECT count(*) FROM ${schema}.marks WHERE kind='receipt'`)).rows[0].count,'1');
  assert.equal((await db.query(`SELECT count(*) FROM ${schema}.transitions WHERE reason=$1`,[`confirmed:${f.action.id}`])).rows[0].count,'1');
 });
 assert.equal(signs,0);assert.equal(sends,0);
 console.log('Exact withdrawal: restart before/after commit, actual fee/gas accounting, duplicate completion rollback passed; zero signatures/broadcasts.');
}finally{await store.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await store.close();}
