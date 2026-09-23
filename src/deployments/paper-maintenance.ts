import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import {auditCanonicalPaperAccounting,
 auditCanonicalPaperConversionAccounting,
 auditCanonicalPaperConversionAccountingV2,
 recordCanonicalNextPaperConversionAccountingV2} from './paper-accounting.js';
import {recordCanonicalPaperFeeEvidence} from './paper-fee-replay.js';
import {recordCanonicalPaperPrincipalValuation} from './paper-valuation.js';
import {advanceCanonicalPaperScenario} from './paper-projection.js';
import {DeploymentConflict,type DeploymentStore} from './store.js';

/** A bounded, signer-free pass for one paper campaign. The supervised worker
 * owns scheduling and campaign selection. Audits stop projection on reorg. */
export async function maintainCanonicalPaperScenario(store:DeploymentStore,
 client:RobinhoodClient,indexer:Pool,campaignId:string,maxSteps=16,
 options:{sampleValuation?:boolean}={}){
 assert(Number.isSafeInteger(maxSteps)&&maxSteps>=1&&maxSteps<=100,
  'Paper maintenance budget invalid');
 const standardAudit=await auditCanonicalPaperAccounting(store,client,campaignId);
 if(standardAudit.alreadyInvalidated||standardAudit.invalidated.length)
  return {status:'invalidated' as const,standardAudit,legacyConversionAudit:null,
   conversionAudit:null,
   steps:0,caughtUp:false};
 const legacyConversionAudit=await auditCanonicalPaperConversionAccounting(store,client,campaignId);
 if(legacyConversionAudit.alreadyInvalidated||legacyConversionAudit.invalidated.length)
  return {status:'invalidated' as const,standardAudit,legacyConversionAudit,
   conversionAudit:null,steps:0,caughtUp:false};
 const conversionAudit=await auditCanonicalPaperConversionAccountingV2(store,client,campaignId);
 if(conversionAudit.alreadyInvalidated||conversionAudit.invalidated.length)
  return {status:'invalidated' as const,standardAudit,legacyConversionAudit,conversionAudit,
   steps:0,caughtUp:false};

 // Sampling is restricted to active and paused campaigns by the supervisor.
 // The store rechecks the prior mark and lifecycle under its campaign lock, so
 // a close that wins the race makes this stale append fail closed.
 if(options.sampleValuation){
  try{await recordCanonicalPaperPrincipalValuation(store,client,campaignId);}
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
    const next=await advanceCanonicalPaperScenario(store,client,indexer,campaignId);
    if(next.caughtUp)return {status:'projection_current' as const,standardAudit,
     legacyConversionAudit,conversionAudit,
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
    legacyConversionAudit,conversionAudit,
    steps,caughtUp:true};
  }catch(error){
   if(!(error instanceof DeploymentConflict&&
    error.code==='paper_accounting_fee_evidence_unavailable'))throw error;
   await recordCanonicalPaperFeeEvidence(store,client,indexer,campaignId);
   // The next pass retries the exact same mark. No later mark can skip it.
  }
 }
 return {status:'budget_exhausted' as const,standardAudit,legacyConversionAudit,
  conversionAudit,
  steps,caughtUp:false};
}
