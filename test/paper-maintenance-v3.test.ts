import assert from 'node:assert/strict';
import test from 'node:test';
import type {RobinhoodClient} from '../src/client.js';
import {PAPER_ACCOUNTING_POLICY,PAPER_CONVERSION_ACCOUNTING_POLICY_V2,PAPER_CONVERSION_ACCOUNTING_POLICY_V3,
 auditCanonicalPaperConversionAccountingV3} from '../src/deployments/paper-accounting.js';
import {maintainCanonicalPaperScenario} from '../src/deployments/paper-maintenance.js';
import {DeploymentConflict,type DeploymentStore,type PaperAccountingAnchor} from '../src/deployments/store.js';

test('V3 canonical audit uses its own policy and detects a stable reorg',async()=>{
 const anchor={accountingId:'4',block:'120',hash:`0x${'1'.repeat(64)}`,
  timestamp:1020} as PaperAccountingAnchor;
 let policy:string|undefined,reads=0;
 const store={async auditPaperAccounting(_campaignId:string,
  verify:(chainId:number,sources:readonly PaperAccountingAnchor[])=>Promise<unknown>,
  selectedPolicy:string){
  policy=selectedPolicy;
  const mismatch=await verify(4663,[anchor]);
  return {alreadyInvalidated:false,invalidated:mismatch?[{accountingId:'4'}]:[]};
 }} as unknown as DeploymentStore;
 const client={getChainId:async()=>4663,getBlock:async()=>{
  reads++;
  return {hash:`0x${'2'.repeat(64)}`,timestamp:1020};
 }} as unknown as RobinhoodClient;

 const result=await auditCanonicalPaperConversionAccountingV3(store,client,
  '00000000-0000-4000-8000-000000000001');
 assert.equal(policy,PAPER_CONVERSION_ACCOUNTING_POLICY_V3);
 assert.equal(reads,2);
 assert.deepEqual(result.invalidated,[{accountingId:'4'}]);
});

test('maintenance treats a trusted V3 terminal as current without V2 reprojection',async()=>{
 const auditedPolicies:string[]=[],calls:string[]=[];
 const store={async auditPaperAccounting(_campaignId:string,
  _verify:(chainId:number,sources:readonly PaperAccountingAnchor[])=>Promise<unknown>,
  policy:string){
  auditedPolicies.push(policy);
  return {alreadyInvalidated:false,invalidated:[]};
 },async hasTrustedStaticPaperCloseConvertV3Terminal(){return true;},
 async recordNextPaperAccounting(){calls.push('legacy_projection');},
 async recordCanonicalNextPaperConversionAccountingV2(){calls.push('v2_projection');},
 } as unknown as DeploymentStore;
 const client={getChainId:async()=>4663} as unknown as RobinhoodClient;
 const indexer={} as never;

 const result=await maintainCanonicalPaperScenario(store,client,indexer,
  '00000000-0000-4000-8000-000000000001');
 assert.equal(result.status,'projection_current');
 assert.equal(result.terminalV3,true);
 assert.equal(result.caughtUp,true);
 assert.equal(auditedPolicies.at(-1),PAPER_CONVERSION_ACCOUNTING_POLICY_V3);
 assert.deepEqual(calls,[]);
});

test('default maintenance continues from caught-up V1 into V2 within one bounded pass',async()=>{
 const policies:string[]=[];let v1Writes=0,v2Writes=0;
 const store={
  async auditPaperAccounting(){return {alreadyInvalidated:false,invalidated:[]};},
  async hasTrustedStaticPaperCloseConvertV3Terminal(){return false;},
  async recordNextPaperAccounting(_campaignId:string,_verify:unknown,policy?:string){
   const selected=policy??PAPER_ACCOUNTING_POLICY;policies.push(selected);
   if(selected===PAPER_CONVERSION_ACCOUNTING_POLICY_V2)
    return v2Writes++<2?{markId:String(v2Writes)}:null;
   return v1Writes++<2?{markId:String(v1Writes)}:null;
  },
 } as unknown as DeploymentStore;
 const leaseClient={on(){return this;},off(){return this;},release(){},async query(sql:string){
  if(sql.includes('pg_try_advisory_lock_shared'))return {rows:[{acquired:true}]};
  if(sql.includes('pg_advisory_unlock_shared'))return {rows:[{unlocked:true}]};
  throw Error('Unexpected preparation lease query');
 }};
 const indexer={connect:async()=>leaseClient} as unknown as import('pg').Pool;
 const client={getChainId:async()=>4663} as unknown as RobinhoodClient;
 const result=await maintainCanonicalPaperScenario(store,client,indexer,
  '00000000-0000-4000-8000-000000000001',4,{sampleValuation:false});
 assert.deepEqual(policies,[PAPER_ACCOUNTING_POLICY,PAPER_ACCOUNTING_POLICY,
  PAPER_ACCOUNTING_POLICY,PAPER_CONVERSION_ACCOUNTING_POLICY_V2,
  PAPER_CONVERSION_ACCOUNTING_POLICY_V2]);
 assert.equal(result.status,'budget_exhausted');
 assert.equal(result.caughtUp,false);
 assert.equal(v1Writes,3,'two V1 writes plus caught-up probe');
 assert.equal(v2Writes,2,'both V2 predecessors are projected within the same four-step budget');

 policies.length=0;
 const caughtUp=await maintainCanonicalPaperScenario(store,client,indexer,
  '00000000-0000-4000-8000-000000000001',4,{sampleValuation:false});
 assert.deepEqual(policies,[PAPER_ACCOUNTING_POLICY,PAPER_CONVERSION_ACCOUNTING_POLICY_V2]);
 assert.equal(caughtUp.status,'projection_current');
 assert.equal(caughtUp.caughtUp,true);
});

function delayedProjectionFixture({v1=[],v2=[]}:{v1?:string[];v2?:string[]}={}){
 const pendingV1=[...v1],pendingV2=[...v2],projectedV1=['1'],projectedV2:string[]=[];
 let valuationStateReads=0,replayUnavailable=false;
 const store={
  async auditPaperAccounting(){return {alreadyInvalidated:false,invalidated:[]};},
  async hasTrustedStaticPaperCloseConvertV3Terminal(){return false;},
  async paperValuationState(){
   valuationStateReads++;
   throw new DeploymentConflict('paper_valuation_state_unavailable');
  },
  async recordNextPaperAccounting(_campaignId:string,_verify:unknown,policy?:string){
   if(replayUnavailable)throw Error('simulated canonical replay temporarily unavailable');
   const v2Policy=policy===PAPER_CONVERSION_ACCOUNTING_POLICY_V2,
    queue=v2Policy?pendingV2:pendingV1,projected=v2Policy?projectedV2:projectedV1,
    markId=queue.shift();
   if(markId===undefined)return null;
   projected.push(markId);
   return {markId,snapshotId:markId};
  },
 } as unknown as DeploymentStore;
 const leaseClient={on(){return this;},off(){return this;},release(){},async query(sql:string){
  if(sql.includes('pg_try_advisory_lock_shared'))return {rows:[{acquired:true}]};
  if(sql.includes('pg_advisory_unlock_shared'))return {rows:[{unlocked:true}]};
  throw Error('Unexpected preparation lease query');
 }};
 const indexer={connect:async()=>leaseClient} as unknown as import('pg').Pool;
 const client={getChainId:async()=>4663} as unknown as RobinhoodClient;
 return {store,indexer,client,pendingV1,pendingV2,projectedV1,projectedV2,
  setReplayUnavailable(value:boolean){replayUnavailable=value;},
  get valuationStateReads(){return valuationStateReads;}};
}

test('maintenance drains an existing V1 backlog before sampling a new valuation',async()=>{
 const fixture=delayedProjectionFixture({v1:['2','3']});
 const partial=await maintainCanonicalPaperScenario(fixture.store,fixture.client,fixture.indexer,
  '00000000-0000-4000-8000-000000000001',1,{sampleValuation:true});
 assert.equal(partial.status,'budget_exhausted');
 assert.deepEqual(fixture.projectedV1,['1','2']);
 assert.equal(fixture.valuationStateReads,0,
  'budget exhaustion must leave the later valuation unsampled behind the pending mark');

 const caughtUp=await maintainCanonicalPaperScenario(fixture.store,fixture.client,fixture.indexer,
  '00000000-0000-4000-8000-000000000001',2,{sampleValuation:true});
 assert.equal(caughtUp.status,'projection_current');
 assert.equal(caughtUp.caughtUp,true);
 assert.deepEqual(fixture.projectedV1,['1','2','3']);
 assert.equal(fixture.pendingV1.length,0,
  'the latest saved mark is fully projected before this pass returns');
 assert.equal(fixture.valuationStateReads,0,
  'the pass that finishes the backlog must not immediately append a later valuation');

 const subsequent=await maintainCanonicalPaperScenario(fixture.store,fixture.client,fixture.indexer,
  '00000000-0000-4000-8000-000000000001',2,{sampleValuation:true});
 assert.equal(subsequent.status,'projection_current');
 assert.equal(fixture.valuationStateReads,1,
  'a later pass may enter the valuation sampler once the saved journal was already current');
});

test('a V2-only backlog also blocks valuation sampling across bounded passes',async()=>{
 const fixture=delayedProjectionFixture({v2:['2','3']});
 const partial=await maintainCanonicalPaperScenario(fixture.store,fixture.client,fixture.indexer,
  '00000000-0000-4000-8000-000000000001',1,{sampleValuation:true});
 assert.equal(partial.status,'budget_exhausted');
 assert.deepEqual(fixture.projectedV2,['2']);
 assert.equal(fixture.valuationStateReads,0);

 const caughtUp=await maintainCanonicalPaperScenario(fixture.store,fixture.client,fixture.indexer,
  '00000000-0000-4000-8000-000000000001',2,{sampleValuation:true});
 assert.equal(caughtUp.status,'projection_current');
 assert.equal(caughtUp.caughtUp,true);
 assert.deepEqual(fixture.projectedV2,['2','3']);
 assert.equal(fixture.valuationStateReads,0,
  'V1 being current cannot let a later mark bypass a delayed V2 projection');

 await maintainCanonicalPaperScenario(fixture.store,fixture.client,fixture.indexer,
  '00000000-0000-4000-8000-000000000001',2,{sampleValuation:true});
 assert.equal(fixture.valuationStateReads,1);
});

test('unavailable accounting replay defers sampling through failure and the recovery pass',async()=>{
 const fixture=delayedProjectionFixture({v1:['2']});
 fixture.setReplayUnavailable(true);
 for(let pass=0;pass<2;pass++)
  await assert.rejects(maintainCanonicalPaperScenario(fixture.store,fixture.client,fixture.indexer,
   '00000000-0000-4000-8000-000000000001',2,{sampleValuation:true}),
   /simulated canonical replay temporarily unavailable/);
 assert.equal(fixture.valuationStateReads,0,
  'replay failure must stop the pass before entering valuation sampling');

 fixture.setReplayUnavailable(false);
 const recovered=await maintainCanonicalPaperScenario(fixture.store,fixture.client,fixture.indexer,
  '00000000-0000-4000-8000-000000000001',2,{sampleValuation:true});
 assert.equal(recovered.status,'projection_current');
 assert.deepEqual(fixture.projectedV1,['1','2']);
 assert.equal(fixture.valuationStateReads,0,
  'the pass that catches up after replay recovery returns without sampling a newer mark');

 await maintainCanonicalPaperScenario(fixture.store,fixture.client,fixture.indexer,
  '00000000-0000-4000-8000-000000000001',1,{sampleValuation:true});
 assert.equal(fixture.valuationStateReads,1,
  'a one-step pass that begins caught up can still enter the sampler');
});
