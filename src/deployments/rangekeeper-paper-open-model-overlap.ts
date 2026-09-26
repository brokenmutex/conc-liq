import assert from 'node:assert/strict';
import type {RobinhoodClient} from '../client.js';
import type {RangeKeeperCandidate} from '../strategy/rangekeeper/domain.js';
import type {PaperOpenFrame} from './paper-preview.js';
import {contentHash} from './contracts.js';
import type {PaperGasProfileRow} from './paper-cost.js';
import {buildRangeKeeperPaperOpenModel,type RangeKeeperPaperDraft,type RangeKeeperPaperOpenModel,
 resolveRangeKeeperPaperPolicy} from './rangekeeper-paper-open-model.js';
import {modelRangeKeeperPaperCosts,rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,
 rangeKeeperPaperSizeBand,selectRangeKeeperPaperCostProfiles,type RangeKeeperPaperModeledCosts,
 type RangeKeeperPaperCandidateScope} from './rangekeeper-paper-cost.js';
import {verifyRangeKeeperPaperGasReport} from './rangekeeper-paper-gas-evidence.js';
import type {RangeKeeperPaperPinnedQuoteCache} from './rangekeeper-paper-pinned-quote-cache.js';

type Registration={version:number;profileIds:readonly string[];reportHash:string};
type SpeculativeRows=PaperGasProfileRow[];

function candidateFrom(value:RangeKeeperPaperOpenModel['candidate']):RangeKeeperCandidate{
 if(!value)throw Error('rangekeeper_open_model_candidate_unavailable');
 return {kind:value.kind,range:value.range,swap:value.swap?{...value.swap,
  amountIn:BigInt(value.swap.amountIn),quotedOut:BigInt(value.swap.quotedOut),
  minOut:BigInt(value.swap.minOut),priceAfter:BigInt(value.swap.priceAfter),
  feeValue:BigInt(value.swap.feeValue),shortfallValue:BigInt(value.swap.shortfallValue)}:null,
  amount0Desired:BigInt(value.amount0Desired),amount1Desired:BigInt(value.amount1Desired),
  amount0Min:BigInt(value.amount0Min),amount1Min:BigInt(value.amount1Min),
  liquidity:BigInt(value.liquidity),deployedValue:BigInt(value.deployedValue),
  sourceBlock:BigInt(value.sourceBlock),sourceHash:value.sourceHash as `0x${string}`,
  expiresAt:value.expiresAt};
}
function scopedRows(report:ReturnType<typeof verifyRangeKeeperPaperGasReport>):SpeculativeRows{
 const sampledAt=new Date(report.sampledAt);
 return report.stageProfiles.map((stage,index)=>({id:`speculative:${index}:${stage.stage}`,
  version:1,poolAddress:report.scope.poolAddress,pathVersion:report.pathVersion,stage:stage.stage,
  allowanceState:stage.allowanceState,sizeBand:report.sizeBand,component:'gas_units',
  status:'provisional',evidenceClass:'fork_estimated',model:stage.model,sourceHash:stage.sourceHash,
  observedUntil:sampledAt}));
}
function sameCostsExceptProfileIds(a:RangeKeeperPaperModeledCosts,b:RangeKeeperPaperModeledCosts){
 const {profileIds:_a,...bodyA}=a,{profileIds:_b,...bodyB}=b;
 return contentHash(bodyA)===contentHash(bodyB);
}

/** Waits for both unpublished branches before propagating either failure. */
export async function settleRangeKeeperPaperOpenOverlap<T,U>(registration:Promise<T>,
 speculative:Promise<U>):Promise<[T,U]>{
 const results=await Promise.allSettled([registration,speculative] as const);
 const rejected=results.find((result)=>result.status==='rejected');
 if(rejected?.status==='rejected')throw rejected.reason;
 const registered=results[0],modeled=results[1];
 if(registered.status!=='fulfilled'||modeled.status!=='fulfilled')
  throw Error('rangekeeper_open_model_overlap_unsettled');
 return [registered.value,modeled.value];
}
export function assertRangeKeeperPaperOpenCandidateFresh(expiresAtSeconds:number,now=Date.now()){
 if(!Number.isSafeInteger(expiresAtSeconds)||expiresAtSeconds<=0||now>=expiresAtSeconds*1000)
  throw Error('rangekeeper_open_model_overlap_candidate_expired');
}

/** Exact receipt-to-row join used before provisional model costs can be rebound. */
export function assertRangeKeeperPaperOpenReportRows(
 report:ReturnType<typeof verifyRangeKeeperPaperGasReport>,registration:Registration,
 persisted:readonly PaperGasProfileRow[]):PaperGasProfileRow[]{
 if(registration.reportHash!==report.reportHash||registration.version<1||
  registration.profileIds.length!==report.stageProfiles.length||persisted.length>200)
  throw Error('rangekeeper_open_model_overlap_registration_mismatch');
 const byId=new Map(persisted.map(row=>[row.id,row]));
 if(byId.size!==persisted.length)throw Error('rangekeeper_open_model_overlap_duplicate_profile_id');
 const imported:PaperGasProfileRow[]=[];
 for(let i=0;i<report.stageProfiles.length;i++){
  const stage=report.stageProfiles[i]!,id=registration.profileIds[i],row=id?byId.get(id):undefined;
  if(!row||row.version!==registration.version||row.stage!==stage.stage||
   row.poolAddress.toLowerCase()!==report.scope.poolAddress.toLowerCase()||
   row.pathVersion!==report.pathVersion||row.sizeBand!==report.sizeBand||
   row.allowanceState!==stage.allowanceState||row.component!=='gas_units'||
   row.status!=='provisional'||row.evidenceClass!=='fork_estimated'||
   contentHash(row.model)!==contentHash(stage.model)||row.sourceHash!==stage.sourceHash||
   !row.observedUntil||row.observedUntil.getTime()!==Date.parse(report.sampledAt))
   throw Error('rangekeeper_open_model_overlap_persisted_profile_mismatch');
  imported.push(row);
 }
 if(new Set(imported.map(row=>row.version)).size!==1||
  new Set(imported.map(row=>row.stage)).size!==imported.length)
  throw Error('rangekeeper_open_model_overlap_persisted_profile_set_invalid');
 return imported;
}

/** Runs first-observation model planning concurrently with strict report registration.
 * The speculative model is held only in this call. No preview is returned until the
 * registration receipt and every persisted row have been reconciled with the report,
 * after which modeled costs are recomputed from the actual persisted rows and their IDs.
 */
export async function buildRangeKeeperPaperOpenModelWhileRegistering(input:{
 client:RobinhoodClient;draft:RangeKeeperPaperDraft;frame:PaperOpenFrame;buildId:string;
 report:unknown;marketGasPriceWei:bigint;marketGasPriceObservedAt:number;
 pinnedQuoteCache?:RangeKeeperPaperPinnedQuoteCache;
 register:(report:unknown)=>Promise<Registration>;
 readRows:(query:{poolAddress:string;pathVersion:string;sizeBand:string})=>Promise<readonly PaperGasProfileRow[]>;
 onTiming?:(timing:{registrationMs:number;speculativeModelMs:number;parallelWallMs:number})=>void;
 now?:number;
}):Promise<RangeKeeperPaperOpenModel>{
 const now=input.now??Date.now(),report=verifyRangeKeeperPaperGasReport(input.report,now),
  candidate=report.reportKind==='open'?candidateFrom({
   kind:report.candidate.kind,range:report.candidate.range,swap:report.candidate.swap,
   amount0Desired:report.candidate.amount0Desired,amount1Desired:report.candidate.amount1Desired,
   amount0Min:report.candidate.amount0Min,amount1Min:report.candidate.amount1Min,
   liquidity:report.candidate.liquidity,deployedValue:report.candidate.deployedValue,
   sourceBlock:report.candidate.sourceBlock,sourceHash:report.candidate.sourceHash,
   expiresAt:report.candidate.expiresAt}):null;
 if(!candidate||report.campaignId!==input.draft.id||report.revision!==input.draft.revision||
  report.profileHash!==input.draft.profileHash||report.configHash!==input.draft.configHash||
  report.buildId!==input.buildId||report.candidateSource.block!==input.frame.source.block||
  report.candidateSource.hash.toLowerCase()!==input.frame.source.hash.toLowerCase()||
  report.candidateReferenceProofHash!==input.frame.referenceProofHash||
  report.frame.source.block!==input.frame.source.block||
  report.frame.source.hash.toLowerCase()!==input.frame.source.hash.toLowerCase()||
  report.frame.referenceProofHash!==input.frame.referenceProofHash)
  throw Error('rangekeeper_open_model_overlap_report_binding_invalid');
 const scope:RangeKeeperPaperCandidateScope={poolAddress:report.scope.poolAddress,
  profileHash:report.scope.profileHash,candidateHash:report.scope.candidateHash,
  deployedValue:BigInt(report.scope.deployedValue),sharePpm:BigInt(report.scope.sharePpm),
  range:report.scope.range,swapKind:report.scope.swapKind};
 const expectedCandidateHash=rangeKeeperPaperCandidateHash({campaignId:input.draft.id,
  revision:input.draft.revision,profileHash:input.draft.profileHash,configHash:input.draft.configHash,
  source:input.frame.source,referenceProofHash:input.frame.referenceProofHash,candidate});
 if(expectedCandidateHash!==report.candidateHash||
  rangeKeeperPaperSizeBand(report.pathVersion,scope)!==report.sizeBand)
  throw Error('rangekeeper_open_model_overlap_candidate_mismatch');

 const speculativeRows=scopedRows(report);
 const parallelStartedAt=Date.now(),registrationStartedAt=parallelStartedAt,modelStartedAt=parallelStartedAt;
 let registrationFinishedAt=0,modelFinishedAt=0;
 const registrationPromise=input.register(report).then(value=>{
  registrationFinishedAt=Date.now();return value;
 });
 const modelPromise=buildRangeKeeperPaperOpenModel({client:input.client,draft:input.draft,
  frame:input.frame,buildId:input.buildId,gasProfiles:speculativeRows,
  marketGasPriceWei:input.marketGasPriceWei,marketGasPriceObservedAt:input.marketGasPriceObservedAt,
  pinnedQuoteCache:input.pinnedQuoteCache,now}).then(value=>{modelFinishedAt=Date.now();return value;});
 const [registration,speculative]=await settleRangeKeeperPaperOpenOverlap(registrationPromise,modelPromise);
 input.onTiming?.({registrationMs:registrationFinishedAt-registrationStartedAt,
  speculativeModelMs:modelFinishedAt-modelStartedAt,parallelWallMs:Date.now()-parallelStartedAt});
 if(registration.reportHash!==report.reportHash||registration.version<1||
  registration.profileIds.length!==report.stageProfiles.length||
  speculative.status!=='indicative'||speculative.candidateHash!==report.candidateHash||
  !speculative.costs||speculative.decision?.kernelAction!=='confirm')
  throw Error('rangekeeper_open_model_overlap_registration_or_model_unavailable');

 const persisted=await input.readRows({poolAddress:report.scope.poolAddress,
  pathVersion:report.pathVersion,sizeBand:report.sizeBand});
 const imported=assertRangeKeeperPaperOpenReportRows(report,registration,persisted);
 verifyRangeKeeperPaperGasReport(report,Date.now());
 if(!speculative.candidate)throw Error('rangekeeper_open_model_overlap_candidate_unavailable');
 assertRangeKeeperPaperOpenCandidateFresh(Number(speculative.candidate.expiresAt));
 const resolved=resolveRangeKeeperPaperPolicy(input.draft,input.buildId);
 if(!resolved.policy||resolved.unavailable.length)
  throw Error('rangekeeper_open_model_overlap_policy_unavailable');
 const selected=selectRangeKeeperPaperCostProfiles({candidate,scope,source:input.frame.source,
  rows:imported,now});
 if(selected.status!=='available'||selected.simulationHash!==report.sequenceHash)
  throw Error('rangekeeper_open_model_overlap_persisted_cost_profiles_unavailable');
 const persistedCosts=modelRangeKeeperPaperCosts({profiles:selected,limits:resolved.policy.limits,
  nativePrice:input.frame.nativePrice!,marketGasPriceWei:BigInt(speculative.costs.marketGasPriceWei),
  swapFeeAndShortfallValue:candidate.swap?candidate.swap.feeValue+candidate.swap.shortfallValue:0n,
  now:Date.parse(speculative.costs.gasPriceObservedAt)});
 assert(sameCostsExceptProfileIds(speculative.costs,persistedCosts),
  'rangekeeper_open_model_overlap_cost_replay_changed');
 const published={...speculative,costs:persistedCosts,
  execution:{...speculative.execution,modeledOpenCost:persistedCosts.open.expectedValue,
   modeledOpenCostBound:persistedCosts.open.boundValue,
   modeledRetainExitCost:persistedCosts.retainExit.expectedValue,
   modeledExitReserve:persistedCosts.retainExit.requiredReserveWei}};
 return published;
}
