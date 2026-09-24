import {z} from 'zod';
import {replayPaperMint} from '../v3/position-math.js';
import type {RangeKeeperCandidate,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {contentHash} from './contracts.js';
import type {RangeKeeperPaperConfirmationEnvelope} from './rangekeeper-paper-confirmation.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const sourceSchema=z.object({block:raw,hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 timestamp:z.number().int().nonnegative()}).strict();
const hash64=z.string().regex(/^[0-9a-f]{64}$/);
const confirmationCandidateSchema=z.object({kind:z.enum(['entry','recenter']),
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 swap:z.object({token:z.union([z.literal(0),z.literal(1)]),amountIn:raw,quotedOut:raw,minOut:raw,
  priceAfter:raw,feeValue:raw,shortfallValue:raw}).strict().nullable(),
 amount0Desired:raw,amount1Desired:raw,amount0Min:raw,amount1Min:raw,liquidity:raw,
 deployedValue:raw,sourceBlock:raw,sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 expiresAt:z.number().int().nonnegative()}).strict();
const confirmationBodySchema=z.object({schemaVersion:z.literal(1),
 kind:z.literal('rangekeeper_paper_open_confirmation_v1'),status:z.literal('confirmed'),
 campaignId:z.uuid(),revision:z.number().int().positive(),draftConfigHash:hash64,profileHash:hash64,
 firstObservation:z.object({source:sourceSchema,modelHash:hash64,candidateHash:hash64}).strict(),
 confirmationObservation:z.object({source:sourceSchema,candidateHash:hash64,
  candidate:confirmationCandidateSchema,poolState:z.object({tick:z.number().int(),sqrtPriceX96:raw,
   poolLiquidity:raw}).strict(),reference:z.object({price0:raw,price1:raw,nativePrice:raw,
   proofHash:hash64,proof:z.record(z.string(),z.unknown())}).strict()}).strict(),
 decision:z.object({action:z.literal('execute'),reason:z.literal('two_confirmations'),gasSequenceHash:
  z.string().regex(/^0x[0-9a-fA-F]{64}$/),simulation:z.object({status:z.literal('success'),
   sourceBlock:raw,sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),candidateHash:hash64,
   simulationHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/)}).strict()}).strict(),
 costs:z.object({status:z.literal('provisional'),profileIds:z.array(z.object({stage:z.string().min(1),
  id:z.string().uuid(),version:z.number().int().positive()}).strict())}).passthrough(),
 strategyState:z.record(z.string(),z.unknown()),
 inventory:z.object({position:z.object({tickLower:z.number().int(),tickUpper:z.number().int(),
  liquidity:raw}).strict(),idle:z.object({token0:raw,token1:raw}).strict()}).strict(),
 selectedGasProfileIds:z.array(z.string().uuid()),
 executionEvidence:z.literal('caller_supplied_simulation_attestation_unverified'),
 openingBooked:z.literal(false),actionAvailable:z.literal(false)}).strict();
const stateSchema=z.object({schemaVersion:z.literal(1),policyId:z.literal('rangekeeper_v1'),
 strategyVersion:z.literal('1.0.0'),configHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 buildId:z.string().regex(/^[a-f0-9]{64}$/),
 lastEligible:z.object({block:raw,hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  timestamp:z.number().int().nonnegative()}).strict().nullable(),
 confirmation:z.object({candidate:z.object({kind:z.enum(['entry','recenter']),
  range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
  swap:z.object({token:z.union([z.literal(0),z.literal(1)]),amountIn:raw,quotedOut:raw,minOut:raw,
   priceAfter:raw,feeValue:raw,shortfallValue:raw}).strict().nullable(),
  amount0Desired:raw,amount1Desired:raw,amount0Min:raw,amount1Min:raw,liquidity:raw,
  deployedValue:raw,sourceBlock:raw,sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  expiresAt:z.number().int().nonnegative()}).strict(),firstBlock:raw,
  firstHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),firstAt:z.number().int().nonnegative()}).strict().nullable(),
 exit:z.object({tokenId:z.string().min(1),tickLower:z.number().int(),tickUpper:z.number().int(),
  block:raw,hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),since:z.number().int().nonnegative(),
  lastOutsideAt:z.number().int().nonnegative()}).strict().nullable()}).strict();
const candidateSchema=z.object({kind:z.enum(['entry','recenter']),
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 swap:z.object({token:z.union([z.literal(0),z.literal(1)]),amountIn:raw,quotedOut:raw,minOut:raw,
  priceAfter:raw,feeValue:raw,shortfallValue:raw}).strict().nullable(),
 amount0Desired:raw,amount1Desired:raw,amount0Min:raw,amount1Min:raw,
 liquidity:raw,deployedValue:raw,sourceBlock:raw,sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 expiresAt:z.number().int().nonnegative()}).strict();
const kernelSchema=z.object({source:sourceSchema,state:stateSchema,
 wallet0:raw,wallet1:raw,released0:raw,released1:raw,nativeWei:raw,
 campaignStartValue:raw,highWaterValue:raw,rollingSpentCost:raw,campaignSpentCost:raw,
 reservedCost:raw,recenters:z.number().int().nonnegative(),pending:z.boolean(),
 entryAllowed:z.boolean(),safeExitRequired:z.boolean(),executionReady:z.boolean()}).strict();

export interface RangeKeeperPaperMarkPayload {
 inventory:{position:{tickLower:number;tickUpper:number;liquidity:string};idle:{token0:string;token1:string}};
 provenance:{classification:'rangekeeper_paper_mark_v1';source:{block:string;hash:string;timestamp:number};
  candidateHash:string;kernelSnapshot:z.infer<typeof kernelSchema>};
}

/** Validates the restart-safe, dashboard-safe representation of the second
 * observation. The envelope remains provisional and cannot book an opening. */
export function validateRangeKeeperPaperConfirmationEnvelope(value:unknown,
 expected:{campaignId:string;revision:number}):RangeKeeperPaperConfirmationEnvelope{
 const parsed=z.object({...confirmationBodySchema.shape,envelopeHash:hash64}).strict().parse(value),
  {envelopeHash,...body}=parsed;
 if(parsed.campaignId!==expected.campaignId||parsed.revision!==expected.revision||
  BigInt(parsed.confirmationObservation.source.block)<=BigInt(parsed.firstObservation.source.block)||
  parsed.confirmationObservation.source.timestamp<=parsed.firstObservation.source.timestamp||
  parsed.confirmationObservation.candidate.sourceBlock!==parsed.confirmationObservation.source.block||
  parsed.confirmationObservation.candidate.sourceHash.toLowerCase()!==
   parsed.confirmationObservation.source.hash.toLowerCase()||
  parsed.decision.simulation.sourceBlock!==parsed.confirmationObservation.source.block||
  parsed.decision.simulation.sourceHash.toLowerCase()!==parsed.confirmationObservation.source.hash.toLowerCase()||
  parsed.decision.simulation.candidateHash!==parsed.confirmationObservation.candidateHash||
  parsed.costs.profileIds.length!==parsed.selectedGasProfileIds.length||
  parsed.costs.profileIds.some((profile,index)=>profile.id!==parsed.selectedGasProfileIds[index])||
  contentHash(body)!==envelopeHash)
  throw new Error('rangekeeper_paper_confirmation_envelope_integrity_invalid');
 return parsed as unknown as RangeKeeperPaperConfirmationEnvelope;
}

function serializeCandidate(candidate:RangeKeeperCandidate){
 return {kind:candidate.kind,range:candidate.range,swap:candidate.swap?{
  token:candidate.swap.token,amountIn:String(candidate.swap.amountIn),
  quotedOut:String(candidate.swap.quotedOut),minOut:String(candidate.swap.minOut),
  priceAfter:String(candidate.swap.priceAfter),feeValue:String(candidate.swap.feeValue),
  shortfallValue:String(candidate.swap.shortfallValue)}:null,
  amount0Desired:String(candidate.amount0Desired),amount1Desired:String(candidate.amount1Desired),
  amount0Min:String(candidate.amount0Min),amount1Min:String(candidate.amount1Min),
  liquidity:String(candidate.liquidity),deployedValue:String(candidate.deployedValue),
  sourceBlock:String(candidate.sourceBlock),sourceHash:candidate.sourceHash,expiresAt:candidate.expiresAt};
}

/** Parses the persisted JSON representation of a strategy candidate without
 * converting any absent or malformed quantity to a default. */
export function parseRangeKeeperPaperCandidate(value:unknown):RangeKeeperCandidate{
 const c=candidateSchema.parse(value);
 return {kind:c.kind,range:c.range,swap:c.swap?{token:c.swap.token,amountIn:BigInt(c.swap.amountIn),
  quotedOut:BigInt(c.swap.quotedOut),minOut:BigInt(c.swap.minOut),priceAfter:BigInt(c.swap.priceAfter),
  feeValue:BigInt(c.swap.feeValue),shortfallValue:BigInt(c.swap.shortfallValue)}:null,
  amount0Desired:BigInt(c.amount0Desired),amount1Desired:BigInt(c.amount1Desired),
  amount0Min:BigInt(c.amount0Min),amount1Min:BigInt(c.amount1Min),liquidity:BigInt(c.liquidity),
  deployedValue:BigInt(c.deployedValue),sourceBlock:BigInt(c.sourceBlock),
  sourceHash:c.sourceHash as `0x${string}`,expiresAt:c.expiresAt};
}

/** Parses JSON-safe persisted kernel state into the exact strategy state used
 * by RangeKeeper. */
export function parseRangeKeeperPaperState(value:unknown):RangeKeeperState{
 const s=stateSchema.parse(value);
 return {schemaVersion:s.schemaVersion,policyId:s.policyId,strategyVersion:s.strategyVersion,
  configHash:s.configHash as `0x${string}`,buildId:s.buildId,
  lastEligible:s.lastEligible?{block:BigInt(s.lastEligible.block),hash:s.lastEligible.hash as `0x${string}`,
   timestamp:s.lastEligible.timestamp}:null,
  confirmation:s.confirmation?{candidate:parseRangeKeeperPaperCandidate(s.confirmation.candidate),
   firstBlock:BigInt(s.confirmation.firstBlock),firstHash:s.confirmation.firstHash as `0x${string}`,
   firstAt:s.confirmation.firstAt}:null,
  exit:s.exit?{tokenId:s.exit.tokenId,tickLower:s.exit.tickLower,tickUpper:s.exit.tickUpper,
   block:BigInt(s.exit.block),hash:s.exit.hash as `0x${string}`,since:s.exit.since,
   lastOutsideAt:s.exit.lastOutsideAt}:null};
}

/** Converts live in-memory kernel BigInts into the exact JSON-safe wire shape
 * consumed after process restart. */
export function serializeRangeKeeperPaperKernelSnapshot(input:{state:RangeKeeperState;
 source:{block:string;hash:string;timestamp:number};wallet0:bigint;wallet1:bigint;
 released0:bigint;released1:bigint;nativeWei:bigint;campaignStartValue:bigint;
 highWaterValue:bigint;rollingSpentCost:bigint;campaignSpentCost:bigint;reservedCost:bigint;
 recenters:number;pending:boolean;entryAllowed:boolean;safeExitRequired:boolean;executionReady:boolean}){
 const s=input.state;
 return {source:input.source,state:{schemaVersion:s.schemaVersion,policyId:s.policyId,
  strategyVersion:s.strategyVersion,configHash:s.configHash,buildId:s.buildId,
  lastEligible:s.lastEligible?{block:String(s.lastEligible.block),hash:s.lastEligible.hash,
   timestamp:s.lastEligible.timestamp}:null,
  confirmation:s.confirmation?{candidate:serializeCandidate(s.confirmation.candidate),
   firstBlock:String(s.confirmation.firstBlock),firstHash:s.confirmation.firstHash,
   firstAt:s.confirmation.firstAt}:null,
  exit:s.exit?{tokenId:s.exit.tokenId,tickLower:s.exit.tickLower,tickUpper:s.exit.tickUpper,
   block:String(s.exit.block),hash:s.exit.hash,since:s.exit.since,lastOutsideAt:s.exit.lastOutsideAt}:null},
  wallet0:String(input.wallet0),wallet1:String(input.wallet1),released0:String(input.released0),
  released1:String(input.released1),nativeWei:String(input.nativeWei),
  campaignStartValue:String(input.campaignStartValue),highWaterValue:String(input.highWaterValue),
  rollingSpentCost:String(input.rollingSpentCost),campaignSpentCost:String(input.campaignSpentCost),
  reservedCost:String(input.reservedCost),recenters:input.recenters,pending:input.pending,
  entryAllowed:input.entryAllowed,safeExitRequired:input.safeExitRequired,
  executionReady:input.executionReady};
}

/** Builds the durable observation mark consumed by the restart-safe exit loader.
 * Position and idle inventory come from the saved open candidate; only the
 * kernel's evolving strategy state is supplied by the trusted paper runner. */
export function buildRangeKeeperPaperMarkPayload(input:{source:unknown;openSource:unknown;
 openModel:unknown;allocation:{token0Raw:string;token1Raw:string};candidateHash:string;
 kernelSnapshot:unknown}):RangeKeeperPaperMarkPayload{
 const source=sourceSchema.parse(input.source),openSource=sourceSchema.parse(input.openSource),
  open=z.object({kind:z.literal('rangekeeper_paper_open_model'),status:z.literal('indicative'),
   actionAvailable:z.literal(false),campaignId:z.uuid(),revision:z.number().int().positive(),
   strategyId:z.literal('rangekeeper_v1'),strategyVersion:z.literal('1.0.0'),
   kernelPolicyHash:z.string().regex(/^[0-9a-f]{64}$/),kernelBuildId:z.string().regex(/^[a-f0-9]{64}$/),
   candidateHash:z.string().regex(/^[0-9a-f]{64}$/),source:sourceSchema,
   poolState:z.object({sqrtPriceX96:raw}).passthrough(),candidate:candidateSchema}).passthrough().parse(input.openModel),
  kernel=kernelSchema.parse(input.kernelSnapshot);
 if(BigInt(source.block)<=BigInt(openSource.block)||source.timestamp<openSource.timestamp)
  throw new Error('rangekeeper_paper_mark_source_order_invalid');
 if(input.candidateHash!==open.candidateHash||open.source.block!==openSource.block||
  open.source.hash.toLowerCase()!==openSource.hash.toLowerCase()||
  kernel.source.block!==source.block||kernel.source.hash.toLowerCase()!==source.hash.toLowerCase()||
  kernel.source.timestamp!==source.timestamp||kernel.state.buildId!==open.kernelBuildId||
  kernel.state.configHash.toLowerCase()!==`0x${open.kernelPolicyHash}`.toLowerCase()||kernel.pending)
  throw new Error('rangekeeper_paper_mark_identity_invalid');
 if(kernel.recenters!==0)
  throw new Error('rangekeeper_paper_mark_recenter_persistence_unavailable');
 const candidate=open.candidate,range=candidate.range;
 if(range.tickLower>=range.tickUpper||BigInt(candidate.liquidity)<=0n||
  candidate.sourceBlock!==openSource.block||candidate.sourceHash.toLowerCase()!==openSource.hash.toLowerCase())
  throw new Error('rangekeeper_paper_mark_candidate_invalid');
 const replay=replayPaperMint(BigInt(open.poolState.sqrtPriceX96),range,
  BigInt(candidate.amount0Desired),BigInt(candidate.amount1Desired),0n);
 if(replay.liquidity!==BigInt(candidate.liquidity)||candidate.expiresAt!==openSource.timestamp+90)
  throw new Error('rangekeeper_paper_mark_mint_replay_mismatch');
 let available0=BigInt(input.allocation.token0Raw),available1=BigInt(input.allocation.token1Raw);
 if(candidate.swap){
  if(candidate.swap.token===0){available0-=BigInt(candidate.swap.amountIn);available1+=BigInt(candidate.swap.quotedOut);}
  else{available1-=BigInt(candidate.swap.amountIn);available0+=BigInt(candidate.swap.quotedOut);}
 }
 const idle0=available0-replay.amount0,idle1=available1-replay.amount1;
 if(idle0<0n||idle1<0n||BigInt(kernel.wallet0)!==idle0||BigInt(kernel.wallet1)!==idle1)
  throw new Error('rangekeeper_paper_mark_inventory_mismatch');
 return {inventory:{position:{tickLower:range.tickLower,tickUpper:range.tickUpper,
   liquidity:String(candidate.liquidity)},idle:{token0:String(idle0),token1:String(idle1)}},
  provenance:{classification:'rangekeeper_paper_mark_v1',source,candidateHash:input.candidateHash,
   kernelSnapshot:kernel}};
}
