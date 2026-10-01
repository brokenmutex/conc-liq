import assert from 'node:assert/strict';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {createRangeKeeperPaperExitAcceptance}
 from '../src/deployments/rangekeeper-paper-exit-acceptance.js';

const campaignId='00000000-0000-4000-8000-00000000abcd';
const previewId='22222222-2222-4222-8222-222222222222';
const source={block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)-10};
const exitModel={schemaVersion:1,kind:'rangekeeper_paper_exit_model',status:'indicative',
 exitKind:'retain',source};
const {source:_omitted,...sourcelessModel}=exitModel;
const proposal=(model:unknown=exitModel)=>({rangekeeperPaperExitModel:model,
 rangekeeperPaperExitModelHash:contentHash(model)});

const accepted={id:'33333333-3333-4333-8333-333333333333',status:'queued',replayed:false};
const request={previewId,contentDigest:'a'.repeat(64),expectedRevision:3,
 idempotencyKey:'44444444-4444-4444-8444-444444444444'} as never;

const context=(overrides:Record<string,unknown>={})=>({mode:'paper',lifecycle:'active',
 chainId:4663,strategyId:'rangekeeper_v1',currentRevision:3,profileHash:'b'.repeat(64),
 configHash:'c'.repeat(64),
 preview:{kind:'close_retain',contentDigest:'a'.repeat(64),expectedRevision:3,
  expiresAt:new Date(Date.now()+60_000),proposal:proposal()},...overrides});

const stub=(ctx:unknown)=>{
 const calls:unknown[][]=[];
 return {calls,store:{rangeKeeperPaperExitAcceptanceContext:async()=>ctx,
  acceptOperation:async(...args:unknown[])=>{calls.push(args);return accepted;}} as never};
};
const ok=async()=>{};

test('admits a RangeKeeper retain exit through the bare acceptOperation',async()=>{
 const {calls,store}=stub(context());
 const accept=createRangeKeeperPaperExitAcceptance({store,verifyAnchors:ok});
 assert.deepEqual(await accept(campaignId,request,'operator'),accepted);
 assert.equal(calls.length,1);
 // Exactly three arguments: a fourth would be an admission discriminator, whose
 // branches hardcode static_manual_v1 and would reject this campaign.
 assert.equal(calls[0]!.length,3);
 assert.deepEqual(calls[0],[campaignId,request,'operator']);
});

test('refuses a convert exit, because the worker has no completion for it',async()=>{
 const {calls,store}=stub(context({preview:{...context().preview,kind:'close_convert'}}));
 const accept=createRangeKeeperPaperExitAcceptance({store,verifyAnchors:ok});
 await assert.rejects(()=>accept(campaignId,request,'operator'),(error:{code?:string})=>{
  assert.equal(error.code,'rangekeeper_paper_exit_acceptance_convert_unavailable');return true;});
 // Admitting it would strand the campaign in `closing` behind a blocked operation.
 assert.equal(calls.length,0);
});

test('refuses every state an exit operation could not complete from',async()=>{
 const base=context();
 const cases:[string,unknown][]=[
  ['rangekeeper_paper_exit_acceptance_campaign_not_found',null],
  ['rangekeeper_paper_exit_acceptance_campaign_unavailable',context({mode:'live'})],
  ['rangekeeper_paper_exit_acceptance_campaign_unavailable',
   context({strategyId:'static_manual_v1'})],
  ['rangekeeper_paper_exit_acceptance_campaign_unavailable',context({chainId:1})],
  // A draft has nothing to exit; a closed campaign has already exited.
  ['rangekeeper_paper_exit_acceptance_campaign_unavailable',context({lifecycle:'draft'})],
  ['rangekeeper_paper_exit_acceptance_campaign_unavailable',context({lifecycle:'closed'})],
  ['rangekeeper_paper_exit_acceptance_preview_not_found',context({preview:null})],
  ['rangekeeper_paper_exit_acceptance_preview_wrong_kind',
   context({preview:{...base.preview,kind:'open'}})],
  ['rangekeeper_paper_exit_acceptance_expected_revision_mismatch',
   context({currentRevision:4})],
  ['rangekeeper_paper_exit_acceptance_expected_revision_mismatch',
   context({preview:{...base.preview,expectedRevision:2}})],
  ['rangekeeper_paper_exit_acceptance_content_digest_mismatch',
   context({preview:{...base.preview,contentDigest:'d'.repeat(64)}})],
  ['rangekeeper_paper_exit_acceptance_preview_expired',
   context({preview:{...base.preview,expiresAt:new Date(Date.now()-1)}})],
  // The saved model must hash to the proposal's own recorded hash before any
  // field inside it is trusted.
  ['rangekeeper_paper_exit_acceptance_model_integrity',
   context({preview:{...base.preview,proposal:{...proposal(),
    rangekeeperPaperExitModelHash:'e'.repeat(64)}}})],
  ['rangekeeper_paper_exit_acceptance_model_integrity',
   context({preview:{...base.preview,proposal:{}}})],
  // A model that hashes correctly but has no recoverable source.
  ['rangekeeper_paper_exit_acceptance_model_integrity',
   context({preview:{...base.preview,proposal:proposal(sourcelessModel)}})],
 ];
 for(const [reason,ctx] of cases){
  const {calls,store}=stub(ctx);
  const accept=createRangeKeeperPaperExitAcceptance({store,verifyAnchors:ok});
  await assert.rejects(()=>accept(campaignId,request,'operator'),(error:{code?:string})=>{
   assert.equal(error.code,reason,`expected ${reason}, got ${error.code}`);return true;});
  assert.equal(calls.length,0,`${reason} must not admit an operation`);
 }
});

test('refuses a source that is no longer canonical',async()=>{
 const {calls,store}=stub(context());
 const accept=createRangeKeeperPaperExitAcceptance({store,
  verifyAnchors:async()=>{throw new Error('reorg');}});
 await assert.rejects(()=>accept(campaignId,request,'operator'),(error:{code?:string})=>{
  assert.equal(error.code,'rangekeeper_paper_exit_acceptance_source_not_canonical');return true;});
 assert.equal(calls.length,0);
});
