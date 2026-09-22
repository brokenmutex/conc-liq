import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import {recordCanonicalNextPaperAccounting} from './paper-accounting.js';
import {recordCanonicalPaperFeeEvidence} from './paper-fee-replay.js';
import {DeploymentConflict,type DeploymentStore} from './store.js';

type FeeWrite={evidenceId:string;replayed:boolean}|null;

/** One bounded paper projection step. A missing adjacent fee interval is the
 * only condition that starts the sampler. Every other integrity/canonicality
 * failure stops the step; existing append-only rows remain available for a
 * later retry. The callback is injected only by isolated tests. */
export async function advancePaperScenarioWithFeeSampler(store:DeploymentStore,
 client:RobinhoodClient,campaignId:string,sampleFee:()=>Promise<FeeWrite>){
 let fee:FeeWrite=null;
 let accounting;
 try{
  accounting=await recordCanonicalNextPaperAccounting(store,client,campaignId);
 }catch(error){
  if(!(error instanceof DeploymentConflict&&
   error.code==='paper_accounting_fee_evidence_unavailable'))throw error;
  fee=await sampleFee();
  // Another worker can have inserted the interval between the failed read
  // and the sampler's read. Retry once even when it found no work.
  accounting=await recordCanonicalNextPaperAccounting(store,client,campaignId);
 }
 return {feeEvidenceId:fee?.evidenceId??null,
  accountingMarkId:accounting?.markId??null,
  accountingSnapshotId:accounting?.snapshotId??null,
  caughtUp:accounting===null};
}

/** Production wiring: canonical chain/indexer fee sampling and the canonical
 * journal append. This has no signer, broadcast or background scheduling. */
export async function advanceCanonicalPaperScenario(store:DeploymentStore,
 client:RobinhoodClient,indexer:Pool,campaignId:string){
 return advancePaperScenarioWithFeeSampler(store,client,campaignId,
  ()=>recordCanonicalPaperFeeEvidence(store,client,indexer,campaignId));
}
