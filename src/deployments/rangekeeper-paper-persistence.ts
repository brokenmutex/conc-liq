import {z} from 'zod';
import {principalAmounts} from '../backtest/principal.js';
import {replayPaperMint} from '../v3/position-math.js';
import type {RangeKeeperCandidate,RangeKeeperState} from '../strategy/rangekeeper/domain.js';
import {contentHash} from './contracts.js';
import {referenceProofHash} from './market-profile.js';
import {rangeKeeperPaperCandidateHash} from './rangekeeper-paper-cost.js';
import {verifyRangeKeeperPaperOwnedForkConfirmationEvidence} from './rangekeeper-paper-confirmation-simulation.js';
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
 simulationEvidence:z.record(z.string(),z.unknown()),
 costs:z.object({status:z.literal('provisional'),profileIds:z.array(z.object({stage:z.string().min(1),
  id:z.string().uuid(),version:z.number().int().positive()}).strict())}).passthrough(),
 strategyState:z.record(z.string(),z.unknown()),
 inventory:z.object({position:z.object({tickLower:z.number().int(),tickUpper:z.number().int(),
  liquidity:raw}).strict(),idle:z.object({token0:raw,token1:raw}).strict()}).strict(),
 selectedGasProfileIds:z.array(z.string().uuid()),
 executionEvidence:z.literal('source_bound_caller_simulation_evidence_unverified'),
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
 provenance:{classification:'rangekeeper_paper_mark_v1';epoch:number;source:{block:string;hash:string;timestamp:number};
  candidateHash:string;candidateReferenceProofHash:string;positionEpoch:Record<string,unknown>;
  kernelSnapshot:z.infer<typeof kernelSchema>;initialModeledOpenCost:Record<string,unknown>};
}

const initialModeledOpenCostSchema=z.object({schemaVersion:z.literal(1),
 kind:z.literal('rangekeeper_paper_initial_modeled_open_cost_v1'),
 openModelHash:hash64,costHash:hash64,profileIds:z.array(z.object({stage:z.string().min(1),
  id:z.string().uuid(),version:z.number().int().positive()}).strict()),
 expectedValue:raw,boundValue:raw,expectedWei:raw,boundWei:raw,
 classification:z.literal('provisional'),paidCostsAvailable:z.literal(false)}).strict();
export function validateRangeKeeperPaperInitialModeledOpenCost(value:unknown){
 return initialModeledOpenCostSchema.parse(value);
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
  referenceProofHash(parsed.confirmationObservation.reference.proof)!==
   parsed.confirmationObservation.reference.proofHash||
  contentHash(body)!==envelopeHash)
  throw new Error('rangekeeper_paper_confirmation_envelope_integrity_invalid');
 verifyRangeKeeperPaperOwnedForkConfirmationEvidence(parsed.simulationEvidence,{
  campaignId:parsed.campaignId,revision:parsed.revision,configHash:parsed.draftConfigHash,
  profileHash:parsed.profileHash,source:parsed.confirmationObservation.source,
  referenceProofHash:parsed.confirmationObservation.reference.proofHash,
  candidate:parseRangeKeeperPaperCandidate(parsed.confirmationObservation.candidate),
  candidateHash:parsed.confirmationObservation.candidateHash,
  simulationHash:parsed.decision.simulation.simulationHash});
 return parsed as unknown as RangeKeeperPaperConfirmationEnvelope;
}

export function serializeRangeKeeperPaperCandidate(candidate:RangeKeeperCandidate){
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
const serializeCandidate=serializeRangeKeeperPaperCandidate;

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
 openModel:unknown;allocation:{token0Raw:string;token1Raw:string;nativeWei:string};candidateHash:string;
 kernelSnapshot:unknown;epoch?:number}):RangeKeeperPaperMarkPayload{
 const source=sourceSchema.parse(input.source),openSource=sourceSchema.parse(input.openSource),
  open=z.object({kind:z.literal('rangekeeper_paper_open_model'),status:z.literal('indicative'),
   actionAvailable:z.literal(false),campaignId:z.uuid(),revision:z.number().int().positive(),
   strategyId:z.literal('rangekeeper_v1'),strategyVersion:z.literal('1.0.0'),
   kernelPolicyHash:z.string().regex(/^[0-9a-f]{64}$/),kernelBuildId:z.string().regex(/^[a-f0-9]{64}$/),
   candidateHash:z.string().regex(/^[0-9a-f]{64}$/),source:sourceSchema,
   poolState:z.object({sqrtPriceX96:raw}).passthrough(),
   reference:z.object({price0:z.string().nullable(),price1:z.string().nullable(),nativePrice:z.string().nullable(),
    eligible:z.boolean(),proofHash:hash64,proof:z.record(z.string(),z.unknown()).nullable(),
   reasons:z.array(z.string())}).passthrough(),costs:z.unknown().nullable(),
   candidate:candidateSchema}).passthrough().parse(input.openModel),
  kernel=kernelSchema.parse(input.kernelSnapshot);
 if(BigInt(source.block)<=BigInt(openSource.block)||source.timestamp<openSource.timestamp)
  throw new Error('rangekeeper_paper_mark_source_order_invalid');
 if(!open.reference.proof||referenceProofHash(open.reference.proof)!==open.reference.proofHash||
  input.candidateHash!==open.candidateHash||open.source.block!==openSource.block||
  open.source.hash.toLowerCase()!==openSource.hash.toLowerCase()||
  kernel.source.block!==source.block||kernel.source.hash.toLowerCase()!==source.hash.toLowerCase()||
  kernel.source.timestamp!==source.timestamp||kernel.state.buildId!==open.kernelBuildId||
  kernel.state.configHash.toLowerCase()!==`0x${open.kernelPolicyHash}`.toLowerCase()||kernel.pending)
  throw new Error('rangekeeper_paper_mark_identity_invalid');
 const epoch=input.epoch??0;
 if(kernel.recenters!==epoch)
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
 const openCost=(open.costs as {status?:unknown;open?:{expectedValue?:unknown;boundValue?:unknown;
  expectedWei?:unknown;boundWei?:unknown};profileIds?:unknown}|null)?.open,
  profileIds=(open.costs as {profileIds?:unknown}|null)?.profileIds,
  costStatus=(open.costs as {status?:unknown}|null)?.status;
 if(costStatus!=='provisional'||!openCost||!Array.isArray(profileIds))
  throw new Error('rangekeeper_paper_initial_open_cost_evidence_unavailable');
 const costEvidence=initialModeledOpenCostSchema.parse({schemaVersion:1,
  kind:'rangekeeper_paper_initial_modeled_open_cost_v1',openModelHash:contentHash(input.openModel),
  costHash:contentHash(openCost),profileIds,expectedValue:String(openCost.expectedValue),
  boundValue:String(openCost.boundValue),expectedWei:String(openCost.expectedWei),
  boundWei:String(openCost.boundWei),classification:'provisional',paidCostsAvailable:false});
 if(BigInt(kernel.campaignSpentCost)!==BigInt(costEvidence.boundValue)||
  BigInt(kernel.rollingSpentCost)!==BigInt(costEvidence.boundValue)||
  BigInt(kernel.nativeWei)!==BigInt(input.allocation.nativeWei)-BigInt(costEvidence.boundWei))
  throw new Error('rangekeeper_paper_initial_open_cost_debit_mismatch');
 const inventory={position:{tickLower:range.tickLower,tickUpper:range.tickUpper,
   liquidity:String(candidate.liquidity)},idle:{token0:String(idle0),token1:String(idle1)}},
  positionEpoch={epoch:0,inventory,candidate:candidateHashInput(candidate),candidateHash:input.candidateHash,
   candidateReferenceProofHash:open.reference.proofHash,mintSqrtPriceX96:open.poolState.sqrtPriceX96,
   fundingBeforeSwap:{token0:input.allocation.token0Raw,token1:input.allocation.token1Raw},
   allowancesCleared:false,source:openSource,reference:open.reference,
   poolState:open.poolState};
 return {inventory,provenance:{classification:'rangekeeper_paper_mark_v1',epoch,source,
  candidateHash:input.candidateHash,candidateReferenceProofHash:open.reference.proofHash,
  positionEpoch,kernelSnapshot:kernel,initialModeledOpenCost:costEvidence}};
}

/** Validates an observation in the current inventory epoch. It does not
 * reconstruct position amounts from the opening allocation, which becomes
 * stale after a recenter. */
export function buildRangeKeeperPaperEpochObservationPayload(input:{epoch:number;source:unknown;
 previousMark:RangeKeeperPaperEpochMark;frame:{source:{block:string;hash:string;timestamp:number};
  sqrtPriceX96:bigint;tick:number;poolLiquidity:bigint};kernelSnapshot:unknown}){
 const source=recenterSourceSchema.parse(input.source),frameSource=recenterSourceSchema.parse(input.frame.source),
  previous=input.previousMark,inventory=recenterInventorySchema.parse(previous.inventory),
  candidate=candidateSchema.parse(previous.candidate),kernel=kernelSchema.parse(input.kernelSnapshot),
  priorKernel=kernelSchema.parse(previous.kernelSnapshot),
  initialCost=initialModeledOpenCostSchema.safeParse(previous.provenance?.initialModeledOpenCost),
  candidateHash=previous.candidateHash??String(previous.provenance?.candidateHash??'');
 if(!Number.isSafeInteger(input.epoch)||input.epoch<0||input.epoch!==previous.epoch||
  contentHash(source)!==contentHash(frameSource)||BigInt(source.block)<=BigInt(previous.source.block)||
  source.timestamp<previous.source.timestamp||candidate.range.tickLower!==inventory.position.tickLower||
  candidate.range.tickUpper!==inventory.position.tickUpper||candidate.liquidity!==inventory.position.liquidity||
  kernel.recenters!==input.epoch||kernel.pending||kernel.source.block!==source.block||
  kernel.source.hash.toLowerCase()!==source.hash.toLowerCase()||kernel.source.timestamp!==source.timestamp||
  kernel.wallet0!==inventory.idle.token0||kernel.wallet1!==inventory.idle.token1)
  throw new Error('rangekeeper_paper_epoch_observation_identity_invalid');
 if(!/^[a-f0-9]{64}$/.test(candidateHash))throw new Error('rangekeeper_paper_epoch_candidate_hash_unavailable');
 if(!initialCost.success||BigInt(priorKernel.campaignSpentCost)<BigInt(initialCost.data.boundValue)||
  BigInt(priorKernel.rollingSpentCost)<BigInt(initialCost.data.boundValue))
  throw new Error('rangekeeper_paper_initial_open_cost_evidence_unavailable');
 const principal=principalAmounts({liquidity:BigInt(inventory.position.liquidity),
  tickLower:inventory.position.tickLower,tickUpper:inventory.position.tickUpper,
  sqrtPriceX96:input.frame.sqrtPriceX96});
 if(kernel.released0!==String(principal.amount0)||kernel.released1!==String(principal.amount1))
  throw new Error('rangekeeper_paper_epoch_observation_principal_mismatch');
 if(kernel.nativeWei!==priorKernel.nativeWei||kernel.campaignStartValue!==priorKernel.campaignStartValue||
  BigInt(kernel.highWaterValue)<BigInt(priorKernel.highWaterValue)||
  BigInt(kernel.rollingSpentCost)<BigInt(priorKernel.rollingSpentCost)||
  BigInt(kernel.campaignSpentCost)<BigInt(priorKernel.campaignSpentCost))
  throw new Error('rangekeeper_paper_epoch_observation_baseline_changed');
 const epochLineage=(previous.provenance?.positionEpoch as Record<string,unknown>|undefined)??
  {epoch:input.epoch,inventory,candidate:candidateHashInput(candidate),candidateHash,
   candidateReferenceProofHash:previous.provenance?.candidateReferenceProofHash,
   mintSqrtPriceX96:previous.provenance?.mintSqrtPriceX96??
    (previous.provenance?.poolState as Record<string,unknown>|undefined)?.sqrtPriceX96,
   fundingBeforeSwap:previous.provenance?.fundingBeforeSwap,
   allowancesCleared:previous.provenance?.allowancesCleared??false,
   source:previous.provenance?.source,reference:previous.provenance?.reference};
 return {inventory,provenance:{classification:'rangekeeper_paper_mark_v1',epoch:input.epoch,
  candidateReferenceProofHash:String(previous.provenance?.candidateReferenceProofHash??''),
  source,poolState:{tick:input.frame.tick,sqrtPriceX96:String(input.frame.sqrtPriceX96),
   poolLiquidity:String(input.frame.poolLiquidity)},candidateHash,candidate:candidateHashInput(candidate),
  kernelSnapshot:kernel,initialModeledOpenCost:initialCost.data,
  positionEpoch:{...epochLineage,epoch:input.epoch,inventory}}};
}

const recenterSourceSchema=z.object({block:raw,hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 timestamp:z.number().int().nonnegative()}).strict();
const recenterInventorySchema=z.object({position:z.object({tickLower:z.number().int(),
 tickUpper:z.number().int(),liquidity:raw}).strict(),idle:z.object({token0:raw,token1:raw}).strict()}).strict();
export const rangeKeeperPaperRecenterBookingSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('rangekeeper_paper_recenter_v1'),
 campaignId:z.uuid(),revision:z.number().int().positive(),
 previousEpoch:z.number().int().nonnegative(),epoch:z.number().int().positive(),
 priorMark:z.object({id:raw,markHash:z.string().regex(/^[0-9a-f]{64}$/),source:recenterSourceSchema}).strict(),
 source:recenterSourceSchema,
 poolState:z.object({tick:z.number().int(),sqrtPriceX96:raw,poolLiquidity:raw}).strict(),
 allowancesCleared:z.literal(true),
 reference:z.object({price0:raw,price1:raw,nativePrice:raw,proofHash:hash64,
  proof:z.record(z.string(),z.unknown())}).strict(),
 candidateReferenceProofHash:z.string().regex(/^[0-9a-f]{64}$/),candidateHash:hash64,
 retiredPosition:z.object({tickLower:z.number().int(),tickUpper:z.number().int(),liquidity:raw}).strict(),
 withdrawal:z.object({amount0:raw,amount1:raw}).strict(),
 collected:z.object({amount0:raw,amount1:raw}).strict(),
 swap:z.object({token:z.union([z.literal(0),z.literal(1)]),amountIn:raw,quotedOut:raw,
  minOut:raw,amountOut:raw,priceAfter:raw,feeValue:raw,shortfallValue:raw,
  source:recenterSourceSchema}).strict().nullable(),
 candidate:candidateSchema,inventory:recenterInventorySchema,kernelSnapshot:kernelSchema,
 simulationHash:hash64,
 modeledCosts:z.object({status:z.literal('provisional'),expectedValue:raw,boundValue:raw,
  expectedWei:raw,boundWei:raw,requiredReserveWei:raw,marketGasPriceWei:raw,
  gasPriceBoundWei:raw}).passthrough().nullable(),
 modelHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export function validateRangeKeeperPaperRecenterBooking(value:unknown){
 const booking=rangeKeeperPaperRecenterBookingSchema.parse(value),{modelHash,...body}=booking;
 if(modelHash!==contentHash(body))throw new Error('rangekeeper_paper_recenter_model_hash_invalid');
 const costs=booking.modeledCosts;
 if(!costs)throw new Error('rangekeeper_paper_recenter_cost_model_unavailable');
 const marketPrice=BigInt(costs.marketGasPriceWei),priceBound=BigInt(costs.gasPriceBoundWei);
 if(marketPrice<=0n||priceBound!==(marketPrice*5n+3n)/4n)
  throw new Error('rangekeeper_paper_recenter_gas_price_bound_invalid');
 return booking;
}
export function createRangeKeeperPaperRecenterBookingModel(
 body:Omit<z.input<typeof rangeKeeperPaperRecenterBookingSchema>,'modelHash'>){
 const parsed=rangeKeeperPaperRecenterBookingSchema.omit({modelHash:true}).parse(body);
 return rangeKeeperPaperRecenterBookingSchema.parse({...parsed,modelHash:contentHash(parsed)});
}

export interface RangeKeeperPaperEpochMark {
 id:string;markHash:string;source:{block:string;hash:string;timestamp:number};epoch:number;
 classification:'rangekeeper_paper_open_v1'|'rangekeeper_paper_mark_v1'|'rangekeeper_paper_recenter_v1';
 candidate:unknown;candidateHash?:string;inventory:unknown;kernelSnapshot?:unknown;
 provenance?:Record<string,unknown>;
}

/** Replays and validates an append-only recenter booking from the current
 * persisted epoch. The opening allocation is deliberately absent: only the
 * previous epoch inventory can fund the new position. Costs remain modeled
 * evidence and never become paid ledger amounts here. */
export function buildRangeKeeperPaperRecenterBooking(input:{draft:{id:string;revision:number;
 configHash:string;profileHash:string;profile:{pool:{decimals0:number;decimals1:number}}};previousMark:RangeKeeperPaperEpochMark;
 frame:{source:{block:string;hash:string;timestamp:number};sqrtPriceX96:bigint};booking:unknown}){
 const b=validateRangeKeeperPaperRecenterBooking(input.booking),previous=input.previousMark,
  priorInventory=recenterInventorySchema.parse(previous.inventory),
  priorCandidate=candidateSchema.parse(previous.candidate),
  previousKernel=kernelSchema.parse(previous.kernelSnapshot),
  initialCost=initialModeledOpenCostSchema.safeParse(previous.provenance?.initialModeledOpenCost);
 if(!initialCost.success||BigInt(previousKernel.campaignSpentCost)<BigInt(initialCost.data.boundValue)||
  BigInt(previousKernel.rollingSpentCost)<BigInt(initialCost.data.boundValue))
  throw new Error('rangekeeper_paper_initial_open_cost_evidence_unavailable');
 if(b.campaignId!==input.draft.id||b.revision!==input.draft.revision||
  b.previousEpoch!==previous.epoch||b.epoch!==previous.epoch+1||
  b.priorMark.id!==previous.id||b.priorMark.markHash!==previous.markHash||
  contentHash(b.priorMark.source)!==contentHash(previous.source)||
  !['rangekeeper_paper_open_v1','rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1'].includes(previous.classification)||
  contentHash(b.source)!==contentHash(input.frame.source)||
  BigInt(b.source.block)<=BigInt(previous.source.block)||b.source.timestamp<previous.source.timestamp||
  b.candidate.kind!=='recenter'||b.candidate.sourceBlock!==b.source.block||
  b.candidate.sourceHash.toLowerCase()!==b.source.hash.toLowerCase()||
  b.candidate.expiresAt!==b.source.timestamp+90||
  b.retiredPosition.tickLower!==priorInventory.position.tickLower||
  b.retiredPosition.tickUpper!==priorInventory.position.tickUpper||
  b.retiredPosition.liquidity!==priorInventory.position.liquidity||
  priorCandidate.range.tickLower!==priorInventory.position.tickLower||
  priorCandidate.range.tickUpper!==priorInventory.position.tickUpper||
  priorCandidate.liquidity!==priorInventory.position.liquidity||
  contentHash(b.retiredPosition)!==contentHash(priorCandidate.range?{
   tickLower:priorInventory.position.tickLower,tickUpper:priorInventory.position.tickUpper,
   liquidity:priorInventory.position.liquidity}:null))
  throw new Error('rangekeeper_paper_recenter_prior_epoch_invalid');
 const {modelHash,...body}=b;
 if(modelHash!==contentHash(body))throw new Error('rangekeeper_paper_recenter_model_hash_invalid');
 const candidateHash=rangeKeeperPaperCandidateHash({campaignId:b.campaignId,revision:b.revision,
  profileHash:input.draft.profileHash,configHash:input.draft.configHash,source:b.source,
  referenceProofHash:b.candidateReferenceProofHash,candidate:parseRangeKeeperPaperCandidate(b.candidate)});
 if(candidateHash!==b.candidateHash)
  throw new Error('rangekeeper_paper_recenter_candidate_hash_invalid');
 if(referenceProofHash(b.reference.proof)!==b.reference.proofHash||
  b.reference.proofHash!==b.candidateReferenceProofHash)
  throw new Error('rangekeeper_paper_recenter_reference_proof_invalid');
 if(b.poolState.sqrtPriceX96!==String(input.frame.sqrtPriceX96))
  throw new Error('rangekeeper_paper_recenter_pool_state_mismatch');
 const principal=principalAmounts({liquidity:BigInt(priorInventory.position.liquidity),
  tickLower:priorInventory.position.tickLower,tickUpper:priorInventory.position.tickUpper,
  sqrtPriceX96:input.frame.sqrtPriceX96});
 const withdrawal0=BigInt(b.withdrawal.amount0),withdrawal1=BigInt(b.withdrawal.amount1),
  collected0=BigInt(b.collected.amount0),collected1=BigInt(b.collected.amount1);
 if(withdrawal0!==principal.amount0||withdrawal1!==principal.amount1||
  collected0!==withdrawal0||collected1!==withdrawal1)
  throw new Error('rangekeeper_paper_recenter_withdrawal_replay_mismatch');
 let available0=BigInt(priorInventory.idle.token0)+collected0,
  available1=BigInt(priorInventory.idle.token1)+collected1;
 if(b.swap){
  if(contentHash(b.swap.source)!==contentHash(b.source)||b.swap.amountOut!==b.swap.quotedOut||
   BigInt(b.swap.amountOut)<BigInt(b.swap.minOut)||
   (b.candidate.swap===null||b.candidate.swap.token!==b.swap.token||
    b.candidate.swap.amountIn!==b.swap.amountIn||b.candidate.swap.quotedOut!==b.swap.quotedOut||
    b.candidate.swap.minOut!==b.swap.minOut||b.candidate.swap.priceAfter!==b.swap.priceAfter))
   throw new Error('rangekeeper_paper_recenter_swap_replay_mismatch');
  if(b.swap.token===0){available0-=BigInt(b.swap.amountIn);available1+=BigInt(b.swap.amountOut);}
  else{available1-=BigInt(b.swap.amountIn);available0+=BigInt(b.swap.amountOut);}
 }else if(b.candidate.swap!==null)throw new Error('rangekeeper_paper_recenter_missing_swap_evidence');
 if(available0<0n||available1<0n)throw new Error('rangekeeper_paper_recenter_inventory_underflow');
 const mintPrice=b.swap?BigInt(b.swap.priceAfter):input.frame.sqrtPriceX96;
 if(b.swap&&BigInt(b.candidate.swap!.priceAfter)!==mintPrice)
  throw new Error('rangekeeper_paper_recenter_post_swap_price_mismatch');
 const mint=replayPaperMint(mintPrice,b.candidate.range,
  BigInt(b.candidate.amount0Desired),BigInt(b.candidate.amount1Desired),0n),
  idle0=available0-mint.amount0,idle1=available1-mint.amount1,
  canonicalPrincipal=principalAmounts({liquidity:BigInt(b.candidate.liquidity),
   tickLower:b.candidate.range.tickLower,tickUpper:b.candidate.range.tickUpper,
   sqrtPriceX96:BigInt(b.poolState.sqrtPriceX96)}),
  kernel=kernelSchema.parse(b.kernelSnapshot),candidate=b.candidate;
 if(mint.liquidity!==BigInt(candidate.liquidity)||mint.amount0<BigInt(candidate.amount0Min)||
  mint.amount1<BigInt(candidate.amount1Min)||idle0<0n||idle1<0n||
  kernel.source.block!==b.source.block||kernel.source.hash.toLowerCase()!==b.source.hash.toLowerCase()||
  kernel.source.timestamp!==b.source.timestamp||kernel.recenters!==b.epoch||kernel.pending||
  kernel.wallet0!==String(idle0)||kernel.wallet1!==String(idle1)||
  kernel.released0!==String(canonicalPrincipal.amount0)||kernel.released1!==String(canonicalPrincipal.amount1)||
  kernel.campaignStartValue!==previousKernel.campaignStartValue||
  kernel.state.buildId!==previousKernel.state.buildId||
  kernel.state.configHash.toLowerCase()!==previousKernel.state.configHash.toLowerCase()||
  !b.modeledCosts||
  BigInt(kernel.rollingSpentCost)<BigInt(previousKernel.rollingSpentCost)||
  BigInt(kernel.campaignSpentCost)!==BigInt(previousKernel.campaignSpentCost)+BigInt(b.modeledCosts.boundValue)||
  BigInt(kernel.nativeWei)!==BigInt(previousKernel.nativeWei)-BigInt(b.modeledCosts.boundWei)||
  BigInt(kernel.nativeWei)<BigInt(b.modeledCosts.requiredReserveWei)||
  kernel.state.confirmation!==null||kernel.state.exit!==null)
  throw new Error('rangekeeper_paper_recenter_mint_or_kernel_replay_mismatch');
 const inventory={position:{tickLower:candidate.range.tickLower,tickUpper:candidate.range.tickUpper,
  liquidity:candidate.liquidity},idle:{token0:String(idle0),token1:String(idle1)}};
 if(contentHash(inventory)!==contentHash(b.inventory))
  throw new Error('rangekeeper_paper_recenter_result_inventory_mismatch');
 const provenance={classification:'rangekeeper_paper_recenter_v1',schemaVersion:1,
  campaignId:b.campaignId,revision:b.revision,
  previousEpoch:b.previousEpoch,epoch:b.epoch,priorMark:b.priorMark,source:b.source,
  poolState:b.poolState,reference:b.reference,
  mintSqrtPriceX96:String(mintPrice),
  retiredPosition:b.retiredPosition,withdrawal:b.withdrawal,collected:b.collected,swap:b.swap,
  candidate:candidateHashInput(candidate),candidateHash:b.candidateHash,
  candidateReferenceProofHash:b.candidateReferenceProofHash,allowancesCleared:true,
  initialModeledOpenCost:initialCost.data,
  fundingBeforeSwap:{token0:String(BigInt(priorInventory.idle.token0)+collected0),
   token1:String(BigInt(priorInventory.idle.token1)+collected1)},inventory,kernelSnapshot:kernel,
  modelHash:b.modelHash,simulationHash:b.simulationHash,paidCostsAvailable:false,modeledCosts:b.modeledCosts};
 return {inventory,provenance,ledger:{kind:'rangekeeper_paper_recenter_model_v1',
  fromEpoch:b.previousEpoch,toEpoch:b.epoch,source:b.source,modeledCosts:b.modeledCosts,
  paidCostsAvailable:false,capitalIn:'0'}};
}

function candidateHashInput(candidate:z.infer<typeof candidateSchema>){
 return {kind:candidate.kind,range:candidate.range,swap:candidate.swap,
  amount0Desired:candidate.amount0Desired,amount1Desired:candidate.amount1Desired,
  amount0Min:candidate.amount0Min,amount1Min:candidate.amount1Min,
  liquidity:candidate.liquidity,deployedValue:candidate.deployedValue,
  sourceBlock:candidate.sourceBlock,sourceHash:candidate.sourceHash,expiresAt:candidate.expiresAt};
}
