import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {keccak256,stringToHex} from 'viem';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import type {PaperOpenFrame} from '../src/deployments/paper-preview.js';
import {buildRangeKeeperPaperConfirmation,prepareRangeKeeperPaperConfirmation,
 isRangeKeeperPaperConfirmationPreparation,type RangeKeeperPaperConfirmationProbe}
 from '../src/deployments/rangekeeper-paper-confirmation.js';
import {RangeKeeperPaperPinnedQuoteCache} from
 '../src/deployments/rangekeeper-paper-pinned-quote-cache.js';
import {parseRangeKeeperPaperCandidate,validateRangeKeeperPaperConfirmationEnvelope}
 from '../src/deployments/rangekeeper-paper-persistence.js';
import {loadRangeKeeperPaperConfirmationContext} from '../src/deployments/rangekeeper-paper-confirmation-context.js';
import {adaptRangeKeeperConfirmedOpenContext} from
 '../src/deployments/rangekeeper-paper-confirmed-open-adapter.js';
import {buildRangeKeeperPaperConfirmedOpenInventory,createRangeKeeperPaperConfirmedOpenRecord,
 validateRangeKeeperPaperConfirmedOpenRecord} from
 '../src/deployments/rangekeeper-paper-confirmed-open-adapter.js';
import {buildRangeKeeperPaperMarkPayload} from '../src/deployments/rangekeeper-paper-persistence.js';
import {buildRangeKeeperPaperOwnedForkConfirmationEvidence} from
 '../src/deployments/rangekeeper-paper-confirmation-simulation.js';
import {isRangeKeeperPaperConfirmationReplayCapability,replayRangeKeeperPaperConfirmationOnOwnedFork} from
 '../src/deployments/rangekeeper-paper-confirmation-replay-verifier.js';
import {buildRangeKeeperPaperConfirmationProducerReceipt,
 isRangeKeeperPaperServerProduced,markRangeKeeperPaperServerProduced,
 validateRangeKeeperPaperConfirmationProducerReceipt} from
 '../src/deployments/rangekeeper-paper-confirmation-provenance.js';
import {rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,rangeKeeperPaperSizeBand,
 RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP,RANGEKEEPER_PAPER_OPEN_STAGES_SWAP,
 RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES,RANGEKEEPER_PAPER_ZERO_ALLOWANCES,
 RANGEKEEPER_PAPER_POST_ENTRY_ALLOWANCES,selectRangeKeeperPaperCostProfiles,
 modelRangeKeeperPaperCosts,type RangeKeeperPaperCandidateScope} from '../src/deployments/rangekeeper-paper-cost.js';
import {replayPaperMint} from '../src/v3/position-math.js';
import type {RangeKeeperCandidate} from '../src/strategy/rangekeeper/domain.js';

const address=(n:string)=>`0x${n.repeat(40)}`;
const gasHash=(n:string)=>`0x${n.repeat(64)}`;

function gasRows(input:{candidate:RangeKeeperCandidate;scope:RangeKeeperPaperCandidateScope;
 source:PaperOpenFrame['source'];sampledAt:number;profilePool:string}){
 const path=rangeKeeperPaperPathVersion(input.candidate),sizeBand=rangeKeeperPaperSizeBand(path,input.scope),
  stages=[...(input.candidate.swap?RANGEKEEPER_PAPER_OPEN_STAGES_SWAP:RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP),
   ...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES],sequenceHash=gasHash('e'),
  estimatedAt=new Date(input.sampledAt).toISOString();
 return stages.map((stage,index)=>{
  const callHash=gasHash(String(index+1).padStart(2,'0').slice(-1));
  const source={block:input.source.block,hash:input.source.hash,estimatedAt,callHash,
   method:'owned_fork_nitro_exact_call_v1' as const};
  const model={schemaVersion:1 as const,source,gasUnitsExpected:'100000',gasUnitsBound:'130000',
   poolAddress:input.profilePool,pathVersion:path,stage,
   allowanceState:stage.startsWith('open_')?RANGEKEEPER_PAPER_ZERO_ALLOWANCES:
    RANGEKEEPER_PAPER_POST_ENTRY_ALLOWANCES,profileHash:input.scope.profileHash,
   candidateHash:input.scope.candidateHash,deployedValue:String(input.scope.deployedValue),
   sharePpm:String(input.scope.sharePpm),range:input.scope.range,
   swapKind:input.scope.swapKind,simulation:{kind:'owned_fork_full_candidate_v1' as const,
    status:'success' as const,sourceBlock:input.source.block,sourceHash:input.source.hash,
    candidateHash:input.scope.candidateHash,sequenceHash}};
  return {id:randomUUID(),version:1,poolAddress:input.profilePool,pathVersion:path,stage,
   allowanceState:model.allowanceState,sizeBand,component:'gas_units',status:'provisional',
   evidenceClass:'fork_estimated',model,sourceHash:contentHash(source),
   observedUntil:new Date(input.sampledAt)};
 });
}

test('builds only a source-pinned confirmation envelope after exact gas and simulation evidence',async()=>{
 const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:address('1'),pool:address('2'),
  token0:address('3'),token1:address('4'),quoteToken:1,decimals0:18,decimals1:18,fee:3000,
  tickSpacing:60,positionManager:address('5'),router:address('6'),quoter:address('7'),
  poolCodeHash:gasHash('a'),token0CodeHash:gasHash('b'),token1CodeHash:gasHash('c'),
  managerCodeHash:gasHash('d'),quoterCodeHash:gasHash('e'),reference0:'A/USD',reference1:'B/USD',
  nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
   token0:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
   token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
   nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
 const profileHash=contentHash(profile),parameters={fullWidthSpacings:2,limits:{
  maxDeploymentValue:'100000000000000000000',minDeploymentValue:'1',minDeploymentPpm:1,
  maxSwapInputValue:'10000000000000000000',maxSwapInputPpm:1000000,
  maxSwapShortfallValue:'1000000000000000000',maxSlippageBps:50,
  maxActionCost:'10000000000000000000',maxRollingCost:'10000000000000000000',
  maxCampaignCost:'10000000000000000000',maxExposurePpm:1000000,maxLossValue:'10000000000000000000',
  maxDrawdownPpm:1000000,maxRecenters:2,maxLiquiditySharePpm:100000,
  maxObservationGapSeconds:90,exitReserveWei:'1000000000000000'}},
  configHash=contentHash({...parameters,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1}),
  draft={id:randomUUID(),revision:1,allocation:{token0Raw:'1000000000000000000',
   token1Raw:'1000000000000000000',nativeWei:'10000000000000000'},profile,profileHash,configHash,
   strategyId:'rangekeeper_v1' as const,parameters};
 const now=Date.now(),firstAt=Math.floor(now/1000)-60,secondAt=firstAt+30,
  proof={fixture:'range-keeper-confirmation',registry:{fetchedAt:new Date(now).toISOString(),
   sha256:`sha256:${'b'.repeat(64)}`,url:'https://fixture.test/registry'},
   feedDirectory:{fetchedAt:new Date(now).toISOString(),sha256:`sha256:${'c'.repeat(64)}`,
    url:'https://fixture.test/feeds'}},proofHash=referenceProofHash(proof),
  firstSource={block:'100',hash:gasHash('1'),timestamp:firstAt},
  secondSource={block:'101',hash:gasHash('2'),timestamp:secondAt},
  frame1:PaperOpenFrame={source:firstSource,tick:0,sqrtPriceX96:sqrtRatioAtTick(0),
   poolLiquidity:10n**24n,price0:10n**18n,price1:10n**18n,nativePrice:10n**18n,
   referenceEligible:true,referenceReasons:[],referenceProofHash:proofHash,referenceProof:proof},
  frame2:PaperOpenFrame={...frame1,source:secondSource};
 const range={tickLower:-60,tickUpper:60},mint=replayPaperMint(frame1.sqrtPriceX96,range,
  10n**18n,10n**18n,0n),candidate:RangeKeeperCandidate={kind:'entry',range,swap:null,
   amount0Desired:10n**18n,amount1Desired:10n**18n,amount0Min:0n,amount1Min:0n,
   liquidity:mint.liquidity,deployedValue:2n*10n**18n,sourceBlock:100n,
   sourceHash:firstSource.hash as `0x${string}`,expiresAt:firstAt+90},
  firstHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:1,profileHash,configHash,
   source:firstSource,referenceProofHash:proofHash,candidate}),
  denominator=frame1.poolLiquidity+candidate.liquidity,
  firstScope:RangeKeeperPaperCandidateScope={poolAddress:profile.pool.pool,profileHash,
   candidateHash:firstHash,deployedValue:candidate.deployedValue,
   sharePpm:candidate.liquidity*1_000_000n/denominator,range,swapKind:'none'},
  firstRows=gasRows({candidate,scope:firstScope,source:firstSource,
   sampledAt:firstAt*1000+100,profilePool:profile.pool.pool}),
  nowGas=BigInt(1_000_000_000n),gasObservedAt=now-500,
  policyHash=contentHash({fixture:'kernel-policy'}),buildId='f'.repeat(64),
  selected=selectRangeKeeperPaperCostProfiles({candidate,scope:firstScope,source:firstSource,rows:firstRows,now});
 assert.equal(selected.status,'available');
 const firstCosts=modelRangeKeeperPaperCosts({profiles:selected,limits:{
  fullWidthSpacings:2,maxDeploymentValue:100n*10n**18n,minDeploymentPpm:1,
  maxSwapInputValue:10n*10n**18n,maxSwapInputPpm:1_000_000,maxSwapShortfallValue:10n**18n,
  maxSlippageBps:50,maxActionCost:10n**18n,maxRollingCost:10n**18n,maxCampaignCost:10n**18n,
  maxExposurePpm:1_000_000,maxLossValue:10n**18n,maxDrawdownPpm:1_000_000,maxRecenters:2,
  maxLiquiditySharePpm:100_000,maxObservationGapSeconds:90,exitReserveWei:10n**15n},
  nativePrice:10n**18n,marketGasPriceWei:nowGas,swapFeeAndShortfallValue:0n,now:gasObservedAt});
 const openModel:any={schemaVersion:1,kind:'rangekeeper_paper_open_model',status:'indicative',
  blockingReason:'rangekeeper_two_observation_confirmation_pending',campaignId:draft.id,revision:1,
  strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',draftConfigHash:configHash,
  kernelPolicyHash:null,kernelBuildId:null,policyMapping:{minimumDeployment:'unresolved',expiry:'unresolved'},
  profileHash,source:firstSource,poolState:{tick:0,sqrtPriceX96:String(frame1.sqrtPriceX96),poolLiquidity:'1000000000000000000000000'},
  reference:{price0:'1000000000000000000',price1:'1000000000000000000',nativePrice:'1000000000000000000',
   eligible:true,proofHash,proof,reasons:[]},allocation:{token0Raw:draft.allocation.token0Raw,
   token1Raw:draft.allocation.token1Raw,nativeWei:draft.allocation.nativeWei,token0Value:'1000000000000000000',
   token1Value:'1000000000000000000',nativeValue:'10000000000000000',
   strategyInventoryValue:'2000000000000000000',totalAllocatedValue:'2010000000000000000'},
  candidate:{kind:'entry',range,swap:null,amount0Desired:String(candidate.amount0Desired),
   amount1Desired:String(candidate.amount1Desired),amount0Min:'0',amount1Min:'0',
   liquidity:String(candidate.liquidity),deployedValue:String(candidate.deployedValue),
   sourceBlock:String(candidate.sourceBlock),sourceHash:candidate.sourceHash,expiresAt:candidate.expiresAt},
  candidateHash:firstHash,decision:{status:'indicative',reason:'pending',kernelAction:'confirm',
   kernelReason:'first_confirmation',requiresSecondObservation:true,remaining:{action:'1',rolling:'1',campaign:'1',nativeWei:'1'}},
  costs:firstCosts,actionAvailable:false,execution:{classification:'read_only_hypothetical',fillRecorded:false,
   paidCosts:null,modeledOpenCost:firstCosts.open.expectedValue,modeledOpenCostBound:firstCosts.open.boundValue,
   modeledRetainExitCost:firstCosts.retainExit.expectedValue,modeledExitReserve:firstCosts.retainExit.requiredReserveWei,
   configuredExitReserveWei:'1000000000000000',feeAccrual:null,netNav:null,absolutePnl:null,passiveAlpha:null},unavailable:[]};
 openModel.kernelPolicyHash=contentHash({draftConfigHash:configHash,profileHash,
  strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',limits:Object.fromEntries(Object.entries({
   fullWidthSpacings:2,maxDeploymentValue:'100000000000000000000',minDeploymentPpm:1,
   maxSwapInputValue:'10000000000000000000',maxSwapInputPpm:1000000,
   maxSwapShortfallValue:'1000000000000000000',maxSlippageBps:50,
   maxActionCost:'10000000000000000000',maxRollingCost:'10000000000000000000',
   maxCampaignCost:'10000000000000000000',maxExposurePpm:1000000,maxLossValue:'10000000000000000000',
   maxDrawdownPpm:1000000,maxRecenters:2,maxLiquiditySharePpm:100000,
   maxObservationGapSeconds:90,exitReserveWei:'1000000000000000'}))});
 openModel.kernelBuildId=buildId;
 const client={} as never,frameNow=now;
 const readFirst=async(query:{pathVersion:string;sizeBand:string})=>
  query.sizeBand===firstCosts.sizeBand?firstRows:[];
 const baseInput={draft,firstModel:openModel as never,frame:frame2,buildId,client,
  readGasProfiles:readFirst,marketGasPriceWei:nowGas,marketGasPriceObservedAt:gasObservedAt,
  simulate:async()=>({status:'success' as const,sourceBlock:secondSource.block,sourceHash:secondSource.hash,
   candidateHash:'x',simulationHash:gasHash('f')}),now:frameNow};
 const probe=await buildRangeKeeperPaperConfirmation({...baseInput,probeOnly:true});
 assert.equal(probe.status,'candidate');
 const prepared=await prepareRangeKeeperPaperConfirmation({draft,firstFrame:frame1,firstCandidate:candidate,
  frame:frame2,buildId,client});
 assert.equal(prepared.status,'prepared_candidate');
 assert.equal(prepared.actionAvailable,false);
 assert.equal(isRangeKeeperPaperConfirmationPreparation(prepared),true);
 assert.equal(isRangeKeeperPaperConfirmationPreparation(structuredClone(prepared)),false,
  'A JSON clone cannot carry the request-local planner brand');
 if(prepared.status==='prepared_candidate'){
  assert.equal(Object.isFrozen(prepared),true);
  assert.equal(Object.isFrozen(prepared.candidate),true);
  const joined=await buildRangeKeeperPaperConfirmation({...baseInput,preparation:prepared,probeOnly:true});
  assert.equal(joined.status,'candidate',JSON.stringify(joined,(_key,value)=>
   typeof value==='bigint'?String(value):value));
  if(joined.status==='candidate'&&probe.status==='candidate'){
   assert.equal(joined.candidateHash,probe.candidateHash);
   assert.equal(contentHash(JSON.parse(JSON.stringify(joined.candidate,(_key,value)=>
    typeof value==='bigint'?String(value):value))),contentHash(JSON.parse(JSON.stringify(probe.candidate,(_key,value)=>
    typeof value==='bigint'?String(value):value))));
  }
  const wrongFrame={...prepared,secondFrameHash:'0'.repeat(64)};
  assert.equal(isRangeKeeperPaperConfirmationPreparation(wrongFrame),false,
   'A modified preparation cannot be rehashed into a trusted result');
  const rejected=await buildRangeKeeperPaperConfirmation({...baseInput,preparation:wrongFrame as never,probeOnly:true});
  assert.equal(rejected.status,'unavailable');
  if(rejected.status==='unavailable')assert.equal(rejected.reason,'rangekeeper_confirmation_preparation_mismatch');
  const forgedCandidate={...prepared,candidate:{...prepared.candidate,
   amount0Desired:prepared.candidate.amount0Desired+1n}};
  assert.equal(isRangeKeeperPaperConfirmationPreparation(forgedCandidate),false,
   'A modified candidate cannot inherit the planner brand');
  const rejectedCandidate=await buildRangeKeeperPaperConfirmation({...baseInput,
   preparation:forgedCandidate as never,probeOnly:true});
  assert.equal(rejectedCandidate.status,'unavailable');
  if(rejectedCandidate.status==='unavailable')
   assert.equal(rejectedCandidate.reason,'rangekeeper_confirmation_preparation_mismatch');
 }
 const mismatchedCache=new RangeKeeperPaperPinnedQuoteCache(client,{...profile,
  pool:{...profile.pool,fee:profile.pool.fee+1}}),cacheMismatch=await buildRangeKeeperPaperConfirmation({
   ...baseInput,pinnedQuoteCache:mismatchedCache});
 assert.equal(cacheMismatch.status,'unavailable');
 if(cacheMismatch.status==='unavailable')
  assert.equal(cacheMismatch.reason,'rangekeeper_confirmation_quote_cache_context_mismatch');
 const secondCandidate=(probe as RangeKeeperPaperConfirmationProbe).candidate,
  secondRows=gasRows({candidate:secondCandidate,scope:(probe as RangeKeeperPaperConfirmationProbe).scope,
   source:secondSource,sampledAt:now,profilePool:profile.pool.pool});
 const reader=async(query:{pathVersion:string;sizeBand:string})=>
  query.sizeBand===firstCosts.sizeBand?firstRows:secondRows;
 let simulationHash: string|undefined;
 const result=await buildRangeKeeperPaperConfirmation({...baseInput,readGasProfiles:reader,
  simulate:async confirmed=>{
   const h=rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:1,profileHash,configHash,
    source:secondSource,referenceProofHash:proofHash,candidate:confirmed});
   simulationHash=h;
   const stages=[...(confirmed.swap?RANGEKEEPER_PAPER_OPEN_STAGES_SWAP:RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP),
    ...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES],ownedForkEvidence=buildRangeKeeperPaperOwnedForkConfirmationEvidence({
     probe:probe as RangeKeeperPaperConfirmationProbe,frame:frame2,configHash,
     samples:stages.map((action,index)=>({action,to:address('3'),calldata:'0x1234',returnData:'0x',
      localHash:gasHash(String((index%8)+2)),localGasUsed:'21000',localEffectiveGasPriceWei:'1',
      sourceBlock:secondSource.block,sourceHash:secondSource.hash,estimate:{gas:'25000',parentGas:'21000',
       baseFeeWei:'1',parentBaseFeeWei:'1',totalFeeWei:'1',parentFeeWei:'1',executionFeeWei:'0',
       basis:'node_estimateGas_with_paper_prestate_and_parent_component' as const},
      stateOverrideHash:'f'.repeat(64),stateOverrides:{}}))});
   return {status:'success' as const,sourceBlock:secondSource.block,sourceHash:secondSource.hash,
    candidateHash:h,simulationHash:ownedForkEvidence.sequenceHash,ownedForkEvidence};
  }});
 assert.equal(result.status,'confirmed');
 if(result.status!=='confirmed')return;
 assert.equal(result.actionAvailable,false);assert.equal(result.decision.reason,'two_confirmations');
 assert.equal(result.openingBooked,false);
 assert.equal(result.executionEvidence,'source_bound_caller_simulation_evidence_unverified');
 assert.equal(result.simulationEvidence.sequenceHash,result.decision.simulation.simulationHash);
 const freshAt={...frame2,referenceProof:{...proof,
  registry:{...proof.registry,fetchedAt:new Date(now+1000).toISOString()},
  feedDirectory:{...proof.feedDirectory,fetchedAt:new Date(now+1000).toISOString()}}};
 freshAt.referenceProofHash=referenceProofHash(freshAt.referenceProof);
 const replayed=await replayRangeKeeperPaperConfirmationOnOwnedFork({draft,envelope:result,frame:freshAt,
  operationId:randomUUID(),openPreviewId:randomUUID(),operationSnapshotHash:'a'.repeat(64),
  rpcUrl:'http://fixture.invalid',beforeRead:async()=>{}},{runOwnedFork:async request=>({
   status:'success',sourceBlock:frame2.source.block,sourceHash:frame2.source.hash,
   candidateHash:request.probe.candidateHash,simulationHash:result.simulationEvidence.sequenceHash,
   ownedForkEvidence:result.simulationEvidence})});
 assert.equal(replayed.status,'matched');assert.equal(replayed.bookingAvailable,false);
 assert.equal(replayed.actionAvailable,false);
 assert.equal(isRangeKeeperPaperConfirmationReplayCapability(replayed,{operationId:replayed.operationId,
  openPreviewId:replayed.openPreviewId,operationSnapshotHash:replayed.operationSnapshotHash,
  campaignId:draft.id,revision:1,envelopeHash:result.envelopeHash,
  candidateHash:result.confirmationObservation.candidateHash,simulationHash:result.decision.simulation.simulationHash}),false,
  'Test-injected fork runners cannot mint a booking capability');
 const tamperedReplay={...result,simulationEvidence:{...result.simulationEvidence,
  stages:result.simulationEvidence.stages.map((stage,index)=>index===0?{...stage,to:address('9')}:stage)}};
 await assert.rejects(replayRangeKeeperPaperConfirmationOnOwnedFork({draft,envelope:tamperedReplay,
  frame:frame2,operationId:randomUUID(),openPreviewId:randomUUID(),
  operationSnapshotHash:'a'.repeat(64),rpcUrl:'http://fixture.invalid',beforeRead:async()=>{}},{runOwnedFork:async request=>({
   status:'success',sourceBlock:frame2.source.block,sourceHash:frame2.source.hash,
   candidateHash:request.probe.candidateHash,simulationHash:result.simulationEvidence.sequenceHash,
   ownedForkEvidence:result.simulationEvidence})}));
 const producerPreviewId=randomUUID(),producerReceipt=buildRangeKeeperPaperConfirmationProducerReceipt({
  envelope:result,openPreviewId:producerPreviewId,producerRunId:randomUUID(),createdAt:new Date(now)});
 assert.equal(producerReceipt.kind,'rangekeeper_paper_server_producer_receipt_v1');
 assert.equal(producerReceipt.envelopeHash,result.envelopeHash);
 assert.equal(producerReceipt.openPreviewId,producerPreviewId);
 assert.deepEqual(validateRangeKeeperPaperConfirmationProducerReceipt(producerReceipt,{campaignId:draft.id,
  revision:1,openPreviewId:producerPreviewId,envelope:result}),producerReceipt);
 assert.throws(()=>validateRangeKeeperPaperConfirmationProducerReceipt(producerReceipt,{campaignId:draft.id,
  revision:1,openPreviewId:randomUUID(),envelope:result}),/producer_receipt_binding_invalid/);
 const {receiptHash:_receiptHash,...producerReceiptBody}=producerReceipt,
  forgedReceiptBody={...producerReceiptBody,candidateHash:'f'.repeat(64)},
  forgedReceipt={...forgedReceiptBody,receiptHash:contentHash(forgedReceiptBody)};
 assert.throws(()=>validateRangeKeeperPaperConfirmationProducerReceipt(forgedReceipt,{campaignId:draft.id,
  revision:1,openPreviewId:producerPreviewId,envelope:result}),/producer_receipt_binding_invalid/);
 const resultCopy={...result};assert.equal(isRangeKeeperPaperServerProduced(resultCopy),false);
 markRangeKeeperPaperServerProduced(result);assert.equal(isRangeKeeperPaperServerProduced(result),true);
 assert.equal(isRangeKeeperPaperServerProduced(resultCopy),false);
 assert.equal(result.confirmationObservation.candidateHash,simulationHash);
 assert.equal(result.decision.simulation.candidateHash,simulationHash);
 assert.equal(result.decision.gasSequenceHash,gasHash('e'));
 assert.deepEqual(validateRangeKeeperPaperConfirmationEnvelope(result,{campaignId:draft.id,revision:1}),result);
 const callerSupplied=await buildRangeKeeperPaperConfirmation({...baseInput,readGasProfiles:reader,
  simulate:async candidate=>({status:'success' as const,sourceBlock:secondSource.block,
   sourceHash:secondSource.hash,candidateHash:rangeKeeperPaperCandidateHash({campaignId:draft.id,
    revision:1,profileHash,configHash,source:secondSource,referenceProofHash:proofHash,candidate}),
   simulationHash:gasHash('f')})});
 assert.equal(callerSupplied.status,'unavailable');
 const confirmationContextBody={schemaVersion:1,kind:'rangekeeper_paper_confirmation_context_v1',
  campaignId:draft.id,revision:1,mode:'paper',lifecycle:'draft',
  runtimeIdentity:{buildId,configHash:'a'.repeat(64),nodeVersion:'v24.20.0'},
  draft:{...draft},openModel,openModelHash:contentHash(openModel),envelope:result},
  confirmationContext={...confirmationContextBody,snapshotHash:contentHash(confirmationContextBody)};
 const restoredContext=await loadRangeKeeperPaperConfirmationContext({campaignId:draft.id,
  runtimeIdentity:confirmationContext.runtimeIdentity,readSnapshot:async()=>confirmationContext,
  readGasProfiles:reader,now:frameNow});
 assert.equal(restoredContext.status,'available');
 if(restoredContext.status==='available'){
  assert.equal(restoredContext.candidate.sourceBlock,BigInt(secondSource.block));
  assert.equal(restoredContext.state.lastEligible?.hash.toLowerCase(),secondSource.hash.toLowerCase());
  assert.deepEqual(restoredContext.costs,result.costs);
  assert.equal(restoredContext.inventory.kind,'modeled_after_confirmation');
  assert.equal(restoredContext.evidence.simulation,'source_bound_caller_evidence_unverified');
  assert.equal(restoredContext.evidence.actionAvailable,false);
  assert.equal(restoredContext.evidence.openingBooked,false);
  const adapted=adaptRangeKeeperConfirmedOpenContext(restoredContext),
   bookedSource=result.confirmationObservation.source,
   nextSource={block:String(BigInt(bookedSource.block)+1n),hash:gasHash('8'),
    timestamp:bookedSource.timestamp+15};
  assert.equal(adapted.model.source.block,bookedSource.block);
  assert.equal(adapted.model.candidate?.sourceBlock,bookedSource.block);
  assert.equal(adapted.model.candidateHash,result.confirmationObservation.candidateHash);
  assert.equal(adapted.lineage.firstModelHash,result.firstObservation.modelHash);
  assert.equal(adapted.lineage.confirmationEnvelopeHash,result.envelopeHash);
  assert.equal(adapted.bookingAvailable,false);assert.equal(adapted.actionAvailable,false);
  const payload=buildRangeKeeperPaperMarkPayload({source:nextSource,
   openSource:bookedSource,openModel:adapted.model,allocation:draft.allocation,
   candidateHash:adapted.model.candidateHash!,kernelSnapshot:{source:nextSource,
    state:{schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',
     configHash:`0x${adapted.model.kernelPolicyHash}`,buildId,
     lastEligible:{block:nextSource.block,hash:nextSource.hash,timestamp:nextSource.timestamp},
     confirmation:null,exit:null},wallet0:restoredContext.inventory.idle.token0,
    wallet1:restoredContext.inventory.idle.token1,released0:'0',released1:'0',
    nativeWei:draft.allocation.nativeWei,campaignStartValue:'2000000000000000000',
    highWaterValue:'2000000000000000000',rollingSpentCost:'0',campaignSpentCost:'0',
    reservedCost:'0',recenters:0,pending:false,entryAllowed:true,safeExitRequired:false,
    executionReady:true}});
  assert.equal(payload.provenance.source.block,nextSource.block);
  assert.equal(payload.provenance.candidateHash,result.confirmationObservation.candidateHash);
  assert.equal(payload.inventory.position.liquidity,String(restoredContext.candidate.liquidity));
  const previewId=randomUUID(),operationId=randomUUID(),replayFixture={
   status:'matched' as const,campaignId:draft.id,revision:1,operationId,openPreviewId:previewId,
   operationSnapshotHash:'a'.repeat(64),envelopeHash:result.envelopeHash,
   candidateHash:result.confirmationObservation.candidateHash,
   simulationHash:result.decision.simulation.simulationHash,replayHash:'b'.repeat(64),
   bookingAvailable:false as const,actionAvailable:false as const},
   record=createRangeKeeperPaperConfirmedOpenRecord({adapter:adapted,previewId,operationId,
    replay:replayFixture});
  const openInventory=buildRangeKeeperPaperConfirmedOpenInventory({model:adapted.model,
   allocation:draft.allocation,decimals0:profile.pool.decimals0,decimals1:profile.pool.decimals1});
  assert.equal(openInventory.position.liquidity,String(restoredContext.candidate.liquidity));
  assert.equal(openInventory.idle.token0,restoredContext.inventory.idle.token0);
  assert.equal(openInventory.idle.token1,restoredContext.inventory.idle.token1);
  assert.equal(validateRangeKeeperPaperConfirmedOpenRecord(record,{campaignId:draft.id,revision:1,
   previewId,operationId,firstModel:openModel,
   confirmationEnvelopeHash:result.envelopeHash,confirmationEnvelope:result}),record);
  assert.throws(()=>validateRangeKeeperPaperConfirmedOpenRecord({...record,
   confirmationEnvelopeHash:'0'.repeat(64)},{campaignId:draft.id,revision:1,previewId,operationId,
   firstModel:openModel,confirmationEnvelopeHash:result.envelopeHash,confirmationEnvelope:result}),
   /rangekeeper_paper_confirmed_open_record_invalid/);
  const tamperedModel={...record.model,reference:{...record.model.reference,price0:'1'}},
   tamperedRecord={...record,model:tamperedModel,modelHash:contentHash(tamperedModel)};
  assert.throws(()=>validateRangeKeeperPaperConfirmedOpenRecord(tamperedRecord,{campaignId:draft.id,
   revision:1,previewId,operationId,firstModel:openModel,
   confirmationEnvelopeHash:result.envelopeHash,confirmationEnvelope:result}),
   /rangekeeper_paper_confirmed_open_model_invalid/);
 }
 const expiredOpenModel=structuredClone(openModel) as any;
 expiredOpenModel.candidate.expiresAt=firstAt-1;
 const expiredOpenHash=contentHash(expiredOpenModel),expiredEnvelopeBody=structuredClone(result) as any;
 delete expiredEnvelopeBody.envelopeHash;
 expiredEnvelopeBody.firstObservation.modelHash=expiredOpenHash;
 const expiredEnvelope={...expiredEnvelopeBody,envelopeHash:contentHash(expiredEnvelopeBody)},
  expiredContextBody={...confirmationContextBody,openModel:expiredOpenModel,
   openModelHash:expiredOpenHash,envelope:expiredEnvelope},
  expiredContext={...expiredContextBody,snapshotHash:contentHash(expiredContextBody)},
  expiredPreview=await loadRangeKeeperPaperConfirmationContext({campaignId:draft.id,
   runtimeIdentity:confirmationContext.runtimeIdentity,readSnapshot:async()=>expiredContext,
   readGasProfiles:reader,now:frameNow});
 assert.equal(expiredPreview.status,'unavailable');
 if(expiredPreview.status==='unavailable')
  assert.equal(expiredPreview.reason,'rangekeeper_confirmation_open_preview_expired');
 const staleRuntime=await loadRangeKeeperPaperConfirmationContext({campaignId:draft.id,
  runtimeIdentity:{...confirmationContext.runtimeIdentity,buildId:'0'.repeat(64)},
  readSnapshot:async()=>confirmationContext,readGasProfiles:reader,now:frameNow});
 assert.equal(staleRuntime.status,'unavailable');
 if(staleRuntime.status==='unavailable')
  assert.equal(staleRuntime.reason,'rangekeeper_confirmation_snapshot_identity_invalid');
 const invalidCandidateJson=structuredClone(result.confirmationObservation.candidate) as any;
 invalidCandidateJson.range={tickLower:900000,tickUpper:900060};
 const invalidCandidate=parseRangeKeeperPaperCandidate(invalidCandidateJson),
  invalidCandidateHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:1,profileHash,
   configHash,source:secondSource,referenceProofHash:proofHash,candidate:invalidCandidate}),
  invalidEnvelopeBody=structuredClone(result) as any;
 delete invalidEnvelopeBody.envelopeHash;
 invalidEnvelopeBody.confirmationObservation.candidate=invalidCandidateJson;
 invalidEnvelopeBody.confirmationObservation.candidateHash=invalidCandidateHash;
 invalidEnvelopeBody.decision.simulation.candidateHash=invalidCandidateHash;
 const invalidSimulationEvidence=invalidEnvelopeBody.simulationEvidence;
 invalidSimulationEvidence.candidate=invalidCandidateJson;
 invalidSimulationEvidence.candidateHash=invalidCandidateHash;
 const {sequenceHash:_oldSequenceHash,...invalidSimulationEvidenceBody}=invalidSimulationEvidence;
 invalidSimulationEvidence.sequenceHash=keccak256(stringToHex(contentHash(invalidSimulationEvidenceBody)));
 invalidEnvelopeBody.decision.simulation.simulationHash=invalidSimulationEvidence.sequenceHash;
 const invalidEnvelope={...invalidEnvelopeBody,envelopeHash:contentHash(invalidEnvelopeBody)},
  invalidContextBody={...confirmationContextBody,envelope:invalidEnvelope},
  invalidContext={...invalidContextBody,snapshotHash:contentHash(invalidContextBody)},
  mintFailure=await loadRangeKeeperPaperConfirmationContext({campaignId:draft.id,
   runtimeIdentity:confirmationContext.runtimeIdentity,readSnapshot:async()=>invalidContext,
   readGasProfiles:reader,now:frameNow});
 assert.equal(mintFailure.status,'unavailable');
 if(mintFailure.status==='unavailable')
  assert.equal(mintFailure.reason,'rangekeeper_confirmation_mint_replay_unavailable');
 assert.throws(()=>validateRangeKeeperPaperConfirmationEnvelope({...result,
  confirmationObservation:{...result.confirmationObservation,source:{...secondSource,hash:gasHash('3')}}},
  {campaignId:draft.id,revision:1}),/rangekeeper_paper_confirmation_envelope_integrity_invalid/);
 assert.throws(()=>validateRangeKeeperPaperConfirmationEnvelope(result,{campaignId:draft.id,revision:2}),
  /rangekeeper_paper_confirmation_envelope_integrity_invalid/);
 const stale=await buildRangeKeeperPaperConfirmation({...baseInput,readGasProfiles:async query=>
  query.sizeBand===firstCosts.sizeBand?firstRows:secondRows.map(row=>({...row,
   model:{...row.model,source:{...row.model.source,block:'99'}}}))});
 assert.equal(stale.status,'unavailable');
});
