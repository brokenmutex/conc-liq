import assert from 'node:assert/strict';
import test from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {USDG} from '../src/constants.js';
import {contentHash} from '../src/deployments/contracts.js';
import {referenceProofHash} from '../src/deployments/market-profile.js';
import {sizeLiquidityForQuoteBudget} from '../src/simulator/math.js';
import {buildResearchCandidateReplay,verifyResearchCandidateReplay} from '../src/research/candidate-replay.js';

const digest=contentHash;
const hash=(n:string)=>`0x${n.repeat(64)}`;
const fromTimestamp=Math.floor(Date.parse('2026-09-23T10:00:00.000Z')/1000);
const throughTimestamp=fromTimestamp+900;
const source=(block:string,sourceHash:string,timestamp:number)=>({block,hash:sourceHash,timestamp});
const quoteCapital=100_000_000n;
const token1='0x7000000000000000000000000000000000000001';
const range={tickLower:-60,tickUpper:60};
const profile={chainId:4663,profileHash:'a'.repeat(64),id:'00000000-0000-4000-8000-000000000001',
 claimedVerificationClass:'canonical_chain_and_independent_reference_v1' as const,
 poolAddress:'0x8000000000000000000000000000000000000001',token0:USDG,token1,
 decimals0:6,decimals1:6,quoteToken:0 as const,fee:3000,tickSpacing:60,
 reference0:'USDG/USD',reference1:'TOKEN/USD',nativeReference:'ETH/USD' as const,
 streamKey:'rh-v3',targetSetHash:'target-set-abc',maxPoolDeviationPpm:1_000};
const from=source('100',hash('1'),fromTimestamp),through=source('115',hash('2'),throughTimestamp);
const frame=(anchor:ReturnType<typeof source>)=>({source:anchor,
 sourceClaim:{kind:'caller_claimed_rpc_anchor_bracket_v1' as const,block:anchor.block,
  expectedHash:anchor.hash,observedHash:anchor.hash,timestamp:anchor.timestamp,
  checkedBefore:true as const,checkedAfter:true as const},profileHash:profile.profileHash,
 poolState:{tick:0,sqrtPriceX96:String(sqrtRatioAtTick(0)),poolLiquidity:'1000000000'},
 references:{source:anchor,price0:'1000000000000000000',price1:'1000000000000000000',
  nativePrice:'2000000000000000000000',proofHash:'',proof:{source:anchor,
   token0:{basis:'heartbeat_valid',oracle:{executionEligible:true,feed:{baseAsset:'USDG',quoteAsset:'USD'},
    state:{answer:'100000000',decimals:8}}},
   token1:{basis:'heartbeat_valid',oracle:{executionEligible:true,feed:{baseAsset:'TOKEN',quoteAsset:'USD'},
    state:{answer:'100000000',decimals:8}}},
   native:{executionEligible:true,feed:{baseAsset:'ETH',quoteAsset:'USD'},
    state:{answer:'200000000000',decimals:8}}}}});
const fromFrame=frame(from),throughFrame=frame(through);
fromFrame.references.proofHash=referenceProofHash(fromFrame.references.proof);
throughFrame.references.proofHash=referenceProofHash(throughFrame.references.proof);
const candidateSizing=sizeLiquidityForQuoteBudget({budgetQuote:quoteCapital,quoteToken:USDG,
 sqrtPriceX96:sqrtRatioAtTick(0),tickLower:range.tickLower,tickUpper:range.tickUpper,
 token0:profile.token0,token1:profile.token1});
const interval={kind:'paper_observed_flow_fee_interval_v1' as const,pool:profile.poolAddress,
 token0Address:profile.token0,token1Address:profile.token1,fee:profile.fee,tickSpacing:profile.tickSpacing,
 from:{block:from.block,hash:from.hash},to:{block:through.block,hash:through.hash},range,
 liquidity:String(candidateSizing.liquidity),
 token0:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
 token1:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
 events:0,segments:0,partialSegments:0,accounting:'modeled_hypothetical_fee_share' as const,
 coverage:{stream:profile.streamKey,targetSetHash:profile.targetSetHash,
  completeThroughBlock:through.block,completeThroughHash:through.hash,chainAnchorRecheckRequired:false as const}};
const gasEstimateTime='2026-09-23T10:00:30.000Z';
const gasSource={block:'99',hash:hash('9'),estimatedAt:gasEstimateTime,callHash:hash('8'),
 method:'owned_fork_nitro_exact_call_v1' as const};
const stages=['approve_token0','approve_token1','mint','withdraw_collect','cleanup_token0','cleanup_token1'] as const;
const gasProfiles=stages.map((stage,index)=>{
 const model={schemaVersion:1 as const,source:{...gasSource,callHash:hash(String(index+1))},
  gasUnitsExpected:'100000',gasUnitsBound:'130000',sizeMinValue:'1',sizeMaxValue:'100000000000000000000000',
  shareMinPpm:'0',shareMaxPpm:'1000000',tickLower:range.tickLower,tickUpper:range.tickUpper};
 return {id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,version:1,
  poolAddress:profile.poolAddress,pathVersion:'paper_static_manual_no_swap_v1',stage,
  allowanceState:'zero',sizeBand:'exact_test_scope',component:'gas_units',status:'provisional',
  evidenceClass:'fork_estimated',model,sourceHash:digest(model.source),observedUntil:new Date(gasEstimateTime)};
});
const gasPrice=(anchor:ReturnType<typeof source>)=>({source:anchor,expectedWei:'1000000000',
 boundWei:'1250000000',method:'canonical_gas_price_scenario_v1' as const});
const input={request:{schemaVersion:1 as const,strategyId:'static_manual_v1' as const,
 windowSeconds:900,capitalQuoteRaw:String(quoteCapital),range},profile,from:fromFrame,through:throughFrame,
 feeInterval:interval,gasProfiles,gasPricing:{open:gasPrice(from),close:gasPrice(through)}};
const now=Date.parse('2026-09-23T10:20:00.000Z');

test('static/manual candidate scenario reconciles canonical sources, inventory, fees and scoped costs',()=>{
 const result=buildResearchCandidateReplay(input,now);
 assert.equal(result.status,'unverified_scenario');
 assert.equal(result.actionAvailable,false);
 assert.equal(result.draftCreationAvailable,false);
 assert.equal(result.candidate?.liquidity,String(candidateSizing.liquidity));
 assert.equal(result.economics?.passiveStartUsd6,String(quoteCapital));
 assert.equal(result.economics?.passiveEndUsd6,String(quoteCapital));
 assert.equal(result.economics?.totalExpectedCostUsd6,'1200000');
 assert.equal(result.economics?.totalBoundCostUsd6,'1950000');
 assert(result.evidenceHash);
 assert.deepEqual(verifyResearchCandidateReplay(input,result,now),{valid:true,reason:null});
});

test('RangeKeeper stays unavailable without its outside timer and recenter replay',()=>{
 const result=buildResearchCandidateReplay({...input,request:{...input.request,strategyId:'rangekeeper_v1'}},now);
 assert.equal(result.status,'unavailable');
 assert.equal(result.missing[0],'rangekeeper_recenter_replay_unavailable');
 assert.equal(result.economics,null);
});

test('candidate replay fails closed when a scoped gas stage is absent',()=>{
 const result=buildResearchCandidateReplay({...input,gasProfiles:gasProfiles.slice(1)},now);
 assert.equal(result.status,'unavailable');
 assert.equal(result.missing[0],'candidate_scoped_cost_evidence_unavailable');
 assert.equal(result.economics,null);
});

test('candidate replay rejects unverified anchors, self-mismatched references, and fee scope changes',()=>{
 const badAnchor=structuredClone(input);
 (badAnchor.through.sourceClaim as unknown as {checkedAfter:boolean}).checkedAfter=false;
 assert.equal(buildResearchCandidateReplay(badAnchor,now).missing[0],'source_anchor_claim_mismatch');
 const badRef=structuredClone(input);badRef.from.references.price0='0';
 assert.equal(buildResearchCandidateReplay(badRef,now).missing[0],'independent_reference_unavailable');
 const mismatchedRef=structuredClone(input);mismatchedRef.from.references.price0='1000000000000000001';
 assert.equal(buildResearchCandidateReplay(mismatchedRef,now).missing[0],'independent_reference_value_mismatch');
 const badProofHash=structuredClone(input);badProofHash.from.references.proofHash='b'.repeat(64);
 assert.equal(buildResearchCandidateReplay(badProofHash,now).missing[0],'reference_proof_hash_mismatch');
 const badFee=structuredClone(input);badFee.feeInterval.coverage.targetSetHash='other-targets';
 assert.equal(buildResearchCandidateReplay(badFee,now).missing[0],'canonical_fee_interval_scope_mismatch');
});

test('replay verification recomputes the complete result and rejects changed economics',()=>{
 const result=buildResearchCandidateReplay(input,now),changed=structuredClone(result);
 assert.equal(verifyResearchCandidateReplay(input,changed,now).valid,true);
 changed.economics!.candidatePnlExpectedUsd6='0';
 assert.deepEqual(verifyResearchCandidateReplay(input,changed,now),
  {valid:false,reason:'candidate_replay_result_mismatch'});
});
