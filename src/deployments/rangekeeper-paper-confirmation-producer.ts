import {contentHash} from './contracts.js';
import type {RangeKeeperCandidate} from '../strategy/rangekeeper/domain.js';
import type {RobinhoodClient} from '../client.js';
import {loadRuntimeIdentity} from '../runtime/identity.js';
import {readCanonicalPaperOpenFrame,type PaperOpenFrame} from './paper-preview.js';
import {verifyCanonicalPaperAnchors} from './paper-canonical-anchors.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft} from './rangekeeper-paper-open-model.js';
import {rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,rangeKeeperPaperSizeBand,
 type RangeKeeperPaperCandidateScope} from './rangekeeper-paper-cost.js';
import {simulateRangeKeeperPaperConfirmationOnOwnedFork} from './rangekeeper-paper-confirmation-simulation.js';
import type {RangeKeeperPaperConfirmationResult}
 from './rangekeeper-paper-confirmation.js';
import type {RangeKeeperPaperConfirmationCandidateBinding} from './rangekeeper-paper-confirmation-simulation.js';
import type {DeploymentStore} from './store.js';

type ConfirmationStore=Pick<DeploymentStore,'paperDraft'|'readRangeKeeperPaperConfirmationEnvelope'>;
type ForkRunner=typeof simulateRangeKeeperPaperConfirmationOnOwnedFork;
type CanonicalFrameReader=(client:RobinhoodClient,profile:RangeKeeperPaperDraft['profile'])=>Promise<PaperOpenFrame>;

export interface RangeKeeperPaperConfirmationProducerDependencies {
 store:ConfirmationStore;client:RobinhoodClient;rpcUrl:string;beforeRead:()=>Promise<void>;
 maxRequests?:number;timeoutMs?:number;
 /** Test seam bound when constructing the service; never taken from an HTTP request. */
 runOwnedFork?:ForkRunner;readCanonicalFrame?:CanonicalFrameReader;
}

export type RangeKeeperPaperConfirmationProducer=(campaignId:string)=>Promise<RangeKeeperPaperConfirmationResult>;

/** Constructs a server-side paper confirmation service. Its returned entrypoint
 * accepts only a campaign ID: it loads the draft and canonical frame itself,
 * replays scoped costs in the store builder, and invokes the owned-fork runner
 * with trusted allocation and policy context. It never accepts stage evidence
 * or a simulation result from the caller. */
export function createRangeKeeperPaperConfirmationProducer(
 dependencies:RangeKeeperPaperConfirmationProducerDependencies):RangeKeeperPaperConfirmationProducer{
 const runFork=dependencies.runOwnedFork??simulateRangeKeeperPaperConfirmationOnOwnedFork,
  readFrame=dependencies.readCanonicalFrame??readCanonicalPaperOpenFrame;
 return async campaignId=>{
  let draft:RangeKeeperPaperDraft;
  try{draft=await dependencies.store.paperDraft(campaignId) as RangeKeeperPaperDraft;}
  catch{return {status:'unavailable',reason:'rangekeeper_confirmation_draft_unavailable',
   campaignId,revision:0,actionAvailable:false};}
  if(draft.id!==campaignId||draft.strategyId!=='rangekeeper_v1')
   return {status:'unavailable',reason:'rangekeeper_confirmation_strategy_unavailable',
    campaignId,revision:draft.revision,actionAvailable:false};
  let runtime;
  try{runtime=loadRuntimeIdentity();}catch{return {status:'unavailable',
   reason:'rangekeeper_runtime_identity_unavailable',campaignId,revision:draft.revision,actionAvailable:false};}
  if(!runtime)return {status:'unavailable',reason:'rangekeeper_runtime_identity_unavailable',
   campaignId,revision:draft.revision,actionAvailable:false};
  let frame:PaperOpenFrame;
  try{frame=await readFrame(dependencies.client,draft.profile);}
  catch{return {status:'unavailable',reason:'rangekeeper_confirmation_canonical_frame_unavailable',
   campaignId,revision:draft.revision,actionAvailable:false};}
  let marketGasPriceWei:bigint|null=null,marketGasPriceObservedAt:number|null=null;
  try{marketGasPriceWei=await dependencies.client.getGasPrice();marketGasPriceObservedAt=Date.now();}
  catch{/* Builder returns an explicit unavailable result when gas price is absent. */}
  const now=Date.now();
  return dependencies.store.readRangeKeeperPaperConfirmationEnvelope({campaignId,frame,
   client:dependencies.client,marketGasPriceWei,marketGasPriceObservedAt,now,
   verifyAnchors:(chainId,sources)=>verifyCanonicalPaperAnchors(dependencies.client,chainId,sources),
   simulate:async(candidate:RangeKeeperCandidate)=>{
    const policy=resolveRangeKeeperPaperPolicy(draft,runtime.buildId);
    if(!policy.policy||policy.unavailable.length)throw new Error('rangekeeper_confirmation_policy_unavailable');
    const candidateHash=rangeKeeperPaperCandidateHash({campaignId,revision:draft.revision,
     profileHash:draft.profileHash,configHash:draft.configHash,source:frame.source,
     referenceProofHash:frame.referenceProofHash,candidate});
    const denominator=frame.poolLiquidity+candidate.liquidity;
    if(denominator<=0n)throw new Error('rangekeeper_confirmation_liquidity_share_unavailable');
    const scope:RangeKeeperPaperCandidateScope={poolAddress:draft.profile.pool.pool,
     profileHash:draft.profileHash,candidateHash,deployedValue:candidate.deployedValue,
     sharePpm:candidate.liquidity*1_000_000n/denominator,range:candidate.range,
     swapKind:candidate.swap?'direct_pool_exact_input':'none'};
    const probe:RangeKeeperPaperConfirmationCandidateBinding={status:'candidate',campaignId,revision:draft.revision,
     source:frame.source,
     candidate,candidateHash,scope,pathVersion:rangeKeeperPaperPathVersion(candidate),
     sizeBand:rangeKeeperPaperSizeBand(rangeKeeperPaperPathVersion(candidate),scope),actionAvailable:false};
    if(contentHash(draft.profile)!==draft.profileHash)throw new Error('rangekeeper_confirmation_profile_hash_invalid');
    return runFork({probe,profile:draft.profile,frame,configHash:draft.configHash,
     initialBalances:[BigInt(draft.allocation.token0Raw),BigInt(draft.allocation.token1Raw)],
     limits:policy.policy.limits,rpcUrl:dependencies.rpcUrl,beforeRead:dependencies.beforeRead,
     maxRequests:dependencies.maxRequests,timeoutMs:dependencies.timeoutMs});
   }});
 };
}
