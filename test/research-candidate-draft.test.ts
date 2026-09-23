import assert from 'node:assert/strict';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {referenceProofHash,marketProfileSchema} from '../src/deployments/market-profile.js';
import {USDG,UNISWAP_V3_FACTORY,NONFUNGIBLE_POSITION_MANAGER} from '../src/constants.js';
import {PAPER_ROUTER,PAPER_QUOTER} from '../src/paper/execution-abi.js';
import {createStaticResearchDraft} from '../src/research/candidate-draft.js';
import type {DeploymentStore} from '../src/deployments/store.js';
import type {PostgresResearchCandidateStore,VerifiedResearchProfile} from '../src/research/postgres-candidate-store.js';
import type {RobinhoodClient} from '../src/client.js';

const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
 pool:'0x8000000000000000000000000000000000000001',token0:USDG,
 token1:'0x7000000000000000000000000000000000000001',quoteToken:0,decimals0:6,decimals1:6,
 fee:3000,tickSpacing:60,positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
 poolCodeHash:`0x${'a'.repeat(64)}`,token0CodeHash:`0x${'b'.repeat(64)}`,
 token1CodeHash:`0x${'c'.repeat(64)}`,managerCodeHash:`0x${'d'.repeat(64)}`,
 quoterCodeHash:`0x${'e'.repeat(64)}`,reference0:'USDG/USD',reference1:'TOKEN/USD',
 nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
const id='00000000-0000-4000-8000-000000000001',campaignId='00000000-0000-4000-8000-000000000002';
const source={block:'100',hash:`0x${'f'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)};
const referenceProof={fixture:'registered_profile_source'};
const refs={price0:'1000000000000000000',price1:'1000000000000000000',
 nativePrice:'2000000000000000000000',proofHash:referenceProofHash(referenceProof)};
const evidence={verificationClass:'canonical_chain_and_independent_reference_v1' as const,source,
 streamKey:'test-stream',indexerTargetSetHash:`0x${'9'.repeat(64)}`,
 contractHashes:{poolCodeHash:profile.pool.poolCodeHash,token0CodeHash:profile.pool.token0CodeHash,
  token1CodeHash:profile.pool.token1CodeHash,managerCodeHash:profile.pool.managerCodeHash,
  quoterCodeHash:profile.pool.quoterCodeHash},references:refs,referenceProof};
const verified={id,profileHash:contentHash(profile),profile,evidence,registryEnabled:true} as VerifiedResearchProfile;
const request={schemaVersion:1 as const,strategyId:'static_manual_v1' as const,windowSeconds:900,
 capitalQuoteRaw:'100000000',range:{tickLower:-60,tickUpper:60}};
const allocation={token0Raw:'100000000',token1Raw:'0',nativeWei:'1000000000000000000'};
const limits={maxDeploymentValue:'1000000000',minDeploymentValue:'1',maxExposurePpm:1_000_000,
 maxLossValue:'1000000000',maxDrawdownPpm:1_000_000,maxActionCost:'1000000000',
 maxRollingCost:'1000000000',maxCampaignCost:'1000000000',exitReserveWei:'1',maxSlippageBps:500};
function fixture(options:{canonical?:boolean}={}){
 const calls:{input?:unknown}={};
 const researchStore={loadCurrentProfile:async()=>verified} as unknown as PostgresResearchCandidateStore;
 const deploymentStore={createDraft:async(input:unknown)=>{calls.input=input;
   return {id:campaignId,revision:1,configHash:'a'.repeat(64)};},
  paperDraft:async()=>({id:campaignId,revision:1,profileHash:verified.profileHash,
   configHash:'a'.repeat(64),allocation,parameters:{tickLower:-60,tickUpper:60,limits},
   strategyId:'static_manual_v1'})} as unknown as DeploymentStore;
 const client={getChainId:async()=>options.canonical===false?1:4663,
  getBlock:async()=>({hash:source.hash,timestamp:BigInt(source.timestamp)})} as unknown as RobinhoodClient;
 return {deps:{researchStore,deploymentStore,client},calls};
}
const draftInput={profileId:id,request,wallet:'0x1111111111111111111111111111111111111111',allocation,limits};

test('static Research setup binds current profile source, exact range, allocation and stored revision',async()=>{
 const {deps,calls}=fixture(),result=await createStaticResearchDraft(draftInput,deps);
 assert.equal(result.status,'draft_created');assert.equal(result.draftId,campaignId);
 assert.equal(result.profileHash,verified.profileHash);assert.equal(result.source?.block,'100');
 assert.equal(result.candidateSource,'caller_supplied_static_request');
 assert(result.limitations.includes('range_and_capital_come_from_caller_request_not_historical_candidate_output'));
 assert(result.bindingHash);
 assert.equal(result.actionAvailable,false);assert.equal(result.economics.status,'unavailable');
 assert(result.missing.includes('historical_window_replay_unavailable'));
 const saved=calls.input as {marketProfileId:string;config:{tickLower:number;tickUpper:number};allocation:typeof allocation};
 assert.equal(saved.marketProfileId,id);assert.deepEqual(saved.config,{tickLower:-60,tickUpper:60,limits});
 assert.deepEqual(saved.allocation,allocation);
});

test('malformed saved draft readback returns unavailable without throwing',async()=>{
 const {deps,calls}=fixture();
 (deps.deploymentStore as unknown as {paperDraft:(id:string)=>Promise<unknown>}).paperDraft=async()=>({
  id:campaignId,revision:1,profileHash:verified.profileHash,configHash:'a'.repeat(64),
  allocation,parameters:null,strategyId:'static_manual_v1'});
 const result=await createStaticResearchDraft(draftInput,deps);
 assert.equal(result.status,'unavailable');
 assert.equal(result.draftId,campaignId);
 assert.equal(result.missing[0],'created_draft_binding_readback_mismatch');
 assert(calls.input);
});

test('mismatched capital, off-grid range, or noncanonical profile source cannot create a draft',async()=>{
 const mismatched=fixture();
 const capital=await createStaticResearchDraft({...draftInput,request:{...request,capitalQuoteRaw:'1'}},mismatched.deps);
 assert.equal(capital.missing[0],'allocation_does_not_match_profile_source_capital');
 assert.equal(mismatched.calls.input,undefined);
 const offGrid=fixture();
 const range=await createStaticResearchDraft({...draftInput,request:{...request,range:{tickLower:-61,tickUpper:60}}},offGrid.deps);
 assert.equal(range.missing[0],'candidate_range_not_tick_aligned');
 assert.equal(offGrid.calls.input,undefined);
 const reorg=fixture({canonical:false});
 const sourceResult=await createStaticResearchDraft(draftInput,reorg.deps);
 assert.equal(sourceResult.missing[0],'registered_profile_source_not_canonical');
 assert.equal(reorg.calls.input,undefined);
 const stale=fixture();
 const staleResult=await createStaticResearchDraft(draftInput,stale.deps,source.timestamp*1000+181_000);
 assert.equal(staleResult.missing[0],'registered_profile_reference_source_stale');
 assert.equal(stale.calls.input,undefined);
});
