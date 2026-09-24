import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import {advancePaperFeeCarry,readAnchoredPaperFeeFrame,readCanonicalPaperFeeInterval,
 type PaperFeeFrame,type PaperFeeCarry} from './paper-fee-replay.js';
import type {StaticPaperCloseConvertFeeContext} from './paper-close-convert-fee-reader.js';
import {contentHash} from './contracts.js';
import type {PaperOpenFrame} from './paper-preview.js';

type CanonicalFeeInterval=Awaited<ReturnType<typeof readCanonicalPaperFeeInterval>>;
export interface EphemeralStaticPaperCloseConvertFeeReplay {
 kind:'paper_close_convert_ephemeral_fee_replay_v1';classification:'fork_estimated';
 previousFeeEvidenceId:string;from:PaperFeeFrame['source'];to:PaperFeeFrame['source'];
 stream:string;targetSetHash:string;interval:CanonicalFeeInterval;intervalHash:string;
 previousFeeCarryHash:string;feeCarry:PaperFeeCarry;feeCarryHash:string;replayHash:string;
}

/** Binds an in-memory interval to the persisted predecessor and exact sample. */
export function advanceEphemeralStaticPaperFeeCarry(input:{previous:PaperFeeCarry;
 interval:CanonicalFeeInterval;sampleSource:PaperFeeFrame['source'];stream:string;targetSetHash:string;
 opening:{block:string;hash:string}}){
 const {previous,interval,sampleSource,stream,targetSetHash}=input;
 assert.equal(interval.from.block,previous.through.block,
  'paper_close_convert_ephemeral_fee_interval_not_adjacent');
 assert.equal(interval.from.hash.toLowerCase(),previous.through.hash.toLowerCase(),
  'paper_close_convert_ephemeral_fee_interval_anchor_mismatch');
 assert.equal(interval.to.block,sampleSource.block,
  'paper_close_convert_ephemeral_fee_interval_source_mismatch');
 assert.equal(interval.to.hash.toLowerCase(),sampleSource.hash.toLowerCase(),
  'paper_close_convert_ephemeral_fee_interval_source_hash_mismatch');
 assert.equal(interval.coverage.stream,stream,'paper_close_convert_ephemeral_fee_stream_changed');
 assert.equal(interval.coverage.targetSetHash,targetSetHash,
  'paper_close_convert_ephemeral_fee_target_set_changed');
 assert.equal(interval.coverage.chainAnchorRecheckRequired,false,
  'paper_close_convert_ephemeral_fee_anchors_unverified');
 assert(BigInt(interval.coverage.completeThroughBlock)>=BigInt(sampleSource.block),
  'paper_close_convert_ephemeral_fee_coverage_incomplete');
 if(interval.coverage.completeThroughBlock===sampleSource.block)
  assert.equal(interval.coverage.completeThroughHash?.toLowerCase(),sampleSource.hash.toLowerCase(),
   'paper_close_convert_ephemeral_fee_coverage_hash_mismatch');
 const feeCarry=advancePaperFeeCarry(previous,interval,input.opening);
 assert.equal(feeCarry.through.block,sampleSource.block,
  'paper_close_convert_ephemeral_fee_carry_block_mismatch');
 assert.equal(feeCarry.through.hash.toLowerCase(),sampleSource.hash.toLowerCase(),
  'paper_close_convert_ephemeral_fee_carry_hash_mismatch');
 return {feeCarry,feeCarryHash:contentHash(feeCarry),intervalHash:contentHash(interval)};
}

/**
 * Replays one adjacent fee interval from the exact latest persisted mark to a
 * candidate sample frame. The interval and advanced carry exist only in
 * memory; this helper never writes a deployment mark or fee evidence row.
 */
export async function replayEphemeralStaticPaperCloseConvertFees(input:{
 context:StaticPaperCloseConvertFeeContext;client:RobinhoodClient;indexer:Pool;
 frame:PaperOpenFrame;
}):Promise<EphemeralStaticPaperCloseConvertFeeReplay>{
 const {context,frame}=input,{state,feeCarry,feeEvidence,stream,targetSetHash}=context,
  source=frame.source,previous=state.previous.source;
 assert(BigInt(source.block)>BigInt(previous.block),
  'paper_close_convert_ephemeral_fee_source_not_later');
 await context.verifyPersistedContext({state,feeCarry,feeEvidence,source});
 const anchoredBefore=await readAnchoredPaperFeeFrame(input.client,state.profile,previous),
  before={source:previous,tick:anchoredBefore.poolState.tick,
   sqrtPriceX96:BigInt(anchoredBefore.poolState.sqrtPriceX96),
   poolLiquidity:BigInt(anchoredBefore.poolState.poolLiquidity)},
  after={source,tick:frame.tick,sqrtPriceX96:frame.sqrtPriceX96,poolLiquidity:frame.poolLiquidity};
 const interval=await readCanonicalPaperFeeInterval(input.client,input.indexer,stream,targetSetHash,
  state.profile,before,after,{tickLower:state.openModel.candidate.range.tickLower,
   tickUpper:state.openModel.candidate.range.tickUpper},BigInt(state.openModel.candidate.liquidity));
 const advanced=advanceEphemeralStaticPaperFeeCarry({previous:feeCarry,interval,sampleSource:source,
  stream,targetSetHash,opening:state.openModel.source});
 const replay={kind:'paper_close_convert_ephemeral_fee_replay_v1' as const,classification:'fork_estimated' as const,
  previousFeeEvidenceId:feeEvidence.id,from:interval.from,to:interval.to,stream,targetSetHash,
  interval,intervalHash:advanced.intervalHash,previousFeeCarryHash:contentHash(feeCarry),
  feeCarry:advanced.feeCarry,feeCarryHash:advanced.feeCarryHash};
 return {...replay,replayHash:contentHash(replay)};
}
