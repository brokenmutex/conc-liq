import assert from 'node:assert/strict';
import test from 'node:test';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../src/client.js';
import type {DeploymentStore} from '../src/deployments/store.js';
import {processOnePaperOperation} from '../src/deployments/paper-operation-worker.js';
import {principalAmounts,sqrtRatioAtTick} from '../src/backtest/principal.js';
import {contentHash} from '../src/deployments/contracts.js';
import {buildRangeKeeperPaperCloseRetainBooking,
 recoverRangeKeeperPaperExitModelSource,
 rangeKeeperPaperCloseRetainModelBookingSchema,
 type RangeKeeperPaperCloseRetainModelForBooking}
 from '../src/deployments/rangekeeper-paper-exit-completion.js';

// ---------------------------------------------------------------------------
// Shared fixture: a self-consistent retain exit model whose retained-lower-
// bound/principal fields are computed from the same `principalAmounts` the
// booking builder uses, so the "happy path" actually exercises the real
// arithmetic check rather than a value that merely happens to match.
// ---------------------------------------------------------------------------
const campaignId='11111111-1111-4111-8111-111111111111';
const operationId='22222222-2222-4222-8222-222222222222';
const previewId='33333333-3333-4333-8333-333333333333';
const openMarkId='10';
const previousMarkId='11';
const tickLower=-600,tickUpper=600,liquidity=1_000_000_000n;
const sqrtPriceX96=sqrtRatioAtTick(0);
const principal=principalAmounts({liquidity,sqrtPriceX96,tickLower,tickUpper});
const idle0=12_345n,idle1=67_890n;
const retained0=idle0+principal.amount0,retained1=idle1+principal.amount1;
const openSource={block:'100',hash:`0x${'a'.repeat(64)}`,timestamp:1_000};
const previousSource={block:'110',hash:`0x${'b'.repeat(64)}`,timestamp:1_100};
const exitSource={block:'120',hash:`0x${'c'.repeat(64)}`,timestamp:1_200};
const candidateHash='d'.repeat(64),openModelHash='e'.repeat(64),
 profileHash='f'.repeat(64),draftConfigHash='1'.repeat(64);

function model(overrides:Record<string,unknown>={}):RangeKeeperPaperCloseRetainModelForBooking{
 return rangeKeeperPaperCloseRetainModelBookingSchema.parse({
  schemaVersion:1,kind:'rangekeeper_paper_exit_model',status:'indicative',exitKind:'retain',
  actionAvailable:true,campaignId,revision:1,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',
  draftConfigHash,profileHash,openMarkId,openModelHash,candidateHash,
  currentEpoch:{epoch:0,markId:openMarkId,markHash:'6'.repeat(64),source:openSource,
   candidateHash,candidateReferenceProofHash:'2'.repeat(64),allowancesCleared:false,
   position:{tickLower,tickUpper,liquidity:String(liquidity)}},
  previousMark:{id:previousMarkId,source:previousSource,candidateHash},
  source:exitSource,poolState:{tick:0,sqrtPriceX96:String(sqrtPriceX96),poolLiquidity:'1'},
  reference:{price0:'1',price1:'1',nativePrice:'1',proofHash:'2'.repeat(64),proof:{fixture:true}},
  position:{paperPositionKey:`paper:${candidateHash}`,tickLower,tickUpper,liquidity:String(liquidity),
   sharePpm:'1',idle0:String(idle0),idle1:String(idle1),
   principal0:String(principal.amount0),principal1:String(principal.amount1),
   retainedLowerBound0:String(retained0),retainedLowerBound1:String(retained1)},
  conversion:null,
  costs:{status:'provisional',profileIds:[{stage:'exit',id:'44444444-4444-4444-8444-444444444444',version:1}]},
  kernelEvaluation:null,unmodeled:['uncollected_fees'],unavailable:[],
  ...overrides});
}

const bookingInput=(overrides:Record<string,unknown>={})=>({operationId,previewId,
 modelHash:'5'.repeat(64),model:model(),
 openMarkPosition:{tickLower,tickUpper,liquidity:String(liquidity)},
 currentEpochPosition:{tickLower,tickUpper,liquidity:String(liquidity)},
 previousMark:{id:previousMarkId,position:{tickLower,tickUpper,liquidity:String(liquidity)},
  idle:{token0:String(idle0),token1:String(idle1)}},
 pool:{token0:'0x7000000000000000000000000000000000000000',
  token1:'0x7000000000000000000000000000000000000001'},...overrides});

test('buildRangeKeeperPaperCloseRetainBooking books the retained-lower-bound ledger and mark',()=>{
 const booking=buildRangeKeeperPaperCloseRetainBooking(bookingInput() as any);
 assert.equal(booking.ledger.length,3);
 const byAsset=Object.fromEntries(booking.ledger.map(entry=>[entry.asset,entry]));
 assert.equal(byAsset.token0!.entryKey,`rangekeeper_close_retain:${operationId}:token0`);
 assert.equal(byAsset.token0!.token,'0x7000000000000000000000000000000000000000');
 assert.equal((byAsset.token0!.source as any).principalLowerBoundRaw,String(retained0));
 assert.equal((byAsset.token1!.source as any).principalLowerBoundRaw,String(retained1));
 assert.equal(byAsset.native!.token,null);
 assert.equal((byAsset.native!.source as any).principalLowerBoundRaw,null);
 assert.equal((booking.mark.inventory as any).retainedPrincipalLowerBound.token0Raw,String(retained0));
 assert.equal((booking.mark.inventory as any).retainedPrincipalLowerBound.token1Raw,String(retained1));
 assert.deepEqual(booking.mark.calibrationProfileIds,['44444444-4444-4444-8444-444444444444']);
});

test('retain booking uses the active epoch position while preserving the opening baseline',()=>{
 const nextLower=-1_200,nextUpper=1_200,nextLiquidity=2_000_000_000n,
  nextPrincipal=principalAmounts({liquidity:nextLiquidity,sqrtPriceX96,tickLower:nextLower,tickUpper:nextUpper}),
  nextIdle0=101n,nextIdle1=202n,nextCandidateHash='9'.repeat(64),nextRetained0=nextIdle0+nextPrincipal.amount0,
  nextRetained1=nextIdle1+nextPrincipal.amount1;
 const nextModel=model({candidateHash:nextCandidateHash,currentEpoch:{epoch:1,markId:'11',markHash:'7'.repeat(64),
  source:previousSource,candidateHash:nextCandidateHash,candidateReferenceProofHash:'2'.repeat(64),
  allowancesCleared:true,position:{tickLower:nextLower,tickUpper:nextUpper,liquidity:String(nextLiquidity)}},
  position:{paperPositionKey:`paper:${nextCandidateHash}`,tickLower:nextLower,tickUpper:nextUpper,
   liquidity:String(nextLiquidity),sharePpm:'1',idle0:String(nextIdle0),idle1:String(nextIdle1),
   principal0:String(nextPrincipal.amount0),principal1:String(nextPrincipal.amount1),
   retainedLowerBound0:String(nextRetained0),retainedLowerBound1:String(nextRetained1)}});
 const booking=buildRangeKeeperPaperCloseRetainBooking({...bookingInput(),model:nextModel,
  currentEpochPosition:{tickLower:nextLower,tickUpper:nextUpper,liquidity:String(nextLiquidity)},
  previousMark:{id:previousMarkId,position:{tickLower:nextLower,tickUpper:nextUpper,liquidity:String(nextLiquidity)},
   idle:{token0:String(nextIdle0),token1:String(nextIdle1)}}} as any);
 assert.equal((booking.mark.inventory as any).retainedPrincipalLowerBound.token0Raw,String(nextRetained0));
 assert.equal((booking.mark.provenance as any).candidateHash,nextCandidateHash);
});

test('buildRangeKeeperPaperCloseRetainBooking fails closed on every independently-checkable mismatch',()=>{
 // conversion/exitKind mismatch: corrupt the already-parsed model directly,
 // since the booking schema itself forces conversion:null for a 'retain' kind.
 assert.throws(()=>buildRangeKeeperPaperCloseRetainBooking(
  {...bookingInput(),model:{...model(),exitKind:'convert'}} as any),
  /rangekeeper_paper_exit_retain_model_kind_mismatch/);
 assert.throws(()=>buildRangeKeeperPaperCloseRetainBooking(
  {...bookingInput(),previousMark:{...bookingInput().previousMark,id:'999'}} as any),
  /rangekeeper_paper_exit_previous_mark_mismatch/);
 assert.throws(()=>buildRangeKeeperPaperCloseRetainBooking(
  {...bookingInput(),openMarkPosition:{tickLower:tickLower+60,tickUpper,liquidity:String(liquidity)}} as any),
  /rangekeeper_paper_exit_position_mismatch/);
 assert.throws(()=>buildRangeKeeperPaperCloseRetainBooking(
  {...bookingInput(),previousMark:{...bookingInput().previousMark,
   idle:{token0:'1',token1:String(idle1)}}} as any),
  /rangekeeper_paper_exit_idle_mismatch/);
 assert.throws(()=>buildRangeKeeperPaperCloseRetainBooking(
  {...bookingInput(),model:model({position:{...model().position,principal0:'1'}})} as any),
  /rangekeeper_paper_exit_principal_mismatch/);
 assert.throws(()=>buildRangeKeeperPaperCloseRetainBooking(
  {...bookingInput(),model:model({position:{...model().position,retainedLowerBound0:'1'}})} as any),
  /rangekeeper_paper_exit_retained_lower_bound_mismatch/);
});

test('recoverRangeKeeperPaperExitModelSource binds the model to its declared hash before trusting it',()=>{
 const m=model();
 const proposal={rangekeeperPaperExitModel:m,rangekeeperPaperExitModelHash:contentHash(m)};
 assert.deepEqual(recoverRangeKeeperPaperExitModelSource(proposal),exitSource);
 assert.equal(recoverRangeKeeperPaperExitModelSource(null),null);
 assert.equal(recoverRangeKeeperPaperExitModelSource({}),null);
 assert.equal(recoverRangeKeeperPaperExitModelSource({rangekeeperPaperExitModel:m,
  rangekeeperPaperExitModelHash:'not-a-hash'}),null);
 assert.equal(recoverRangeKeeperPaperExitModelSource({rangekeeperPaperExitModel:m,
  rangekeeperPaperExitModelHash:contentHash({...m,revision:2})}),null,
  'a hash that does not bind the saved model must never be trusted');
 assert.equal(recoverRangeKeeperPaperExitModelSource({rangekeeperPaperExitModel:{...m,source:{block:'x'}},
  rangekeeperPaperExitModelHash:contentHash({...m,source:{block:'x'}})}),null,
  'a structurally-invalid source must not be returned even if the hash binds');
});

// ---------------------------------------------------------------------------
// Worker dispatch: processOnePaperOperation routing rangekeeper_v1 through
// close_retain/close_convert (gap D), stubbing the store/chain/indexer the
// way test/rangekeeper-paper-operation-worker.test.ts and
// test/deployments-paper-operation-worker.test.ts already do.
// ---------------------------------------------------------------------------
function exitWorkerFixture({kind='close_retain',status='preflighting',
 proposalOverride}:{kind?:string;status?:string;proposalOverride?:Record<string,unknown>}={}){
 const calls:unknown[][]=[];
 const m=model();
 const proposal=proposalOverride??{rangekeeperPaperExitModel:m,rangekeeperPaperExitModelHash:contentHash(m)};
 const context={id:operationId,campaign_id:campaignId,kind,status,claimed_by:'rk-worker',
  claim_valid:true,created_at:new Date(Date.now()-1_000),expires_at:new Date(Date.now()+60_000),
  mode:'paper',lifecycle:'closing',strategy_id:'rangekeeper_v1',proposal,request:{},
  current_revision:1,expected_revision:1,preview_kind:kind};
 const store={claimNext:async(_w:string,_l:number,_m:'paper'|'live',strategy?:string)=>
   strategy==='rangekeeper_v1'?{id:operationId,campaign_id:campaignId,status,stage:'accepted',attempts:1}:null,
  advanceClaim:async(...args:unknown[])=>{calls.push(['advance',...args]);},
  renewClaim:async(...args:unknown[])=>{calls.push(['renew',...args]);},
  releaseClaim:async(...args:unknown[])=>{calls.push(['release',...args]);},
  completeRangeKeeperPaperConfirmedExit:async(...args:unknown[])=>{
   calls.push(['complete',...args.slice(0,2)]);return {markId:'99',replayed:false};},
 };
 const chain={getChainId:async()=>4663,
  getBlock:async({blockNumber}:{blockNumber:bigint})=>({hash:exitSource.hash,
   timestamp:BigInt(exitSource.timestamp)})};
 const indexer={query:async()=>({rows:[context]})};
 return {store:store as unknown as DeploymentStore,chain:chain as unknown as RobinhoodClient,
  indexer:indexer as unknown as Pool,calls};
}

test('worker routes rangekeeper close_retain through sourceFor, anchors and completion',async()=>{
 const {store,chain,indexer,calls}=exitWorkerFixture();
 const result=await processOnePaperOperation(store,chain,indexer,'rk-worker');
 assert.deepEqual(result,{status:'completed',operationId,kind:'close_retain',markId:'99',replayed:false});
 assert.deepEqual(calls.map(c=>c[0]),['advance','advance','complete']);
 assert.deepEqual(calls[0]!.slice(1),[operationId,'rk-worker',
  'paper_model_preflight_checked','executing',null]);
 assert.deepEqual(calls[1]!.slice(1),[operationId,'rk-worker',
  'paper_model_reconciling','reconciling',null]);
});

test('worker resumes a reconciling close_retain claim and completes exactly once',async()=>{
 const {store,chain,indexer,calls}=exitWorkerFixture({status:'reconciling'});
 const result=await processOnePaperOperation(store,chain,indexer,'rk-worker');
 assert.deepEqual(result,{status:'completed',operationId,kind:'close_retain',markId:'99',replayed:false});
 assert.deepEqual(calls.map(c=>c[0]),['complete']);
});

test('worker requires owned-fork replay configuration before booking RangeKeeper convert',async()=>{
 const {store,chain,indexer,calls}=exitWorkerFixture({kind:'close_convert'});
 const result=await processOnePaperOperation(store,chain,indexer,'rk-worker');
 assert.deepEqual(result,{status:'blocked',operationId,
  reason:'rangekeeper_paper_convert_fork_rpc_unavailable'});
 // The claim still advances to 'reconciling' and the source is still
 // anchor-checked before the kind is refused; the third advance is the
 // block() call itself moving the claim to 'blocked'. Only the completion
 // call is withheld.
 assert.deepEqual(calls.map(c=>c[0]),['advance','advance','advance']);
 assert.equal(calls.some(c=>c[0]==='complete'),false);
});

test('worker fails closed when the saved exit model does not bind to its declared hash',async()=>{
 const {store,chain,indexer,calls}=exitWorkerFixture({
  proposalOverride:{rangekeeperPaperExitModel:model(),rangekeeperPaperExitModelHash:'f'.repeat(64)}});
 const result=await processOnePaperOperation(store,chain,indexer,'rk-worker');
 assert.deepEqual(result,{status:'blocked',operationId,reason:'paper_operation_saved_model_unavailable'});
 assert.equal(calls.some(c=>c[0]==='complete'),false);
});

test('worker fails closed when the exit model source is not canonical',async()=>{
 const {store,chain,indexer,calls}=exitWorkerFixture();
 (chain as any).getBlock=async()=>({hash:`0x${'9'.repeat(64)}`,timestamp:BigInt(exitSource.timestamp)});
 const result=await processOnePaperOperation(store,chain,indexer,'rk-worker');
 assert.deepEqual(result,{status:'blocked',operationId,reason:'paper_operation_canonical_or_evidence_invalid'});
 assert.equal(calls.some(c=>c[0]==='complete'),false);
});

test('worker leaves rangekeeper lifecycle/pause kinds refused exactly as before gap D',async()=>{
 const {store,chain,indexer}=exitWorkerFixture({kind:'pause'});
 const result=await processOnePaperOperation(store,chain,indexer,'rk-worker');
 assert.deepEqual(result,{status:'blocked',operationId,
  reason:'rangekeeper_paper_operation_path_unavailable'});
});
