import assert from 'node:assert/strict';
import type {RobinhoodClient} from '../client.js';
import {loadRuntimeIdentity} from '../runtime/identity.js';
import {contentHash} from './contracts.js';
import type {RangeKeeperLimits,RangeKeeperCandidate} from '../strategy/rangekeeper/domain.js';
import type {RangeKeeperPaperGasProbeRequest,RangeKeeperPaperGasStageSample}
 from './rangekeeper-paper-gas-evidence.js';
import {produceRangeKeeperPaperGasEvidence} from './rangekeeper-paper-gas-evidence.js';
import {buildRangeKeeperPaperOpenModel,resolveRangeKeeperPaperPolicy,
 type RangeKeeperPaperDraft} from './rangekeeper-paper-open-model.js';
import {RangeKeeperPaperPinnedQuoteCache} from './rangekeeper-paper-pinned-quote-cache.js';
import {readCanonicalPaperOpenFrame,type PaperOpenFrame} from './paper-preview.js';
import {parseRangeKeeperPaperCandidate} from './rangekeeper-paper-persistence.js';
import {rangeKeeperPaperCandidateHash,selectRangeKeeperPaperCostProfiles,
 type RangeKeeperPaperCandidateScope, type RangeKeeperPaperGasProfileReader}
 from './rangekeeper-paper-cost.js';
import type {DeploymentStore} from './store.js';

type OwnedFork=(request:RangeKeeperPaperGasProbeRequest,limits:RangeKeeperLimits,
 initialBalances:readonly [bigint,bigint])=>Promise<readonly RangeKeeperPaperGasStageSample[]>;
export type RangeKeeperPaperOpenRuntimePhase='frame_read'|'gas_read'|'candidate_build'|'prepared_fork_open'|
 'owned_fork_sample'|'gas_evidence_prepare'|'registration'|'initial_model_finalize'|'fresh_gas_read'|'fresh_rebuild';
export type RangeKeeperPaperOpenRuntimeTiming=(phase:RangeKeeperPaperOpenRuntimePhase,durationMs:number)=>void;
const jsonSafe=(value:unknown)=>JSON.parse(JSON.stringify(value,(_key,item)=>
 typeof item==='bigint'?String(item):item));

/** Canonical first-observation runtime. If the exact candidate scope lacks
 * fresh provisional profiles, it samples an owned fork, verifies a replay
 * from the same saved draft/source, appends the profile sequence, then builds
 * the model again against those newly persisted profiles. */
export async function prepareRangeKeeperPaperOpenRuntime(input:{store:DeploymentStore;
 client:RobinhoodClient;campaignId:string;sampleOwnedFork:OwnedFork;
 readGasProfiles:RangeKeeperPaperGasProfileReader;frame?:PaperOpenFrame;now?:number;
 pinnedQuoteCache?:RangeKeeperPaperPinnedQuoteCache;onPhaseTiming?:RangeKeeperPaperOpenRuntimeTiming}){
 const phaseTiming=(phase:RangeKeeperPaperOpenRuntimePhase,durationMs:number)=>{
  try{input.onPhaseTiming?.(phase,Math.max(0,durationMs));}catch{/* Diagnostics cannot gate preparation. */}
 };
 const draft=await input.store.paperDraft(input.campaignId) as RangeKeeperPaperDraft;
 if(draft.id!==input.campaignId||draft.strategyId!=='rangekeeper_v1')
  throw Error('rangekeeper_paper_open_runtime_draft_unavailable');
 const runtime=loadRuntimeIdentity();
 if(!runtime)throw Error('rangekeeper_runtime_identity_unavailable');
 const policy=resolveRangeKeeperPaperPolicy(draft,runtime.buildId);
 if(!policy.policy||policy.unavailable.length)
  throw Error('rangekeeper_paper_open_runtime_policy_unavailable');
 const frameStarted=Date.now(),frame=input.frame??await readCanonicalPaperOpenFrame(input.client,draft.profile);
 if(!input.frame)phaseTiming('frame_read',Date.now()-frameStarted);
 const gasStarted=Date.now(),gasPrice=await input.client.getGasPrice();
 phaseTiming('gas_read',Date.now()-gasStarted);
 const observedAt=input.now??Date.now(),
  pinnedQuoteCache=input.pinnedQuoteCache??new RangeKeeperPaperPinnedQuoteCache(input.client,draft.profile);
 if(!pinnedQuoteCache.matches(input.client,draft.profile))
  throw Error('rangekeeper_paper_open_runtime_quote_cache_context_mismatch');
 if(gasPrice<=0n)throw Error('rangekeeper_paper_open_runtime_gas_price_unavailable');
 let samplingAttempted=false;
 const buildModel=(at:number,price:bigint,onCandidate?:Parameters<typeof buildRangeKeeperPaperOpenModel>[0]['onCandidate'])=>
  buildRangeKeeperPaperOpenModel({client:input.client,draft,frame,
  buildId:runtime.buildId,marketGasPriceWei:price,marketGasPriceObservedAt:at,
  now:at,readGasProfiles:input.readGasProfiles,pinnedQuoteCache,onCandidate});
 const initialStarted=Date.now();
 const model=await buildModel(observedAt,gasPrice,async probe=>{
   phaseTiming('candidate_build',Date.now()-initialStarted);
   const rows=await input.readGasProfiles({poolAddress:draft.profile.pool.pool,
    pathVersion:probe.pathVersion,sizeBand:probe.sizeBand});
   const prior=selectRangeKeeperPaperCostProfiles({candidate:probe.candidate,scope:probe.scope,
    source:frame.source,rows,now:observedAt});
   if(prior.status==='available')return;
   if(samplingAttempted)return;
   samplingAttempted=true;
   const evidenceStarted=Date.now();
   const report=await produceRangeKeeperPaperGasEvidence({kind:'open',campaignId:draft.id,
    revision:draft.revision,configHash:draft.configHash,buildId:runtime.buildId,
    profile:draft.profile,frame,candidateSource:frame.source,
    candidateReferenceProofHash:frame.referenceProofHash,candidate:probe.candidate,
    openMarkId:null,openModelHash:null,scope:probe.scope,marketGasPriceWei:gasPrice,
    sampleOwnedFork:async request=>{
     const started=Date.now();
     try{return await input.sampleOwnedFork(request,policy.policy!.limits,
      [BigInt(draft.allocation.token0Raw),BigInt(draft.allocation.token1Raw)]);}
     finally{phaseTiming('owned_fork_sample',Date.now()-started);}
    }});
   phaseTiming('gas_evidence_prepare',Date.now()-evidenceStarted);
   const registrationStarted=Date.now();
   try{await input.store.registerRangeKeeperPaperGasEvidence({report,client:input.client,
    replayPersistedContext:async({report:verified,frame:verifiedFrame})=>{
     const reportCandidate=parseRangeKeeperPaperCandidate(verified.candidate),
      source=verified.candidateSource;
     const capture:{value:{candidate:RangeKeeperCandidate;scope:RangeKeeperPaperCandidateScope;
      pathVersion:string;sizeBand:string}|null}={value:null};
     const replayGasPrice=BigInt(verified.marketGasPriceWei),replayNow=Date.parse(verified.sampledAt);
     await buildRangeKeeperPaperOpenModel({client:input.client,draft,frame:verifiedFrame,
      buildId:runtime.buildId,marketGasPriceWei:replayGasPrice,
      marketGasPriceObservedAt:replayNow,now:replayNow,gasProfiles:[],pinnedQuoteCache,
      readGasProfiles:async()=>[],onCandidate:async value=>{capture.value=value;}});
     const discovered=capture.value;
     if(!discovered)throw Error('rangekeeper_paper_open_gas_replay_candidate_unavailable');
     const candidateHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,
      revision:draft.revision,profileHash:draft.profileHash,configHash:draft.configHash,
      source,referenceProofHash:verified.candidateReferenceProofHash,candidate:discovered.candidate});
     assert.equal(candidateHash,verified.candidateHash);
     assert.equal(contentHash(jsonSafe(discovered.candidate)),contentHash(jsonSafe(reportCandidate)));
     assert.equal(contentHash(jsonSafe(discovered.scope)),contentHash(verified.scope));
     assert.equal(discovered.pathVersion,verified.pathVersion);
     assert.equal(discovered.sizeBand,verified.sizeBand);
     return {replayHash:contentHash(jsonSafe({campaignId:draft.id,revision:draft.revision,
      source:verifiedFrame.source,candidateHash,scope:discovered.scope,
      profileHash:draft.profileHash,configHash:draft.configHash}))};
    }});}finally{phaseTiming('registration',Date.now()-registrationStarted);}
  });
 if(!samplingAttempted){phaseTiming('initial_model_finalize',Date.now()-initialStarted);return model;}
 phaseTiming('initial_model_finalize',Date.now()-initialStarted);
 // A fork sample may take minutes. Rebuild from the exact same pinned frame
 // with a fresh wall clock and gas price so stale references/costs cannot be
 // made eligible by the earlier observation time.
 const freshGasStarted=Date.now(),refreshedGasPrice=await input.client.getGasPrice(),refreshedAt=Date.now();
 phaseTiming('fresh_gas_read',Date.now()-freshGasStarted);
 if(refreshedGasPrice<=0n)throw Error('rangekeeper_paper_open_runtime_gas_price_unavailable');
 const rebuildStarted=Date.now();
 try{return await buildModel(refreshedAt,refreshedGasPrice);}
 finally{phaseTiming('fresh_rebuild',Date.now()-rebuildStarted);}
}
