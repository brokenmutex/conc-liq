import {DeploymentConflict,type DeploymentStore} from './store.js';
import type {AcceptInput} from './contracts.js';
import type {PaperOpenFrame} from './paper-preview.js';
import {recoverRangeKeeperPaperExitModelSource} from './rangekeeper-paper-exit-completion.js';

type AnchorVerifier=(chainId:number,sources:readonly PaperOpenFrame['source'][])=>Promise<void>;

/** A RangeKeeper exit kind the worker can actually finish. close_convert has a
 * preview, a quote contract and a gas sampler, but no completion: the worker
 * blocks it with `rangekeeper_paper_exit_convert_completion_unavailable` rather
 * than guess at a conversion ledger. Admitting one would create an operation
 * guaranteed to block, leaving the campaign in `closing` with no way forward, so
 * it is refused here instead — at the point the operator can still choose retain. */
const COMPLETABLE_EXIT_KINDS:readonly string[]=['close_retain'];
const EXIT_PREVIEW_KINDS:readonly string[]=['close_retain','close_convert'];

/** Admits a RangeKeeper paper exit operation.
 *
 * A parallel acceptance, like the open one: it pre-validates, then calls the bare
 * `acceptOperation` with no admission discriminator, so the static admission
 * branches that hardcode `strategy_id==='static_manual_v1'` are never reached.
 * `acceptOperation` re-reads the campaign and preview under its own row lock,
 * refuses a pending operation, and moves the campaign to `closing` — the
 * convention `completeRangeKeeperPaperConfirmedExit` assumes. */
export function createRangeKeeperPaperExitAcceptance(dependencies:{store:DeploymentStore;
 verifyAnchors:AnchorVerifier}){
 const {store,verifyAnchors}=dependencies;
 return async (campaignId:string,request:AcceptInput,actor:string):Promise<unknown>=>{
  const context=await store.rangeKeeperPaperExitAcceptanceContext({campaignId,
   previewId:request.previewId});
  if(!context)throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_campaign_not_found');
  if(context.mode!=='paper'||context.strategyId!=='rangekeeper_v1'||context.chainId!==4663||
   !['active','paused'].includes(context.lifecycle))
   throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_campaign_unavailable');
  const preview=context.preview;
  if(!preview)throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_preview_not_found');
  if(!EXIT_PREVIEW_KINDS.includes(preview.kind))
   throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_preview_wrong_kind');
  if(!COMPLETABLE_EXIT_KINDS.includes(preview.kind))
   throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_convert_unavailable');
  if(preview.expectedRevision!==context.currentRevision||
   preview.expectedRevision!==request.expectedRevision)
   throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_expected_revision_mismatch');
  if(preview.contentDigest!==request.contentDigest)
   throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_content_digest_mismatch');
  if(!preview.expiresAt||preview.expiresAt.getTime()<=Date.now())
   throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_preview_expired');
  // Recovers the source only after re-hashing the saved model against the
  // proposal's own `rangekeeperPaperExitModelHash`, so nothing inside the model is
  // trusted before the binding holds. This is the same helper the worker uses, so
  // acceptance and completion cannot disagree about which source they mean.
  const source=recoverRangeKeeperPaperExitModelSource(preview.proposal);
  if(!source)throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_model_integrity');
  try{await verifyAnchors(context.chainId,[source]);}
  catch{throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_source_not_canonical');}
  // No admission argument: the static discriminators are deliberately bypassed.
  return store.acceptOperation(campaignId,request,actor);
 };
}
