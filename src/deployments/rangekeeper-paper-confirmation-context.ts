import {z} from 'zod';
import type {RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {contentHash,allocationSchema,parseStrategyParameters} from './contracts.js';
import {marketProfileSchema,referenceProofHash} from './market-profile.js';
import {replayPaperMint} from '../v3/position-math.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft,
 type RangeKeeperPaperOpenModel} from './rangekeeper-paper-open-model.js';
import {rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,rangeKeeperPaperSizeBand,
 selectRangeKeeperPaperCostProfiles,modelRangeKeeperPaperCosts,
 type RangeKeeperPaperGasProfileReader,type RangeKeeperPaperModeledCosts,
 type RangeKeeperPaperCandidateScope} from './rangekeeper-paper-cost.js';
import {parseRangeKeeperPaperCandidate,parseRangeKeeperPaperState,
 validateRangeKeeperPaperConfirmationEnvelope} from './rangekeeper-paper-persistence.js';
import type {RangeKeeperPaperConfirmationEnvelope} from './rangekeeper-paper-confirmation.js';
import type {PaperGasProfileRow} from './paper-cost.js';

const hash64=z.string().regex(/^[0-9a-f]{64}$/);
const runtimeSchema=z.object({buildId:z.string().regex(/^[a-f0-9]{64}$/),
 configHash:z.string().regex(/^[a-f0-9]{64}$/),nodeVersion:z.string().min(1)}).strict();
const draftSchema=z.object({id:z.uuid(),revision:z.number().int().positive(),
 allocation:allocationSchema,profile:marketProfileSchema,profileHash:hash64,configHash:hash64,
 strategyId:z.literal('rangekeeper_v1'),parameters:z.record(z.string(),z.unknown())}).strict();
const snapshotSchema=z.object({schemaVersion:z.literal(1),
 kind:z.literal('rangekeeper_paper_confirmation_context_v1'),campaignId:z.uuid(),revision:z.number().int().positive(),
 mode:z.literal('paper'),lifecycle:z.enum(['draft','active']),runtimeIdentity:runtimeSchema,
 draft:draftSchema,openModel:z.record(z.string(),z.unknown()),openModelHash:hash64,
 envelope:z.unknown(),snapshotHash:hash64}).strict();

export type RangeKeeperPaperConfirmationContextReader=(campaignId:string)=>Promise<unknown>;
export interface RangeKeeperPaperConfirmedContext {
 status:'available';campaignId:string;revision:number;draft:RangeKeeperPaperDraft;
 openModel:RangeKeeperPaperOpenModel;envelope:RangeKeeperPaperConfirmationEnvelope;
 candidate:ReturnType<typeof parseRangeKeeperPaperCandidate>;state:RangeKeeperState;
 costs:RangeKeeperPaperModeledCosts;scope:RangeKeeperPaperCandidateScope;
 inventory:{kind:'modeled_after_confirmation';position:{tickLower:number;tickUpper:number;liquidity:string};
  idle:{token0:string;token1:string}};
 evidence:{gas:'fork_estimated_provisional';simulation:'caller_supplied_unverified';
  openingBooked:false;actionAvailable:false};snapshotHash:string;
}
export interface RangeKeeperPaperConfirmationContextUnavailable {
 status:'unavailable';reason:string;campaignId:string;actionAvailable:false;
}
export type RangeKeeperPaperConfirmationContext=RangeKeeperPaperConfirmedContext|
 RangeKeeperPaperConfirmationContextUnavailable;

const unavailable=(campaignId:string,reason:string):RangeKeeperPaperConfirmationContextUnavailable=>
 ({status:'unavailable',reason,campaignId,actionAvailable:false});

/** Consumes only the immutable campaign snapshot. It replays the selected
 * candidate and cost profiles after restart; it never enables or books an action. */
export async function loadRangeKeeperPaperConfirmationContext(input:{campaignId:string;
 runtimeIdentity:unknown;readSnapshot:RangeKeeperPaperConfirmationContextReader;
 readGasProfiles:RangeKeeperPaperGasProfileReader;now?:number}):Promise<RangeKeeperPaperConfirmationContext>{
 const now=input.now??Date.now(),runtime=runtimeSchema.safeParse(input.runtimeIdentity);
 if(!runtime.success)return unavailable(input.campaignId,'rangekeeper_runtime_identity_unavailable');
 let snapshot:z.infer<typeof snapshotSchema>;
 try{snapshot=snapshotSchema.parse(await input.readSnapshot(input.campaignId));}
 catch{return unavailable(input.campaignId,'rangekeeper_confirmation_snapshot_unavailable');}
 const {snapshotHash,...body}=snapshot;
 if(snapshot.campaignId!==input.campaignId||snapshotHash!==contentHash(body)||
  contentHash(runtime.data)!==contentHash(snapshot.runtimeIdentity)||
  snapshot.revision!==snapshot.draft.revision||snapshot.draft.id!==snapshot.campaignId||
  contentHash(snapshot.draft.profile)!==snapshot.draft.profileHash)
  return unavailable(input.campaignId,'rangekeeper_confirmation_snapshot_identity_invalid');
 const draft=snapshot.draft as RangeKeeperPaperDraft,
  profileConfig={...snapshot.draft.parameters,strategyId:'rangekeeper_v1',
   strategyVersion:'1.0.0',stateSchemaVersion:1};
 if(contentHash(profileConfig)!==snapshot.draft.configHash)
  return unavailable(input.campaignId,'rangekeeper_confirmation_config_hash_invalid');
 try{parseStrategyParameters('rangekeeper_v1',snapshot.draft.parameters);}
 catch{return unavailable(input.campaignId,'rangekeeper_confirmation_config_invalid');}
 const envelope=(()=>{try{return validateRangeKeeperPaperConfirmationEnvelope(snapshot.envelope,
  {campaignId:input.campaignId,revision:snapshot.revision});}catch{return null;}})();
 if(!envelope||envelope.envelopeHash===undefined||snapshot.openModelHash!==contentHash(snapshot.openModel))
  return unavailable(input.campaignId,'rangekeeper_confirmation_envelope_invalid');
 const open=snapshot.openModel as unknown as RangeKeeperPaperOpenModel,
  first=open.source,confirmed=envelope.confirmationObservation,
  confirmationSource=confirmed.source,
  proofHash=(()=>{try{return referenceProofHash(confirmed.reference.proof);}catch{return null;}})();
 if(open.kind!=='rangekeeper_paper_open_model'||open.campaignId!==snapshot.campaignId||
  open.revision!==snapshot.revision||open.status!=='indicative'||open.actionAvailable!==false||
  open.profileHash!==draft.profileHash||open.draftConfigHash!==draft.configHash||
  contentHash(open)!==envelope.firstObservation.modelHash||
  open.candidateHash!==envelope.firstObservation.candidateHash||
  contentHash(first)!==contentHash(envelope.firstObservation.source)||
  proofHash===null||proofHash!==confirmed.reference.proofHash||!open.kernelBuildId||
  open.kernelBuildId!==snapshot.runtimeIdentity.buildId||!open.kernelPolicyHash)
  return unavailable(input.campaignId,'rangekeeper_confirmation_open_identity_invalid');
 if(!confirmed.reference.proof||BigInt(confirmed.reference.price0)<=0n||
  BigInt(confirmed.reference.price1)<=0n||BigInt(confirmed.reference.nativePrice)<=0n||
  BigInt(confirmed.poolState.sqrtPriceX96)<=0n||BigInt(confirmed.poolState.poolLiquidity)<0n||
  !Number.isSafeInteger(confirmationSource.timestamp)||now<confirmationSource.timestamp*1000||
  now-confirmationSource.timestamp*1000>180_000)
  return unavailable(input.campaignId,'rangekeeper_confirmation_source_or_reference_stale');
 const policy=resolveRangeKeeperPaperPolicy(draft,runtime.data.buildId);
 if(!policy.policy||policy.unavailable.length||policy.policy.policyHash!==open.kernelPolicyHash||
  policy.policy.buildId!==open.kernelBuildId)
  return unavailable(input.campaignId,policy.unavailable.join(',')||'rangekeeper_confirmation_policy_invalid');
 const candidate=(()=>{try{return parseRangeKeeperPaperCandidate(confirmed.candidate);}catch{return null;}})();
 if(!candidate)return unavailable(input.campaignId,'rangekeeper_confirmation_candidate_invalid');
 const candidateHash=rangeKeeperPaperCandidateHash({campaignId:input.campaignId,revision:snapshot.revision,
  profileHash:draft.profileHash,configHash:draft.configHash,source:confirmationSource,
  referenceProofHash:confirmed.reference.proofHash,candidate});
 if(candidateHash!==confirmed.candidateHash||candidate.sourceBlock!==BigInt(confirmationSource.block)||
  candidate.sourceHash.toLowerCase()!==confirmationSource.hash.toLowerCase()||
  candidate.range.tickLower>=candidate.range.tickUpper||candidate.liquidity<=0n)
  return unavailable(input.campaignId,'rangekeeper_confirmation_candidate_identity_mismatch');
 const frameSqrt=BigInt(confirmed.poolState.sqrtPriceX96),range=candidate.range;
 let minted:ReturnType<typeof replayPaperMint>;
 try{minted=replayPaperMint(frameSqrt,range,candidate.amount0Desired,candidate.amount1Desired,0n);}
 catch{return unavailable(input.campaignId,'rangekeeper_confirmation_mint_replay_unavailable');}
 if(minted.liquidity!==candidate.liquidity)
  return unavailable(input.campaignId,'rangekeeper_confirmation_mint_replay_mismatch');
 let available0=BigInt(draft.allocation.token0Raw),available1=BigInt(draft.allocation.token1Raw);
 if(candidate.swap){
  if(candidate.swap.token===0){available0-=candidate.swap.amountIn;available1+=candidate.swap.quotedOut;}
  else{available1-=candidate.swap.amountIn;available0+=candidate.swap.quotedOut;}
 }
 const idle0=available0-minted.amount0,idle1=available1-minted.amount1;
 if(idle0<0n||idle1<0n||String(minted.liquidity)!==envelope.inventory.position.liquidity||
  envelope.inventory.position.tickLower!==range.tickLower||envelope.inventory.position.tickUpper!==range.tickUpper||
  envelope.inventory.idle.token0!==String(idle0)||envelope.inventory.idle.token1!==String(idle1))
  return unavailable(input.campaignId,'rangekeeper_confirmation_inventory_replay_mismatch');
 const denominator=BigInt(confirmed.poolState.poolLiquidity)+candidate.liquidity;
 if(denominator<=0n)return unavailable(input.campaignId,'rangekeeper_confirmation_share_unavailable');
 const scope:RangeKeeperPaperCandidateScope={poolAddress:draft.profile.pool.pool,
  profileHash:draft.profileHash,candidateHash,deployedValue:candidate.deployedValue,
  sharePpm:candidate.liquidity*1_000_000n/denominator,range,
  swapKind:candidate.swap?'direct_pool_exact_input':'none'},
  path=rangeKeeperPaperPathVersion(candidate),sizeBand=rangeKeeperPaperSizeBand(path,scope);
 if(envelope.costs.pathVersion!==path||envelope.costs.sizeBand!==sizeBand||
  envelope.selectedGasProfileIds.length===0||!envelope.selectedGasProfileIds.every(id=>
   envelope.costs.profileIds.some(row=>row.id===id)))
  return unavailable(input.campaignId,'rangekeeper_confirmation_cost_scope_mismatch');
 const gasAt=Date.parse(envelope.costs.gasPriceObservedAt),
  gasPrice=BigInt(envelope.costs.marketGasPriceWei);
 if(!Number.isFinite(gasAt)||gasAt>now||now-gasAt>30_000||gasPrice<=0n)
  return unavailable(input.campaignId,'rangekeeper_confirmation_gas_price_stale');
 let rows:readonly PaperGasProfileRow[];
 try{rows=await input.readGasProfiles({poolAddress:draft.profile.pool.pool,pathVersion:path,sizeBand});}
 catch{return unavailable(input.campaignId,'rangekeeper_confirmation_cost_profile_read_failed');}
 const selected=selectRangeKeeperPaperCostProfiles({candidate,scope,source:confirmationSource,rows,now});
 if(selected.status!=='available'||selected.simulationHash!==envelope.decision.gasSequenceHash)
  return unavailable(input.campaignId,selected.status==='available'?
   'rangekeeper_confirmation_cost_sequence_changed':`rangekeeper_confirmation_${selected.reason}`);
 let costs:RangeKeeperPaperModeledCosts;
 try{costs=modelRangeKeeperPaperCosts({profiles:selected,limits:policy.policy.limits,
  nativePrice:BigInt(confirmed.reference.nativePrice),marketGasPriceWei:gasPrice,
  swapFeeAndShortfallValue:candidate.swap?candidate.swap.feeValue+candidate.swap.shortfallValue:0n,
  now:gasAt});}
 catch{return unavailable(input.campaignId,'rangekeeper_confirmation_cost_replay_failed');}
 if(contentHash(costs)!==contentHash(envelope.costs))
  return unavailable(input.campaignId,'rangekeeper_confirmation_cost_replay_mismatch');
 let state:RangeKeeperState;
 try{state=parseRangeKeeperPaperState(envelope.strategyState);}catch{
  return unavailable(input.campaignId,'rangekeeper_confirmation_kernel_state_invalid');}
 if(state.buildId!==runtime.data.buildId||state.configHash.toLowerCase()!==
  `0x${policy.policy.policyHash}`.toLowerCase()||state.lastEligible?.block!==BigInt(confirmationSource.block)||
  state.lastEligible.hash.toLowerCase()!==confirmationSource.hash.toLowerCase()||state.lastEligible.timestamp!==
   confirmationSource.timestamp||state.confirmation!==null||state.exit!==null)
  return unavailable(input.campaignId,'rangekeeper_confirmation_kernel_identity_mismatch');
 return {status:'available',campaignId:input.campaignId,revision:snapshot.revision,draft,
  openModel:open,envelope,candidate,state,costs,scope,
  inventory:{kind:'modeled_after_confirmation',position:{tickLower:range.tickLower,
   tickUpper:range.tickUpper,liquidity:String(candidate.liquidity)},idle:{token0:String(idle0),token1:String(idle1)}},
  evidence:{gas:'fork_estimated_provisional',simulation:'caller_supplied_unverified',
   openingBooked:false,actionAvailable:false},snapshotHash};
}
