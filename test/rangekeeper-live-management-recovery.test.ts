import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {RangeKeeperMintUnavailableError,RangeKeeperStaleCandidateError} from '../src/strategy/rangekeeper/live-stage.js';
import {RANGEKEEPER_MINT_WAIT_SECONDS,classifyRangeKeeperStageError,convertRangeKeeperRecenterToRetainExit,
 deriveRangeKeeperLiveReplanTransition,isRangeKeeperMintPriceSlippage,rangeKeeperLiveCostBudgetExhausted,
 rangeKeeperLiveRemainingActionBudget,settleRangeKeeperLiveStageError} from '../src/deployments/rangekeeper-live-management-recovery.js';
import {deriveRangeKeeperStage,isRangeKeeperAwaitingReplan,isRangeKeeperRetainedExit,
 type RangeKeeperLiveCampaign} from '../src/deployments/rangekeeper-live-campaign.js';
import {describeRangeKeeperWorkerError} from '../src/deployments/rangekeeper-live-wallet-worker.js';
import {isTransientReferenceReadError,shouldRetryReceiptValuation} from '../src/deployments/rangekeeper-live-queue-adapters.js';

const wallet='0x0000000000000000000000000000000000000003',hash=(c:string)=>`0x${c.repeat(64)}` as `0x${string}`;
const source={block:100n,hash:hash('1'),timestamp:1_800_000_000};
const snapshot=(tick=0,at=source):any=>({source:at,operator:wallet,wallet0:900n,wallet1:800n,nativeWei:5_000n,nonce:7,nftCount:1n,tick,
 sqrtPriceX96:1n<<96n,unlocked:true,poolLiquidity:10_000n,allowances:[],position:null});
const candidate=(over:Record<string,unknown>={}):any=>({kind:'recenter',range:{tickLower:-60,tickUpper:60},swap:null,amount0Desired:1n,
 amount1Desired:2n,amount0Min:1n,amount1Min:1n,liquidity:3n,deployedValue:4n,sourceBlock:BigInt(source.block)+30n,
 sourceHash:hash('2'),expiresAt:source.timestamp+200,...over});
function state(over:Record<string,unknown>={}):any{
 return {version:1,id:'c1',operator:wallet,configHash:hash('b'),buildId:'e'.repeat(64),phase:'recenter',desired:'running',exitMode:null,
  haltReason:null,createdAt:1,expiresAt:9_999_999_999,economicActions:1,recenters:0,
  policy:{schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',configHash:hash('b'),buildId:'e'.repeat(64),lastEligible:null,
   exit:{tokenId:'9'},confirmation:{firstBlock:1n}},last:snapshot(),activeTokenId:null,retiredTokenIds:['9'],legacyNftCount:0n,
  reserve0:0n,reserve1:0n,reserveNativeWei:0n,initial0:1n,initial1:1n,initialNativeWei:1n,initialStrategyValue:1n,candidate:candidate(),
  swapDone:false,swapConfirmedAt:null,withdrawDone:true,actionStartCostIndex:0,reservedActionCost:50n,mintRecoveryAttempts:0,
  collectedFee0:0n,collectedFee1:0n,gasSpentWei:10n,costEvents:[{hash:hash('3'),block:90n,timestamp:source.timestamp-60,gasWei:10n,
   gasValue:20n,swapFeeValue:0n,swapShortfallValue:0n}],highWaterValue:1n,activeSeconds:0,outsideSeconds:0,lastMarkTimestamp:1,
  lastReason:'withdraw_collected',closedAt:null,...over};
}
const limits:any={maxActionCost:100n,maxRollingCost:500n,maxCampaignCost:1_000n};
const campaign=(s:any,over:Record<string,unknown>={}):RangeKeeperLiveCampaign=>({id:'c1',chainId:4663,wallet:wallet as any,revision:1,
 profileId:'p',profileHash:'a'.repeat(64),profile:{},config:{limits} as any,configHash:hash('b'),revisionConfig:{},revisionConfigHash:'c'.repeat(64),
 allocation:{allocationId:'a1',campaignId:'c1',revision:1,wallet,liquidByTokenAddress:{},nativeSpendWei:1n,pendingNativeSpendWei:0n,
  exitReserveWei:1n,nftTokenIds:[],allocationHash:'d'.repeat(64),sourceGeneration:1,sourceHash:source.hash},baseline:{},reviewPayload:{},
 state:s,stateHash:'f'.repeat(64),stateRevision:5,status:'active',...over} as any);

describe('recenter stage-error settlement',()=>{
 const stale=new RangeKeeperStaleCandidateError('Current swap would leave the approved range');
 const mint=new RangeKeeperMintUnavailableError('Frozen mint range no longer contains price');
 it('discards a stale candidate after a confirmed withdrawal for re-planning and repeats nothing',()=>{
  const before=state(),result=settleRangeKeeperLiveStageError(before,snapshot(5),source.timestamp,stale);
  assert.equal(result.kind,'replan');if(result.kind!=='replan')return;
  assert.equal(result.state.candidate,null);assert.equal(result.state.policy.confirmation,null);assert.equal(result.state.policy.exit,null);
  assert.equal(result.state.reservedActionCost,0n);assert.equal(result.state.withdrawDone,true,'the confirmed withdrawal is never repeated');
  assert.equal(result.state.activeTokenId,null);assert.deepEqual(result.state.retiredTokenIds,['9']);
  assert.equal(result.state.actionStartCostIndex,0,'costs already attributed to this recenter stay counted');
  assert.equal(result.state.costEvents.length,1);assert.equal(result.state.phase,'recenter');
  assert.equal(before.candidate.kind,'recenter','input state stays untouched');assert(isRangeKeeperAwaitingReplan(result.state));
  assert.equal(isRangeKeeperAwaitingReplan(before),false);
 });
 it('treats an infeasible no-swap mint after the withdrawal the same way',()=>{
  assert.equal(settleRangeKeeperLiveStageError(state(),snapshot(),source.timestamp,mint).kind,'replan');
 });
 it('never settles a stale candidate before the withdrawal or after a completed swap',()=>{
  assert.equal(settleRangeKeeperLiveStageError(state({withdrawDone:false,activeTokenId:9n}),snapshot(),source.timestamp,stale).kind,'unsettled');
  assert.equal(settleRangeKeeperLiveStageError(state({swapDone:true,swapConfirmedAt:source.timestamp}),snapshot(),source.timestamp,stale).kind,'unsettled');
  assert.equal(settleRangeKeeperLiveStageError(state({phase:'holding'}),snapshot(),source.timestamp,stale).kind,'unsettled');
  assert.equal(settleRangeKeeperLiveStageError(state({desired:'stopped'}),snapshot(),source.timestamp,stale).kind,'unsettled');
  assert.equal(settleRangeKeeperLiveStageError(state(),snapshot(),source.timestamp,new Error('boom')).kind,'unsettled');
 });
 it('waits a bounded time for a post-swap mint, then exits retained without repeating the swap',()=>{
  const swapped=state({swapDone:true,swapConfirmedAt:source.timestamp-60,candidate:candidate({swap:{token:0}})});
  const wait=settleRangeKeeperLiveStageError(swapped,snapshot(0),source.timestamp,mint);
  assert.deepEqual(wait,{kind:'wait',reason:'repriced_mint_wait'});
  const late=settleRangeKeeperLiveStageError({...swapped,swapConfirmedAt:source.timestamp-RANGEKEEPER_MINT_WAIT_SECONDS},snapshot(0),source.timestamp,mint);
  assert.equal(late.kind,'exit');
  const outside=settleRangeKeeperLiveStageError(swapped,snapshot(500),source.timestamp,mint);
  assert.equal(outside.kind,'exit');
  if(outside.kind==='exit'){
   const s=outside.state;assert(isRangeKeeperRetainedExit(s));assert.equal(s.candidate,null);assert.equal(s.phase,'exit');
   assert.equal(s.exitMode,'retain');assert.equal(s.desired,'stopped');assert.deepEqual(s.retiredTokenIds,['9']);
   assert.equal(s.actionStartCostIndex,s.costEvents.length,'the exit starts its own action-cost window');
   assert.match(s.lastReason,/repriced_mint_exit/);
  }
 });
 it('converts a recenter in progress to a retained exit without losing custody history',()=>{
  const live=state({activeTokenId:9n,withdrawDone:false,candidate:candidate(),retiredTokenIds:[]});
  const converted=convertRangeKeeperRecenterToRetainExit(live,'loss_limit',snapshot(1));
  assert(isRangeKeeperRetainedExit(converted));assert.equal(converted.activeTokenId,9n);assert.equal(converted.candidate,null);
  assert.equal(converted.lastReason,'manager_close_retain:loss_limit');assert.equal(converted.last.tick,1);
  assert.throws(()=>convertRangeKeeperRecenterToRetainExit({...live,phase:'holding'},'x'),/Only a recenter/);
 });
 it('recognises a mint price-slippage failure anywhere in the error chain before signing',()=>{
  const inner=new Error('execution reverted: Price slippage check'),outer=Object.assign(new Error('call failed'),{cause:{cause:inner}});
  assert.equal(isRangeKeeperMintPriceSlippage(outer),true);assert.equal(isRangeKeeperMintPriceSlippage(new Error('other')),false);
  assert(classifyRangeKeeperStageError({kind:'mint'} as any,outer) instanceof RangeKeeperMintUnavailableError);
  assert.equal(classifyRangeKeeperStageError({kind:'swap'} as any,outer),outer);
  assert.equal(classifyRangeKeeperStageError(null,outer),outer);
 });
});

describe('replan transition',()=>{
 const c=campaign(state({candidate:null,reservedActionCost:0n}));
 const policy=(over:Record<string,unknown>={})=>({schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',configHash:hash('b'),
  buildId:'e'.repeat(64),lastEligible:{block:BigInt(source.block)+30n,hash:hash('2'),timestamp:source.timestamp+30},exit:null,confirmation:null,...over}) as any;
 const fresh={block:String(source.block+30n),hash:hash('2'),timestamp:source.timestamp+30};
 const input=(over:Record<string,unknown>={})=>({source:fresh,snapshot:snapshot(0,{block:source.block+30n,hash:hash('2'),timestamp:source.timestamp+30} as any),
  candidate:candidate({kind:'entry'}),policy:policy(),costs:{status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source:fresh,actionCostValue:'30'},...over}) as any;
 it('installs the fresh candidate as a recenter candidate and keeps the withdrawal and costs',()=>{
  const next=deriveRangeKeeperLiveReplanTransition(c,input());
  assert.equal(next.candidate?.kind,'recenter');assert.equal(next.withdrawDone,true);assert.equal(next.swapDone,false);
  assert.equal(next.reservedActionCost,30n);assert.equal(next.costEvents.length,1);assert.equal(next.activeTokenId,null);
  assert.equal(next.policy.confirmation,null);assert.match(next.lastReason,/manager_recenter_replan/);assert.equal(isRangeKeeperAwaitingReplan(next),false);
  assert.equal(c.state!.candidate,null,'input state stays untouched');
 });
 it('rejects a replan that is not bound to a later canonical source, an unconfirmed policy, or an over-budget cost',()=>{
  const awaiting=c;
  assert.doesNotThrow(()=>deriveRangeKeeperLiveReplanTransition(awaiting,input()));
  assert.throws(()=>deriveRangeKeeperLiveReplanTransition(campaign(state({candidate:candidate()})),input()),/Only a withdrawn recenter/);
  const bad=(over:Record<string,unknown>,pattern:RegExp)=>assert.throws(()=>deriveRangeKeeperLiveReplanTransition(awaiting,input(over)),pattern);
  bad({source:{...fresh,block:'99'},snapshot:snapshot(0,{block:99n,hash:hash('2'),timestamp:source.timestamp+30} as any)},/not later/);
  bad({candidate:candidate({sourceHash:hash('9')})},/source\/expiry mismatch/);
  bad({candidate:candidate({expiresAt:source.timestamp})},/source\/expiry mismatch/);
  bad({policy:policy({confirmation:{firstBlock:1n}})},/not confirmed/);
  bad({policy:policy({buildId:'f'.repeat(64)})},/not confirmed/);
  bad({costs:{status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source:fresh,actionCostValue:'81'}},/remaining per-action/);
  bad({costs:{status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source:{...fresh,block:'1'},actionCostValue:'3'}},/cost evidence/);
 });
 it('derives the remaining per-action budget from receipts already attributed to this recenter',()=>{
  assert.equal(rangeKeeperLiveRemainingActionBudget(campaign(state())),80n);
  assert.equal(rangeKeeperLiveRemainingActionBudget(campaign(state({costEvents:[{...state().costEvents[0],gasValue:null}]}))),0n,'unvalued costs leave no budget');
  assert.equal(rangeKeeperLiveRemainingActionBudget(campaign(state({actionStartCostIndex:1}))),100n);
 });
});

describe('cost-budget exit trigger',()=>{
 const events=(value:bigint)=>[{hash:hash('3'),block:90n,timestamp:1,gasWei:1n,gasValue:value,swapFeeValue:0n,swapShortfallValue:0n}];
 it('fires only when valued receipts reach the rolling or campaign cap',()=>{
  assert.equal(rangeKeeperLiveCostBudgetExhausted(campaign(state({costEvents:events(499n)}))),false);
  assert.equal(rangeKeeperLiveCostBudgetExhausted(campaign(state({costEvents:events(500n)}))),true,'rolling cap');
  const tight=campaign(state({costEvents:events(900n)}));tight.config.limits={...limits,maxRollingCost:2_000n,maxCampaignCost:900n} as any;
  assert.equal(rangeKeeperLiveCostBudgetExhausted(tight),true,'campaign cap');
  assert.equal(rangeKeeperLiveCostBudgetExhausted(campaign(state({costEvents:[{...events(1n)[0]!,gasValue:null}]}))),false,
   'unvalued history is not itself an exit trigger');
 });
});

describe('stage identity and error handling helpers',()=>{
 it('derives a distinct, bounded stage key for the replacement of a cancelled unsigned intent',()=>{
  const plan={kind:'approve',token:0,spender:'positionManager',amount:5n} as const;
  const first=deriveRangeKeeperStage(plan,3),retry=deriveRangeKeeperStage(plan,3,1),again=deriveRangeKeeperStage(plan,3,2);
  assert.notEqual(first,retry);assert.notEqual(retry,again);assert.equal(deriveRangeKeeperStage(plan,3,0),first);
  assert(retry.length<=64&&/^[A-Za-z0-9._:-]{1,64}$/.test(retry));assert.throws(()=>deriveRangeKeeperStage(plan,3,-1),/retry/);
 });
 it('labels deterministic gas and cost bounds with a stable, clear worker reason',()=>{
  for(const message of ['Stage would invade reserved exit gas','Stage cost exceeds reviewed action budget','Owned-fork stage exceeds per-action cost policy',
   'Stage padded gas exceeds bounded transaction size','rangekeeper_withdrawCollect_gas_bound','Retained close exceeds its scoped native allocation'])
   assert.match(describeRangeKeeperWorkerError(new Error(message)),/^stage_gas_or_cost_bound_exceeded: /,message);
  assert.equal(describeRangeKeeperWorkerError(new Error('Lease lost')),'Lease lost');
  assert.equal(describeRangeKeeperWorkerError('x'),'worker_adapter_failed');
  assert(describeRangeKeeperWorkerError(new Error('x'.repeat(2000))).length<=300);
 });
 it('retries a reference outage at a recent receipt but lets an old receipt be recorded unvalued',()=>{
  const http503=Object.assign(new Error('HTTP request failed.'),{name:'HttpRequestError',status:503});
  assert.equal(isTransientReferenceReadError(http503),true);
  assert.equal(isTransientReferenceReadError(Object.assign(new Error('x'),{cause:{status:503}})),true);
  assert.equal(isTransientReferenceReadError(new Error('independent_reference_unavailable')),false);
  const now=1_800_000_000_000,recent=now/1000-30,old=now/1000-3_600;
  assert.equal(shouldRetryReceiptValuation(http503,old,now),true,'transport outages always retry');
  assert.equal(shouldRetryReceiptValuation(new Error('independent_reference_unavailable'),recent,now),true);
  assert.equal(shouldRetryReceiptValuation(new Error('independent_reference_unavailable'),old,now),false);
 });
});
