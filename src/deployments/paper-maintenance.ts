import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import {auditCanonicalPaperAccounting,
 auditCanonicalPaperConversionAccounting,
 recordCanonicalNextPaperConversionAccounting} from './paper-accounting.js';
import {recordCanonicalPaperFeeEvidence} from './paper-fee-replay.js';
import {advanceCanonicalPaperScenario} from './paper-projection.js';
import {DeploymentConflict,type DeploymentStore} from './store.js';

/** A bounded, signer-free pass for one paper campaign. The supervised worker
 * owns scheduling and campaign selection. Audits stop projection on reorg. */
export async function maintainCanonicalPaperScenario(store:DeploymentStore,
 client:RobinhoodClient,indexer:Pool,campaignId:string,maxSteps=16){
 assert(Number.isSafeInteger(maxSteps)&&maxSteps>=1&&maxSteps<=100,
  'Paper maintenance budget invalid');
 const standardAudit=await auditCanonicalPaperAccounting(store,client,campaignId);
 if(standardAudit.alreadyInvalidated||standardAudit.invalidated.length)
  return {status:'invalidated' as const,standardAudit,conversionAudit:null,
   steps:0,caughtUp:false};
 const conversionAudit=await auditCanonicalPaperConversionAccounting(store,client,campaignId);
 if(conversionAudit.alreadyInvalidated||conversionAudit.invalidated.length)
  return {status:'invalidated' as const,standardAudit,conversionAudit,
   steps:0,caughtUp:false};

 let conversionTerminal=false;
 let steps=0;
 for(;steps<maxSteps;steps++){
  if(!conversionTerminal){
   try{
    const next=await advanceCanonicalPaperScenario(store,client,indexer,campaignId);
    if(next.caughtUp)return {status:'current' as const,standardAudit,conversionAudit,
     steps,caughtUp:true};
    continue;
   }catch(error){
    if(!(error instanceof DeploymentConflict&&
     error.code==='paper_accounting_mark_unsupported'))throw error;
    // V1 has no conversion-close mark. V2 replays the whole mark sequence
    // under its own policy before its fee-aware terminal can be finalized.
    conversionTerminal=true;
   }
  }
  try{
   const next=await recordCanonicalNextPaperConversionAccounting(store,client,campaignId);
   if(next===null)return {status:'current' as const,standardAudit,conversionAudit,
    steps,caughtUp:true};
  }catch(error){
   if(!(error instanceof DeploymentConflict&&
    error.code==='paper_accounting_fee_evidence_unavailable'))throw error;
   await recordCanonicalPaperFeeEvidence(store,client,indexer,campaignId);
   // The next pass retries the exact same mark. No later mark can skip it.
  }
 }
 return {status:'budget_exhausted' as const,standardAudit,conversionAudit,
  steps,caughtUp:false};
}
