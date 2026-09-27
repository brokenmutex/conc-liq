import type {PaperOpenFrame,PaperDraft} from './paper-preview.js';
import {contentHash} from './contracts.js';

type GasReport={reportHash:string;campaignId:string;revision:number;configHash:string;
 profileHash:string;source:{block:string;hash:string;timestamp:number};sampledAt:string};
type GasAttestation={reportHash:string;sourceHash:string;profileHash:string;verifiedAt:string};
export type StaticPaperGasPreparationResult<T>=
 |{status:'available';value:T;reportHash?:string;imported?:boolean}
 |{status:'unavailable';reason:string;value?:T};

/** Ensures the exact candidate has fresh, replay-attested six-stage gas
 * evidence, then rebuilds its caller-owned preview at the same pinned source.
 * Importing provisional calibration rows is the only persistent side effect;
 * this helper never creates a draft, preview, operation, or wallet action. */
export async function prepareStaticPaperGasForCandidate<T>(draft:PaperDraft,frame:PaperOpenFrame,deps:{
 sample:(draft:PaperDraft,frame:PaperOpenFrame)=>Promise<unknown>;
 verify:(report:unknown)=>Promise<unknown>;
 importEvidence:(report:unknown,attestation:unknown)=>Promise<{created:boolean;reportHash:string}>;
 rebuild:()=>Promise<T>;
 isPrepared:(value:T)=>boolean;
 sourceOf:(value:T)=>PaperOpenFrame['source']|null;
 unavailableReasonOf?:(value:T)=>string|null;
 now?:()=>number;
}):Promise<StaticPaperGasPreparationResult<T>>{
 const now=deps.now??Date.now,sourceAge=()=>now()-frame.source.timestamp*1000;
 const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
 if(!Number.isSafeInteger(frame.source.timestamp)||sourceAge()<0||sourceAge()>180_000)
  return {status:'unavailable',reason:'paper_cost_preparation_source_expired'};
 let initial:T;
 try{initial=await deps.rebuild();}catch{return {status:'unavailable',reason:'paper_cost_preparation_rebuild_failed'};}
 const initialSource=deps.sourceOf(initial);
 if(!initialSource){
  const reason=deps.unavailableReasonOf?.(initial);
  if(reason)return {status:'unavailable',reason,value:initial};
 }
 if(!initialSource||initialSource.block!==frame.source.block||!same(initialSource.hash,frame.source.hash)||
  initialSource.timestamp!==frame.source.timestamp)
  return {status:'unavailable',reason:'paper_cost_initial_preview_source_mismatch',value:initial};
 if(deps.isPrepared(initial)){
  if(sourceAge()<0||sourceAge()>180_000)
   return {status:'unavailable',reason:'paper_cost_preparation_source_expired',value:initial};
  return {status:'available',value:initial};
 }
 let rawReport:unknown;
 try{rawReport=await deps.sample(draft,frame);}catch{return {status:'unavailable',reason:'paper_cost_sampling_failed',value:initial};}
 if(!rawReport||typeof rawReport!=='object'||Array.isArray(rawReport))
  return {status:'unavailable',reason:'paper_cost_sample_result_invalid',value:initial};
 const report=rawReport as GasReport;
 if(typeof report.reportHash!=='string'||!/^[0-9a-f]{64}$/.test(report.reportHash)||
  !report.source||typeof report.source.block!=='string'||!/^(0|[1-9][0-9]*)$/.test(report.source.block)||
  typeof report.source.hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(report.source.hash)||
  !Number.isSafeInteger(report.source.timestamp)||typeof report.sampledAt!=='string'||
  !Number.isFinite(Date.parse(report.sampledAt))||
  report.campaignId!==draft.id||report.revision!==draft.revision||report.configHash!==draft.configHash||
  report.profileHash!==draft.profileHash||report.profileHash!==contentHash(draft.profile)||
  report.source?.block!==frame.source.block||!same(report.source.hash,frame.source.hash)||
  report.source.timestamp!==frame.source.timestamp)
  return {status:'unavailable',reason:'paper_cost_sample_identity_mismatch',value:initial};
 if(sourceAge()<0||sourceAge()>180_000)
  return {status:'unavailable',reason:'paper_cost_preparation_source_expired',value:initial};
 let rawAttestation:unknown;
 try{rawAttestation=await deps.verify(rawReport);}catch{return {status:'unavailable',reason:'paper_cost_sample_replay_unverified',value:initial};}
 if(!rawAttestation||typeof rawAttestation!=='object'||Array.isArray(rawAttestation))
  return {status:'unavailable',reason:'paper_cost_sample_attestation_invalid',value:initial};
 const attestation=rawAttestation as GasAttestation;
 if(typeof attestation.reportHash!=='string'||typeof attestation.sourceHash!=='string'||
  !/^0x[0-9a-f]{64}$/i.test(attestation.sourceHash)||typeof attestation.profileHash!=='string'||
  typeof attestation.verifiedAt!=='string'||attestation.reportHash!==report.reportHash||
  !same(attestation.sourceHash,frame.source.hash)||attestation.profileHash!==draft.profileHash||
  !Number.isFinite(Date.parse(attestation.verifiedAt)))
  return {status:'unavailable',reason:'paper_cost_sample_attestation_mismatch',value:initial};
 if(sourceAge()<0||sourceAge()>180_000)
  return {status:'unavailable',reason:'paper_cost_preparation_source_expired',value:initial};
 let imported:{created:boolean;reportHash:string};
 try{imported=await deps.importEvidence(rawReport,rawAttestation);}catch{
  return {status:'unavailable',reason:'paper_cost_sample_import_failed',value:initial};
 }
 if(imported.reportHash!==report.reportHash)
  return {status:'unavailable',reason:'paper_cost_sample_import_identity_mismatch',value:initial};
 if(sourceAge()<0||sourceAge()>180_000)
  return {status:'unavailable',reason:'paper_cost_preparation_source_expired',value:initial};
 let rebuilt:T;
 try{rebuilt=await deps.rebuild();}catch{return {status:'unavailable',reason:'paper_cost_prepared_preview_rebuild_failed',value:initial};}
 const rebuiltSource=deps.sourceOf(rebuilt);
 if(!rebuiltSource){
  const reason=deps.unavailableReasonOf?.(rebuilt);
  if(reason)return {status:'unavailable',reason,value:rebuilt};
 }
 if(!rebuiltSource||rebuiltSource.block!==frame.source.block||!same(rebuiltSource.hash,frame.source.hash)||
  rebuiltSource.timestamp!==frame.source.timestamp)
  return {status:'unavailable',reason:'paper_cost_prepared_preview_source_mismatch',value:rebuilt};
 if(!deps.isPrepared(rebuilt))return {status:'unavailable',reason:'paper_cost_prepared_preview_unavailable',value:rebuilt};
 if(sourceAge()<0||sourceAge()>180_000)
  return {status:'unavailable',reason:'paper_cost_preparation_source_expired',value:rebuilt};
 return {status:'available',value:rebuilt,reportHash:report.reportHash,imported:imported.created};
}
