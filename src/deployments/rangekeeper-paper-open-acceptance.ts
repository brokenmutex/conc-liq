import {AssertionError} from 'node:assert';
import type {AcceptInput} from './contracts.js';
import type {PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import {validateRangeKeeperPaperConfirmationEnvelope} from './rangekeeper-paper-persistence.js';
import {DeploymentConflict,type DeploymentStore} from './store.js';

/** The parallel acceptance for a RangeKeeper paper `open` operation.
 *
 * `DeploymentStore.acceptOperation` (store.ts:~2908) is strategy-agnostic on
 * its own: called with no admission argument it validates the preview
 * generically, refuses a pending operation, checks the campaign lifecycle,
 * inserts the row and notifies the worker -- without ever looking at
 * `strategy_id`. Every existing wrapper instead passes an admission
 * discriminator whose branches hardcode `strategy_id==='static_manual_v1'`
 * (see docs/plans/rangekeeper-paper-operation-path-2026-10-01.md section 0).
 *
 * Rather than growing that already-long `if` chain with a RangeKeeper branch,
 * this module does its own pre-validation -- that the preview being accepted
 * is the exact one the published two-observation confirmation is bound to,
 * that the confirmation envelope is intact and confirmed, and that both of
 * its canonical anchors still hold -- then calls the bare `acceptOperation`.
 * This mirrors the shape `createStaticPaperCloseConvertAcceptance`
 * (paper-close-convert-runtime.ts) uses for the close-convert path: a
 * strategy-specific module in front of the strategy-agnostic acceptance,
 * never a branch inside it.
 *
 * This only admits the operation. It leaves the database in exactly the
 * state `rangeKeeperPaperConfirmationOperationSnapshot` (store.ts:~1269)
 * expects to find when the worker later claims it: an `open` operation whose
 * `preview_id` is the confirmation's `open_preview_id`, at the campaign's
 * current revision. */
export function createRangeKeeperPaperOpenAcceptance(input:{store:DeploymentStore;
 verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}){
 const {store,verifyAnchors}=input;
 return async(campaignId:string,request:AcceptInput,actor:string)=>{
  const context=await store.rangeKeeperPaperOpenAcceptanceContext(
   {campaignId,previewId:request.previewId});
  if(!context)
   throw new DeploymentConflict('rangekeeper_paper_open_acceptance_campaign_not_found');
  if(context.mode!=='paper'||context.strategyId!=='rangekeeper_v1'||
   context.lifecycle!=='draft'||context.chainId!==4663)
   throw new DeploymentConflict('rangekeeper_paper_open_acceptance_campaign_unavailable');
  if(!context.preview)
   throw new DeploymentConflict('rangekeeper_paper_open_acceptance_preview_not_found');
  if(context.preview.kind!=='open')
   throw new DeploymentConflict('rangekeeper_paper_open_acceptance_preview_wrong_kind');
  if(!context.confirmation)
   throw new DeploymentConflict('rangekeeper_paper_open_acceptance_confirmation_unavailable');
  // The confirmation is read at the campaign's current revision (the store
  // query joins on it), but the preview being accepted must be the *exact*
  // preview that confirmation was built against -- not merely some live
  // open preview at the same revision.
  if(context.confirmation.openPreviewId!==request.previewId)
   throw new DeploymentConflict('rangekeeper_paper_open_acceptance_preview_not_bound');
  if(context.preview.expectedRevision!==request.expectedRevision)
   throw new DeploymentConflict('rangekeeper_paper_open_acceptance_expected_revision_mismatch');
  if(context.preview.contentDigest!==request.contentDigest)
   throw new DeploymentConflict('rangekeeper_paper_open_acceptance_content_digest_mismatch');
  let envelope;
  // validateRangeKeeperPaperConfirmationEnvelope's schema requires
  // status:'confirmed' as a literal and checks campaignId/revision against
  // the `expected` passed here, so a successful parse already proves both
  // "confirmed" and "for this campaign's current revision" -- there is no
  // other status this validator will ever return.
  try{envelope=validateRangeKeeperPaperConfirmationEnvelope(context.confirmation.envelope,
   {campaignId,revision:context.currentRevision});}
  catch{throw new DeploymentConflict('rangekeeper_paper_open_acceptance_envelope_invalid');}
  if(envelope.envelopeHash!==context.confirmation.envelopeHash)
   throw new DeploymentConflict('rangekeeper_paper_open_acceptance_envelope_integrity');
  try{await verifyAnchors(context.chainId,
   [envelope.firstObservation.source,envelope.confirmationObservation.source]);}
  catch(error){if(error instanceof AssertionError)
    throw new DeploymentConflict('rangekeeper_paper_open_acceptance_source_not_canonical');
   throw error;}
  // No admission discriminator: the preceding checks are this module's
  // admission. acceptOperation still re-validates the preview's own
  // integrity (stale_preview, preview_expired, idempotency, pending
  // operation, lifecycle) generically.
  return store.acceptOperation(campaignId,request,actor);
 };
}
