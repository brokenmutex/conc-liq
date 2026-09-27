import assert from 'node:assert/strict';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {readStaticPaperCloseConvertFeeContext} from '../src/deployments/paper-close-convert-fee-reader.js';

const saved={campaignId:'00000000-0000-4000-8000-000000000001',revision:1,
 openMarkId:'1',openModel:{candidate:{fixture:true}},openModelHash:'a'.repeat(64),
 profile:{pool:{chainId:4663}},profileHash:'b'.repeat(64),configHash:'c'.repeat(64),
 stream:'paper-fees',targetSetHash:'0x'+'4'.repeat(64),
 parameters:{limits:{maxSlippageBps:50}},
 previous:{markId:'2',sourceBlock:'100',sourceHash:'0x'+'1'.repeat(64),
  source:{block:'100',hash:'0x'+'1'.repeat(64),timestamp:1000}},
 feeCarry:{kind:'paper_fee_carry_v1',intervals:1,token0:{lowerAmountRaw:'7'}},
 feeEvidence:{id:'00000000-0000-4000-8000-000000000002',proofHash:'d'.repeat(64),
  carryHash:'e'.repeat(64)},
 sources:[{block:'90',hash:'0x'+'2'.repeat(64),timestamp:900},
  {block:'100',hash:'0x'+'1'.repeat(64),timestamp:1000}]};

test('persisted close-convert fee context is rebound and source-anchor checked before use',async()=>{
 let reads=0,anchorChecks=0;
 const store={readStaticPaperCloseConvertFeeCarry:async()=>{reads++;return structuredClone(saved);}};
 const context=await readStaticPaperCloseConvertFeeContext({store:store as never,campaignId:saved.campaignId,
  revision:1,verifyAnchors:async(chainId,sources)=>{anchorChecks++;assert.equal(chainId,4663);
   assert.deepEqual(sources,saved.sources);}});
 assert.equal(reads,1);assert.equal(anchorChecks,1);
 assert.equal(context.stream,saved.stream);assert.equal(context.targetSetHash,saved.targetSetHash);
 await context.verifyPersistedContext({state:context.state,feeCarry:context.feeCarry,
  feeEvidence:context.feeEvidence,source:{block:'101',hash:'0x'+'3'.repeat(64),timestamp:1010}});
 assert.equal(reads,2);assert.equal(anchorChecks,2);
 await assert.rejects(context.verifyPersistedContext({state:{...context.state,openMarkId:'3'},
  feeCarry:context.feeCarry,feeEvidence:context.feeEvidence,
  source:{block:'101',hash:'0x'+'3'.repeat(64),timestamp:1010}}),
 /paper_close_convert_persisted_state_changed/);
 await assert.rejects(context.verifyPersistedContext({state:context.state,
  feeCarry:{...context.feeCarry,intervals:2},feeEvidence:context.feeEvidence,
  source:{block:'101',hash:'0x'+'3'.repeat(64),timestamp:1010}}),
 /paper_close_convert_persisted_fee_carry_changed/);
 await assert.rejects(context.verifyPersistedContext({state:context.state,feeCarry:context.feeCarry,
  feeEvidence:{...context.feeEvidence,proofHash:'f'.repeat(64)},
  source:{block:'101',hash:'0x'+'3'.repeat(64),timestamp:1010}}),
 /paper_close_convert_persisted_fee_evidence_changed/);
 await assert.rejects(context.verifyPersistedContext({state:context.state,feeCarry:context.feeCarry,
  feeEvidence:context.feeEvidence,source:context.state.previous.source}),
 /paper_close_convert_frame_source_not_later_than_fee_anchor/);
 const changed={...saved,feeCarry:{...saved.feeCarry,intervals:2}};
 let mutableReads=0;
 const mutableStore={readStaticPaperCloseConvertFeeCarry:async()=>mutableReads++===0?
  structuredClone(saved):changed};
 const stale=await readStaticPaperCloseConvertFeeContext({store:mutableStore as never,
  campaignId:saved.campaignId,revision:1,verifyAnchors:async()=>{}});
 await assert.rejects(stale.verifyPersistedContext({state:stale.state,feeCarry:stale.feeCarry,
  feeEvidence:stale.feeEvidence,source:{block:'101',hash:'0x'+'3'.repeat(64),timestamp:1010}}),
 /paper_close_convert_persisted_context_digest_changed/);
 assert.notEqual(contentHash(saved),contentHash(changed));
});
