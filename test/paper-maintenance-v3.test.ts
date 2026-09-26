import assert from 'node:assert/strict';
import test from 'node:test';
import type {RobinhoodClient} from '../src/client.js';
import {PAPER_CONVERSION_ACCOUNTING_POLICY_V3,
 auditCanonicalPaperConversionAccountingV3} from '../src/deployments/paper-accounting.js';
import {maintainCanonicalPaperScenario} from '../src/deployments/paper-maintenance.js';
import type {DeploymentStore,PaperAccountingAnchor} from '../src/deployments/store.js';

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
