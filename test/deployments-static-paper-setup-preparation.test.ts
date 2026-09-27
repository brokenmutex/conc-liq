import assert from 'node:assert/strict';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {prepareStaticPaperSetup} from '../src/deployments/static-paper-setup-preparation.js';

const now=Date.now(),source={block:'100',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor(now/1000)-10},
 profile={pool:{pool:'0x0000000000000000000000000000000000000001'}},profileHash=contentHash(profile),
 limits={maxDeploymentValue:'1000000000000000000000',minDeploymentValue:'1',maxExposurePpm:950_000,
  maxLossValue:'1000000000000000000',maxDrawdownPpm:100_000,maxActionCost:'1000000000000000000',
  maxRollingCost:'2000000000000000000',maxCampaignCost:'3000000000000000000',exitReserveWei:'1000000000000000',
  maxSlippageBps:50},input={profileId:'00000000-0000-4000-8000-000000000001',
  capitalQuoteRaw:'2000000000',halfWidthTicks:20,limits},frame={source,tick:0,sqrtPriceX96:1n,
  poolLiquidity:1n,price0:1n,price1:1n,nativePrice:1n,referenceEligible:true,referenceReasons:[],
  referenceProofHash:'b'.repeat(64),referenceProof:{}};

test('setup preparation samples exact reviewed candidate then returns rebuilt same-source costs',async()=>{
 let calls=0,samples=0,imports=0;
 const available={status:'available',kind:'paper_setup_preflight',profileHash,source,
  costs:{status:'provisional'},actionAvailable:false,draftCreated:false,operationCreated:false};
 const initial={...available,status:'unavailable',costs:{status:'unavailable',reason:'complete_fresh_stage_costs_unavailable'},
  requirements:{token0Raw:'123',token1Raw:'456'},profile:{pool:profile.pool.pool}};
 const result=await prepareStaticPaperSetup(input,{
  runPreflight:async(_input,pinned)=>{calls++;if(calls===1){assert.equal(pinned,undefined);return initial;}
   assert.deepEqual(pinned,source);return calls===2?initial:available;},
  loadProfile:async id=>({id,profile,profileHash}) as never,readFrame:async(_profile,pinned)=>{
   assert.deepEqual(pinned,source);return frame;},forkRpcUrl:'http://127.0.0.1:8545',
  sample:async(draft,sampledFrame)=>{samples++;assert.deepEqual(sampledFrame.source,source);
   assert.deepEqual(draft.parameters,{halfWidthTicks:20,limits});
   return {reportHash:'c'.repeat(64),campaignId:draft.id,revision:draft.revision,configHash:draft.configHash,
    profileHash:draft.profileHash,source,sampledAt:new Date(now).toISOString()};},
  verify:async()=>({reportHash:'c'.repeat(64),sourceHash:source.hash,profileHash,verifiedAt:new Date(now).toISOString()}),
  importEvidence:async()=>{imports++;return {created:true,reportHash:'c'.repeat(64)};},
 });
 assert.equal((result as typeof available).status,'available');
 assert.equal(calls,3);assert.equal(samples,1);assert.equal(imports,1);
});

test('setup preparation does not sample without explicit limits or fork RPC',async()=>{
 let samples=0;
 const base={status:'unavailable',source,costs:{status:'unavailable',reason:'complete_fresh_stage_costs_unavailable'},
  missing:['complete_fresh_stage_costs_unavailable']};
 const deps={runPreflight:async()=>base,loadProfile:async()=>null,readFrame:async()=>frame,
  forkRpcUrl:null,sample:async()=>{samples++;return {};},verify:async()=>({}),
  importEvidence:async()=>({created:true,reportHash:'c'.repeat(64)})};
 const missingLimits=await prepareStaticPaperSetup({...input,limits:undefined},deps);
 const missingFork=await prepareStaticPaperSetup(input,{...deps,forkRpcUrl:null});
 assert.equal((missingLimits as {costs:{reason:string}}).costs.reason,'static_manual_limits_required_for_cost_preparation');
 assert.equal((missingFork as {costs:{reason:string}}).costs.reason,'paper_cost_preparation_fork_rpc_unavailable');
 assert.equal(samples,0);
});

test('setup preparation only preserves an allowlisted explicit-null preflight reason',async()=>{
 const malformed={status:'unavailable',source:null,missing:[{reason:'fresh_source_not_canonical'}]},
  cases=[
   {label:'allowlisted reason',value:{status:'unavailable',source:null,missing:['fresh_source_not_canonical']},
    expected:'fresh_source_not_canonical',expectedSource:null},
   {label:'unlisted reason',value:{status:'unavailable',source:null,missing:['rpc_url_contains_secret']},
    expected:'paper_cost_initial_preview_source_mismatch',expectedSource:null},
   {label:'malformed reason',value:malformed,expected:'paper_cost_initial_preview_source_mismatch',expectedSource:null},
   {label:'missing source property',value:{status:'unavailable',missing:['fresh_source_not_canonical']},
    expected:'paper_cost_initial_preview_source_mismatch',expectedSource:undefined},
   {label:'available result without source',value:{status:'available',source:null,costs:{status:'provisional'}},
    expected:'paper_cost_initial_preview_source_mismatch',expectedSource:null},
  ];
 for(const {label,value,expected,expectedSource} of cases){
  let calls=0,samples=0,imports=0;
  const initial={status:'unavailable',kind:'paper_setup_preflight',profileHash,source,
   costs:{status:'unavailable',reason:'complete_fresh_stage_costs_unavailable'},
   requirements:{token0Raw:'123',token1Raw:'456'},profile:{pool:profile.pool.pool}};
  const result=await prepareStaticPaperSetup(input,{
   runPreflight:async()=>++calls===1?initial:value,
   loadProfile:async id=>({id,profile,profileHash}) as never,
   readFrame:async()=>frame,forkRpcUrl:'http://127.0.0.1:8545',
   sample:async()=>{samples++;throw Error('source-less initial result must not sample');},
   verify:async()=>({}),importEvidence:async()=>{imports++;return {created:true,reportHash:'c'.repeat(64)};},
  });
  const reviewed=result as {status:string;costs:{reason:string};missing:string[];source?:null;
   draftCreated:boolean;operationCreated:boolean};
  assert.equal(reviewed.status,'unavailable',label);
  assert.equal(reviewed.costs.reason,expected,label);
  assert.deepEqual(reviewed.missing,[expected],label);
  assert.equal(reviewed.source,expectedSource,label);
  assert.equal(reviewed.draftCreated,false,label);assert.equal(reviewed.operationCreated,false,label);
  assert.equal(samples,0,label);assert.equal(imports,0,label);
 }
});

test('setup preparation keeps strict post-import mismatch for malformed source-less result',async()=>{
 let calls=0,samples=0,imports=0;
 const initial={status:'unavailable',kind:'paper_setup_preflight',profileHash,source,
  costs:{status:'unavailable',reason:'complete_fresh_stage_costs_unavailable'},
  requirements:{token0Raw:'123',token1Raw:'456'},profile:{pool:profile.pool.pool}};
 const malformed={status:'unavailable',source:null,missing:[{reason:'fresh_source_not_canonical'}]};
 const result=await prepareStaticPaperSetup(input,{
  runPreflight:async()=>++calls===1?initial:calls===2?initial:malformed,
  loadProfile:async id=>({id,profile,profileHash}) as never,
  readFrame:async()=>frame,forkRpcUrl:'http://127.0.0.1:8545',
  sample:async(draft,sampledFrame)=>{samples++;assert.deepEqual(sampledFrame.source,source);
   return {reportHash:'c'.repeat(64),campaignId:draft.id,revision:draft.revision,
    configHash:draft.configHash,profileHash:draft.profileHash,source,sampledAt:new Date(now).toISOString()};},
  verify:async()=>({reportHash:'c'.repeat(64),sourceHash:source.hash,profileHash,
   verifiedAt:new Date(now).toISOString()}),
  importEvidence:async()=>{imports++;return {created:true,reportHash:'c'.repeat(64)};},
 });
 const reviewed=result as {status:string;costs:{reason:string};missing:string[]};
 assert.equal(reviewed.status,'unavailable');
 assert.equal(reviewed.costs.reason,'paper_cost_prepared_preview_source_mismatch');
 assert.deepEqual(reviewed.missing,['paper_cost_prepared_preview_source_mismatch']);
 assert.equal(samples,1);assert.equal(imports,1);assert.equal(calls,3);
});
