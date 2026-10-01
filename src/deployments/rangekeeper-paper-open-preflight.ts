import {DeploymentConflict,type DeploymentStore} from './store.js';
import {contentHash} from './contracts.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {RangeKeeperPaperDraft,
 RangeKeeperPaperOpenModel} from './rangekeeper-paper-open-model.js';

type AnchorVerifier=(chainId:number,sources:readonly PaperOpenFrame['source'][])=>Promise<void>;

/** The window a RangeKeeper open preview is trusted for. `recordPreview` refuses
 * anything beyond 120s, and `readRangeKeeperPaperConfirmationEnvelope` refuses an
 * expired row, so the confirmation producer has to run inside this window. The
 * canonical source is itself only accepted for 180s, so the shorter of the two
 * bounds the preview. */
const PREVIEW_WINDOW_MS=120_000;
const SOURCE_WINDOW_MS=180_000;

/** Persists the trusted `deployment_previews` row of kind `open` that the
 * RangeKeeper confirmation path requires and that nothing previously wrote.
 *
 * `readRangeKeeperPaperConfirmationEnvelope` selects the newest `open` preview
 * for the campaign and re-derives its `previewDigest`; the producer receipt then
 * joins the same row by id. Without this row the whole RangeKeeper open path is
 * unreachable, which is what kept it so — see
 * docs/plans/rangekeeper-paper-operation-path-2026-10-01.md section 0.
 *
 * It mirrors `persistTrustedPaperOpenPreview` for the static path, including
 * refusing to persist anything but an indicative model with provisional costs,
 * and re-verifying the model's own source is canonical before writing. The
 * request/proposal/evidence shapes are RangeKeeper's, not static's: the proposal
 * carries `rangekeeperPaperOpenModel`, which is the key
 * `persistRangeKeeperPaperConfirmationWithProducerReceipt` already reads
 * (store.ts:1445). */
export async function persistTrustedRangeKeeperPaperOpenPreview(input:{store:DeploymentStore;
 draft:RangeKeeperPaperDraft;model:RangeKeeperPaperOpenModel;
 verifyAnchors:AnchorVerifier;now?:number}){
 const {store,draft,model}=input,now=input.now??Date.now();
 if(draft.strategyId!=='rangekeeper_v1')
  throw new DeploymentConflict('rangekeeper_open_preview_strategy_unavailable');
 if(model.campaignId!==draft.id||model.revision!==draft.revision||
  model.draftConfigHash!==draft.configHash||model.profileHash!==draft.profileHash)
  throw new DeploymentConflict('rangekeeper_open_preview_draft_binding_invalid');
 // Only a complete, costed, kernel-indicative model is worth binding an
 // operation to. A blocked model has an explicit reason the operator should see
 // instead, and persisting it would let acceptance bind evidence the kernel
 // itself refused.
 if(model.status!=='indicative'||!model.candidate||!model.candidateHash||
  !model.costs||model.costs.status!=='provisional')
  throw new DeploymentConflict('rangekeeper_open_costed_model_unavailable');
 if(!model.kernelPolicyHash||!model.kernelBuildId)
  throw new DeploymentConflict('rangekeeper_open_preview_policy_unavailable');
 // RangeKeeper opens on two observations, not one. buildRangeKeeperPaperConfirmation
 // takes this model as its *first* observation and requires the kernel to have
 // said `confirm` with requiresSecondObservation; the producer then takes the
 // second observation at a later frame. Persisting any other decision would bind
 // a preview the confirmation is guaranteed to reject, turning a clear reason
 // here into an opaque failure later.
 if(model.decision?.kernelAction!=='confirm'||model.decision.requiresSecondObservation!==true)
  throw new DeploymentConflict('rangekeeper_open_preview_first_confirmation_unavailable');
 if(!model.reference.eligible||!model.reference.proof)
  throw new DeploymentConflict('rangekeeper_open_preview_reference_unavailable');
 if(contentHash(draft.profile)!==draft.profileHash)
  throw new DeploymentConflict('rangekeeper_open_preview_profile_hash_mismatch');
 const sourceAgeMs=now-model.source.timestamp*1000;
 if(!Number.isSafeInteger(model.source.timestamp)||sourceAgeMs<0||sourceAgeMs>SOURCE_WINDOW_MS)
  throw new DeploymentConflict('rangekeeper_open_preview_source_stale');
 // The preview can never outlive its own canonical source, whichever bound bites
 // first. Both are checked again on read, so a clock skew here fails closed.
 const expiresAt=new Date(Math.min(model.source.timestamp*1000+SOURCE_WINDOW_MS,
  now+PREVIEW_WINDOW_MS));
 if(expiresAt.getTime()<=now)
  throw new DeploymentConflict('rangekeeper_open_preview_expired');
 try{await input.verifyAnchors(draft.profile.pool.chainId,[model.source]);}
 catch{throw new DeploymentConflict('rangekeeper_open_preview_source_not_canonical');}
 const saved=await store.recordPreview({campaignId:draft.id,expectedRevision:draft.revision,
  kind:'open',
  request:{kind:'open',strategyId:'rangekeeper_v1',profileHash:draft.profileHash,
   configHash:draft.configHash,allocationHash:contentHash(draft.allocation),
   candidateHash:model.candidateHash},
  // The reader cross-checks this hash when present (store.ts:887-889), so it is
  // set rather than left out: an edited proposal then fails on the model itself
  // and not only on the preview digest.
  proposal:{rangekeeperPaperOpenModel:model,rangekeeperPaperOpenModelHash:contentHash(model)},
  evidence:{verificationClass:'canonical_rangekeeper_paper_open_model_v1',
   classification:'paper_model_provisional',source:model.source,
   profileHash:model.profileHash,referenceProofHash:model.reference.proofHash,
   kernelPolicyHash:model.kernelPolicyHash,kernelBuildId:model.kernelBuildId,
   costEvidenceClass:'fork_estimated',
   costProfileIds:model.costs.profileIds,
   // A RangeKeeper open model is costed from a sample of its own candidate, never
   // from a reused band, so no paid cost or fee accrual exists at preview time.
   paidCostsAvailable:false,feeAccrualAvailable:false},
  expiresAt});
 return {...saved,modelHash:contentHash(model),expectedRevision:draft.revision};
}
