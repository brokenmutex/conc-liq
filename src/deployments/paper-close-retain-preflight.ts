import {DeploymentConflict,type DeploymentStore} from './store.js';
import {contentHash} from './contracts.js';
import {buildPaperCloseRetainModel} from './paper-close-model.js';
import {costIndicativePaperOpenPreview,type PaperGasProfileRow} from './paper-cost.js';
import type {PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import type {PaperOpenFrame} from './paper-preview.js';

type State=Awaited<ReturnType<DeploymentStore['paperValuationState']>>;

/** Build and persist the exact static/manual retain-close model from a current
 * canonical terminal frame. Browser input supplies no model or evidence. */
export async function persistTrustedStaticPaperRetainPreview(input:{store:DeploymentStore;
 state:State;frame:PaperOpenFrame;gasProfiles:PaperGasProfileRow[];gasPriceWei:bigint;
 verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>;
 now?:number}){
 const {store,state,frame,gasProfiles,gasPriceWei}=input,now=input.now??Date.now();
 const {openModel,openMarkId,previous,profile,profileHash,parameters}=state;
 const costed=costIndicativePaperOpenPreview({status:'indicative',candidate:openModel.candidate},
  gasProfiles,profile.pool.pool,frame.nativePrice??0n,gasPriceWei,now);
 if(costed.costs.status!=='provisional')
  throw new DeploymentConflict(`paper_close_retain_cost_unavailable:${costed.costs.reason}`);
 let model;
 try{model=buildPaperCloseRetainModel(openModel,openMarkId,previous,frame,profile,parameters,costed,now);}
 catch{throw new DeploymentConflict('paper_close_retain_model_unavailable');}
 if(contentHash(profile)!==profileHash||model.campaignId!==openModel.campaignId||
  model.revision!==openModel.revision||model.openModelHash!==contentHash(openModel))
  throw new DeploymentConflict('paper_close_retain_state_changed');
 try{await input.verifyAnchors(profile.pool.chainId,[openModel.source,previous.source,model.source]);}
 catch{throw new DeploymentConflict('paper_close_retain_source_not_canonical');}
 const expiresAt=new Date(now+60_000),modelHash=contentHash(model);
 const saved=await store.recordPreview({campaignId:model.campaignId,
  expectedRevision:model.revision,kind:'close_retain',request:{kind:'close_retain',
   strategyId:'static_manual_v1',profileHash,openMarkId,previousMarkId:previous.markId,modelHash},
  proposal:{paperCloseRetainModel:model},evidence:{
   verificationClass:'canonical_paper_close_retain_preflight_v1',
   classification:'paper_model_provisional',profileHash,modelHash,
   openModelHash:model.openModelHash,referenceProofHash:model.referenceProofHash,
   source:model.source,costEvidenceClass:'fork_estimated',
   costProfileIds:model.costs.stages.map(stage=>stage.profileId),paidCostsAvailable:false,
   feeAccrualAvailable:false},expiresAt});
 return {id:saved.id,kind:'close_retain' as const,status:'indicative' as const,
  expectedRevision:model.revision,contentDigest:saved.contentDigest,
  expiresAt:expiresAt.toISOString(),source:model.source,modelHash,
  retainedLowerBound:model.retainedLowerBound,costs:{scope:'saved_open_candidate_close_retain_stages_only',
   closeRetain:model.costs.closeRetain,profileIds:model.costs.stages.slice(3).map(stage=>stage.profileId),
   gasPriceWei:model.costs.gasPriceWei,boundGasPriceWei:model.costs.boundGasPriceWei,
   gasPriceObservedAt:model.costs.gasPriceObservedAt,nativeReferencePrice:model.costs.nativeReferencePrice},
  economics:null,paidCostsAvailable:false,feeCaptureAvailable:false,
  trustedPreviewSaved:true,actionAvailable:false,operationAcceptanceAvailable:false,
  limitations:['retained amounts are principal-only lower bounds',
   'costs are provisional fork-estimated models and are not paid gas',
   'fee capture paid gas and net economics remain unavailable']};
}
