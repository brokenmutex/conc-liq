import type {RobinhoodClient} from '../client.js';
import type {RangeKeeperPaperOpenModel} from './rangekeeper-paper-open-model.js';
import {loadRuntimeIdentity} from '../runtime/identity.js';
import {prepareRangeKeeperPaperOpenRuntime} from './rangekeeper-paper-open-runtime.js';
import type {RangeKeeperPaperOpenRuntimeTiming} from './rangekeeper-paper-open-runtime.js';
import {simulateRangeKeeperPaperConfirmationOnOwnedFork,
 verifyRangeKeeperPaperOwnedForkConfirmationEvidence,type RangeKeeperPaperOwnedForkConfirmationEvidence,
 type RangeKeeperPaperConfirmationCandidateBinding,prepareRangeKeeperPaperConfirmationFork,
 discardRangeKeeperPaperConfirmationFork,type RangeKeeperPaperPreparedForkCapability}
 from './rangekeeper-paper-confirmation-simulation.js';
import type {RangeKeeperPaperConfirmationSimulation} from './rangekeeper-paper-confirmation.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {RangeKeeperPaperPinnedQuoteCache} from './rangekeeper-paper-pinned-quote-cache.js';
import type {DeploymentStore} from './store.js';
import type {RangeKeeperPaperGasStageSample} from './rangekeeper-paper-gas-evidence.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft} from './rangekeeper-paper-open-model.js';
import {rangeKeeperPaperSizeBand} from './rangekeeper-paper-cost.js';
import type {ForkReadDiagnostics,ForkReadHint} from '../paper/fork.js';

type Simulation=RangeKeeperPaperConfirmationSimulation&{
 ownedForkEvidence:RangeKeeperPaperOwnedForkConfirmationEvidence};
type PreparedForkOutcome={ok:true;handle?:RangeKeeperPaperPreparedForkCapability}|{ok:false;error:unknown};

/** Convert only the already-verified owned-fork result into gas-report stage
 * rows. This conversion returns data, never a confirmation capability. */
export function rangeKeeperPaperConfirmationEvidenceSamples(
 evidence:RangeKeeperPaperOwnedForkConfirmationEvidence):readonly RangeKeeperPaperGasStageSample[]{
 if(evidence.kind!=='rangekeeper_paper_owned_fork_confirmation_simulation_v1'||evidence.status!=='success'||
  evidence.stages.length<8||evidence.stages.length>10)
  throw Error('rangekeeper_confirmation_owned_fork_samples_unavailable');
 return evidence.stages.map(stage=>{
  if(!/^0x[0-9a-fA-F]{40}$/.test(stage.to)||!/^0x(?:[0-9a-fA-F]{2})+$/.test(stage.calldata)||
   !/^0x(?:[0-9a-fA-F]{2})*$/.test(stage.returnData)||!/^0x[0-9a-fA-F]{64}$/.test(stage.localTransactionHash)||
   !/^[1-9][0-9]*$/.test(stage.gasUsed)||!/^[1-9][0-9]*$/.test(stage.effectiveGasPriceWei)||
   !/^[a-f0-9]{64}$/.test(stage.stateOverrideHash))
   throw Error('rangekeeper_confirmation_owned_fork_stage_invalid');
  return {action:stage.stage,to:stage.to,calldata:stage.calldata,returnData:stage.returnData,
   localHash:stage.localTransactionHash,localGasUsed:stage.gasUsed,
   localEffectiveGasPriceWei:stage.effectiveGasPriceWei,sourceBlock:evidence.source.block,
   sourceHash:evidence.source.hash,estimate:stage.estimate,stateOverrideHash:stage.stateOverrideHash,
   stateOverrides:stage.stateOverrides};
 });
}

/** Prepares the second-frame gas evidence and owned-fork confirmation replay
 * from one real execution sequence. The simulation is only surfaced from the
 * branded production runner; the ordinary gas report registration/replay path
 * in the open runtime remains unchanged. */
export async function prepareRangeKeeperPaperConfirmationRuntime(input:{store:DeploymentStore;
 client:RobinhoodClient;campaignId:string;frame:PaperOpenFrame;
 pinnedQuoteCache:RangeKeeperPaperPinnedQuoteCache;rpcUrl:string;beforeRead:()=>Promise<void>;
 maxRequests?:number;timeoutMs?:number;now?:number;onPhaseTiming?:RangeKeeperPaperOpenRuntimeTiming
 prefetchHints?:readonly ForkReadHint[];onReadHints?:(hints:readonly ForkReadHint[])=>void;
 onReadDiagnostics?:(diagnostics:ForkReadDiagnostics)=>void
}):Promise<{model:RangeKeeperPaperOpenModel;simulation?:Simulation}>{
 let simulation:Simulation|undefined;
 let preparedForkPromise:Promise<PreparedForkOutcome>=Promise.resolve({ok:true});
 if(input.prefetchHints?.length){
  try{
   const draft=await input.store.paperDraft(input.campaignId) as RangeKeeperPaperDraft,
    runtime=loadRuntimeIdentity(),policy=resolveRangeKeeperPaperPolicy(draft,runtime?.buildId??'');
   if(runtime&&policy.policy&&!policy.unavailable.length&&draft.id===input.campaignId){
    const started=Date.now();
    preparedForkPromise=prepareRangeKeeperPaperConfirmationFork({profile:draft.profile,frame:input.frame,
     configHash:draft.configHash,allocation:draft.allocation,limits:policy.policy.limits,
     rpcUrl:input.rpcUrl,beforeRead:input.beforeRead,maxRequests:input.maxRequests,timeoutMs:input.timeoutMs,
     prefetchHints:input.prefetchHints,onReadHints:input.onReadHints})
     .then(handle=>({ok:true as const,handle}),error=>({ok:false as const,error}));
    // Ignore diagnostic failures; the prepared fork itself remains optional.
     void preparedForkPromise.then(()=>{try{input.onPhaseTiming?.('prepared_fork_open',Date.now()-started);}catch{}});
   }
  }catch(error){preparedForkPromise=Promise.resolve({ok:false,error});}
 }
 let primaryError=false;
 try{
 const model=await prepareRangeKeeperPaperOpenRuntime({store:input.store,client:input.client,
  campaignId:input.campaignId,frame:input.frame,pinnedQuoteCache:input.pinnedQuoteCache,now:input.now,
  readGasProfiles:query=>input.store.rangeKeeperPaperGasProfiles(query.poolAddress,query.pathVersion,
   query.sizeBand),
  onPhaseTiming:input.onPhaseTiming,
  sampleOwnedFork:async(request,limits,initialBalances)=>{
   const draft=await input.store.paperDraft(input.campaignId) as RangeKeeperPaperDraft,
    runtime=loadRuntimeIdentity(),policy=resolveRangeKeeperPaperPolicy(draft,runtime?.buildId??'');
   if(!policy.policy||policy.unavailable.length)throw Error('rangekeeper_confirmation_fork_policy_unavailable');
   if(draft.id!==input.campaignId||draft.revision<1||draft.profileHash!==request.scope.profileHash||
    !runtime||policy.policy.buildId!==runtime.buildId)
    throw Error('rangekeeper_confirmation_fork_context_changed');
   const probe:RangeKeeperPaperConfirmationCandidateBinding={status:'candidate',campaignId:draft.id,revision:draft.revision,
    source:request.frame.source,
    candidate:request.candidate,candidateHash:request.candidateHash,scope:request.scope,
    pathVersion:request.pathVersion,sizeBand:rangeKeeperPaperSizeBand(request.pathVersion,request.scope),
    actionAvailable:false};
   const prepared=await preparedForkPromise;
   if(!prepared.ok)throw prepared.error;
   const result=await simulateRangeKeeperPaperConfirmationOnOwnedFork({probe,
    profile:draft.profile,frame:request.frame,configHash:draft.configHash,
    initialBalances,limits:policy.policy.limits,allocation:draft.allocation,rpcUrl:input.rpcUrl,
    beforeRead:input.beforeRead,maxRequests:input.maxRequests,timeoutMs:input.timeoutMs,
    prefetchHints:input.prefetchHints,onReadHints:input.onReadHints,
    onReadDiagnostics:input.onReadDiagnostics,preparedFork:prepared.handle});
   const evidence=verifyRangeKeeperPaperOwnedForkConfirmationEvidence(result.ownedForkEvidence,{
    campaignId:draft.id,revision:draft.revision,configHash:draft.configHash,
    profileHash:draft.profileHash,source:request.frame.source,
    referenceProofHash:request.candidateReferenceProofHash,candidate:request.candidate,
    candidateHash:request.candidateHash,simulationHash:result.simulationHash});
   simulation=result;
   return rangeKeeperPaperConfirmationEvidenceSamples(evidence);
  }});
 return simulation?{model,simulation}:{model};
 }catch(error){primaryError=true;throw error;
 }finally{
  const prepared=await preparedForkPromise;
  if(prepared.ok&&prepared.handle){
   try{await discardRangeKeeperPaperConfirmationFork(prepared.handle);}
   catch(error){if(!primaryError)throw error;}
  }
 }
}
