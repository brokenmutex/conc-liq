import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import {auditCanonicalPaperAccounting,
 auditCanonicalPaperConversionAccounting,
 auditCanonicalPaperConversionAccountingV2,
 auditCanonicalPaperConversionAccountingV3,
 recordCanonicalNextPaperConversionAccountingV2} from './paper-accounting.js';
import {recordCanonicalPaperFeeEvidence} from './paper-fee-replay.js';
import {recordCanonicalPaperPrincipalValuation} from './paper-valuation.js';
import {advanceCanonicalPaperScenario} from './paper-projection.js';
import {DeploymentConflict,type DeploymentStore} from './store.js';
import {acquirePaperPreparationSharedLease} from './paper-preparation-lease.js';

/** A bounded, signer-free pass for one paper campaign. The supervised worker
 * owns scheduling and campaign selection. Audits stop projection on reorg. */
export async function maintainCanonicalPaperScenario(store:DeploymentStore,
 client:RobinhoodClient,indexer:Pool,campaignId:string,maxSteps=16,
 options:{sampleValuation?:boolean;progress?:(stage:string,state:'started'|'completed'|'failed',
  durationMs?:number,reason?:string)=>void}={}){
 assert(Number.isSafeInteger(maxSteps)&&maxSteps>=1&&maxSteps<=100,
  'Paper maintenance budget invalid');
 const timed=async<T>(stage:string,fn:()=>Promise<T>):Promise<T>=>{
  const started=Date.now();options.progress?.(stage,'started');
  try{const result=await fn();options.progress?.(stage,'completed',Date.now()-started);return result;}
  catch(error){options.progress?.(stage,'failed',Date.now()-started,
   error instanceof DeploymentConflict?error.code:'maintenance_stage_failed');throw error;}
 };
 const standardAudit=await timed('standard_accounting_audit',()=>
  auditCanonicalPaperAccounting(store,client,campaignId));
 if(standardAudit.alreadyInvalidated||standardAudit.invalidated.length)
  return {status:'invalidated' as const,standardAudit,legacyConversionAudit:null,
   conversionAudit:null,conversionV3Audit:null,
   steps:0,caughtUp:false};
 const legacyConversionAudit=await timed('legacy_conversion_audit',()=>
  auditCanonicalPaperConversionAccounting(store,client,campaignId));
 if(legacyConversionAudit.alreadyInvalidated||legacyConversionAudit.invalidated.length)
  return {status:'invalidated' as const,standardAudit,legacyConversionAudit,
   conversionAudit:null,conversionV3Audit:null,steps:0,caughtUp:false};
 const conversionAudit=await timed('conversion_v2_audit',()=>
  auditCanonicalPaperConversionAccountingV2(store,client,campaignId));
 if(conversionAudit.alreadyInvalidated||conversionAudit.invalidated.length)
  return {status:'invalidated' as const,standardAudit,legacyConversionAudit,conversionAudit,
   conversionV3Audit:null,steps:0,caughtUp:false};
 const conversionV3Audit=await timed('conversion_v3_audit',()=>
  auditCanonicalPaperConversionAccountingV3(store,client,campaignId));
 if(conversionV3Audit.alreadyInvalidated||conversionV3Audit.invalidated.length)
  return {status:'invalidated' as const,standardAudit,legacyConversionAudit,conversionAudit,
   conversionV3Audit,steps:0,caughtUp:false};
 if(await store.hasTrustedStaticPaperCloseConvertV3Terminal(campaignId))
  return {status:'projection_current' as const,standardAudit,legacyConversionAudit,
   conversionAudit,conversionV3Audit,terminalV3:true,steps:0,caughtUp:true};

 // Audits above still run while a close preview is being prepared. A shared
 // session lease now protects only mutable valuation/fee/projection work; a
 // concurrent preparer owns the exclusive lock for this same campaign.
 const preparationLease=await timed('preparation_lease',()=>
  acquirePaperPreparationSharedLease(indexer,campaignId));
 if(!preparationLease)return {status:'preparation_locked' as const,standardAudit,legacyConversionAudit,
  conversionAudit,conversionV3Audit,steps:0,caughtUp:false};
 try{

 // Sampling is restricted to active and paused campaigns by the supervisor.
 // The store rechecks the prior mark and lifecycle under its campaign lock, so
 // a close that wins the race makes this stale append fail closed.
 if(options.sampleValuation){
  try{await timed('principal_valuation',()=>
   recordCanonicalPaperPrincipalValuation(store,client,campaignId));}
  catch(error){
   if(error instanceof Error&&error.message==='paper_next_source_not_later'){
    // A fresh canonical head is not available yet; keep the existing marks
    // eligible for projection and retry sampling on the next supervised pass.
   }else if(!(error instanceof DeploymentConflict&&[
    'paper_valuation_campaign_unavailable','paper_valuation_duplicate_source',
    'paper_valuation_conflicting_source','paper_valuation_prior_mark_changed',
    'paper_valuation_source_time_regressed','paper_valuation_state_unavailable',
   ].includes(error.code)))throw error;
  }
 }

 let conversionTerminal=false;
 let steps=0;
 for(;steps<maxSteps;steps++){
  if(!conversionTerminal){
   try{
    const next=await timed('advance_accounting_projection',()=>
     advanceCanonicalPaperScenario(store,client,indexer,campaignId,options.progress));
    if(next.caughtUp)return {status:'projection_current' as const,standardAudit,
     legacyConversionAudit,conversionAudit,conversionV3Audit,
     steps,caughtUp:true};
    continue;
   }catch(error){
    if(!(error instanceof DeploymentConflict&&
     error.code==='paper_accounting_mark_unsupported'))throw error;
   // V1 has no conversion-close mark. The separately versioned conversion
   // policy replays the mark sequence before its terminal can be finalized.
    conversionTerminal=true;
   }
  }
  try{
   const next=await recordCanonicalNextPaperConversionAccountingV2(store,client,campaignId);
   if(next===null)return {status:'projection_current' as const,standardAudit,
    legacyConversionAudit,conversionAudit,conversionV3Audit,
    steps,caughtUp:true};
  }catch(error){
   if(!(error instanceof DeploymentConflict&&
    error.code==='paper_accounting_fee_evidence_unavailable'))throw error;
   await recordCanonicalPaperFeeEvidence(store,client,indexer,campaignId);
   // The next pass retries the exact same mark. No later mark can skip it.
  }
 }
 return {status:'budget_exhausted' as const,standardAudit,legacyConversionAudit,
  conversionAudit,conversionV3Audit,
  steps,caughtUp:false};
 }finally{await preparationLease.release();}
}
