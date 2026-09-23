import {AssertionError} from 'node:assert';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import {paperOpenModelSchema} from './paper-open-model.js';
import {paperCloseRetainModelSchema} from './paper-close-model.js';
import {paperCloseConvertModelSchema,
 verifyCanonicalPaperCloseConvertQuote} from './paper-close-convert-model.js';
import {verifyCanonicalPaperAnchors,type PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import {maintainCanonicalPaperScenario} from './paper-maintenance.js';
import {DeploymentConflict,type DeploymentStore} from './store.js';

type ClaimedOperation={id:string;campaign_id:string;status:string;stage:string;
 attempts:number};
type OperationContext={id:string;campaign_id:string;kind:string;status:string;claimed_by:string|null;
 claim_valid:boolean;created_at:Date;mode:string;lifecycle:string;strategy_id:string;
 expires_at:Date;proposal:Record<string,unknown>};
const MAX_ATTEMPTS=5;
const LEASE_SECONDS=120;

const sourceFor=(context:OperationContext):PaperCanonicalAnchor=>{
 if(!context.proposal||typeof context.proposal!=='object'||Array.isArray(context.proposal))
  throw new DeploymentConflict('paper_operation_saved_model_unavailable');
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
   o.created_at,c.mode,c.lifecycle,r.strategy_id,v.expires_at,v.proposal
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

/** One restart-safe claim pass. No signer or transaction broadcaster is loaded.
 * Completion methods remain the sole append boundary and repeat canonical
 * checks inside their transaction. HTTP acceptance remains separately gated. */
export async function processOnePaperOperation(store:DeploymentStore,
 chain:RobinhoodClient,indexer:Pool,workerId:string){
 const claim=await store.claimNext(workerId,LEASE_SECONDS,'paper','static_manual_v1');
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
  if(context.mode!=='paper'||context.strategy_id!=='static_manual_v1'||
   !['open','close_retain','close_convert'].includes(context.kind))
   return await block('paper_operation_path_unavailable');
  if(context.created_at.getTime()>context.expires_at.getTime())
   return await block('paper_operation_stale_admission');
  const source=sourceFor(context),verify=(chainId:number,sources:readonly PaperCanonicalAnchor[])=>
   verifyCanonicalPaperAnchors(chain,chainId,sources);
  await verifyCanonicalPaperAnchors(chain,4663,[source]);
  if(lost)return {status:'claim_lost' as const,operationId:claim.id};
  if(claim.status==='preflighting'){
   await store.advanceClaim(claim.id,workerId,'paper_model_preflight_checked','executing',null);
   await store.advanceClaim(claim.id,workerId,'paper_model_reconciling','reconciling',null);
  }else if(claim.status==='executing'||claim.status==='confirming')
   await store.advanceClaim(claim.id,workerId,'paper_model_reconciling','reconciling',null);
  else if(claim.status!=='reconciling')return await block('paper_operation_status_unavailable');
  if(lost)return {status:'claim_lost' as const,operationId:claim.id};
  if(context.kind==='open')await store.completeTrustedPaperOpen(claim.id,workerId,verify);
  else if(context.kind==='close_retain')
   await store.completeTrustedPaperCloseRetain(claim.id,workerId,verify);
  else{
   await store.prepareTrustedPaperCloseConvert(claim.id,workerId,verify);
   const projection=await maintainCanonicalPaperScenario(store,chain,indexer,
    claim.campaign_id,100);
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
