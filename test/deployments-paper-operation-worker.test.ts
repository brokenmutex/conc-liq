import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../src/client.js';
import type {DeploymentStore} from '../src/deployments/store.js';
import {processOnePaperOperation} from '../src/deployments/paper-operation-worker.js';

const operationId='11111111-1111-4111-8111-111111111111';
const campaignId='22222222-2222-4222-8222-222222222222';
const anchor={block:'100',hash:'0x'+'a'.repeat(64),timestamp:1_000};
const openModel={schemaVersion:1,kind:'paper_open_model',campaignId,revision:1,
 strategyId:'static_manual_v1',profileHash:'a'.repeat(64),configHash:'b'.repeat(64),
 candidateHash:'c'.repeat(64),source:anchor,poolState:{tick:0,sqrtPriceX96:'1',poolLiquidity:'1'},
 referenceProof:{fixture:true},referenceProofHash:'d'.repeat(64),
 reference:{price0:'1',price1:'1',nativePrice:'1'},
 allocation:{token0Raw:'1',token1Raw:'1',nativeWei:'1'},
 candidate:{range:{tickLower:-60,tickUpper:60,fullWidthTicks:120},liquidity:'1',
  amount0Desired:'1',amount1Desired:'1',amount0Minted:'1',amount1Minted:'1',
  idle0:'0',idle1:'0',deployedValue:'1',exposurePpm:'1',feeEarningAtEntry:true,
  oneSided:false,dilutedSharePpm:'1'},
 costs:{status:'provisional',scope:'open_and_close_retain_gas_only',
  pathVersion:'paper_static_manual_no_swap_v1',sizeBand:'fixture',gasPriceWei:'1',
  boundGasPriceWei:'1',gasPriceObservedAt:new Date().toISOString(),nativeReferencePrice:'1',
  stages:Array.from({length:6},(_,i)=>({stage:`s${i}`,profileId:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
   version:1,evidenceClass:'fork_estimated',expectedGasUnits:'1',boundGasUnits:'1',
   source:{block:'100',hash:anchor.hash,estimatedAt:new Date().toISOString(),
    callHash:'0x'+'e'.repeat(64),method:'owned_fork_nitro_exact_call_v1'} })),
  open:{expectedGasUnits:'1',boundGasUnits:'1',expectedWei:'1',boundWei:'1',expectedValue:'1',boundValue:'1'},
  closeRetain:{expectedGasUnits:'1',boundGasUnits:'1',expectedWei:'1',boundWei:'1',expectedValue:'1',boundValue:'1'},
  missing:[]}};

function workerFixture({status='preflighting',kind='open',claimValid=true,
 verifyError=false,completeError=false}:{status?:string;kind?:string;claimValid?:boolean;
 verifyError?:boolean;completeError?:boolean}={}){
 const calls:unknown[][]=[];
 let currentStatus=status;
 const context={id:operationId,campaign_id:campaignId,kind,status,
  claimed_by:'paper-worker-1',claim_valid:claimValid,created_at:new Date(Date.now()-1000),
  expires_at:new Date(Date.now()+60_000),mode:'paper',lifecycle:'opening',
  strategy_id:'static_manual_v1',proposal:{paperOpenModel:openModel,
   paperCloseRetainModel:retainModel}};
 const store={claimNext:async()=>({id:operationId,campaign_id:campaignId,
   status:currentStatus,stage:'accepted',attempts:1}),
  advanceClaim:async(...args:unknown[])=>{calls.push(['advance',...args]);currentStatus=args[3] as string;},
  renewClaim:async(...args:unknown[])=>{calls.push(['renew',...args]);},
  completeTrustedPaperOpen:async(...args:unknown[])=>{calls.push(['complete',...args.slice(0,2)]);
   if(completeError)throw Error('temporary database outage');return {markId:'1',replayed:false};},
  completeTrustedPaperCloseRetain:async(...args:unknown[])=>{calls.push(['retain',...args.slice(0,2)]);},
  prepareTrustedPaperCloseConvert:async(...args:unknown[])=>{calls.push(['prepare-convert',...args.slice(0,2)]);},
  completeTrustedPaperCloseConvert:async(...args:unknown[])=>{calls.push(['complete-convert',...args.slice(0,2)]);},
 };
 const chain={getChainId:async()=>{if(verifyError)throw Error('transient RPC fault');return 4663;},
  getBlock:async({blockNumber}:{blockNumber:bigint})=>{
   const source=String(blockNumber)==='101'?retainModel.source:anchor;
   return {hash:source.hash,timestamp:BigInt(source.timestamp)};
  }};
 const indexer={query:async()=>({rows:[context]})};
 return {store,chain,indexer,calls};
}

const retainModel={schemaVersion:1,kind:'paper_close_retain_model',campaignId,revision:1,
 openMarkId:'1',previousMarkId:'1',previousSource:{block:'100',hash:anchor.hash},
 openModelHash:'a'.repeat(64),source:{block:'101',hash:'0x'+'f'.repeat(64),timestamp:1_001},
 poolState:{tick:0,sqrtPriceX96:'1',poolLiquidity:'1'},referenceProof:{fixture:true},
 referenceProofHash:'d'.repeat(64),reference:{price0:'1',price1:'1',nativePrice:'1'},
 principal:{amount0Raw:'1',amount1Raw:'1'},retainedLowerBound:{token0Raw:'1',token1Raw:'1'},
 unobserved:['fee_capture','paid_gas','net_economics'],costs:openModel.costs};

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
  claim_valid:true,created_at:new Date(Date.now()-1000),
  expires_at:new Date(Date.now()+60_000),mode:'paper',lifecycle:'opening',
  strategy_id:'rangekeeper_v1',proposal:{}}]})} as unknown as Pool;
 const result=await processOnePaperOperation(store,{} as RobinhoodClient,indexer,
  'paper-worker-1');
 assert.deepEqual(result,{status:'blocked',operationId,
  reason:'paper_operation_path_unavailable'});
 assert.deepEqual(transitions,[[operationId,'paper-worker-1',
  'paper_recovery_required','blocked','paper_operation_path_unavailable']]);
});

test('paper operation pass leaves an expired claim for another worker',async()=>{
 const operationId='11111111-1111-4111-8111-111111111111',
  campaignId='22222222-2222-4222-8222-222222222222';
 const store={claimNext:async()=>({id:operationId,campaign_id:campaignId,
   status:'preflighting',stage:'accepted',attempts:1}),
  advanceClaim:async()=>{throw Error('Expired claim must not be blocked');},
  renewClaim:async()=>{throw Error('Renewal must not occur');}} as unknown as DeploymentStore;
 const indexer={query:async()=>({rows:[{id:operationId,campaign_id:campaignId,
  kind:'open',status:'preflighting',claimed_by:'paper-worker-1',claim_valid:false,
  created_at:new Date(Date.now()-1000),expires_at:new Date(Date.now()+60_000),
  mode:'paper',lifecycle:'opening',strategy_id:'static_manual_v1',proposal:{}}]})} as unknown as Pool;
 assert.deepEqual(await processOnePaperOperation(store,{} as RobinhoodClient,indexer,
  'paper-worker-1'),{status:'claim_lost',operationId});
});

test('paper operation worker completes an open through the claimed lifecycle',async()=>{
 const {store,chain,indexer,calls}=workerFixture();
 assert.deepEqual(await processOnePaperOperation(store as unknown as DeploymentStore,
  chain as unknown as RobinhoodClient,indexer as unknown as Pool,'paper-worker-1'),
  {status:'completed',operationId,kind:'open'});
 assert.deepEqual(calls.map(call=>call[0]),['advance','advance','complete']);
 assert.deepEqual(calls.slice(0,2).map(call=>call.slice(1)),[
  [operationId,'paper-worker-1','paper_model_preflight_checked','executing',null],
  [operationId,'paper-worker-1','paper_model_reconciling','reconciling',null]]);
});

test('paper operation worker leaves transient RPC failure retryable without accounting',async()=>{
 const {store,chain,indexer,calls}=workerFixture({verifyError:true});
 assert.deepEqual(await processOnePaperOperation(store as unknown as DeploymentStore,
  chain as unknown as RobinhoodClient,indexer as unknown as Pool,'paper-worker-1'),
  {status:'retry',operationId,reason:'paper_operation_transient_error'});
 assert.equal(calls.some(call=>call[0]==='complete'),false);
 assert.equal(calls.some(call=>call[0]==='advance'&&call[4]==='blocked'),false);
});

test('paper operation worker blocks canonical anchor mismatch before completion',async()=>{
 const {store,chain,indexer,calls}=workerFixture();
 chain.getBlock=async()=>({hash:'0x'+'f'.repeat(64),timestamp:BigInt(anchor.timestamp)});
 assert.deepEqual(await processOnePaperOperation(store as unknown as DeploymentStore,
  chain as unknown as RobinhoodClient,indexer as unknown as Pool,'paper-worker-1'),
  {status:'blocked',operationId,reason:'paper_operation_canonical_or_evidence_invalid'});
 assert.equal(calls.some(call=>call[0]==='complete'),false);
});

test('paper operation worker reports takeover when persisted lease owner changed',async()=>{
 const {store,chain,indexer,calls}=workerFixture({claimValid:false});
 assert.deepEqual(await processOnePaperOperation(store as unknown as DeploymentStore,
  chain as unknown as RobinhoodClient,indexer as unknown as Pool,'paper-worker-1'),
  {status:'claim_lost',operationId});
 assert.deepEqual(calls,[]);
});

test('paper operation worker resumes reconciliation and appends open accounting once',async()=>{
 const {store,chain,indexer,calls}=workerFixture({status:'reconciling'});
 const result=await processOnePaperOperation(store as unknown as DeploymentStore,
  chain as unknown as RobinhoodClient,indexer as unknown as Pool,'paper-worker-1');
 assert.deepEqual(result,{status:'completed',operationId,kind:'open'});
 assert.deepEqual(calls.map(call=>call[0]),['complete']);
 assert.equal(calls.filter(call=>call[0]==='complete').length,1);
});

test('paper operation worker completes retain-close from its saved model',async()=>{
 const {store,chain,indexer,calls}=workerFixture({kind:'close_retain',status:'reconciling'});
 const result=await processOnePaperOperation(store as unknown as DeploymentStore,
  chain as unknown as RobinhoodClient,indexer as unknown as Pool,'paper-worker-1');
 assert.deepEqual(result,{status:'completed',operationId,kind:'close_retain'});
 assert.deepEqual(calls.map(call=>call[0]),['retain']);
});
