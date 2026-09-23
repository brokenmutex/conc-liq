import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../src/client.js';
import type {DeploymentStore} from '../src/deployments/store.js';
import {processOnePaperOperation} from '../src/deployments/paper-operation-worker.js';

test('paper operation pass requests only static/manual claims',async()=>{
 const store={claimNext:async(...args:unknown[])=>{
  assert.deepEqual(args,['paper-worker-1',120,'paper','static_manual_v1']);
  return null;
 }} as unknown as DeploymentStore;
 const result=await processOnePaperOperation(store,{} as RobinhoodClient,{} as Pool,
  'paper-worker-1');
 assert.deepEqual(result,{status:'idle'});
});

test('paper operation pass blocks an unsupported persisted strategy',async()=>{
 const operationId='11111111-1111-4111-8111-111111111111',
  campaignId='22222222-2222-4222-8222-222222222222';
 const transitions:unknown[][]=[];
 const store={claimNext:async()=>({id:operationId,campaign_id:campaignId,
   status:'preflighting',stage:'accepted',attempts:1}),
  advanceClaim:async(...args:unknown[])=>{transitions.push(args);},
  renewClaim:async()=>{throw Error('Renewal must not occur');}} as unknown as DeploymentStore;
 const indexer={query:async()=>({rows:[{id:operationId,campaign_id:campaignId,
  kind:'open',status:'preflighting',claimed_by:'paper-worker-1',
  claim_until:new Date(Date.now()+60_000),created_at:new Date(Date.now()-1000),
  expires_at:new Date(Date.now()+60_000),mode:'paper',lifecycle:'opening',
  strategy_id:'rangekeeper_v1',proposal:{}}]})} as unknown as Pool;
 const result=await processOnePaperOperation(store,{} as RobinhoodClient,indexer,
  'paper-worker-1');
 assert.deepEqual(result,{status:'blocked',operationId,
  reason:'paper_operation_path_unavailable'});
 assert.deepEqual(transitions,[[operationId,'paper-worker-1',
  'paper_recovery_required','blocked','paper_operation_path_unavailable']]);
});
