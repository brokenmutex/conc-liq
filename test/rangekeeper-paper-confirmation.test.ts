import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import type {PaperOpenFrame} from '../src/deployments/paper-preview.js';
import {buildRangeKeeperPaperConfirmation,type RangeKeeperPaperConfirmationProbe}
 from '../src/deployments/rangekeeper-paper-confirmation.js';
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
  proof={fixture:'range-keeper-confirmation'},proofHash=referenceProofHash(proof),
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
   simulationHash=h;return {status:'success' as const,sourceBlock:secondSource.block,
    sourceHash:secondSource.hash,candidateHash:h,simulationHash:gasHash('f')};
  }});
 assert.equal(result.status,'confirmed');
 if(result.status!=='confirmed')return;
 assert.equal(result.actionAvailable,false);assert.equal(result.decision.reason,'two_confirmations');
 assert.equal(result.openingBooked,false);
 assert.equal(result.executionEvidence,'caller_supplied_simulation_attestation_unverified');
 assert.equal(result.confirmationObservation.candidateHash,simulationHash);
 assert.equal(result.decision.simulation.candidateHash,simulationHash);
 assert.equal(result.decision.gasSequenceHash,gasHash('e'));
 const stale=await buildRangeKeeperPaperConfirmation({...baseInput,readGasProfiles:async query=>
  query.sizeBand===firstCosts.sizeBand?firstRows:secondRows.map(row=>({...row,
   model:{...row.model,source:{...row.model.source,block:'99'}}}))});
 assert.equal(stale.status,'unavailable');
});
