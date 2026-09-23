import {z} from 'zod';
import type {RangeKeeperCandidate,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {contentHash,allocationSchema} from './contracts.js';
import {marketProfileSchema,referenceProofHash} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft,
 type RangeKeeperPaperOpenModel} from './rangekeeper-paper-open-model.js';
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
const persistedMarkSchema=z.object({id:raw,classification:z.literal('rangekeeper_paper_mark_v1'),
 source:sourceSchema,candidateHash:hash64,
 position:z.object({tickLower:z.number().int(),tickUpper:z.number().int(),liquidity:raw}).strict(),
 idle:z.object({token0:raw,token1:raw}).strict()}).strict();
const persistedKernelSchema=z.object({source:sourceSchema,state:stateSchema,
 wallet0:raw,wallet1:raw,released0:raw,released1:raw,nativeWei:raw,
 campaignStartValue:raw,highWaterValue:raw,
 rollingSpentCost:raw,campaignSpentCost:raw,reservedCost:raw,recenters:z.number().int().nonnegative(),
 pending:z.boolean(),entryAllowed:z.boolean(),safeExitRequired:z.boolean(),executionReady:z.boolean()}).strict();
const contextSnapshotSchema=z.object({schemaVersion:z.literal(1),
 kind:z.literal('rangekeeper_paper_persisted_context_v1'),campaignId:z.uuid(),revision:z.number().int().positive(),
 mode:z.literal('paper'),lifecycle:z.enum(['active','paused','closing']),pendingOperationId:z.null(),
 draft:persistedDraftSchema,openMark:z.object({id:raw,classification:z.literal('rangekeeper_paper_open_v1'),modelHash:hash64,
  model:z.record(z.string(),z.unknown())}).strict(),previousMark:persistedMarkSchema,
 kernel:persistedKernelSchema,snapshotHash:hash64}).strict();

export type RangeKeeperPaperPersistedContextReader=(campaignId:string)=>Promise<unknown>;
export type RangeKeeperPaperPersistedContextUnavailable={status:'unavailable';reason:string;
 campaignId:string;actionAvailable:false};
export interface RangeKeeperPaperLoadedExitContext {
 status:'available';draft:RangeKeeperPaperDraft;openMarkId:string;openModel:RangeKeeperPaperOpenModel;
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
  openSource=sourceSchema.safeParse(open.source);
 if(!openSource.success||!Number.isSafeInteger(openSource.data.timestamp))
  return unavailable(input.campaignId,'rangekeeper_persisted_open_source_invalid');
 const draft=parsed.draft as RangeKeeperPaperDraft;
 if(parsed.revision!==draft.revision||parsed.revision!==open.revision||
  open.kind!=='rangekeeper_paper_open_model'||open.campaignId!==parsed.campaignId||
  open.status!=='indicative'||open.actionAvailable!==false||
  !open.decision?.requiresSecondObservation||!open.candidate||!open.candidateHash||
  parsed.openMark.modelHash!==contentHash(open)||open.candidateHash!==parsed.previousMark.candidateHash||
  open.profileHash!==draft.profileHash||open.draftConfigHash!==draft.configHash||
  contentHash(draft.profile)!==draft.profileHash||
  BigInt(parsed.openMark.id)<=0n||parsed.previousMark.id==='0'||
  BigInt(parsed.previousMark.id)<=BigInt(parsed.openMark.id)||
  BigInt(parsed.previousMark.source.block)<=BigInt(openSource.data.block)||
  BigInt(source.block)<=BigInt(parsed.previousMark.source.block)||
  source.timestamp<parsed.previousMark.source.timestamp||
  parsed.kernel.source.block!==source.block||
  parsed.kernel.source.hash.toLowerCase()!==source.hash.toLowerCase()||
  parsed.kernel.source.timestamp!==source.timestamp||parsed.kernel.pending||
  parsed.pendingOperationId!==null)
  return unavailable(input.campaignId,'rangekeeper_persisted_open_or_mark_identity_invalid');
 const policy=resolveRangeKeeperPaperPolicy(draft,input.buildId);
 if(!policy.policy||policy.unavailable.length||policy.policy.policyHash!==open.kernelPolicyHash||
  policy.policy.buildId!==open.kernelBuildId)
  return unavailable(input.campaignId,policy.unavailable.join(',')||'rangekeeper_persisted_policy_mismatch');
 if(source.timestamp<0||now<source.timestamp*1000||now-source.timestamp*1000>180_000)
  return unavailable(input.campaignId,'rangekeeper_current_source_not_after_saved_mark');
 const candidateParsed=candidateSchema.safeParse(open.candidate);
 if(!candidateParsed.success)return unavailable(input.campaignId,'rangekeeper_persisted_open_candidate_invalid');
 const candidate=decimalCandidate(candidateParsed.data);
 if(candidate.sourceBlock!==BigInt(openSource.data.block)||candidate.sourceHash.toLowerCase()!==openSource.data.hash.toLowerCase()||
  candidate.range.tickLower!==parsed.previousMark.position.tickLower||
  candidate.range.tickUpper!==parsed.previousMark.position.tickUpper||
  String(candidate.liquidity)!==parsed.previousMark.position.liquidity)
  return unavailable(input.campaignId,'rangekeeper_persisted_position_identity_mismatch');
 const replay=replayPaperMint(BigInt(open.poolState.sqrtPriceX96),candidate.range,
  candidate.amount0Desired,candidate.amount1Desired,0n);
 if(replay.liquidity!==candidate.liquidity||candidate.expiresAt!==openSource.data.timestamp+90)
  return unavailable(input.campaignId,'rangekeeper_open_mint_replay_mismatch');
 let available0=BigInt(draft.allocation.token0Raw),available1=BigInt(draft.allocation.token1Raw);
 if(candidate.swap){
  if(candidate.swap.token===0){available0-=candidate.swap.amountIn;available1+=candidate.swap.quotedOut;}
  else{available1-=candidate.swap.amountIn;available0+=candidate.swap.quotedOut;}
 }
 const idle0=available0-replay.amount0,idle1=available1-replay.amount1;
 if(idle0<0n||idle1<0n||parsed.previousMark.idle.token0!==String(idle0)||
  parsed.previousMark.idle.token1!==String(idle1))
  return unavailable(input.campaignId,'rangekeeper_persisted_idle_inventory_mismatch');
 const priorState=rangeKeeperState(parsed.kernel.state);
 const kernelWithoutProof={state:priorState,source,
  wallet0:BigInt(parsed.kernel.wallet0),wallet1:BigInt(parsed.kernel.wallet1),
  released0:BigInt(parsed.kernel.released0),released1:BigInt(parsed.kernel.released1),
  nativeWei:BigInt(parsed.kernel.nativeWei),
  campaignStartValue:BigInt(parsed.kernel.campaignStartValue),highWaterValue:BigInt(parsed.kernel.highWaterValue),
  rollingSpentCost:BigInt(parsed.kernel.rollingSpentCost),campaignSpentCost:BigInt(parsed.kernel.campaignSpentCost),
  reservedCost:BigInt(parsed.kernel.reservedCost),recenters:parsed.kernel.recenters,
  pending:parsed.kernel.pending,entryAllowed:parsed.kernel.entryAllowed,
  safeExitRequired:parsed.kernel.safeExitRequired,executionReady:parsed.kernel.executionReady};
 if(kernelWithoutProof.wallet0!==idle0||kernelWithoutProof.wallet1!==idle1||
  priorState.buildId!==input.buildId||priorState.configHash.toLowerCase()!==`0x${policy.policy.policyHash}`.toLowerCase())
  return unavailable(input.campaignId,'rangekeeper_persisted_kernel_inventory_mismatch');
 const previous={id:parsed.previousMark.id,source:parsed.previousMark.source,
  candidateHash:parsed.previousMark.candidateHash,position:parsed.previousMark.position,
  idle:parsed.previousMark.idle};
 const kernel:RangeKeeperPaperExitKernelContext={...kernelWithoutProof,inventoryProofHash:''};
 kernel.inventoryProofHash=rangeKeeperPaperExitInventoryProofHash({campaignId:draft.id,
  revision:draft.revision,openMarkId:parsed.openMark.id,openModelHash:parsed.openMark.modelHash,
  candidateHash:open.candidateHash,kernel,previous});
 return {status:'available',draft,openMarkId:parsed.openMark.id,openModel:open,previous,kernel,
  readGasProfiles:input.readGasProfiles,snapshotHash,actionAvailable:false};
}
