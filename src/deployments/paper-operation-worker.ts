import {AssertionError} from 'node:assert';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import {contentHash} from './contracts.js';
import {paperOpenModelSchema} from './paper-open-model.js';
import {paperCloseRetainModelSchema} from './paper-close-model.js';
import {paperCloseConvertModelSchema,
 verifyCanonicalPaperCloseConvertQuote} from './paper-close-convert-model.js';
import {parsePaperStaticCloseConvertTerminalV3} from './paper-close-convert-preflight.js';
import {readStaticPaperCloseConvertFeeContext} from './paper-close-convert-fee-reader.js';
import {replayEphemeralStaticPaperCloseConvertFees} from './paper-close-convert-ephemeral-fees.js';
import {samplePaperCloseConvertPrestate} from './paper-close-convert-prestate-sampler.js';
import {selectPaperCloseConvertPrestateCostsV1} from './paper-close-convert-prestate-costs.js';
import {buildProspectivePaperCloseConvertPrestateGasProfiles} from
 './paper-close-convert-prestate-gas-profiles.js';
import {verifyPaperStaticCloseConvertTerminalForWorker} from
 './paper-close-convert-terminal-replay-verifier.js';
import {verifyCanonicalPaperAnchors,type PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import {maintainCanonicalPaperScenario} from './paper-maintenance.js';
import {DeploymentConflict,type DeploymentStore} from './store.js';
import {readCanonicalPaperOpenFrame} from './paper-preview.js';
import {loadRangeKeeperPaperConfirmationContext} from './rangekeeper-paper-confirmation-context.js';
import {adaptRangeKeeperConfirmedOpenContext} from './rangekeeper-paper-confirmed-open-adapter.js';
import {isRangeKeeperPaperConfirmationReplayCapability,
 replayRangeKeeperPaperConfirmationOnOwnedFork} from './rangekeeper-paper-confirmation-replay-verifier.js';

type ClaimedOperation={id:string;campaign_id:string;status:string;stage:string;
 attempts:number};
type OperationContext={id:string;campaign_id:string;kind:string;status:string;claimed_by:string|null;
 claim_valid:boolean;created_at:Date;mode:string;lifecycle:string;strategy_id:string;
 expires_at:Date;proposal:Record<string,unknown>;request:Record<string,unknown>;
 current_revision:number;expected_revision:number;preview_kind:string};
const MAX_ATTEMPTS=5;
const LEASE_SECONDS=120;
export interface PaperOperationWorkerOptions {rpcUrl?:string;beforeForkRead?:()=>Promise<void>}

const sourceFor=(context:OperationContext):PaperCanonicalAnchor=>{
 if(!context.proposal||typeof context.proposal!=='object'||Array.isArray(context.proposal))
  throw new DeploymentConflict('paper_operation_saved_model_unavailable');
 if(context.kind==='close_convert'&&context.proposal.paperCloseConvertTerminalV3!==undefined){
  try{return parsePaperStaticCloseConvertTerminalV3(
   context.proposal.paperCloseConvertTerminalV3).source;}
  catch{throw new DeploymentConflict('paper_operation_saved_model_unavailable');}
 }
 const parsed=context.kind==='open'?
  paperOpenModelSchema.safeParse(context.proposal.paperOpenModel):
  context.kind==='close_retain'?
   paperCloseRetainModelSchema.safeParse(context.proposal.paperCloseRetainModel):
   paperCloseConvertModelSchema.safeParse(context.proposal.paperCloseConvertModel);
 if(!parsed.success)throw new DeploymentConflict('paper_operation_saved_model_unavailable');
 return parsed.data.source;
};

async function readClaimContext(indexer:Pool,claim:ClaimedOperation,workerId:string){
 const row=(await indexer.query<OperationContext>(`
  SELECT o.id::text,o.campaign_id::text,o.kind,o.status,o.claimed_by,
   (o.claim_until>=clock_timestamp()) AS claim_valid,
   o.created_at,c.mode,c.lifecycle,c.current_revision,r.strategy_id,
   v.expires_at,v.proposal,v.request,v.expected_revision,v.kind AS preview_kind
  FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
  JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
  JOIN deployment_previews v ON v.id=o.preview_id
  WHERE o.id=$1`,[claim.id])).rows[0];
 if(!row||row.campaign_id!==claim.campaign_id||row.claimed_by!==workerId||
  !row.claim_valid||
  row.status!==claim.status)
  throw new DeploymentConflict('paper_operation_claim_changed');
 return row;
}

async function replayStaticCloseConvertV3Gas(input:{store:DeploymentStore;client:RobinhoodClient;
 indexer:Pool;model:ReturnType<typeof parsePaperStaticCloseConvertTerminalV3>;
 frame:import('./paper-preview.js').PaperOpenFrame;rpcUrl:string;
 beforeRead:()=>Promise<void>;verifyAnchors:(chainId:number,
  sources:readonly PaperCanonicalAnchor[])=>Promise<void>}){
 const {store,client,indexer,model,frame,rpcUrl,beforeRead,verifyAnchors}=input,
  context=await readStaticPaperCloseConvertFeeContext({store,campaignId:model.campaignId,
   revision:model.revision,verifyAnchors}),
  feeReplay=await replayEphemeralStaticPaperCloseConvertFees({context,client,indexer,frame}),
  sampled=await samplePaperCloseConvertPrestate({rpcUrl,openModel:context.state.openModel,
   openMarkId:context.state.openMarkId,profile:context.state.profile,frame,
   previous:{markId:context.state.previous.markId,source:context.state.previous.source},
   route:model.conversionRoute,feeCarry:feeReplay.feeCarry,feeReplay,
   verifyPersistedContext:()=>context.verifyPersistedContext({state:context.state,
    feeCarry:context.feeCarry,feeEvidence:context.feeEvidence,source:frame.source}),
   verifyAnchors,beforeRead,deterministicClock:true,
   sampledAt:model.prestateReport.gasStages[0]!.source.estimatedAt});
 if(sampled.reportHash!==model.prestateReport.reportHash)
  throw new DeploymentConflict('paper_close_convert_terminal_prestate_replay_changed');
 const sizeBand=buildProspectivePaperCloseConvertPrestateGasProfiles(sampled).sizeBand,
  rows=await store.staticPaperCloseConvertPrestateGasProfiles({chainId:context.state.profile.pool.chainId,
   poolAddress:context.state.profile.pool.pool,sizeBand,reportHash:sampled.reportHash}),
  costs=selectPaperCloseConvertPrestateCostsV1({report:sampled,rows,
   gasPriceWei:BigInt(model.costs.gasPriceWei),gasPriceObservedAt:model.costs.gasPriceObservedAt});
 if(contentHash(costs)!==contentHash(model.costs))
  throw new DeploymentConflict('paper_close_convert_terminal_prestate_cost_replay_changed');
 return {reportHash:sampled.reportHash,scopeHash:costs.scopeHash,sequenceHash:costs.sequenceHash,
  source:frame.source,costs,stages:costs.stages.map((stage,stageIndex)=>({stage:stage.stage,
   profileId:stage.profileId,version:stage.version,callHash:stage.source.callHash,
   sourceHash:stage.sourceHash,expectedGasUnits:stage.expectedGasUnits,
   boundGasUnits:stage.boundGasUnits,scopeHash:stage.scopeHash,sequenceHash:stage.sequenceHash,
   stageIndex,stageCount:stage.stageCount,source:stage.source}))};
}

/** One restart-safe claim pass. No signer or transaction broadcaster is loaded.
 * Completion methods remain the sole append boundary and repeat canonical
 * checks inside their transaction. HTTP acceptance remains separately gated. */
export async function processOnePaperOperation(store:DeploymentStore,
 chain:RobinhoodClient,indexer:Pool,workerId:string,options:PaperOperationWorkerOptions={}){
 // Keep static/manual priority. RangeKeeper opens require server-owned
 // confirmation evidence and operation-bound replay before provisional booking.
 const claim=await store.claimNext(workerId,LEASE_SECONDS,'paper','static_manual_v1')??
  await store.claimNext(workerId,LEASE_SECONDS,'paper','rangekeeper_v1');
 if(!claim)return {status:'idle' as const};
 let lost=false,renewing=false;
 const renew=setInterval(()=>{
  if(renewing||lost)return;
  renewing=true;
  void store.renewClaim(claim.id,workerId,LEASE_SECONDS)
   .catch(()=>{lost=true;}).finally(()=>{renewing=false;});
 },LEASE_SECONDS*1000/3);
 const block=async(reason:string)=>{
  if(lost)return {status:'claim_lost' as const,operationId:claim.id};
  try{await store.advanceClaim(claim.id,workerId,'paper_recovery_required','blocked',reason);}
  catch{return {status:'claim_lost' as const,operationId:claim.id};}
  return {status:'blocked' as const,operationId:claim.id,reason};
 };
 try{
  if(claim.attempts>MAX_ATTEMPTS)return await block('paper_operation_attempt_bound');
  const context=await readClaimContext(indexer,claim,workerId);
  if(context.mode!=='paper'||
   !['open','pause','resume','close_retain','close_convert'].includes(context.kind))
   return await block('paper_operation_path_unavailable');
  const verify=(chainId:number,sources:readonly PaperCanonicalAnchor[])=>
   verifyCanonicalPaperAnchors(chain,chainId,sources);
   if(context.strategy_id==='rangekeeper_v1'){
    if(context.kind!=='open')return await block('rangekeeper_paper_operation_path_unavailable');
   if(!options.rpcUrl)return await block('rangekeeper_paper_confirmation_fork_rpc_unavailable');
   const snapshot=await store.rangeKeeperPaperConfirmationOperationSnapshot({operationId:claim.id,workerId,
    verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(chain,chainId,sources)});
   const confirmation=await loadRangeKeeperPaperConfirmationContext({campaignId:snapshot.campaignId,
    runtimeIdentity:snapshot.runtimeIdentity,readSnapshot:async()=>snapshot.confirmationContext,
    readGasProfiles:query=>store.rangeKeeperPaperGasProfiles(query.poolAddress,query.pathVersion,query.sizeBand),
    now:snapshot.acceptedAt.getTime()});
   if(confirmation.status!=='available')return await block(confirmation.reason);
   const adapter=adaptRangeKeeperConfirmedOpenContext(confirmation),
    pinnedSource=confirmation.envelope.confirmationObservation.source,
    frame=await readCanonicalPaperOpenFrame(chain,confirmation.draft.profile,pinnedSource);
   if(claim.status==='preflighting'){
    await store.advanceClaim(claim.id,workerId,'paper_model_preflight_checked','executing',null);
    await store.advanceClaim(claim.id,workerId,'paper_model_reconciling','reconciling',null);
   }else if(claim.status==='executing'||claim.status==='confirming')
    await store.advanceClaim(claim.id,workerId,'paper_model_reconciling','reconciling',null);
   else if(claim.status!=='reconciling')return await block('paper_operation_status_unavailable');
   if(lost)return {status:'claim_lost' as const,operationId:claim.id};
   let replay;
   try{replay=await replayRangeKeeperPaperConfirmationOnOwnedFork({draft:confirmation.draft,
    envelope:confirmation.envelope,frame,operationId:claim.id,openPreviewId:snapshot.openPreviewId,
    operationSnapshotHash:snapshot.snapshotHash,rpcUrl:options.rpcUrl,
    beforeRead:options.beforeForkRead??(async()=>{}),maxRequests:1600,timeoutMs:300_000});}
   catch(error){
    if(error instanceof AssertionError)
     return await block('rangekeeper_paper_confirmation_fork_replay_mismatch');
    throw error;
   }
   if(lost)return {status:'claim_lost' as const,operationId:claim.id};
   if(!isRangeKeeperPaperConfirmationReplayCapability(replay,{operationId:claim.id,
    openPreviewId:snapshot.openPreviewId,operationSnapshotHash:snapshot.snapshotHash,
    campaignId:confirmation.draft.id,revision:confirmation.draft.revision,
    envelopeHash:confirmation.envelope.envelopeHash,
    candidateHash:confirmation.envelope.confirmationObservation.candidateHash,
    simulationHash:confirmation.envelope.decision.simulation.simulationHash}))
    return await block('rangekeeper_paper_confirmation_replay_provenance_unavailable');
   // Completion must atomically append the confirmed open mark and capital
   // ledger entries. Until that transaction exists, this worker stays blocked.
   const completed=await store.completeRangeKeeperPaperConfirmedOpen({operationId:claim.id,workerId,
    snapshot,adapter,replay,verifyAnchors:verify});
   return {status:'completed' as const,operationId:claim.id,kind:context.kind,...completed};
  }
  if(context.strategy_id!=='static_manual_v1')return await block('paper_operation_path_unavailable');
  if((context.kind==='pause'||context.kind==='resume')&&
   (context.preview_kind!==context.kind||context.expected_revision!==context.current_revision))
   return await block('paper_lifecycle_revision_or_preview_mismatch');
  if(context.created_at.getTime()>context.expires_at.getTime())
   return await block('paper_operation_stale_admission');
  const lifecycleOperation=context.kind==='pause'||context.kind==='resume';
  if(!lifecycleOperation){
   const source=sourceFor(context);
   await verifyCanonicalPaperAnchors(chain,4663,[source]);
  }
  if(lost)return {status:'claim_lost' as const,operationId:claim.id};
  if(claim.status==='preflighting'){
   await store.advanceClaim(claim.id,workerId,'paper_model_preflight_checked','executing',null);
   await store.advanceClaim(claim.id,workerId,'paper_model_reconciling','reconciling',null);
  }else if(claim.status==='executing'||claim.status==='confirming')
   await store.advanceClaim(claim.id,workerId,'paper_model_reconciling','reconciling',null);
  else if(claim.status!=='reconciling')return await block('paper_operation_status_unavailable');
  if(lost)return {status:'claim_lost' as const,operationId:claim.id};
  if(context.kind==='pause'||context.kind==='resume')
   await store.completeTrustedPaperLifecycleOperation(claim.id,workerId);
  else if(context.kind==='open')await store.completeTrustedPaperOpen(claim.id,workerId,verify);
  else if(context.kind==='close_retain')
   await store.completeTrustedPaperCloseRetain(claim.id,workerId,verify);
  else{
   if(context.proposal.paperCloseConvertTerminalV3!==undefined){
    if(!options.rpcUrl)return await block('paper_close_convert_v3_fork_rpc_unavailable');
    let terminal;
    try{terminal=parsePaperStaticCloseConvertTerminalV3(
     context.proposal.paperCloseConvertTerminalV3);}
    catch{return await block('paper_close_convert_v3_terminal_envelope_invalid');}
    try{
     const verification=await verifyPaperStaticCloseConvertTerminalForWorker({store,campaignId:claim.campaign_id,
      revision:context.current_revision,rawModel:terminal,client:chain,indexer,verifyAnchors:verify,
      replayGasStages:({model,frame})=>replayStaticCloseConvertV3Gas({store,client:chain,indexer,
       model,frame,rpcUrl:options.rpcUrl!,beforeRead:options.beforeForkRead??(async()=>{}),
       verifyAnchors:verify})});
     const completed=await store.completeTrustedStaticPaperCloseConvertV3({operationId:claim.id,
      workerId,verification,verifyAnchors:verify});
     return {status:'completed' as const,operationId:claim.id,kind:context.kind,...completed};
    }catch(error){return await block(error instanceof DeploymentConflict?error.code:
     'paper_close_convert_v3_terminal_replay_invalid');}
   }
   await store.prepareTrustedPaperCloseConvert(claim.id,workerId,verify);
   const projection=await maintainCanonicalPaperScenario(store,chain,indexer,
    claim.campaign_id,100,{sampleValuation:false});
   if(projection.status==='invalidated')
    return await block('paper_operation_canonical_history_invalidated');
   if(!projection.caughtUp)return {status:'retry' as const,operationId:claim.id,
    reason:'paper_accounting_projection_budget'};
   await store.completeTrustedPaperCloseConvert(claim.id,workerId,verify,
    async(chainId,model,inputAmountRaw)=>{
     if(await chain.getChainId()!==chainId)
      throw new DeploymentConflict('paper_conversion_quote_chain_changed');
     return verifyCanonicalPaperCloseConvertQuote(chain,model,inputAmountRaw);
    });
  }
  return {status:'completed' as const,operationId:claim.id,kind:context.kind};
 }catch(error){
  if(error instanceof DeploymentConflict&&error.code==='paper_operation_claim_changed')
   return {status:'claim_lost' as const,operationId:claim.id};
  if(error instanceof DeploymentConflict)return await block(error.code);
  if(error instanceof AssertionError)
   return await block('paper_operation_canonical_or_evidence_invalid');
  return {status:'retry' as const,operationId:claim.id,reason:'paper_operation_transient_error'};
 }finally{clearInterval(renew);}
}
