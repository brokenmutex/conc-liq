import {randomUUID} from 'node:crypto';
import {contentHash,staticManualParameters} from './contracts.js';
import type {PaperOpenFrame,PaperDraft} from './paper-preview.js';
import {buildStaticPaperSetupPreflight,type PaperSetupPreflightInput, type PaperSetupProfile} from './paper-setup-preflight.js';
import {prepareStaticPaperGasForCandidate} from './static-paper-gas-preparation.js';

type SetupResult={status?:string;source?:PaperOpenFrame['source']|null;profile?:unknown;profileHash?:string;
 range?:unknown;requirements?:{token0Raw:string;token1Raw:string}|null;costs?:{status?:string;reason?:string};
 missing?:string[];[key:string]:unknown};

/** Creates the setup review from one server-selected current source. If the
 * current candidate has no complete exact-scope gas rows, it samples and
 * imports provisional six-stage fork evidence, then rebuilds at that same
 * confirmed source. No campaign, draft, preview or operation is created. */
export async function prepareStaticPaperSetup(input:PaperSetupPreflightInput,deps:{
 runPreflight:(input:PaperSetupPreflightInput,pinnedSource?:PaperOpenFrame['source'])=>Promise<unknown>;
 loadProfile:(id:string)=>Promise<PaperSetupProfile|null>;
 readFrame:(profile:PaperSetupProfile['profile'],source?:PaperOpenFrame['source'])=>Promise<PaperOpenFrame>;
 forkRpcUrl:string|null;
 sample:(draft:PaperDraft,frame:PaperOpenFrame)=>Promise<unknown>;
 verify:(report:unknown)=>Promise<unknown>;
 importEvidence:(report:unknown,attestation:unknown)=>Promise<{created:boolean;reportHash:string}>;
}):Promise<unknown>{
 let initialRaw:unknown;
 try{initialRaw=await deps.runPreflight(input);}catch{return {status:'unavailable',kind:'paper_setup_preflight',
  mode:'paper',strategyId:'static_manual_v1',profileId:input.profileId,
  input:{capitalQuoteRaw:input.capitalQuoteRaw,halfWidthTicks:input.halfWidthTicks,...(input.limits?{limits:input.limits}:{})},
  source:null,costs:{status:'unavailable',reason:'fresh_setup_preflight_unavailable'},
  missing:['fresh_setup_preflight_unavailable'],actionAvailable:false,draftCreated:false,operationCreated:false};}
 const initial=initialRaw as SetupResult;
 if(initial.costs?.status==='provisional')return initial;
 if(initial.costs?.reason!=='complete_fresh_stage_costs_unavailable')return initial;
 if(!input.limits)return withUnavailable(initial,'static_manual_limits_required_for_cost_preparation');
 if(!deps.forkRpcUrl)return withUnavailable(initial,'paper_cost_preparation_fork_rpc_unavailable');
 if(!initial.source||!initial.requirements||!initial.profileHash||!initial.profile)
  return withUnavailable(initial,'setup_candidate_unavailable_for_cost_preparation');
 let registered:PaperSetupProfile|null;
 try{registered=await deps.loadProfile(input.profileId);}catch{return withUnavailable(initial,'registered_market_profile_unavailable');}
 let registeredHash:string|null=null;
 try{if(registered)registeredHash=contentHash(registered.profile);}catch{}
 if(!registered||registered.id!==input.profileId||registered.profileHash!==initial.profileHash||
  registeredHash!==registered.profileHash)
  return withUnavailable(initial,'registered_market_profile_integrity');
 let frame:PaperOpenFrame;
 try{frame=await deps.readFrame(registered.profile,initial.source);}catch{return withUnavailable(initial,'pinned_setup_source_unavailable');}
 if(frame.source.block!==initial.source.block||frame.source.hash.toLowerCase()!==initial.source.hash.toLowerCase()||
  frame.source.timestamp!==initial.source.timestamp)
  return withUnavailable(initial,'pinned_setup_source_changed');
 const config=staticManualParameters.safeParse({halfWidthTicks:input.halfWidthTicks,limits:input.limits});
 if(!config.success)return withUnavailable(initial,'static_manual_limits_invalid');
 const allocation={token0Raw:initial.requirements.token0Raw,token1Raw:initial.requirements.token1Raw,
  nativeWei:input.limits.exitReserveWei};
 let draft:PaperDraft;
 try{
  const strategyId='static_manual_v1' as const,strategyVersion='1.0.0' as const,stateSchemaVersion=1 as const,
   configHash=contentHash({...config.data,strategyId,strategyVersion,stateSchemaVersion});
  draft={id:randomUUID(),revision:1,profile:registered.profile,profileHash:registered.profileHash,
   configHash,strategyId,strategyVersion,stateSchemaVersion,parameters:config.data,allocation} as unknown as PaperDraft;
 }catch{return withUnavailable(initial,'static_paper_cost_candidate_invalid');}
 const prepared=await prepareStaticPaperGasForCandidate(draft,frame,{
  sample:deps.sample,verify:deps.verify,importEvidence:deps.importEvidence,
  rebuild:()=>deps.runPreflight(input,frame.source),
  isPrepared:value=>(value as SetupResult)?.status==='available'&&
   (value as SetupResult)?.costs?.status==='provisional',
  sourceOf:value=>(value as SetupResult)?.source??null,
 });
 if(prepared.status==='available')return prepared.value;
 const result=prepared.value??initial;
 return withUnavailable(result,prepared.reason);
}

function withUnavailable(raw:unknown,reason:string){
 const value=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 return {...value,status:'unavailable',costs:{status:'unavailable',reason},
  missing:[reason],actionAvailable:false,draftCreated:false,operationCreated:false,
  limitations:Array.isArray(value.limitations)?value.limitations:[]};
}
