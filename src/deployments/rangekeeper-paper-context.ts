import {z} from 'zod';
import {principalAmounts} from '../backtest/principal.js';
import type {RangeKeeperCandidate,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {contentHash,allocationSchema} from './contracts.js';
import {marketProfileSchema,referenceProofHash} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';
import {resolveRangeKeeperPaperPolicy,rangeKeeperPaperOpenDecisionHasCandidate,type RangeKeeperPaperDraft,
 type RangeKeeperPaperOpenModel} from './rangekeeper-paper-open-model.js';
import {rangeKeeperPaperCandidateHash} from './rangekeeper-paper-cost.js';
import {rangeKeeperPaperExitInventoryProofHash,
 type RangeKeeperPaperExitKernelContext} from './rangekeeper-paper-exit-model.js';
import type {RangeKeeperPaperGasProfileReader} from './rangekeeper-paper-cost.js';
import {replayPaperMint} from '../v3/position-math.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash64=z.string().regex(/^[0-9a-f]{64}$/);
const sourceSchema=z.object({block:raw,hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 timestamp:z.number().int().nonnegative()}).strict();
const candidateSchema=z.object({kind:z.enum(['entry','recenter']),
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 swap:z.object({token:z.union([z.literal(0),z.literal(1)]),amountIn:raw,quotedOut:raw,minOut:raw,
  priceAfter:raw,feeValue:raw,shortfallValue:raw}).strict().nullable(),
 amount0Desired:raw,amount1Desired:raw,amount0Min:raw,amount1Min:raw,liquidity:raw,
 deployedValue:raw,sourceBlock:raw,sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 expiresAt:z.number().int().nonnegative()}).strict();
const stateSchema=z.object({schemaVersion:z.literal(1),policyId:z.literal('rangekeeper_v1'),
 strategyVersion:z.literal('1.0.0'),configHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 buildId:z.string().regex(/^[a-f0-9]{64}$/),
 lastEligible:z.object({block:raw,hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  timestamp:z.number().int().nonnegative()}).strict().nullable(),
 confirmation:z.object({candidate:candidateSchema,firstBlock:raw,
  firstHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),firstAt:z.number().int().nonnegative()}).strict().nullable(),
 exit:z.object({tokenId:z.string().min(1),tickLower:z.number().int(),tickUpper:z.number().int(),
  block:raw,hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),since:z.number().int().nonnegative(),
  lastOutsideAt:z.number().int().nonnegative()}).strict().nullable()}).strict();
const persistedDraftSchema=z.object({id:z.uuid(),revision:z.number().int().positive(),
 allocation:allocationSchema,profile:marketProfileSchema,profileHash:hash64,configHash:hash64,
 strategyId:z.literal('rangekeeper_v1'),parameters:z.record(z.string(),z.unknown())}).strict();
const persistedMarkSchema=z.object({id:raw,classification:z.enum(['rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1']),
 source:sourceSchema,candidateHash:hash64,epoch:z.number().int().nonnegative().optional(),
 position:z.object({tickLower:z.number().int(),tickUpper:z.number().int(),liquidity:raw}).strict(),
 idle:z.object({token0:raw,token1:raw}).strict()}).strict();
const persistedKernelSchema=z.object({source:sourceSchema,state:stateSchema,
 wallet0:raw,wallet1:raw,released0:raw,released1:raw,nativeWei:raw,
 campaignStartValue:raw,highWaterValue:raw,
 rollingSpentCost:raw,campaignSpentCost:raw,reservedCost:raw,recenters:z.number().int().nonnegative(),
 pending:z.boolean(),entryAllowed:z.boolean(),safeExitRequired:z.boolean(),executionReady:z.boolean()}).strict();
const currentEpochSchema=z.object({epoch:z.number().int().nonnegative(),markId:raw,markHash:hash64,
 source:sourceSchema,candidate:candidateSchema,candidateHash:hash64,
 candidateReferenceProofHash:hash64,
 inventory:z.object({position:z.object({tickLower:z.number().int(),tickUpper:z.number().int(),liquidity:raw}).strict(),
  idle:z.object({token0:raw,token1:raw}).strict()}).strict(),
 kernelSnapshot:persistedKernelSchema,mintSqrtPriceX96:raw,
 fundingBeforeSwap:z.object({token0:raw,token1:raw}).strict(),
 allowancesCleared:z.boolean(),
 reference:z.object({price0:raw,price1:raw,nativePrice:raw,proofHash:hash64,
  proof:z.record(z.string(),z.unknown())}).strict()}).strict();
type RangeKeeperExitContextKernelSnapshot=z.infer<typeof persistedKernelSchema>;
const contextSnapshotSchema=z.object({schemaVersion:z.literal(1),
 kind:z.literal('rangekeeper_paper_persisted_context_v1'),campaignId:z.uuid(),revision:z.number().int().positive(),
 mode:z.literal('paper'),lifecycle:z.enum(['active','paused','closing']),pendingOperationId:z.null(),
 draft:persistedDraftSchema,openMark:z.object({id:raw,classification:z.literal('rangekeeper_paper_open_v1'),modelHash:hash64,
  model:z.record(z.string(),z.unknown())}).strict(),previousMark:persistedMarkSchema,
 currentEpoch:currentEpochSchema,kernel:persistedKernelSchema,
 runtimeIdentity:z.object({buildId:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough().optional(),
 runtimeAdoption:z.object({adoptedFromBuildId:z.string().regex(/^[a-f0-9]{64}$/),
  adoptionHash:hash64,latestMarkHash:hash64,compatibilityProof:z.record(z.string(),z.unknown())}).nullable().optional(),
 snapshotHash:hash64}).strict();

export type RangeKeeperPaperPersistedContextReader=(campaignId:string)=>Promise<unknown>;
export type RangeKeeperPaperPersistedContextUnavailable={status:'unavailable';reason:string;
 campaignId:string;actionAvailable:false};
export interface RangeKeeperPaperLoadedExitContext {
 status:'available';draft:RangeKeeperPaperDraft;openMarkId:string;openModel:RangeKeeperPaperOpenModel;
 currentEpoch:{epoch:number;markId:string;markHash:string;source:PaperOpenFrame['source'];
  candidate:RangeKeeperCandidate;candidateHash:string;candidateReferenceProofHash:string;
  inventory:{position:{tickLower:number;tickUpper:number;liquidity:string};idle:{token0:string;token1:string}};
  kernelSnapshot:RangeKeeperExitContextKernelSnapshot;mintSqrtPriceX96:bigint;
  fundingBeforeSwap:{token0:string;token1:string};
  allowancesCleared:boolean;
  reference:{price0:bigint;price1:bigint;nativePrice:bigint;proofHash:string;proof:Record<string,unknown>}};
 previous:{id:string;source:PaperOpenFrame['source'];candidateHash:string;
  position:{tickLower:number;tickUpper:number;liquidity:string};idle:{token0:string;token1:string}};
 kernel:RangeKeeperPaperExitKernelContext;readGasProfiles:RangeKeeperPaperGasProfileReader;
 snapshotHash:string;actionAvailable:false;
}
export type RangeKeeperPaperExitContextLoad=RangeKeeperPaperLoadedExitContext|
 RangeKeeperPaperPersistedContextUnavailable;

function decimalCandidate(c: z.infer<typeof candidateSchema>):RangeKeeperCandidate{
 return {kind:c.kind,range:c.range,swap:c.swap?{token:c.swap.token,amountIn:BigInt(c.swap.amountIn),
  quotedOut:BigInt(c.swap.quotedOut),minOut:BigInt(c.swap.minOut),priceAfter:BigInt(c.swap.priceAfter),
  feeValue:BigInt(c.swap.feeValue),shortfallValue:BigInt(c.swap.shortfallValue)}:null,
  amount0Desired:BigInt(c.amount0Desired),amount1Desired:BigInt(c.amount1Desired),
  amount0Min:BigInt(c.amount0Min),amount1Min:BigInt(c.amount1Min),liquidity:BigInt(c.liquidity),
  deployedValue:BigInt(c.deployedValue),sourceBlock:BigInt(c.sourceBlock),
  sourceHash:c.sourceHash as `0x${string}`,expiresAt:c.expiresAt};
}

function rangeKeeperState(s:z.infer<typeof stateSchema>):RangeKeeperState{
 return {schemaVersion:s.schemaVersion,policyId:s.policyId,strategyVersion:s.strategyVersion,
  configHash:s.configHash as `0x${string}`,buildId:s.buildId,
  lastEligible:s.lastEligible?{block:BigInt(s.lastEligible.block),hash:s.lastEligible.hash as `0x${string}`,
   timestamp:s.lastEligible.timestamp}:null,
  confirmation:s.confirmation?{candidate:decimalCandidate(s.confirmation.candidate),
   firstBlock:BigInt(s.confirmation.firstBlock),firstHash:s.confirmation.firstHash as `0x${string}`,
   firstAt:s.confirmation.firstAt}:null,
  exit:s.exit?{tokenId:s.exit.tokenId,tickLower:s.exit.tickLower,tickUpper:s.exit.tickUpper,
   block:BigInt(s.exit.block),hash:s.exit.hash as `0x${string}`,since:s.exit.since,
   lastOutsideAt:s.exit.lastOutsideAt}:null};
}

const unavailable=(campaignId:string,reason:string):RangeKeeperPaperPersistedContextUnavailable=>
 ({status:'unavailable',reason,campaignId,actionAvailable:false});

/** Extract only the validated profile and prior source needed to acquire a
 * current canonical frame. Full lifecycle and kernel checks still run in the
 * loader after that frame has been read. */
export function rangeKeeperPaperExitContextSeed(raw:unknown,campaignId:string):{
 profile:RangeKeeperPaperDraft['profile'];openSource:PaperOpenFrame['source'];
 previousSource:PaperOpenFrame['source'];candidateSource:PaperOpenFrame['source']
}|null{
 let parsed:z.infer<typeof contextSnapshotSchema>;
 try{parsed=contextSnapshotSchema.parse(raw);}catch{return null;}
 const {snapshotHash,...body}=parsed;
 if(parsed.campaignId!==campaignId||snapshotHash!==contentHash(body)||
  contentHash(parsed.draft.profile)!==parsed.draft.profileHash)return null;
 const openSource=sourceSchema.safeParse(parsed.openMark.model.source);
 if(!openSource.success)return null;
 return {profile:parsed.draft.profile,openSource:openSource.data,
  previousSource:parsed.previousMark.source,candidateSource:parsed.currentEpoch.source};
}

/** Loads only a trusted persisted RangeKeeper context. `readSnapshot` is an
 * internal store callback, never an HTTP-provided object. It must return a
 * hash-checked open model, latest mark and kernel snapshot with no pending
 * operation, source-pinned to the canonical frame supplied by the caller. */
export async function loadRangeKeeperPaperExitContext(input:{campaignId:string;buildId:string|null;
 frame:PaperOpenFrame;now?:number;readSnapshot:RangeKeeperPaperPersistedContextReader;
 readGasProfiles:RangeKeeperPaperGasProfileReader}):Promise<RangeKeeperPaperExitContextLoad>{
 const now=input.now??Date.now();
 if(!input.buildId)return unavailable(input.campaignId,'rangekeeper_runtime_build_identity_unavailable');
 let parsed:z.infer<typeof contextSnapshotSchema>;
 try{parsed=contextSnapshotSchema.parse(await input.readSnapshot(input.campaignId));}
 catch{return unavailable(input.campaignId,'rangekeeper_persisted_context_unavailable');}
 const {snapshotHash,...body}=parsed;
 if(snapshotHash!==contentHash(body)||parsed.campaignId!==input.campaignId)
  return unavailable(input.campaignId,'rangekeeper_persisted_context_hash_mismatch');
 const currentSource=sourceSchema.safeParse(input.frame.source);
 if(!currentSource.success||!Number.isSafeInteger(currentSource.data.timestamp)||
  !input.frame.referenceEligible||input.frame.sqrtPriceX96<=0n||input.frame.poolLiquidity<0n||
  input.frame.price0===null||input.frame.price0<=0n||input.frame.price1===null||input.frame.price1<=0n||
  input.frame.nativePrice===null||input.frame.nativePrice<=0n||!input.frame.referenceProof||
  referenceProofHash(input.frame.referenceProof)!==input.frame.referenceProofHash)
  return unavailable(input.campaignId,'rangekeeper_current_source_or_reference_unavailable');
 const source=currentSource.data,open=parsed.openMark.model as unknown as RangeKeeperPaperOpenModel,
  openSource=sourceSchema.safeParse(open.source),epoch=parsed.currentEpoch,
  epochSource=sourceSchema.safeParse(epoch.source),epochCandidateParsed=candidateSchema.safeParse(epoch.candidate),
  referenceProofHashValue=epoch.reference.proofHash;
 if(!openSource.success||!Number.isSafeInteger(openSource.data.timestamp))
  return unavailable(input.campaignId,'rangekeeper_persisted_open_source_invalid');
 const draft=parsed.draft as RangeKeeperPaperDraft;
 if(parsed.revision!==draft.revision||parsed.revision!==open.revision||
  open.kind!=='rangekeeper_paper_open_model'||open.campaignId!==parsed.campaignId||
  open.status!=='indicative'||open.actionAvailable!==false||
  !rangeKeeperPaperOpenDecisionHasCandidate(open.decision)||!open.candidate||!open.candidateHash||
  parsed.openMark.modelHash!==contentHash(open)||
  open.profileHash!==draft.profileHash||open.draftConfigHash!==draft.configHash||
  contentHash(draft.profile)!==draft.profileHash||
  BigInt(parsed.openMark.id)<=0n||parsed.previousMark.id==='0'||
  BigInt(parsed.previousMark.id)<=BigInt(parsed.openMark.id)||
  !epochSource.success||!epochCandidateParsed.success||
  !Number.isInteger(epoch.epoch)||epoch.epoch!==parsed.previousMark.epoch||
  BigInt(epoch.markId)<=0n||BigInt(epoch.markId)>BigInt(parsed.previousMark.id)||
  !hash64.safeParse(epoch.markHash).success||
  (epoch.epoch===0&&epoch.markId!==parsed.openMark.id)||
  (epoch.epoch===0&&(!openSource.success||contentHash(epoch.source)!==contentHash(openSource.data)))||
  (epoch.epoch>0&&epoch.candidate.kind!=='recenter')||
  (epoch.epoch===0&&epoch.candidate.kind!=='entry')||
  BigInt(parsed.previousMark.source.block)<BigInt(epoch.source.block)||
  parsed.previousMark.source.timestamp<epoch.source.timestamp||
  BigInt(source.block)<=BigInt(parsed.previousMark.source.block)||
  source.timestamp<parsed.previousMark.source.timestamp||
  parsed.kernel.source.block!==parsed.previousMark.source.block||
  parsed.kernel.source.hash.toLowerCase()!==parsed.previousMark.source.hash.toLowerCase()||
  parsed.kernel.source.timestamp!==parsed.previousMark.source.timestamp||parsed.kernel.pending||
  parsed.pendingOperationId!==null)
  return unavailable(input.campaignId,'rangekeeper_persisted_open_or_mark_identity_invalid');
 const policy=resolveRangeKeeperPaperPolicy(draft,input.buildId);
 if(!policy.policy||policy.unavailable.length||policy.policy.policyHash!==open.kernelPolicyHash)
  return unavailable(input.campaignId,policy.unavailable.join(',')||'rangekeeper_persisted_policy_mismatch');
 if(parsed.runtimeIdentity&&parsed.runtimeIdentity.buildId!==input.buildId)
  return unavailable(input.campaignId,'rangekeeper_effective_runtime_identity_mismatch');
 if(open.kernelBuildId!==input.buildId){
  const adoption=parsed.runtimeAdoption,compat=adoption?.compatibilityProof;
  if(!adoption||adoption.adoptedFromBuildId!==open.kernelBuildId||
   compat?.fromBuildId!==open.kernelBuildId||compat?.toBuildId!==input.buildId||
   compat?.latestMarkHash!==adoption.latestMarkHash||compat?.configHash!==draft.configHash||
   compat?.profileHash!==draft.profileHash)
   return unavailable(input.campaignId,'rangekeeper_open_runtime_adoption_unverified');
 }
 if(source.timestamp<0||now<source.timestamp*1000||now-source.timestamp*1000>180_000)
  return unavailable(input.campaignId,'rangekeeper_current_source_not_after_saved_mark');
 const openCandidateParsed=candidateSchema.safeParse(open.candidate);
 if(!openCandidateParsed.success)return unavailable(input.campaignId,'rangekeeper_persisted_open_candidate_invalid');
 const openCandidate=decimalCandidate(openCandidateParsed.data),candidate=decimalCandidate(epochCandidateParsed.data),
  mintPrice=BigInt(epoch.mintSqrtPriceX96),epochReferenceProof=epoch.reference.proof;
 if(!referenceProofHashValue||referenceProofHash(epochReferenceProof)!==referenceProofHashValue||
  referenceProofHashValue!==epoch.candidateReferenceProofHash||
  BigInt(epoch.reference.price0)<=0n||BigInt(epoch.reference.price1)<=0n||BigInt(epoch.reference.nativePrice)<=0n||
  candidate.sourceBlock!==BigInt(epochSource.data.block)||candidate.sourceHash.toLowerCase()!==epochSource.data.hash.toLowerCase()||
  candidate.expiresAt!==epochSource.data.timestamp+90||mintPrice<=0n||
  (candidate.swap!==null&&candidate.swap.priceAfter!==mintPrice)||
  candidate.range.tickUpper-candidate.range.tickLower!==policy.policy.limits.fullWidthSpacings*draft.profile.pool.tickSpacing||
  candidate.range.tickLower!==epoch.inventory.position.tickLower||
  candidate.range.tickUpper!==epoch.inventory.position.tickUpper||
  String(candidate.liquidity)!==epoch.inventory.position.liquidity)
  return unavailable(input.campaignId,'rangekeeper_current_epoch_identity_invalid');
 if(contentHash(epoch.inventory)!==contentHash({position:parsed.previousMark.position,idle:parsed.previousMark.idle}))
  return unavailable(input.campaignId,'rangekeeper_persisted_idle_inventory_mismatch');
 if(epoch.allowancesCleared!==(epoch.epoch>0))
  return unavailable(input.campaignId,'rangekeeper_current_epoch_allowance_state_unproven');
 if(epoch.epoch===0&&(contentHash(openCandidateParsed.data)!==contentHash(epochCandidateParsed.data)||
  epoch.candidateHash!==open.candidateHash||epoch.candidateReferenceProofHash!==open.reference.proofHash))
  return unavailable(input.campaignId,'rangekeeper_open_epoch_candidate_identity_invalid');
 const expectedEpochCandidateHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
  profileHash:draft.profileHash,configHash:draft.configHash,source:epochSource.data,
  referenceProofHash:epoch.candidateReferenceProofHash,candidate});
 if(epoch.candidateHash!==expectedEpochCandidateHash||parsed.previousMark.candidateHash!==epoch.candidateHash)
  return unavailable(input.campaignId,'rangekeeper_current_epoch_candidate_hash_mismatch');
 let available0=BigInt(epoch.fundingBeforeSwap.token0),available1=BigInt(epoch.fundingBeforeSwap.token1);
 if(epoch.epoch===0&&(epoch.fundingBeforeSwap.token0!==draft.allocation.token0Raw||
  epoch.fundingBeforeSwap.token1!==draft.allocation.token1Raw))
  return unavailable(input.campaignId,'rangekeeper_open_epoch_funding_changed');
 if(candidate.swap){
  if(candidate.swap.token===0){available0-=candidate.swap.amountIn;available1+=candidate.swap.quotedOut;}
  else{available1-=candidate.swap.amountIn;available0+=candidate.swap.quotedOut;}
 }
 const replay=replayPaperMint(mintPrice,candidate.range,candidate.amount0Desired,candidate.amount1Desired,0n),
  idle0=available0-replay.amount0,idle1=available1-replay.amount1;
 if(replay.liquidity!==candidate.liquidity||replay.amount0<candidate.amount0Min||replay.amount1<candidate.amount1Min||
  idle0<0n||idle1<0n||epoch.inventory.idle.token0!==String(idle0)||
  epoch.inventory.idle.token1!==String(idle1))
  return unavailable(input.campaignId,'rangekeeper_persisted_idle_inventory_mismatch');
 const priorState=rangeKeeperState(parsed.kernel.state);
 // The persisted kernel belongs to the previous mark. Project only principal
 // onto the newly verified frame; do not relabel the old observation as new,
 // or carry old principal quantities across a pool price change.
 const principal=principalAmounts({liquidity:candidate.liquidity,
  tickLower:candidate.range.tickLower,tickUpper:candidate.range.tickUpper,
  sqrtPriceX96:input.frame.sqrtPriceX96});
 const kernelWithoutProof={state:priorState,source,
  wallet0:BigInt(parsed.kernel.wallet0),wallet1:BigInt(parsed.kernel.wallet1),
  released0:principal.amount0,released1:principal.amount1,
  nativeWei:BigInt(parsed.kernel.nativeWei),
  campaignStartValue:BigInt(parsed.kernel.campaignStartValue),highWaterValue:BigInt(parsed.kernel.highWaterValue),
  rollingSpentCost:BigInt(parsed.kernel.rollingSpentCost),campaignSpentCost:BigInt(parsed.kernel.campaignSpentCost),
  reservedCost:BigInt(parsed.kernel.reservedCost),recenters:parsed.kernel.recenters,
  pending:parsed.kernel.pending,entryAllowed:parsed.kernel.entryAllowed,
  safeExitRequired:parsed.kernel.safeExitRequired,executionReady:parsed.kernel.executionReady};
 if(kernelWithoutProof.wallet0!==idle0||kernelWithoutProof.wallet1!==idle1||
  priorState.buildId!==open.kernelBuildId||priorState.configHash.toLowerCase()!==`0x${policy.policy.policyHash}`.toLowerCase())
  return unavailable(input.campaignId,'rangekeeper_persisted_kernel_inventory_mismatch');
 if(epoch.kernelSnapshot.recenters!==epoch.epoch||
  epoch.kernelSnapshot.campaignStartValue!==parsed.kernel.campaignStartValue||
  epoch.kernelSnapshot.state.configHash.toLowerCase()!==`0x${policy.policy.policyHash}`.toLowerCase())
  return unavailable(input.campaignId,'rangekeeper_current_epoch_kernel_baseline_mismatch');
 const previous={id:parsed.previousMark.id,source:parsed.previousMark.source,
  candidateHash:parsed.previousMark.candidateHash,position:parsed.previousMark.position,
  idle:parsed.previousMark.idle};
 const kernel:RangeKeeperPaperExitKernelContext={...kernelWithoutProof,inventoryProofHash:''};
 const currentEpoch={epoch:epoch.epoch,markId:epoch.markId,markHash:epoch.markHash,source:epochSource.data,
  candidate,candidateHash:epoch.candidateHash,candidateReferenceProofHash:epoch.candidateReferenceProofHash,
  inventory:epoch.inventory,kernelSnapshot:epoch.kernelSnapshot,mintSqrtPriceX96:mintPrice,
  fundingBeforeSwap:epoch.fundingBeforeSwap,allowancesCleared:epoch.allowancesCleared,
  reference:{price0:BigInt(epoch.reference.price0),price1:BigInt(epoch.reference.price1),
   nativePrice:BigInt(epoch.reference.nativePrice),proofHash:epoch.reference.proofHash,proof:epochReferenceProof}};
 kernel.inventoryProofHash=rangeKeeperPaperExitInventoryProofHash({campaignId:draft.id,
  revision:draft.revision,openMarkId:parsed.openMark.id,openModelHash:parsed.openMark.modelHash,
  candidateHash:currentEpoch.candidateHash,currentEpoch,kernel,previous});
 return {status:'available',draft,openMarkId:parsed.openMark.id,openModel:open,currentEpoch,previous,kernel,
  readGasProfiles:input.readGasProfiles,snapshotHash,actionAvailable:false};
}
