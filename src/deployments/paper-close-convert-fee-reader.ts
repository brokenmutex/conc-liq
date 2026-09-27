import assert from 'node:assert/strict';
import {contentHash} from './contracts.js';
import type {PaperCloseConvertFeeEvidenceBinding,PaperCloseConvertPreflightState} from './paper-close-convert-preflight.js';
import type {PaperFeeCarry} from './paper-fee-replay.js';
import type {PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import type {DeploymentStore} from './store.js';
import {persistTrustedStaticPaperCloseConvertPreview,type PaperCloseConvertPreflight}
 from './paper-close-convert-preflight.js';
import {replayEphemeralStaticPaperCloseConvertFees} from './paper-close-convert-ephemeral-fees.js';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import type {PaperOpenFrame} from './paper-preview.js';

export interface StaticPaperCloseConvertFeeContext {
 state:PaperCloseConvertPreflightState;feeCarry:PaperFeeCarry;
 feeEvidence:PaperCloseConvertFeeEvidenceBinding;
 stream:string;targetSetHash:string;
 verifyPersistedContext:(input:{state:PaperCloseConvertPreflightState;feeCarry:PaperFeeCarry;
  feeEvidence:PaperCloseConvertFeeEvidenceBinding;source:PaperCloseConvertPreflightState['previous']['source']})=>Promise<void>;
}

/** Reads the append-only fee carry through the exact latest static/manual paper
 * mark, replays its adjacent intervals, then rechecks every saved anchor. The
 * returned callback repeats the database replay before a preview is saved. */
export async function readStaticPaperCloseConvertFeeContext(input:{store:Pick<DeploymentStore,
 'readStaticPaperCloseConvertFeeCarry'>;campaignId:string;revision:number;
 operation?:{id:string;workerId:string;modelHash:string};
 verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}):
 Promise<StaticPaperCloseConvertFeeContext>{
 const read=()=>input.store.readStaticPaperCloseConvertFeeCarry({campaignId:input.campaignId,
  revision:input.revision,operation:input.operation});
 const saved=await read(),state:PaperCloseConvertPreflightState={openModel:saved.openModel,
  openMarkId:saved.openMarkId,previous:saved.previous,profile:saved.profile,
  profileHash:saved.profileHash,configHash:saved.configHash,parameters:saved.parameters},
  feeCarry=saved.feeCarry,feeEvidence=saved.feeEvidence,
  {stream,targetSetHash}=saved;
 const digest=contentHash(saved);
 await input.verifyAnchors(state.profile.pool.chainId,saved.sources);
 return {state,feeCarry,feeEvidence,stream,targetSetHash,verifyPersistedContext:async current=>{
  assert.equal(contentHash(current.state),contentHash(state),
   'paper_close_convert_persisted_state_changed');
  assert.equal(contentHash(current.feeCarry),contentHash(feeCarry),
   'paper_close_convert_persisted_fee_carry_changed');
  assert.equal(contentHash(current.feeEvidence),contentHash(feeEvidence),
   'paper_close_convert_persisted_fee_evidence_changed');
  assert(BigInt(current.source.block)>BigInt(state.previous.source.block),
   'paper_close_convert_frame_source_not_later_than_fee_anchor');
  const replayed=await read();
  assert.equal(contentHash(replayed),digest,
   'paper_close_convert_persisted_context_digest_changed');
  await input.verifyAnchors(state.profile.pool.chainId,replayed.sources);
 }};
}

/** Preflight entrypoint bound to the persisted replay reader. Callers provide
 * the frame and sampler/quote verifiers, but cannot inject a fee carry or mark
 * context that was not read and replayed from DeploymentStore. */
type PersistInput=Parameters<typeof persistTrustedStaticPaperCloseConvertPreview>[0];
export async function persistStaticPaperCloseConvertPreviewFromPersistedFees(input:
 Omit<PersistInput,'state'|'previousFeeCarry'|'feeReplay'|'feeEvidence'|'verifyPersistedContext'> &
 {store:PersistInput['store']&Pick<DeploymentStore,'readStaticPaperCloseConvertFeeCarry'>;
  campaignId:string;expectedRevision:number;client:RobinhoodClient;indexer:Pool;
  frame:PaperOpenFrame}):Promise<PaperCloseConvertPreflight>{
 const context=await readStaticPaperCloseConvertFeeContext({store:input.store,
  campaignId:input.campaignId,revision:input.expectedRevision,verifyAnchors:input.verifyAnchors});
 const replay=()=>replayEphemeralStaticPaperCloseConvertFees({context,client:input.client,
  indexer:input.indexer,frame:input.frame}),feeReplay=await replay();
 return persistTrustedStaticPaperCloseConvertPreview({...input,state:context.state,
  previousFeeCarry:context.feeCarry,feeReplay,feeEvidence:context.feeEvidence,
  verifyPersistedContext:async current=>{
   await context.verifyPersistedContext({state:current.state,feeCarry:context.feeCarry,
    feeEvidence:current.feeEvidence,source:current.source});
   const replayed=await replay();
   assert.equal(contentHash(replayed),contentHash(current.feeReplay),
    'Canonical close-convert ephemeral fee interval changed before preview persistence');
  }});
}
