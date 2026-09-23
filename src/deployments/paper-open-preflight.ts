import {DeploymentConflict,type DeploymentStore} from './store.js';
import {buildPaperOpenModel} from './paper-open-model.js';
import {contentHash} from './contracts.js';
import {costIndicativePaperOpenPreview} from './paper-cost.js';
import {buildIndicativePaperOpenPreview,type PaperOpenFrame,type PaperPreviewDraft} from './paper-preview.js';

type CostedOpenPreview=ReturnType<typeof costIndicativePaperOpenPreview<
 ReturnType<typeof buildIndicativePaperOpenPreview>>>;
type AnchorVerifier=(chainId:number,sources:readonly PaperOpenFrame['source'][])=>Promise<void>;

/** Persist only a fully bound static/manual paper open preview. This function
 * is for the trusted preflight service; browser requests never provide the
 * model, evidence, or operation digest. */
export async function persistTrustedPaperOpenPreview(input:{store:DeploymentStore;
 draft:PaperPreviewDraft;frame:PaperOpenFrame;preview:CostedOpenPreview;
 verifyAnchors:AnchorVerifier;now?:number}){
 const {store,draft,frame,preview}=input,now=input.now??Date.now();
 if(draft.strategyId!=='static_manual_v1'||preview.status!=='indicative'||
  preview.costs.status!=='provisional'||!preview.candidate)
  throw new DeploymentConflict('paper_open_costed_preflight_unavailable');
 if(contentHash(draft.profile)!==draft.profileHash)
  throw new DeploymentConflict('paper_open_profile_hash_mismatch');
 let model;
 try{model=buildPaperOpenModel(draft,frame,preview);}
 catch{throw new DeploymentConflict('paper_open_model_unavailable');}
 const expiresAt=new Date(preview.expiresAt);
 if(!Number.isFinite(expiresAt.getTime())||expiresAt.getTime()<=now||
  expiresAt.getTime()-now>120_000)
  throw new DeploymentConflict('paper_open_preview_expired');
 try{await input.verifyAnchors(draft.profile.pool.chainId,[model.source]);}
 catch{throw new DeploymentConflict('paper_open_source_not_canonical');}
 const saved=await store.recordPreview({campaignId:draft.id,expectedRevision:draft.revision,
  kind:'open',request:{kind:'open',strategyId:'static_manual_v1',profileHash:draft.profileHash,
   configHash:draft.configHash,allocationHash:contentHash(draft.allocation),
   candidateHash:model.candidateHash},proposal:{paperOpenModel:model},
  evidence:{verificationClass:'canonical_paper_open_preflight_v1',
   classification:'paper_model_provisional',source:model.source,
   profileHash:model.profileHash,referenceProofHash:model.referenceProofHash,
   costEvidenceClass:'fork_estimated',costProfileIds:model.costs.stages.map(stage=>stage.profileId),
   paidCostsAvailable:false,feeAccrualAvailable:false},expiresAt});
 return {...saved,modelHash:contentHash(model),expectedRevision:draft.revision};
}
