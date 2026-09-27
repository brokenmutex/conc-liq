import assert from 'node:assert/strict';
import test from 'node:test';
import type {PaperDraft,PaperOpenFrame} from '../src/deployments/paper-preview.js';
import {contentHash} from '../src/deployments/contracts.js';
import {prepareStaticPaperGasForCandidate} from '../src/deployments/static-paper-gas-preparation.js';

const profile={pool:{pool:'0x0000000000000000000000000000000000000001'}};
const draft={id:'00000000-0000-4000-8000-000000000001',revision:1,
 profile,profileHash:contentHash(profile),configHash:'a'.repeat(64),
 strategyId:'static_manual_v1',parameters:{},allocation:{token0Raw:'1',token1Raw:'1',nativeWei:'1'}} as unknown as PaperDraft;
const frame={source:{block:'100',hash:`0x${'b'.repeat(64)}`,timestamp:1_000},
 tick:0,sqrtPriceX96:1n,poolLiquidity:1n,price0:1n,price1:1n,nativePrice:1n,
 referenceEligible:true,referenceReasons:[],referenceProofHash:'c'.repeat(64),referenceProof:{}} as PaperOpenFrame;
const now=1_000_000;
const report={reportHash:'d'.repeat(64),campaignId:draft.id,revision:draft.revision,
 configHash:draft.configHash,profileHash:draft.profileHash,source:frame.source,
 sampledAt:new Date(now).toISOString()};
const attestation={reportHash:report.reportHash,sourceHash:frame.source.hash,
 profileHash:draft.profileHash,verifiedAt:new Date(now+1).toISOString()};

test('exact-source gas preparation imports replay evidence then rebuilds on the pinned candidate',async()=>{
 let imports=0,rebuilds=0;
 const prepared=await prepareStaticPaperGasForCandidate(draft,frame,{
  now:()=>now,
  sample:async(sampleDraft,sampleFrame)=>{assert.equal(sampleDraft.id,draft.id);assert.deepEqual(sampleFrame.source,frame.source);return report;},
  verify:async(raw)=>{assert.equal(raw,report);return attestation;},
  importEvidence:async(raw,proof)=>{assert.equal(raw,report);assert.equal(proof,attestation);imports++;
   return {created:true,reportHash:report.reportHash};},
  rebuild:async()=>++rebuilds===1?{status:'unavailable',source:frame.source}:
   {status:'available',costs:{status:'provisional'},source:frame.source},
  isPrepared:value=>value.status==='available'&&value.costs?.status==='provisional',
  sourceOf:value=>value.source,
 });
 assert.equal(prepared.status,'available');
 if(prepared.status==='available'){
  assert.equal(prepared.reportHash,report.reportHash);assert.equal(prepared.imported,true);
  assert.equal(prepared.value.status,'available');
 }
 assert.equal(imports,1);assert.equal(rebuilds,2);
});

test('exact-source gas preparation refuses stale source before invoking sampler',async()=>{
 let sampled=false;
 const result=await prepareStaticPaperGasForCandidate(draft,frame,{
  now:()=>1_181_000,
  sample:async()=>{sampled=true;return report;},verify:async()=>attestation,
  importEvidence:async()=>({created:true,reportHash:report.reportHash}),
  rebuild:async()=>({status:'unavailable',source:frame.source}),
  isPrepared:()=>false,sourceOf:value=>value.source,
 });
 assert.deepEqual(result,{status:'unavailable',reason:'paper_cost_preparation_source_expired'});
 assert.equal(sampled,false);
});

test('exact-source gas preparation still rejects a non-null preview from a different anchor',async()=>{
 let sampled=false;
 const mismatched={status:'unavailable',source:{...frame.source,block:'101'}};
 const result=await prepareStaticPaperGasForCandidate(draft,frame,{
  now:()=>now,sample:async()=>{sampled=true;return report;},verify:async()=>attestation,
  importEvidence:async()=>({created:true,reportHash:report.reportHash}),
  rebuild:async()=>mismatched,isPrepared:()=>false,sourceOf:value=>value.source,
 });
 assert.deepEqual(result,{status:'unavailable',reason:'paper_cost_initial_preview_source_mismatch',value:mismatched});
 assert.equal(sampled,false);
});

test('exact-source gas preparation preserves an allowlisted source-less failure after evidence import',async()=>{
 let rebuilds=0,samples=0,imports=0;
 type SetupPreview={status:string;source?:PaperOpenFrame['source']|null;costs?:{status?:string};missing?:string[]};
 const failure:SetupPreview={status:'unavailable',source:null,missing:['fresh_source_not_canonical']},
  unprepared:SetupPreview={status:'unavailable',source:frame.source};
 const result=await prepareStaticPaperGasForCandidate(draft,frame,{
  now:()=>now,sample:async()=>{samples++;return report;},verify:async()=>attestation,
  importEvidence:async()=>{imports++;return {created:true,reportHash:report.reportHash};},
  rebuild:async()=>++rebuilds===1?unprepared:failure,
  isPrepared:value=>value.status==='available'&&value.costs?.status==='provisional',
  sourceOf:value=>value.source??null,
  unavailableReasonOf:value=>value.status==='unavailable'&&value.source===null&&
   value.missing?.[0]==='fresh_source_not_canonical'?'fresh_source_not_canonical':null,
 });
 assert.deepEqual(result,{status:'unavailable',reason:'fresh_source_not_canonical',value:failure});
 assert.equal(samples,1);assert.equal(imports,1);assert.equal(rebuilds,2);
});

test('exact-source gas preparation does not return a ready result if freshness expires during rebuild',async()=>{
 let clockReads=0,sampled=false,imports=0;
 const result=await prepareStaticPaperGasForCandidate(draft,frame,{
  now:()=>clockReads++<2?1_000_000:1_181_000,
  sample:async()=>{sampled=true;return report;},verify:async()=>attestation,
  importEvidence:async()=>{imports++;return {created:true,reportHash:report.reportHash};},
  rebuild:async()=>({status:'available',costs:{status:'provisional'},source:frame.source}),
  isPrepared:value=>value.status==='available',sourceOf:value=>value.source,
 });
 assert.equal(result.status,'unavailable');
 if(result.status==='unavailable')assert.equal(result.reason,'paper_cost_preparation_source_expired');
 assert.equal(sampled,false);assert.equal(imports,0);
});

test('exact-source gas preparation does not import another candidate report',async()=>{
 let imports=0;
 const result=await prepareStaticPaperGasForCandidate(draft,frame,{
  now:()=>now,
  sample:async()=>({...report,configHash:'e'.repeat(64)}),verify:async()=>attestation,
  importEvidence:async()=>{imports++;return {created:true,reportHash:report.reportHash};},
  rebuild:async()=>({status:'unavailable',source:frame.source}),isPrepared:()=>false,
  sourceOf:value=>value.source,
 });
 assert.deepEqual(result,{status:'unavailable',reason:'paper_cost_sample_identity_mismatch',
  value:{status:'unavailable',source:frame.source}});
 assert.equal(imports,0);
});
