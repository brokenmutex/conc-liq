import {randomUUID} from 'node:crypto';
import {AssertionError} from 'node:assert';
import pg,{type PoolClient} from 'pg';
import {assertDeploymentSchemaReady} from '../storage/compatibility.js';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../paper/execution-abi.js';
import {principalAmounts} from '../backtest/principal.js';
import {acceptInput,allocationSchema,contentHash,draftInput,parseStrategyParameters,previewDigest,previewInput,
 staticManualParameters,strategyId,type AcceptInput,type DraftInput,type PreviewInput} from './contracts.js';
import {marketProfileEvidenceSchema,marketProfileSchema,referenceProofHash,verifiedMarketProfileSchema,
 type VerifiedMarketProfile} from './market-profile.js';
import {PAPER_STATIC_GAS_PATH,costIndicativePaperOpenPreview,paperGasEvidenceClassFor,
 paperGasModelSchema,type PaperGasProfileRow} from './paper-cost.js';
import {PAPER_STATIC_GAS_STAGES} from './paper-cost.js';
import {RANGEKEEPER_PAPER_NO_SWAP_PATH,RANGEKEEPER_PAPER_DIRECT_SWAP_PATH,
 RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH} from './rangekeeper-paper-cost.js';
import {buildIndicativePaperOpenPreview} from './paper-preview.js';
import {buildPaperOpenModel,paperOpenModelSchema} from './paper-open-model.js';
import {resolveRangeKeeperPaperPolicy} from './rangekeeper-paper-open-model.js';
import {buildPaperCloseRetainModel,paperCloseRetainModelSchema} from './paper-close-model.js';
import {buildPaperCloseConvertModel,costPaperCloseConvert,paperCloseConvertModelSchema,
 PAPER_STATIC_CONVERT_GAS_PATH,paperCloseConvertQuoteSchema,
 costPaperCloseConvertGasV2,paperCloseConvertGasScopeV2Schema,
 paperCloseConvertGasScopeHashV2,paperCloseConvertGasSizeBandV2,
 paperCloseConvertGasAllowanceStatesV2,PAPER_STATIC_CONVERT_GAS_PATH_V2,
 PAPER_STATIC_CONVERT_GAS_STAGES_V2,
 type PaperCloseConvertModel,type PaperCloseConvertQuote,
 type PaperCloseConvertCostsV2,type PaperCloseConvertGasScopeV2} from './paper-close-convert-model.js';
import {buildPaperPrincipalValuation,paperPrincipalValuationSchema} from './paper-valuation.js';
import {verifyPaperGasEvidence,verifyPaperCloseConvertGasEvidence} from './paper-gas-evidence.js';
import {advancePaperFeeCarry,type CanonicalPaperFeeInterval,type PaperFeeCarry} from './paper-fee-replay.js';
import {registerProspectivePaperCloseConvertPrestateGasProfiles} from
 './paper-close-convert-prestate-gas-importer.js';
import {PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1} from
 './paper-close-convert-prestate-gas-profiles.js';
import type {PaperCloseConvertPrestateGasProfileRow} from './paper-close-convert-prestate-costs.js';
import type {EphemeralStaticPaperCloseConvertFeeReplay} from './paper-close-convert-ephemeral-fees.js';
import {parsePaperStaticCloseConvertTerminalV3,
 type PaperStaticCloseConvertTerminalModel} from './paper-close-convert-preflight.js';
import {selectPaperCloseConvertPrestateCostsV1} from './paper-close-convert-prestate-costs.js';
import {PaperPreparationLeaseRegistry,paperPreparationLockName} from './paper-preparation-lease.js';
import type {PaperOpenModel} from './paper-open-model.js';
import type {MarketProfile} from './market-profile.js';
import {buildPaperAccounting,paperAccountingSchema,buildPaperConversionAccounting,
 paperConversionAccountingSchema,paperAccountingFromConversionSnapshot,PAPER_ACCOUNTING_POLICY,
 PAPER_CONVERSION_ACCOUNTING_POLICY,PAPER_CONVERSION_ACCOUNTING_POLICY_V2,
 PAPER_CONVERSION_ACCOUNTING_POLICY_V3,paperConversionAccountingV2Schema,
 paperConversionAccountingV3Schema,buildPaperConversionAccountingV2,
 buildPaperConversionAccountingV3,assertPaperConversionV3GasWithinReserve,
 paperAccountingFromConversionV2Snapshot,RANGEKEEPER_PAPER_ACCOUNTING_POLICY,
 rangeKeeperPaperAccountingSchema,rangeKeeperPaperReferenceProofFresh,
 type RangeKeeperPaperAccounting} from './paper-accounting.js';
import {loadRuntimeIdentity,type RuntimeIdentity} from '../runtime/identity.js';
import type {RobinhoodClient} from '../client.js';
import type {PaperCloseConvertGasPersistedEvidence} from './paper-gas-source.js';
import type {PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import {verifyCanonicalPaperAnchors} from './paper-canonical-anchors.js';
import {loadRangeKeeperPaperExitContext} from './rangekeeper-paper-context.js';
import {buildRangeKeeperPaperEpochObservationPayload,buildRangeKeeperPaperMarkPayload,
 parseRangeKeeperPaperState,serializeRangeKeeperPaperCandidate,serializeRangeKeeperPaperKernelSnapshot,
 buildRangeKeeperPaperRecenterBooking,type RangeKeeperPaperMarkPayload,
 validateRangeKeeperPaperRecenterBooking,validateRangeKeeperPaperConfirmationEnvelope} from
 './rangekeeper-paper-persistence.js';
import {buildRangeKeeperPaperConfirmedOpenInventory,
 createRangeKeeperPaperConfirmedOpenRecord,validateRangeKeeperPaperConfirmedOpenRecord,
 type RangeKeeperPaperConfirmedOpenAdapterResult} from './rangekeeper-paper-confirmed-open-adapter.js';
import {adaptRangeKeeperConfirmedOpenContext} from './rangekeeper-paper-confirmed-open-adapter.js';
import {isRangeKeeperPaperConfirmationReplayCapability,
 type RangeKeeperPaperConfirmationReplayResult} from './rangekeeper-paper-confirmation-replay-verifier.js';
import {loadRangeKeeperPaperConfirmationContext} from './rangekeeper-paper-confirmation-context.js';
import {buildRangeKeeperPaperConfirmationProducerReceipt,
 isRangeKeeperPaperServerProduced,validateRangeKeeperPaperConfirmationProducerReceipt}
 from './rangekeeper-paper-confirmation-provenance.js';
import {buildRangeKeeperPaperConfirmation,type RangeKeeperPaperConfirmationSimulation,
 type RangeKeeperPaperConfirmationPreparation}
 from './rangekeeper-paper-confirmation.js';
import type {RangeKeeperPaperPinnedQuoteCache} from './rangekeeper-paper-pinned-quote-cache.js';
import {rangeKeeperPaperGasProfileInserts,verifyRangeKeeperPaperGasReport,
 verifyRangeKeeperPaperGasEvidenceSource,
 type RangeKeeperPaperGasSourceReplayVerifier} from './rangekeeper-paper-gas-evidence.js';
import {rangeKeeperPaperCloseRetainModelBookingSchema,
 buildRangeKeeperPaperCloseRetainBooking} from './rangekeeper-paper-exit-completion.js';
import {assertRangeKeeperPaperConvertReplayCapability,
 type RangeKeeperPaperConvertReplayCapability} from './rangekeeper-paper-convert-replay.js';
import {assertRangeKeeperPaperRecenterReplayCapability,
 type RangeKeeperPaperRecenterReplayCapability} from './rangekeeper-paper-recenter-replay.js';
import type {PaperOpenFrame} from './paper-preview.js';
import {z} from 'zod';

const paperGasAttestationSchema=z.object({
 verificationClass:z.literal('canonical_candidate_replay_v1'),
 reportHash:z.string().regex(/^[0-9a-f]{64}$/),
 sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 verifiedAt:z.iso.datetime({offset:true}),
}).strict();
const paperCloseConvertGasAttestationSchema=z.object({
 verificationClass:z.literal('canonical_close_convert_gas_replay_v2'),
 evidenceClass:z.literal('fork_estimated'),status:z.literal('provisional'),
 reportHash:z.string().regex(/^[0-9a-f]{64}$/),
 sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 scopeHash:z.string().regex(/^[0-9a-f]{64}$/),sequenceHash:z.string().regex(/^[0-9a-f]{64}$/),
 postWithdrawReplayHash:z.string().regex(/^[0-9a-f]{64}$/),
 sourceReplayHash:z.string().regex(/^[0-9a-f]{64}$/),
 ownedForkReplayBudget:z.object({requests:z.number().int().nonnegative(),
  rejected:z.number().int().nonnegative(),maxRequests:z.number().int().positive()}).strict(),
 runtimeIdentity:z.object({buildId:z.string().regex(/^[a-f0-9]{64}$/),
  configHash:z.string().regex(/^[a-f0-9]{64}$/),nodeVersion:z.string().min(1)}).strict(),
 verifiedAt:z.iso.datetime({offset:true}),
}).strict();
const rangeKeeperPaperGasAttestationSchema=z.object({
 verificationClass:z.literal('rangekeeper_paper_candidate_replay_v1'),
 reportHash:z.string().regex(/^[0-9a-f]{64}$/),
 sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 candidateHash:z.string().regex(/^[0-9a-f]{64}$/),
 replayHash:z.string().regex(/^[0-9a-f]{64}$/),
 verifiedAt:z.iso.datetime({offset:true}),
}).strict();
const sealedRuntimeIdentitySchema=z.object({buildId:z.string().regex(/^[a-f0-9]{64}$/),
 configHash:z.string().regex(/^[a-f0-9]{64}$/),nodeVersion:z.string().min(1)}).strict();
const paperFeeMarkSourceSchema=z.object({
 block:z.string().regex(/^(0|[1-9][0-9]*)$/),
 hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 timestamp:z.number().int().nonnegative(),
}).strict();
const paperFeeRangeSchema=z.union([
 z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 z.object({tickLower:z.number().int(),tickUpper:z.number().int(),
  fullWidthTicks:z.number().int(),requestedLower:z.number().int(),requestedUpper:z.number().int(),
  rounded:z.boolean()}).strict(),
]);
const paperFeeMarkStateSchema=z.object({tick:z.number().int(),
 sqrtPriceX96:z.string().regex(/^(0|[1-9][0-9]*)$/),
 poolLiquidity:z.string().regex(/^(0|[1-9][0-9]*)$/)}).strict();
const paperFeePositionSchema=z.object({tickLower:z.number().int(),tickUpper:z.number().int(),
 liquidity:z.string().regex(/^[1-9][0-9]*$/)}).passthrough();
const paperFeeCarrySchema=z.object({kind:z.literal('paper_fee_carry_v1'),pool:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
 token0Address:z.string().regex(/^0x[0-9a-fA-F]{40}$/),token1Address:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
 fee:z.number().int().positive(),tickSpacing:z.number().int().positive(),
 range:paperFeeRangeSchema,
 liquidity:z.string().regex(/^[1-9][0-9]*$/),stream:z.string().min(1),
 targetSetHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 from:paperFeeMarkSourceSchema.pick({block:true,hash:true}),through:paperFeeMarkSourceSchema.pick({block:true,hash:true}),
 token0:z.object({lowerRawQ128:z.string().regex(/^(0|[1-9][0-9]*)$/),
  upperRawQ128:z.string().regex(/^(0|[1-9][0-9]*)$/),lowerAmountRaw:z.string().regex(/^(0|[1-9][0-9]*)$/),
  upperAmountRaw:z.string().regex(/^(0|[1-9][0-9]*)$/)}).strict(),
 token1:z.object({lowerRawQ128:z.string().regex(/^(0|[1-9][0-9]*)$/),
  upperRawQ128:z.string().regex(/^(0|[1-9][0-9]*)$/),lowerAmountRaw:z.string().regex(/^(0|[1-9][0-9]*)$/),
  upperAmountRaw:z.string().regex(/^(0|[1-9][0-9]*)$/)}).strict(),
 intervals:z.number().int().positive(),events:z.number().int().nonnegative(),segments:z.number().int().nonnegative(),
 partialSegments:z.number().int().nonnegative(),accounting:z.literal('modeled_hypothetical_fee_share')}).strict();
const paperFeeIntervalAnchorSchema=z.object({block:z.string().regex(/^(0|[1-9][0-9]*)$/),
 hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/)}).strict();
const canonicalPaperFeeIntervalSchema=z.object({kind:z.literal('paper_observed_flow_fee_interval_v1'),
 pool:z.string().regex(/^0x[0-9a-fA-F]{40}$/),token0Address:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
 token1Address:z.string().regex(/^0x[0-9a-fA-F]{40}$/),fee:z.number().int().positive(),tickSpacing:z.number().int().positive(),
 from:paperFeeIntervalAnchorSchema,to:paperFeeIntervalAnchorSchema,
 range:paperFeeRangeSchema,
 liquidity:z.string().regex(/^[1-9][0-9]*$/),
 token0:paperFeeCarrySchema.shape.token0,token1:paperFeeCarrySchema.shape.token1,
 events:z.number().int().nonnegative(),segments:z.number().int().nonnegative(),
 partialSegments:z.number().int().nonnegative(),accounting:z.literal('modeled_hypothetical_fee_share'),
 coverage:z.object({stream:z.string().min(1),targetSetHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  completeThroughBlock:z.string().regex(/^(0|[1-9][0-9]*)$/),completeThroughHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable(),
  chainAnchorRecheckRequired:z.literal(false)}).strict()}).strict();

async function replayPaperCloseConvert(db:PoolClient,model:PaperCloseConvertModel,
 open:PaperOpenModel,profile:MarketProfile,parameters:Record<string,unknown>,now:number){
 const profileIds=model.costs.stages.map(stage=>stage.profileId),
  gasRows=(await db.query<PaperGasProfileRow>(`
   SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
    allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
    evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
    observed_until AS "observedUntil"
   FROM deployment_calibration_profiles WHERE id=ANY($1::uuid[])`,[profileIds])).rows;
 let costs;
 try{costs=costPaperCloseConvert(gasRows,profile.pool.pool,open.candidate,
  BigInt(model.reference.nativePrice),BigInt(model.costs.gasPriceWei),
  Date.parse(model.costs.gasPriceObservedAt));}
 catch{throw new DeploymentConflict('paper_close_convert_gas_profiles_invalid');}
 const frame={source:model.source,tick:model.poolState.tick,
  sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),
  poolLiquidity:BigInt(model.poolState.poolLiquidity),
  price0:BigInt(model.reference.price0),price1:BigInt(model.reference.price1),
  nativePrice:BigInt(model.reference.nativePrice),referenceEligible:true,
  referenceReasons:[],referenceProofHash:model.referenceProofHash,
  referenceProof:model.referenceProof};
 let rebuilt:PaperCloseConvertModel;
 try{rebuilt=buildPaperCloseConvertModel(open,model.openMarkId,
  {markId:model.previousMarkId,sourceBlock:model.previousSource.block,
   sourceHash:model.previousSource.hash},frame,profile,parameters,
  model.conversionRoute,costs,now);}
 catch{throw new DeploymentConflict('paper_close_convert_model_replay_invalid');}
 if(contentHash(costs)!==contentHash(model.costs)||contentHash(rebuilt)!==contentHash(model))
  throw new DeploymentConflict('paper_close_convert_model_changed');
 return {profileIds,costs,rebuilt};
}

async function campaignEffectiveRuntimeIdentity(db:PoolClient,campaignId:string,stored:unknown){
 const parsed=sealedRuntimeIdentitySchema.safeParse(stored);
 if(!parsed.success)return null;
 const rows=(await db.query<{entry_key:string;source:Record<string,unknown>}>(`
  SELECT entry_key,source FROM deployment_ledger WHERE campaign_id=$1 AND kind='attribution_boundary'
   AND entry_key LIKE 'rangekeeper_runtime_adoption:%' ORDER BY id`,[campaignId])).rows;
 let expected:unknown=parsed.data;
 for(const row of rows){
  const source=row.source,adoptionHash=source.adoptionHash,actor=source.actor;
  if(typeof adoptionHash!=='string'||typeof actor!=='string')return null;
  const {adoptionHash:_hash,actor:_actor,...body}=source;
  const from=sealedRuntimeIdentitySchema.safeParse((body as Record<string,unknown>).fromRuntimeIdentity),
   to=sealedRuntimeIdentitySchema.safeParse((body as Record<string,unknown>).toRuntimeIdentity),
   fromHash=(body as Record<string,unknown>).fromIdentityHash,
   toHash=(body as Record<string,unknown>).toIdentityHash;
  if(contentHash(body)!==adoptionHash||row.entry_key!==`rangekeeper_runtime_adoption:${adoptionHash}`||
   !body||typeof body!=='object'||(body as Record<string,unknown>).kind!==
    'rangekeeper_paper_runtime_adoption_v1'||
   !from.success||!to.success||fromHash!==contentHash(from.data)||toHash!==contentHash(to.data)||
   from.data.configHash!==to.data.configHash||from.data.nodeVersion!==to.data.nodeVersion||
   contentHash(from.data)!==contentHash(expected))return null;
  expected=to.data;
 }
 const final=sealedRuntimeIdentitySchema.safeParse(expected);
 return final.success?final.data:null;
}
async function campaignRuntimeMatches(db:PoolClient,campaignId:string,stored:unknown,
 current:ReturnType<typeof loadRuntimeIdentity>):Promise<boolean>{
 if(!current)return false;
 const effective=await campaignEffectiveRuntimeIdentity(db,campaignId,stored);
 return !!effective&&contentHash(effective)===contentHash(current);
}
function rangeKeeperRuntimeAdoptionProjection(rows:readonly {source:Record<string,unknown>}[]){
 if(!rows.length)return null;
 const adoptionChain=rows.map(({source})=>({
  fromBuildId:(source.fromRuntimeIdentity as Record<string,unknown>|undefined)?.buildId,
  toBuildId:(source.toRuntimeIdentity as Record<string,unknown>|undefined)?.buildId,
  adoptionHash:source.adoptionHash,
  latestMarkHash:(source.latestMark as Record<string,unknown>|undefined)?.markHash,
  compatibilityProof:source.compatibilityProof}));
 const first=adoptionChain[0]!,last=adoptionChain.at(-1)!;
 return {adoptedFromBuildId:first.fromBuildId,adoptionHash:last.adoptionHash,
  latestMarkHash:last.latestMarkHash,compatibilityProof:last.compatibilityProof,adoptionChain};
}

function rangeKeeperTerminalInventoryHash(context:Awaited<ReturnType<typeof loadRangeKeeperPaperExitContext>>,
 report:ReturnType<typeof verifyRangeKeeperPaperGasReport>):string{
 if(context.status!=='available')throw new DeploymentConflict('rangekeeper_paper_exit_gas_context_unavailable');
 const c=report.candidate as {range:{tickLower:number;tickUpper:number};liquidity:string},
  k=context.kernel,e=context.currentEpoch,
  principal=principalAmounts({liquidity:BigInt(c.liquidity),tickLower:c.range.tickLower,
   tickUpper:c.range.tickUpper,sqrtPriceX96:BigInt(report.frame.sqrtPriceX96)});
 return contentHash({kind:'range_keeper_paper_terminal_inventory_v1',currentEpoch:{epoch:e.epoch,
  markId:e.markId,markHash:e.markHash,candidateSource:e.source,candidateHash:e.candidateHash,
  candidateReferenceProofHash:e.candidateReferenceProofHash,inventory:e.inventory,
  mintSqrtPriceX96:String(e.mintSqrtPriceX96),fundingBeforeSwap:e.fundingBeforeSwap},
  source:report.frame.source,inventoryProofHash:k.inventoryProofHash,
  wallet0:String(k.wallet0),wallet1:String(k.wallet1),released0:String(k.released0),
  released1:String(k.released1),nativeWei:String(k.nativeWei),
  position:{tickLower:c.range.tickLower,tickUpper:c.range.tickUpper,liquidity:String(c.liquidity)},
  principal0:String(principal.amount0),principal1:String(principal.amount1),
  idle0:context.previous.idle.token0,idle1:context.previous.idle.token1,
  terminal0:String(k.wallet0+k.released0),terminal1:String(k.wallet1+k.released1)});
}

/** Accepts only the historical pre-normalization opening observation shape.
 * It is read-only: the exact full-native/zero-cost baseline is validated, and
 * callers must still use the strict writer to append the first normalized
 * observation with its one-time modeled open-cost debit. */
function validateLegacyRangeKeeperInitialObservation(input:{provenance:Record<string,unknown>;
 inventory:unknown;openModel:Record<string,unknown>;allocation:{token0Raw:string;token1Raw:string;nativeWei:string};
 source:{block:string;hash:string;timestamp:number}}){
 const p=input.provenance,saved=p.kernelSnapshot as Record<string,unknown>|undefined,
  pool=p.poolState as {sqrtPriceX96?:unknown}|undefined,
  position=(input.inventory as {position?:unknown}|null)?.position as
   {tickLower?:unknown;tickUpper?:unknown;liquidity?:unknown}|undefined,
  idle=(input.inventory as {idle?:unknown}|null)?.idle as {token0?:unknown;token1?:unknown}|undefined;
 if(p.classification!=='rangekeeper_paper_mark_v1'||(p.epoch??0)!==0||
  p.initialModeledOpenCost!==undefined||p.candidateHash!==input.openModel.candidateHash||
  !saved||!pool||typeof pool.sqrtPriceX96!=='string'||!position||!idle)
  throw new Error('legacy initial observation shape invalid');
 const state=parseRangeKeeperPaperState(saved.state),normalized=serializeRangeKeeperPaperKernelSnapshot({
  source:input.source,state,wallet0:BigInt(String(saved.wallet0)),wallet1:BigInt(String(saved.wallet1)),
  released0:BigInt(String(saved.released0)),released1:BigInt(String(saved.released1)),
  nativeWei:BigInt(String(saved.nativeWei)),campaignStartValue:BigInt(String(saved.campaignStartValue)),
  highWaterValue:BigInt(String(saved.highWaterValue)),rollingSpentCost:BigInt(String(saved.rollingSpentCost)),
  campaignSpentCost:BigInt(String(saved.campaignSpentCost)),reservedCost:BigInt(String(saved.reservedCost)),
  recenters:Number(saved.recenters),pending:saved.pending===true,entryAllowed:saved.entryAllowed===true,
  safeExitRequired:saved.safeExitRequired===true,executionReady:saved.executionReady===true}),
  principal=principalAmounts({liquidity:BigInt(String(position.liquidity)),
   tickLower:Number(position.tickLower),tickUpper:Number(position.tickUpper),
   sqrtPriceX96:BigInt(pool.sqrtPriceX96)});
 if(contentHash(normalized)!==contentHash(saved)||state.buildId!==input.openModel.kernelBuildId||
  state.configHash.toLowerCase()!==`0x${String(input.openModel.kernelPolicyHash)}`.toLowerCase()||
  normalized.source.block!==input.source.block||normalized.source.hash.toLowerCase()!==input.source.hash.toLowerCase()||
  normalized.recenters!==0||normalized.pending||normalized.wallet0!==String(idle.token0)||
  normalized.wallet1!==String(idle.token1)||normalized.released0!==String(principal.amount0)||
  normalized.released1!==String(principal.amount1)||normalized.campaignSpentCost!=='0'||
  normalized.rollingSpentCost!=='0'||normalized.nativeWei!==input.allocation.nativeWei)
  throw new Error('legacy initial observation baseline invalid');
 return normalized;
}
function rangeKeeperPositionIdleProjection(value:unknown){
 return z.object({position:z.object({tickLower:z.number().int(),tickUpper:z.number().int(),
  liquidity:z.string().regex(/^[1-9][0-9]*$/)}),
  idle:z.object({token0:z.string().regex(/^(0|[1-9][0-9]*)$/),
   token1:z.string().regex(/^(0|[1-9][0-9]*)$/)})}).parse(value);
}

function closeConvertGasScopeV2(profile:MarketProfile,open:PaperOpenModel,
 model:PaperCloseConvertModel,inventory:{token0Raw:string;token1Raw:string}):PaperCloseConvertGasScopeV2{
 const residual0=BigInt(open.candidate.amount0Desired)-BigInt(open.candidate.amount0Minted),
  residual1=BigInt(open.candidate.amount1Desired)-BigInt(open.candidate.amount1Minted);
 if(residual0<0n||residual1<0n)throw new DeploymentConflict('paper_close_convert_open_allowance_invalid');
 const inputAmountRaw=model.conversionRoute.inputAsset==='token0'?inventory.token0Raw:inventory.token1Raw;
 return paperCloseConvertGasScopeV2Schema.parse({poolAddress:profile.pool.pool,
  profileHash:open.profileHash,openModelHash:contentHash(open),candidate:{
   deployedValue:open.candidate.deployedValue,sharePpm:open.candidate.dilutedSharePpm,
   tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
   liquidity:open.candidate.liquidity},routeHash:model.conversionRoute.routeHash,
  inputAsset:model.conversionRoute.inputAsset,inputAmountRaw,
  inventory:{token0Raw:inventory.token0Raw,token1Raw:inventory.token1Raw},
  initialAllowances:{manager0:String(residual0),manager1:String(residual1),router0:'0',router1:'0'}});
}

export class DeploymentConflict extends Error {
 constructor(public readonly code:string){super(code);}
}

type DraftRequestOutcome={status:'conflict'}|{status:'found';id:string;revision:number;configHash:string}|null;
function deploymentDraftValues(raw:DraftInput){
 const input=draftInput.parse(raw),config={...parseStrategyParameters(input.strategyId,input.config),
  strategyId:input.strategyId,strategyVersion:input.strategyVersion,stateSchemaVersion:input.stateSchemaVersion};
 return {input,config,configHash:contentHash(config),wallet:input.wallet.toLowerCase()};
}
async function matchDraftRequest(db:Pick<PoolClient,'query'>,id:string,raw:DraftInput):Promise<DraftRequestOutcome>{
 const {input,configHash,wallet}=deploymentDraftValues(raw);
 const row=(await db.query<{id:string;mode:string;chain_id:number;wallet:string;market_profile_id:string;
  allocation:unknown;strategy_id:string;revision:number;config:unknown;
  config_hash:string}>(`SELECT c.id,c.mode,c.chain_id,c.wallet,c.market_profile_id,c.allocation,
   r.revision,r.strategy_id,r.config,r.config_hash
   FROM deployment_campaigns c JOIN deployment_revisions r
    ON r.campaign_id=c.id AND r.revision=1 WHERE c.id=$1`,[id])).rows[0];
 if(!row)return null;
 const allocation=allocationSchema.safeParse(row.allocation);
 let configMatches=false,allocationMatches=false;
 try{configMatches=row.config!==null&&typeof row.config==='object'&&!Array.isArray(row.config)&&
   contentHash(row.config)===configHash;}catch{}
 try{allocationMatches=allocation.success&&contentHash(allocation.data)===contentHash(input.allocation);}catch{}
 const matches=row.id===id&&row.mode===input.mode&&row.chain_id===input.chainId&&
  row.wallet.toLowerCase()===wallet&&row.market_profile_id===input.marketProfileId&&
  row.revision===1&&row.strategy_id===input.strategyId&&
  row.config_hash===configHash&&configMatches&&allocationMatches;
 return matches?{status:'found',id:row.id,revision:1,configHash:row.config_hash}:
  {status:'conflict'};
}

/** Shared advisory lease held by explicitly enabled paper operation workers.
 * The command runtime reads the matching granted ShareLock in pg_locks.
 * Keep separate from maintenance lock 18727. */
export const PAPER_OPERATION_READINESS_LOCK=[4663,18728] as const;
export const PAPER_OPERATION_NOTIFY_CHANNEL='deployment_operation_accepted' as const;
export const PAPER_OPERATION_TRANSIENT_RETRY_BACKOFF_SECONDS=30;

export interface PaperAccountingAnchor {
 accountingId:string;markId:string;block:string;hash:string;timestamp:number;
}
export interface PaperAccountingAnchorMismatch {
 accountingId:string;actual:{hash:string;timestamp:number};
}

/** Exact open-preview authority held only while a producer prepares a
 * confirmation and atomically publishes its proof and producer receipt. */
const preparedRangeKeeperConfirmationBindings=new WeakMap<object,{campaignId:string;revision:number;
 openPreviewId:string;previewDigest:string;expiresAtMs:number;owner:object}>();

/** The new command ledger. It owns no signer and performs no startup DDL. */
export class DeploymentStore {
 private readonly pool:pg.Pool;
 private readonly readPool:pg.Pool;
 private readonly paperPreparationLeasePool:pg.Pool;
 private readonly paperPreparationLeases:PaperPreparationLeaseRegistry;
 private readonly rangeKeeperProducerStoreToken=Object.freeze({});
 constructor(connectionString:string){
  this.pool=new pg.Pool({connectionString,max:3,statement_timeout:15000});
  // Retained review leases must never consume transaction clients. Two
  // campaigns may hold preparations at once; further checkouts fail fast.
  this.paperPreparationLeasePool=new pg.Pool({connectionString,max:2,
   connectionTimeoutMillis:1_000,statement_timeout:5_000});
  this.paperPreparationLeases=new PaperPreparationLeaseRegistry(this.paperPreparationLeasePool);
  const readUrl=new URL(connectionString);
  readUrl.searchParams.set('options',`${readUrl.searchParams.get('options')??''} -c default_transaction_read_only=on`.trim());
  this.readPool=new pg.Pool({connectionString:readUrl.toString(),max:2,statement_timeout:15000});
 }

 /** Restart-safe worker view for exactly one already-claimed RangeKeeper exit.
  * The context loader excludes only this operation after the claim has been
  * checked; every other pending operation still makes the view unavailable. */
 async rangeKeeperPaperExitOperationSnapshot(campaignId:string,operationId:string,workerId:string){
  if(!z.uuid().safeParse(campaignId).success||!z.uuid().safeParse(operationId).success||
   !/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))
   throw new DeploymentConflict('rangekeeper_paper_exit_operation_snapshot_unavailable');
  const row=(await this.readPool.query<{campaign_id:string;preview_id:string;kind:string;status:string;
   claimed_by:string|null;claim_until:Date|null;claim_valid:boolean|null;current_revision:number;
   request_digest:string;idempotency_key:string;preview_kind:string;expected_revision:number;
   content_digest:string;expires_at:Date;request:Record<string,unknown>;
   proposal:Record<string,unknown>;evidence:Record<string,unknown>;accepted_at:Date;
   runtime_identity:unknown}>(`
   SELECT o.campaign_id,o.preview_id::text,o.kind,o.status,o.claimed_by,o.claim_until,
    (o.claim_until>=clock_timestamp()) AS claim_valid,o.request_digest,o.idempotency_key,
    c.current_revision,c.runtime_identity,v.kind AS preview_kind,v.expected_revision,v.content_digest,v.expires_at,
    v.request,v.proposal,v.evidence,o.created_at AS accepted_at
   FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
   JOIN deployment_previews v ON v.id=o.preview_id
   WHERE o.id=$1 AND o.campaign_id=$2`,[operationId,campaignId])).rows[0];
  if(!row||row.status!=='reconciling'||row.claimed_by!==workerId||!row.claim_valid||
   !(['close_retain','close_convert','change_range'] as string[]).includes(row.kind)||row.preview_kind!==row.kind||
   row.expected_revision!==row.current_revision||row.accepted_at.getTime()>row.expires_at.getTime()||
   previewDigest({campaignId,expectedRevision:row.expected_revision,
    kind:row.preview_kind as 'close_retain'|'close_convert'|'change_range',
    request:row.request,proposal:row.proposal,evidence:row.evidence,expiresAt:row.expires_at})!==row.content_digest)
   throw new DeploymentConflict('rangekeeper_paper_exit_operation_snapshot_unavailable');
  const epochSnapshot=await this.rangeKeeperPaperEpochSnapshot(campaignId,operationId) as Record<string,unknown>;
  if(epochSnapshot.kind!=='rangekeeper_paper_epoch_snapshot_v1')
   throw new DeploymentConflict('rangekeeper_paper_exit_operation_epoch_unavailable');
  const exitContext=row.kind==='change_range'?{status:'not_required',campaignId}:
   await this.rangeKeeperPaperExitContextSnapshot(campaignId,operationId) as Record<string,unknown>;
  if(row.kind!=='change_range'&&(exitContext.status==='unavailable'||exitContext.campaignId!==campaignId))
   throw new DeploymentConflict('rangekeeper_paper_exit_operation_context_unavailable');
  const runtime=sealedRuntimeIdentitySchema.safeParse(epochSnapshot.runtimeIdentity);
  if(!runtime.success)throw new DeploymentConflict('rangekeeper_paper_exit_runtime_mismatch');
  const body={schemaVersion:1,kind:'rangekeeper_paper_exit_operation_snapshot_v1',campaignId,
   revision:row.current_revision,runtimeIdentity:runtime.data,
   operation:{id:operationId,previewId:row.preview_id,kind:row.kind,status:row.status,
    revision:row.current_revision,idempotencyKey:row.idempotency_key,requestDigest:row.request_digest,
    request:row.request,proposal:row.proposal,acceptedAt:row.accepted_at.toISOString(),
    contentDigest:row.content_digest,expiresAt:row.expires_at.toISOString(),
    claim:{workerId,valid:true}},exitContext,epochSnapshot};
  // Catch an operation/claim transition that raced the independent context
  // read. Completion still rechecks under the campaign and operation locks.
  const latest=(await this.readPool.query<{status:string;claimed_by:string|null;valid:boolean|null;
   preview_id:string;request_digest:string}>(`SELECT status,claimed_by,
   (claim_until>=clock_timestamp()) AS valid,preview_id::text,request_digest
   FROM deployment_operations WHERE id=$1 AND campaign_id=$2`,[operationId,campaignId])).rows[0];
  if(!latest||latest.status!=='reconciling'||latest.claimed_by!==workerId||!latest.valid||
   latest.preview_id!==row.preview_id||latest.request_digest!==row.request_digest)
   throw new DeploymentConflict('rangekeeper_paper_exit_operation_claim_lost');
  return {...body,snapshotHash:contentHash(body)};
 }
 async rangeKeeperPaperRecenterOperationSnapshot(campaignId:string,operationId:string,workerId:string){
  const snapshot=await this.rangeKeeperPaperExitOperationSnapshot(campaignId,operationId,workerId) as
   Record<string,unknown>;
  if((snapshot.operation as Record<string,unknown>|undefined)?.kind!=='change_range')
   throw new DeploymentConflict('rangekeeper_paper_recenter_operation_unavailable');
  return snapshot;
 }
 async assertReady(){await assertDeploymentSchemaReady(this.readPool);}
 async close(){try{await this.paperPreparationLeases.close();}
  finally{await Promise.all([this.pool.end(),this.readPool.end(),this.paperPreparationLeasePool.end()]);}}

 private async assertPaperPreparationMutationAllowed(db:pg.PoolClient,campaignId:string){
  const row=(await db.query<{acquired:boolean}>(
   'SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS acquired',
   [paperPreparationLockName(campaignId)])).rows[0];
  if(row?.acquired!==true)throw new DeploymentConflict('paper_preparation_locked');
 }

 async acquireStaticPaperCloseConvertPreparationLease(campaignId:string,maxLifetimeMs=300_000){
  return this.paperPreparationLeases.acquire(campaignId,maxLifetimeMs);
 }
 async acquirePaperPreparationLease(campaignId:string,maxLifetimeMs=300_000){
  return this.paperPreparationLeases.acquire(campaignId,maxLifetimeMs);
 }
 async releasePaperPreparationLease(campaignId:string){
  await this.paperPreparationLeases.release(campaignId);
 }
 async releaseStaticPaperCloseConvertPreparationLease(campaignId:string){
  await this.paperPreparationLeases.release(campaignId);
 }
 async staticPaperCloseConvertPreparationReady(campaignId:string){
  return this.paperPreparationLeases.isHealthy(campaignId);
 }

 async paperOperationWorkerReady(){
  // Inspect the actual worker's shared lease without taking a competing lock:
  // concurrent command requests must not mistake each other's probe lock for
  // a connected worker. pg_locks is visible to ordinary sessions.
  const result=await this.readPool.query<{ready:boolean}>(`
   SELECT EXISTS(SELECT 1 FROM pg_locks
    WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database
      WHERE datname=current_database())
      AND classid=$1::oid AND objid=$2::oid AND objsubid=2
      AND mode='ShareLock' AND granted) AS ready`,[...PAPER_OPERATION_READINESS_LOCK]);
  if(typeof result.rows[0]?.ready!=='boolean')
   throw new DeploymentConflict('paper_operation_readiness_probe_invalid');
  return result.rows[0].ready;
 }

 private async transaction<T>(work:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   try{const value=await work(db);await db.query('COMMIT');return value;}
   catch(error){await db.query('ROLLBACK');throw error;}
  }finally{db.release();}
 }

 /** Called only with a fresh canonical proof from verifyMarketProfile. The
  * indexer identity must agree before a profile can enter the draft catalog. */
 async registerVerifiedMarketProfile(raw:VerifiedMarketProfile){
  const proof=verifiedMarketProfileSchema.parse(raw),p=proof.profile.pool;
  const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  if(proof.profileHash!==contentHash(proof.profile))throw new DeploymentConflict('profile_hash_mismatch');
  if(Date.now()-Date.parse(proof.verifiedAt)>300_000||Date.parse(proof.verifiedAt)>Date.now()+30_000)
   throw new DeploymentConflict('profile_proof_stale');
  if(Math.abs(Date.now()-proof.source.timestamp*1000)>180_000)throw new DeploymentConflict('profile_source_stale');
  if(!same(p.factory,UNISWAP_V3_FACTORY)||!same(p.positionManager,NONFUNGIBLE_POSITION_MANAGER)||
   !same(p.router,PAPER_ROUTER)||!same(p.quoter,PAPER_QUOTER))
   throw new DeploymentConflict('unsupported_deployment_contract');
  for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
   if(!same(p[key],proof.contractHashes[key]))throw new DeploymentConflict('profile_code_hash_mismatch');
  if(BigInt(proof.references.price0)<=0n||BigInt(proof.references.price1)<=0n||BigInt(proof.references.nativePrice)<=0n)
   throw new DeploymentConflict('profile_reference_unavailable');
  if(referenceProofHash(proof.referenceProof)!==proof.references.proofHash)
   throw new DeploymentConflict('profile_reference_proof_mismatch');
  return this.transaction(async db=>{
   const row=(await db.query<{target_set_hash:string;created_block:string}>(`SELECT target_set_hash,
    created_block::text FROM indexer_pools WHERE stream_key=$1 AND lower(pool_address)=lower($2)
    AND chain_id=$3 AND fee=$4 AND enabled=true AND lower(rwa_address)=lower($5)`,
    [proof.streamKey,p.pool,p.chainId,p.fee,p.quoteToken===0?p.token1:p.token0])).rows[0];
   if(!row||BigInt(row.created_block)>BigInt(proof.source.block))throw new DeploymentConflict('indexer_pool_unverified');
   const evidence={verificationClass:'canonical_chain_and_independent_reference_v1',
    source:proof.source,streamKey:proof.streamKey,indexerTargetSetHash:row.target_set_hash,
    contractHashes:proof.contractHashes,references:proof.references,referenceProof:proof.referenceProof};
   const id=randomUUID();
   const inserted=(await db.query<{id:string}>(`INSERT INTO deployment_market_profiles
    (id,chain_id,pool_address,token0_address,token1_address,token0_decimals,token1_decimals,
     quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp())
    ON CONFLICT(chain_id,pool_address,profile_hash) DO NOTHING RETURNING id`,
    [id,p.chainId,p.pool.toLowerCase(),p.token0.toLowerCase(),p.token1.toLowerCase(),p.decimals0,p.decimals1,
     p.quoteToken,p.fee,p.tickSpacing,JSON.stringify(proof.profile),JSON.stringify(evidence),proof.profileHash])).rows[0];
   if(inserted)return {id:inserted.id,created:true};
   const existing=(await db.query<{id:string;retired_at:Date|null}>(`SELECT id,retired_at FROM deployment_market_profiles
    WHERE chain_id=$1 AND pool_address=$2 AND profile_hash=$3`,[p.chainId,p.pool.toLowerCase(),proof.profileHash])).rows[0];
   if(!existing||existing.retired_at)throw new DeploymentConflict('market_profile_unavailable');
   return {id:existing.id,created:false};
  });
 }

 async findDraftRequest(requestId:string,raw:DraftInput):Promise<DraftRequestOutcome>{
  const id=z.uuid().parse(requestId),input=draftInput.parse(raw);
  return matchDraftRequest(this.readPool,id,input);
 }

 /** Bounded authenticated recovery view. It deliberately excludes previews,
  * source observations and cost estimates, which must be refreshed. */
 async listStaticPaperDrafts(){
  const rows=(await this.readPool.query<{id:string;revision:number;wallet:string;market_profile_id:string;
   allocation:unknown;created_at:Date;profile_hash:string;pool_address:string;fee:number;tick_spacing:number;
   profile:unknown;config:unknown;config_hash:string}>(`SELECT c.id,c.current_revision AS revision,c.wallet,
   c.market_profile_id,c.allocation,c.created_at,p.profile_hash,p.pool_address,p.fee,p.tick_spacing,
   p.profile,r.config,r.config_hash FROM deployment_campaigns c
   JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=1
   WHERE c.mode='paper' AND c.lifecycle='draft' AND c.current_revision=1
    AND r.strategy_id='static_manual_v1'
   ORDER BY c.created_at DESC,c.id LIMIT 50`)).rows;
  return rows.map(row=>{
   const profile=marketProfileSchema.safeParse(row.profile),allocation=allocationSchema.safeParse(row.allocation);
   if(!profile.success||!allocation.success||contentHash(profile.data)!==row.profile_hash||
    profile.data.pool.pool.toLowerCase()!==row.pool_address.toLowerCase()||
    profile.data.pool.fee!==row.fee||profile.data.pool.tickSpacing!==row.tick_spacing||
    row.config===null||typeof row.config!=='object'||Array.isArray(row.config)||
    contentHash(row.config)!==row.config_hash)
    throw new DeploymentConflict('static_paper_draft_list_integrity');
   const config=row.config as Record<string,unknown>;
   if(config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||config.stateSchemaVersion!==1)
    throw new DeploymentConflict('static_paper_draft_list_integrity');
   const parameters=staticManualParameters.safeParse({halfWidthTicks:config.halfWidthTicks,limits:config.limits});
   const absolute=parameters.success?null:staticManualParameters.safeParse({tickLower:config.tickLower,
    tickUpper:config.tickUpper,limits:config.limits});
   if(!parameters.success&&!absolute?.success)throw new DeploymentConflict('static_paper_draft_list_integrity');
   const savedConfig=parameters.success?parameters.data:absolute!.data;
   return {id:row.id,revision:row.revision,wallet:row.wallet,marketProfileId:row.market_profile_id,
    profileHash:row.profile_hash,pool:profile.data.pool.pool,fee:profile.data.pool.fee,
    tickSpacing:profile.data.pool.tickSpacing,token0:profile.data.pool.token0,token1:profile.data.pool.token1,
    decimals0:profile.data.pool.decimals0,decimals1:profile.data.pool.decimals1,
    quoteToken:profile.data.pool.quoteToken,reference0:profile.data.pool.reference0,
    reference1:profile.data.pool.reference1,allocation:allocation.data,configHash:row.config_hash,
    config:savedConfig,createdAt:row.created_at.toISOString()};
  });
 }

 /** Logically remove only an untouched static/manual setup draft. The campaign
  * row lock serializes this transition with operation acceptance and mark
  * writers; retained revisions, previews, and request idempotency remain intact. */
 async deleteStaticPaperDraft(campaignId:string){
  const id=z.uuid().parse(campaignId);
  return this.transaction(async db=>{
   const row=(await db.query<{mode:string;strategy_id:string|null;current_revision:number;
    lifecycle:string;predecessor_campaign_id:string|null;predecessor_schema:string|null}>(`
    SELECT c.mode,c.lifecycle,c.current_revision,c.predecessor_campaign_id,c.predecessor_schema,
     (SELECT r.strategy_id FROM deployment_revisions r WHERE r.campaign_id=c.id AND r.revision=1) AS strategy_id
    FROM deployment_campaigns c WHERE c.id=$1 FOR UPDATE`,[id])).rows[0];
   if(!row)throw new DeploymentConflict('campaign_not_found');
   if(row.mode!=='paper'||row.strategy_id!=='static_manual_v1'||row.current_revision!==1||
    row.predecessor_campaign_id!==null||row.predecessor_schema!==null)
    throw new DeploymentConflict('static_paper_draft_not_deletable');
   const pristine=(await db.query<{pristine:boolean}>(`SELECT
    NOT EXISTS(SELECT 1 FROM deployment_operations WHERE campaign_id=$1) AND
    NOT EXISTS(SELECT 1 FROM deployment_marks WHERE campaign_id=$1) AND
    NOT EXISTS(SELECT 1 FROM deployment_ledger WHERE campaign_id=$1) AND
    NOT EXISTS(SELECT 1 FROM deployment_wallet_reservations WHERE campaign_id=$1) AND
    NOT EXISTS(SELECT 1 FROM deployment_paper_accounting WHERE campaign_id=$1) AND
    NOT EXISTS(SELECT 1 FROM deployment_paper_fee_evidence WHERE campaign_id=$1) AS pristine`,[id])).rows[0]?.pristine;
   if(!pristine)throw new DeploymentConflict('static_paper_draft_not_deletable');
   if(row.lifecycle==='closed')return {status:'deleted' as const,campaignId:id,idempotent:true};
   if(row.lifecycle!=='draft')throw new DeploymentConflict('static_paper_draft_not_deletable');
   await db.query(`UPDATE deployment_campaigns SET lifecycle='closed',closed_at=clock_timestamp(),
    updated_at=clock_timestamp() WHERE id=$1 AND lifecycle='draft'`,[id]);
   return {status:'deleted' as const,campaignId:id,idempotent:false};
  });
 }

 async createDraftWithRequestId(requestId:string,raw:DraftInput){
  const id=z.uuid().parse(requestId),input=draftInput.parse(raw),existing=await this.findDraftRequest(id,input);
  if(existing?.status==='conflict')return existing;
  if(existing?.status==='found')return {status:'replayed' as const,id:existing.id,
   revision:existing.revision,configHash:existing.configHash};
  const inserted=await this.insertDraft(id,input,true);
  if('status'in inserted)return inserted;
  return {status:inserted.replayed?'replayed' as const:'created' as const,
   id:inserted.id,revision:inserted.revision,configHash:inserted.configHash};
 }

 async createDraft(raw:DraftInput){
  const result=await this.insertDraft(randomUUID(),raw,false);
  if('status'in result)throw new DeploymentConflict('campaign_id_conflict');
  const {replayed:_replayed,...created}=result;return created;
 }

 private async insertDraft(id:string,raw:DraftInput,requestId:boolean):Promise<
  {id:string;revision:number;configHash:string;replayed:boolean}|{status:'conflict'}>{
 const {input,config,configHash,wallet}=deploymentDraftValues(raw);
  const runtimeIdentity=loadRuntimeIdentity()??null;
  return this.transaction(async db=>{
   const profile=(await db.query<{chain_id:number;retired_at:Date|null;profile:unknown;evidence:Record<string,unknown>;
    profile_hash:string;pool_address:string;token0_address:string;token1_address:string;fee:number}>(
    `SELECT chain_id,retired_at,profile,evidence,profile_hash,pool_address,token0_address,token1_address,fee
     FROM deployment_market_profiles WHERE id=$1 FOR SHARE`,[input.marketProfileId])).rows[0];
   if(!profile||profile.retired_at||profile.chain_id!==input.chainId)throw new DeploymentConflict('market_profile_unavailable');
   const parsed=marketProfileSchema.safeParse(profile.profile),evidence=marketProfileEvidenceSchema.safeParse(profile.evidence);
   if(!parsed.success||!evidence.success||
    contentHash(parsed.data)!==profile.profile_hash||parsed.data.pool.pool.toLowerCase()!==profile.pool_address.toLowerCase()||
    parsed.data.pool.token0.toLowerCase()!==profile.token0_address.toLowerCase()||
    parsed.data.pool.token1.toLowerCase()!==profile.token1_address.toLowerCase()||parsed.data.pool.fee!==profile.fee)
    throw new DeploymentConflict('market_profile_integrity');
   if(referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash)
    throw new DeploymentConflict('market_profile_integrity');
   for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
    if(parsed.data.pool[key].toLowerCase()!==evidence.data.contractHashes[key].toLowerCase())
     throw new DeploymentConflict('market_profile_integrity');
   const known=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
    WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=$3 AND fee=$4 AND enabled=true
    AND target_set_hash=$5 AND lower(rwa_address)=lower($6)) AS found`,[evidence.data.streamKey,
     profile.pool_address,profile.chain_id,profile.fee,evidence.data.indexerTargetSetHash,
     parsed.data.pool.quoteToken===0?parsed.data.pool.token1:parsed.data.pool.token0])).rows[0]?.found;
   if(!known)throw new DeploymentConflict('market_profile_indexer_changed');
   const inserted=await db.query<{id:string}>(`INSERT INTO deployment_campaigns
    (id,mode,chain_id,wallet,market_profile_id,allocation,lifecycle,current_revision,runtime_identity)
    VALUES($1,$2,$3,$4,$5,$6,'draft',1,$7) ${requestId?'ON CONFLICT (id) DO NOTHING':''} RETURNING id`,
    [id,input.mode,input.chainId,wallet,input.marketProfileId,JSON.stringify(input.allocation),
     runtimeIdentity?JSON.stringify(runtimeIdentity):null]);
   if(!inserted.rows[0]){
    if(!requestId)return {status:'conflict'};
    const existing=await matchDraftRequest(db,id,input);
    return existing?.status==='found'?{id:existing.id,revision:existing.revision,
     configHash:existing.configHash,replayed:true}:{status:'conflict'};
   }
   await db.query(`INSERT INTO deployment_revisions
    (campaign_id,revision,parent_revision,strategy_id,strategy_version,state_schema_version,config,config_hash)
    VALUES($1,1,NULL,$2,$3,$4,$5,$6)`,
    [id,input.strategyId,input.strategyVersion,input.stateSchemaVersion,JSON.stringify(config),configHash]);
   return {id,revision:1,configHash,replayed:false};
  });
 }

 /** Read-only input for paper preflight. Configuration and profile bytes are
  * revalidated at the read boundary; no legacy state or live signer is read. */
 async paperDraft(id:string){
  const row=(await this.readPool.query<{id:string;current_revision:number;allocation:unknown;
   chain_id:number;profile:unknown;evidence:unknown;profile_hash:string;config:unknown;config_hash:string;
   strategy_id:string;strategy_version:string;state_schema_version:number}>(`
   SELECT c.id,c.current_revision,c.allocation,c.chain_id,p.profile,p.evidence,p.profile_hash,
    r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version
   FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
   WHERE c.id=$1 AND c.mode='paper' AND c.lifecycle='draft' AND p.retired_at IS NULL`,[id])).rows[0];
  if(!row)throw new DeploymentConflict('paper_draft_unavailable');
  const profile=marketProfileSchema.safeParse(row.profile),evidence=marketProfileEvidenceSchema.safeParse(row.evidence);
  if(!profile.success||!evidence.success||profile.data.pool.chainId!==row.chain_id||
   contentHash(profile.data)!==row.profile_hash||
   referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash)
   throw new DeploymentConflict('market_profile_integrity');
  for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
   if(profile.data.pool[key].toLowerCase()!==evidence.data.contractHashes[key].toLowerCase())
    throw new DeploymentConflict('market_profile_integrity');
  const known=(await this.readPool.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
   WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=$3 AND fee=$4 AND enabled=true
    AND target_set_hash=$5 AND lower(rwa_address)=lower($6)) AS found`,[evidence.data.streamKey,
    profile.data.pool.pool,row.chain_id,profile.data.pool.fee,evidence.data.indexerTargetSetHash,
    profile.data.pool.quoteToken===0?profile.data.pool.token1:profile.data.pool.token0])).rows[0]?.found;
  if(!known)throw new DeploymentConflict('market_profile_indexer_changed');
  if(!row.config||typeof row.config!=='object'||Array.isArray(row.config)||contentHash(row.config)!==row.config_hash)
   throw new DeploymentConflict('campaign_config_integrity');
  const config=row.config as Record<string,unknown>,idParsed=strategyId.safeParse(row.strategy_id);
  if(!idParsed.success||config.strategyId!==row.strategy_id||config.strategyVersion!==row.strategy_version||
   config.stateSchemaVersion!==row.state_schema_version)throw new DeploymentConflict('campaign_config_integrity');
  const {strategyId:_id,strategyVersion:_version,stateSchemaVersion:_schema,...parameters}=config;
  parseStrategyParameters(idParsed.data,parameters);
  return {id:row.id,revision:row.current_revision,allocation:allocationSchema.parse(row.allocation),
   profile:profile.data,profileHash:row.profile_hash,evidence:evidence.data,
   strategyId:idParsed.data,strategyVersion:row.strategy_version,stateSchemaVersion:row.state_schema_version,
   parameters,configHash:row.config_hash};
 }

 /** Returns the verified paper strategy identity for selecting a read-only
  * preview path without pretending unsupported close previews are RangeKeeper. */
 async paperStrategyId(id:string):Promise<z.infer<typeof strategyId>|null>{
  const row=(await this.readPool.query<{mode:string;strategy_id:string;strategy_version:string;
   state_schema_version:number;config:unknown;config_hash:string}>(`
   SELECT c.mode,r.strategy_id,r.strategy_version,r.state_schema_version,r.config,r.config_hash
   FROM deployment_campaigns c JOIN deployment_revisions r
    ON r.campaign_id=c.id AND r.revision=c.current_revision WHERE c.id=$1`,[id])).rows[0];
  if(!row||row.mode!=='paper')return null;
  const parsedId=strategyId.safeParse(row.strategy_id);
  if(!parsedId.success||!row.config||typeof row.config!=='object'||Array.isArray(row.config)||
   contentHash(row.config)!==row.config_hash)
   throw new DeploymentConflict('campaign_config_integrity');
  const config=row.config as Record<string,unknown>;
  if(config.strategyId!==row.strategy_id||config.strategyVersion!==row.strategy_version||
   config.stateSchemaVersion!==row.state_schema_version)
   throw new DeploymentConflict('campaign_config_integrity');
  const {strategyId:_id,strategyVersion:_version,stateSchemaVersion:_schema,...parameters}=config;
  parseStrategyParameters(parsedId.data,parameters);
  return parsedId.data;
 }

 /** Read-only input for the next principal mark. The subsequent write checks
  * the latest mark again under lock, so this snapshot cannot authorize a
  * stale or concurrent append. */
 async paperValuationState(id:string){
  const row=(await this.readPool.query<{current_revision:number;profile:unknown;
   profile_hash:string;config_hash:string;config:unknown;open_mark_id:string;
   open_provenance:Record<string,unknown>;latest_mark_id:string;
   latest_source_block:string|null;latest_source_hash:string|null;
   latest_provenance:Record<string,unknown>;proposal:Record<string,unknown>}>(`
   SELECT c.current_revision,p.profile,p.profile_hash,r.config_hash,r.config,
    o.id::text AS open_mark_id,o.provenance AS open_provenance,
    m.id::text AS latest_mark_id,m.source_block::text AS latest_source_block,
    m.source_hash AS latest_source_hash,m.provenance AS latest_provenance,v.proposal
   FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
   JOIN LATERAL (SELECT id,provenance FROM deployment_marks
    WHERE campaign_id=c.id AND provenance->>'classification'='paper_model_provisional'
    ORDER BY id LIMIT 1) o ON TRUE
   JOIN LATERAL (SELECT id,source_block,source_hash,provenance FROM deployment_marks
    WHERE campaign_id=c.id ORDER BY id DESC LIMIT 1) m ON TRUE
   JOIN deployment_previews v ON v.id=(o.provenance->>'previewId')::uuid
   WHERE c.id=$1 AND c.mode='paper' AND c.lifecycle IN ('active','paused')`,
   [id])).rows[0];
  if(!row||row.latest_source_block===null||row.latest_source_hash===null||
   !['paper_model_provisional','paper_model_principal_valuation'].includes(
    String(row.latest_provenance.classification)))
   throw new DeploymentConflict('paper_valuation_state_unavailable');
  const profile=marketProfileSchema.safeParse(row.profile),
   open=paperOpenModelSchema.safeParse(row.proposal.paperOpenModel);
  if(!profile.success||!open.success||contentHash(row.profile)!==row.profile_hash||
   open.data.campaignId!==id||open.data.revision!==row.current_revision||
   open.data.profileHash!==row.profile_hash||open.data.configHash!==row.config_hash||
   contentHash(open.data)!==row.open_provenance.modelHash||!row.config||
   typeof row.config!=='object'||Array.isArray(row.config)||contentHash(row.config)!==row.config_hash)
   throw new DeploymentConflict('paper_valuation_state_integrity');
  const config=row.config as Record<string,unknown>;
  if(config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||
   config.stateSchemaVersion!==1)throw new DeploymentConflict('paper_valuation_config_integrity');
  const {strategyId:_strategyId,strategyVersion:_strategyVersion,
   stateSchemaVersion:_stateSchemaVersion,...rawParameters}=config;
  const parameters=parseStrategyParameters('static_manual_v1',rawParameters);
  const previousSource=paperFeeMarkSourceSchema.safeParse(row.latest_provenance.source);
  if(!previousSource.success||previousSource.data.block!==row.latest_source_block||
   previousSource.data.hash.toLowerCase()!==row.latest_source_hash.toLowerCase())
   throw new DeploymentConflict('paper_valuation_previous_source_integrity');
  return {openModel:open.data,openMarkId:row.open_mark_id,
   previous:{markId:row.latest_mark_id,sourceBlock:row.latest_source_block,
    sourceHash:row.latest_source_hash,source:previousSource.data},profile:profile.data,
   profileHash:row.profile_hash,configHash:row.config_hash,parameters};
 }

 /** Returns one adjacent, unrecorded paper interval. No network call or write
  * occurs here; the later append rechecks both marks under the campaign lock. */
 async paperFeeSamplingState(id:string){
  const db=await this.readPool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   try{
    const campaign=(await db.query<{mode:string;profile:unknown;profile_hash:string;
     evidence:unknown}>(`SELECT c.mode,p.profile,p.profile_hash,p.evidence
     FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
     WHERE c.id=$1`,[id])).rows[0];
    const profile=marketProfileSchema.safeParse(campaign?.profile),
     evidence=marketProfileEvidenceSchema.safeParse(campaign?.evidence);
    if(!campaign||campaign.mode!=='paper'||!profile.success||!evidence.success||
     contentHash(campaign.profile)!==campaign.profile_hash||
     referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash)
     throw new DeploymentConflict('paper_fee_campaign_unavailable');
    const last=(await db.query<{to_mark_id:string}>(`
     SELECT to_mark_id::text FROM deployment_paper_fee_evidence
     WHERE campaign_id=$1 ORDER BY id DESC LIMIT 1`,[id])).rows[0];
    const markSql=`SELECT id::text,revision,source_block::text,source_hash,inventory,provenance
     FROM deployment_marks WHERE campaign_id=$1`;
    type Mark={id:string;revision:number;source_block:string|null;source_hash:string|null;
     inventory:Record<string,unknown>;provenance:Record<string,unknown>};
    const from=(await db.query<Mark>(last?`${markSql} AND id=$2`:
     `${markSql} ORDER BY deployment_marks.id LIMIT 1`,last?[id,last.to_mark_id]:[id])).rows[0];
    if(!from){
     if(last)throw new DeploymentConflict('paper_fee_prior_mark_unavailable');
     await db.query('COMMIT');return null;
    }
    if(!last&&from.provenance.classification!=='paper_model_provisional')
     throw new DeploymentConflict('paper_fee_open_mark_unavailable');
    const to=(await db.query<Mark>(`${markSql} AND id>$2 ORDER BY deployment_marks.id LIMIT 1`,
     [id,from.id])).rows[0];
    if(!to){await db.query('COMMIT');return null;}
    const closeClass=String(to.provenance.classification),
     closing=closeClass==='paper_model_partial_close'||closeClass==='paper_model_converted_close';
    if(!['paper_model_principal_valuation','paper_model_partial_close',
      'paper_model_converted_close'].includes(closeClass)||
     !['paper_model_provisional','paper_model_principal_valuation'].includes(
      String(from.provenance.classification))||from.revision!==to.revision)
     throw new DeploymentConflict('paper_fee_next_mark_unsupported');
    if(closing&&closeClass==='paper_model_partial_close'){
     const preview=(await db.query<{proposal:Record<string,unknown>}>(`
      SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
      [to.provenance.previewId,id])).rows[0];
     const close=paperCloseRetainModelSchema.safeParse(preview?.proposal.paperCloseRetainModel);
     if(!close.success||close.data.previousMarkId!==from.id||
      close.data.openMarkId!==to.provenance.openMarkId||
      close.data.openModelHash!==to.provenance.openModelHash||
      contentHash(close.data.source)!==contentHash(to.provenance.source)||
      contentHash(close.data.poolState)!==contentHash(to.provenance.poolState)||
      to.inventory.position!==null)
      throw new DeploymentConflict('paper_fee_close_endpoint_unavailable');
    }
    if(closing&&closeClass==='paper_model_converted_close'){
     const preview=(await db.query<{proposal:Record<string,unknown>}>(`
      SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
      [to.provenance.previewId,id])).rows[0];
     const close=paperCloseConvertModelSchema.safeParse(preview?.proposal.paperCloseConvertModel);
     if(!close.success||close.data.previousMarkId!==from.id||
      close.data.openMarkId!==to.provenance.openMarkId||
      close.data.openModelHash!==to.provenance.openModelHash||
      contentHash(close.data.source)!==contentHash(to.provenance.source)||
      contentHash(close.data.poolState)!==contentHash(to.provenance.poolState)||
      contentHash(close.data)!==to.provenance.closeConvertModelHash||to.inventory.position!==null)
      throw new DeploymentConflict('paper_fee_close_endpoint_unavailable');
    }
    const snapshot=(mark:Mark,positionRequired=true)=>{
     const source=paperFeeMarkSourceSchema.safeParse(mark.provenance.source),
      state=paperFeeMarkStateSchema.safeParse(mark.provenance.poolState),
      position=positionRequired?paperFeePositionSchema.safeParse(mark.inventory.position):null;
     if(!source.success||!state.success||(positionRequired&&!position?.success)||
      source.data.block!==mark.source_block||
      source.data.hash.toLowerCase()!==mark.source_hash?.toLowerCase())
      throw new DeploymentConflict('paper_fee_mark_integrity');
     return {source:source.data,tick:state.data.tick,
      sqrtPriceX96:BigInt(state.data.sqrtPriceX96),
      poolLiquidity:BigInt(state.data.poolLiquidity),position:position?.data??null};
    };
    const before=snapshot(from),after=snapshot(to,!closing);
    if(!before.position||!closing&&(!after.position||
      after.position.liquidity!==before.position.liquidity||
      after.position.tickLower!==before.position.tickLower||
      after.position.tickUpper!==before.position.tickUpper)||
     BigInt(after.source.block)<=BigInt(before.source.block))
     throw new DeploymentConflict('paper_fee_position_or_source_changed');
    await db.query('COMMIT');
    return {profile:profile.data,stream:evidence.data.streamKey,
     targetSetHash:evidence.data.indexerTargetSetHash,fromMarkId:from.id,toMarkId:to.id,
     ending:closing?(closeClass==='paper_model_converted_close'?'close_convert' as const:
      'close_retain' as const):'valuation' as const,
     before:{source:before.source,tick:before.tick,sqrtPriceX96:before.sqrtPriceX96,
      poolLiquidity:before.poolLiquidity},
     after:{source:after.source,tick:after.tick,sqrtPriceX96:after.sqrtPriceX96,
      poolLiquidity:after.poolLiquidity},
     range:{tickLower:before.position.tickLower,tickUpper:before.position.tickUpper},
     liquidity:BigInt(before.position.liquidity)};
   }catch(error){await db.query('ROLLBACK');throw error;}
  }finally{db.release();}
 }

 /** Returns one adjacent RangeKeeper position epoch interval for the existing
  * canonical fee sampler. A recenter endpoint is replayed using the prior
  * mark's position; the following interval starts a fresh carry epoch. */
 async rangeKeeperPaperFeeSamplingState(id:string){
  const db=await this.readPool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const campaign=(await db.query<{mode:string;strategy_id:string;profile:unknown;profile_hash:string;
    evidence:unknown}>(`SELECT c.mode,r.strategy_id,p.profile,p.profile_hash,p.evidence
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id WHERE c.id=$1`,[id])).rows[0];
   const profile=marketProfileSchema.safeParse(campaign?.profile),evidence=marketProfileEvidenceSchema.safeParse(campaign?.evidence);
   if(!campaign||campaign.mode!=='paper'||campaign.strategy_id!=='rangekeeper_v1'||
    !profile.success||!evidence.success||contentHash(profile.data)!==campaign.profile_hash||
    referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash)
    throw new DeploymentConflict('rangekeeper_paper_fee_campaign_unavailable');
   const marks=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,source_block::text,source_hash,inventory,provenance
    FROM deployment_marks WHERE campaign_id=$1 ORDER BY deployment_marks.id LIMIT 10002`,[id])).rows;
   if(marks.length>10000)throw new DeploymentConflict('rangekeeper_paper_fee_mark_bound');
   if(!marks.length){await db.query('COMMIT');return null;}
   const feeRows=(await db.query<{from_mark_id:string;to_mark_id:string}>(`SELECT from_mark_id::text,to_mark_id::text
    FROM deployment_paper_fee_evidence WHERE campaign_id=$1 ORDER BY deployment_paper_fee_evidence.id`,[id])).rows;
   const lastFee=feeRows.at(-1),fromIndex=lastFee?marks.findIndex(row=>row.id===lastFee.to_mark_id):0,
    from=marks[fromIndex],
    boundaryIndex=marks.findIndex((row,index)=>index>fromIndex&&[
     'rangekeeper_paper_recenter_v1','rangekeeper_paper_close_retain_v1',
     'rangekeeper_paper_close_convert_v1'].includes(String(row.provenance.classification))),
    toIndex=boundaryIndex>=0?boundaryIndex:marks.length-1,to=marks[toIndex];
   if(!from||!to||from===to||feeRows.some(row=>row.to_mark_id===to.id)){
    await db.query('COMMIT');return null;
   }
   const fromClass=String(from.provenance.classification),toClass=String(to.provenance.classification),
    rkPositions=['rangekeeper_paper_open_v1','rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1'];
   if(!rkPositions.includes(fromClass)||!rkPositions.includes(toClass)&&
    !['rangekeeper_paper_close_retain_v1','rangekeeper_paper_close_convert_v1'].includes(toClass)||
    from.revision!==to.revision)
    throw new DeploymentConflict('rangekeeper_paper_fee_adjacent_mark_unsupported');
   const state=(mark:typeof marks[number],requirePosition=true)=>{
    const source=paperFeeMarkSourceSchema.safeParse(mark.provenance.source),
     inventory=mark.inventory as {position?:unknown},
     position=requirePosition?paperFeePositionSchema.safeParse(inventory.position):null;
    let poolState=mark.provenance.poolState;
    if(mark.provenance.classification==='rangekeeper_paper_open_v1'){
     const model=(mark.provenance.confirmedOpen as {model?:{poolState?:unknown}}|undefined)?.model;
     poolState=model?.poolState;
    }
    const parsedState=paperFeeMarkStateSchema.safeParse(poolState);
    if(!source.success||!parsedState.success||(requirePosition&&!position?.success)||!mark.source_block||!mark.source_hash||
     source.data.block!==mark.source_block||source.data.hash.toLowerCase()!==mark.source_hash.toLowerCase())
     throw new DeploymentConflict('rangekeeper_paper_fee_mark_integrity');
    return {source:source.data,state:parsedState.data,position:position?.data??null};
   };
   const a=state(from),closing=['rangekeeper_paper_close_retain_v1','rangekeeper_paper_close_convert_v1'].includes(toClass);
   if(!a.position)throw new DeploymentConflict('rangekeeper_paper_fee_source_position_missing');
   let b:{source:typeof a.source;state:typeof a.state;position:{tickLower:number;tickUpper:number;
    liquidity:string}|null};
   if(closing){
    const source=paperFeeMarkSourceSchema.safeParse(to.provenance.source),
     parsedState=paperFeeMarkStateSchema.safeParse(to.provenance.poolState);
    if(!source.success||!parsedState.success||source.data.block!==to.source_block||
     source.data.hash.toLowerCase()!==to.source_hash?.toLowerCase())
     throw new DeploymentConflict('rangekeeper_paper_fee_close_integrity');
    b={source:source.data,state:parsedState.data,position:null};
   }else b=state(to,toClass!=='rangekeeper_paper_recenter_v1');
   if(BigInt(b.source.block)<=BigInt(a.source.block)||!closing&&toClass!=='rangekeeper_paper_recenter_v1'&&
    (a.position.tickLower!==b.position!.tickLower||a.position.tickUpper!==b.position!.tickUpper||
     a.position.liquidity!==b.position!.liquidity))
    throw new DeploymentConflict('rangekeeper_paper_fee_position_or_source_changed');
   await db.query('COMMIT');
   return {profile:profile.data,stream:evidence.data.streamKey,targetSetHash:evidence.data.indexerTargetSetHash,
    fromMarkId:from.id,toMarkId:to.id,ending:toClass==='rangekeeper_paper_recenter_v1'?'recenter' as const:
     toClass==='rangekeeper_paper_close_retain_v1'?'close_retain' as const:
     toClass==='rangekeeper_paper_close_convert_v1'?'close_convert' as const:'valuation' as const,
    before:{source:a.source,tick:a.state.tick,sqrtPriceX96:BigInt(a.state.sqrtPriceX96),
     poolLiquidity:BigInt(a.state.poolLiquidity)},
    after:{source:b.source,tick:b.state.tick,sqrtPriceX96:BigInt(b.state.sqrtPriceX96),
     poolLiquidity:BigInt(b.state.poolLiquidity)},
    range:{tickLower:a.position.tickLower,tickUpper:a.position.tickUpper},liquidity:BigInt(a.position.liquidity)};
  }catch(error){await db.query('ROLLBACK');throw error;}
  finally{db.release();}
 }

 async listMarketProfiles(){
  const rows=(await this.readPool.query<{id:string;chain_id:number;profile:unknown;evidence:unknown;
   profile_hash:string;verified_at:Date;retired_at:Date|null;indexed:boolean}>(`
   SELECT p.id,p.chain_id,p.profile,p.evidence,p.profile_hash,p.verified_at,p.retired_at,
    COALESCE(i.enabled AND i.target_set_hash=(p.evidence->>'indexerTargetSetHash')
     AND lower(i.rwa_address)=lower(CASE WHEN p.quote_token=0 THEN p.token1_address ELSE p.token0_address END),false) AS indexed
   FROM deployment_market_profiles p LEFT JOIN indexer_pools i
    ON i.stream_key=p.evidence->>'streamKey' AND lower(i.pool_address)=lower(p.pool_address)
     AND i.chain_id=p.chain_id AND i.fee=p.fee
   ORDER BY p.verified_at DESC,p.id LIMIT 100`)).rows;
  return rows.map(row=>{
   const profile=marketProfileSchema.safeParse(row.profile),evidence=marketProfileEvidenceSchema.safeParse(row.evidence);
   const valid=profile.success&&evidence.success&&profile.data.pool.chainId===row.chain_id&&
    contentHash(profile.data)===row.profile_hash&&
    referenceProofHash(evidence.data.referenceProof)===evidence.data.references.proofHash&&
    (['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
     .every(key=>profile.data.pool[key].toLowerCase()===evidence.data.contractHashes[key].toLowerCase());
   const p=profile.success?profile.data.pool:null;
   return {id:row.id,chainId:row.chain_id,pool:p?.pool??null,token0:p?.token0??null,token1:p?.token1??null,
    decimals0:p?.decimals0??null,decimals1:p?.decimals1??null,quoteToken:p?.quoteToken??null,
    fee:p?.fee??null,tickSpacing:p?.tickSpacing??null,
    reference0:p?.reference0??null,reference1:p?.reference1??null,
    verifiedAt:row.verified_at,source:valid?evidence.data.source:null,
    draftAvailable:valid&&row.retired_at===null&&row.indexed,
    deploymentAvailable:false,
    reason:!valid?'profile_integrity':row.retired_at?'retired':!row.indexed?'indexer_identity_changed':
     'fresh_preflight_and_execution_unavailable'};
  });
 }

 /** Read-only, registered profile lookup for parameterized paper setup sizing.
  * It applies the same stored proof, contract identity, and live indexer
  * identity checks as draft creation without creating a draft. */
 async paperSetupProfile(id:string){
  const row=(await this.readPool.query<{id:string;chain_id:number;profile:unknown;evidence:unknown;
   profile_hash:string;pool_address:string;token0_address:string;token1_address:string;fee:number;retired_at:Date|null}>(`
   SELECT p.id,p.chain_id,p.profile,p.evidence,p.profile_hash,p.pool_address,p.token0_address,
    p.token1_address,p.fee,p.retired_at
   FROM deployment_market_profiles p WHERE p.id=$1`,[id])).rows[0];
  if(!row||row.retired_at)return null;
  const profile=marketProfileSchema.safeParse(row.profile),evidence=marketProfileEvidenceSchema.safeParse(row.evidence);
  if(!profile.success||!evidence.success||profile.data.pool.chainId!==row.chain_id||
   contentHash(profile.data)!==row.profile_hash||profile.data.pool.pool.toLowerCase()!==row.pool_address.toLowerCase()||
   profile.data.pool.token0.toLowerCase()!==row.token0_address.toLowerCase()||
   profile.data.pool.token1.toLowerCase()!==row.token1_address.toLowerCase()||profile.data.pool.fee!==row.fee||
   referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash)
   throw new DeploymentConflict('market_profile_integrity');
  for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
   if(profile.data.pool[key].toLowerCase()!==evidence.data.contractHashes[key].toLowerCase())
    throw new DeploymentConflict('market_profile_integrity');
  const known=(await this.readPool.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
   WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=$3 AND fee=$4 AND enabled=true
    AND target_set_hash=$5 AND lower(rwa_address)=lower($6)) AS found`,[evidence.data.streamKey,
    row.pool_address,row.chain_id,row.fee,evidence.data.indexerTargetSetHash,
    profile.data.pool.quoteToken===0?profile.data.pool.token1:profile.data.pool.token0])).rows[0]?.found;
  if(!known)throw new DeploymentConflict('market_profile_indexer_changed');
  return {id:row.id,profile:profile.data,profileHash:row.profile_hash};
 }

 /** Bounded, read-only calibration lookup. The resolver validates each model,
  * source identity, freshness and complete stage set before exposing costs.
  * The band key covers the exact tick range too, so a row outside the
  * candidate's exact range can never validate; scoping the query to it here
  * keeps the 201-row bound reachable as unrelated ranges accumulate rows.
  * Compare the stored JSON number rather than casting its text: a cast is
  * evaluated per row in an order the planner chooses, so one malformed model
  * would fail the whole lookup and block every open. A mistyped row simply
  * does not match. */
 async paperGasProfiles(poolAddress:string,tickLower:number,tickUpper:number):Promise<PaperGasProfileRow[]>{
  return (await this.readPool.query<PaperGasProfileRow>(`
   SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
    allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
    evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
    observed_until AS "observedUntil"
   FROM deployment_calibration_profiles
   WHERE chain_id=4663 AND lower(pool_address)=lower($1) AND path_version=$2
    AND component='gas_units' AND allowance_state='zero'
    AND model->'tickLower'=to_jsonb($3::int) AND model->'tickUpper'=to_jsonb($4::int)
   ORDER BY size_band,stage,version DESC LIMIT 201`,
   [poolAddress,PAPER_STATIC_GAS_PATH,tickLower,tickUpper])).rows;
 }

 /** Exact candidate scope for a trusted RangeKeeper preview. The selector
  * rejects an over-bound result and validates every returned attestation. */
 async rangeKeeperPaperGasProfiles(poolAddress:string,pathVersion:string,
  sizeBand:string):Promise<PaperGasProfileRow[]>{
  if(!/^0x[0-9a-fA-F]{40}$/.test(poolAddress)||
   ![RANGEKEEPER_PAPER_NO_SWAP_PATH,RANGEKEEPER_PAPER_DIRECT_SWAP_PATH,
    RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH].includes(pathVersion)||
   !/^rk_[0-9a-f]{32}$/.test(sizeBand))
   throw new DeploymentConflict('rangekeeper_paper_gas_scope_invalid');
  return (await this.readPool.query<PaperGasProfileRow>(`
   SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
    allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
    evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
    observed_until AS "observedUntil"
   FROM deployment_calibration_profiles
   WHERE chain_id=4663 AND lower(pool_address)=lower($1) AND path_version=$2
    AND size_band=$3 AND component='gas_units'
   ORDER BY stage,allowance_state,version DESC LIMIT 201`,
   [poolAddress,pathVersion,sizeBand])).rows;
 }

 /** Builds and persists a read-only second-observation confirmation envelope
  * while the campaign is still a draft. It never books capital or opens a position. */
 /** Whether a live, unexpired `open` preview exists for a RangeKeeper draft, and
  * whether its confirmation envelope has already been published. The preview
  * route needs this to tell a first observation from a second: RangeKeeper opens
  * on two observations, so the first request persists the preview and a later one
  * runs the confirmation against it. Read-only; the authoritative checks stay in
  * readRangeKeeperPaperConfirmationEnvelope, which re-reads under its own lock. */
 async rangeKeeperPaperOpenPreviewState(campaignId:string):Promise<{livePreview:boolean;
  confirmed:boolean;binding:{id:string;contentDigest:string;expectedRevision:number;
   expiresAt:Date}|null}>{
  const row=(await this.readPool.query<{confirmed:boolean;preview_id:string|null;
   content_digest:string|null;expected_revision:number|null;expires_at:Date|null}>(`
   SELECT EXISTS(SELECT 1 FROM deployment_rangekeeper_paper_confirmations proof
     WHERE proof.campaign_id=$1 AND proof.revision=c.current_revision) AS confirmed,
    live.id::text AS preview_id,live.content_digest,live.expected_revision,live.expires_at
   FROM deployment_campaigns c
   LEFT JOIN LATERAL (SELECT v.id,v.content_digest,v.expected_revision,v.expires_at
     FROM deployment_previews v
     WHERE v.campaign_id=c.id AND v.kind='open' AND v.expires_at>clock_timestamp()
      AND v.expected_revision=c.current_revision
     ORDER BY v.created_at DESC,v.id DESC LIMIT 1) live ON true
   WHERE c.id=$1`,[campaignId])).rows[0];
  // The binding is what the operator needs to accept: acceptOperation re-checks
  // every field of it under its own lock, so exposing it here cannot widen what
  // is acceptable.
  const binding=row?.preview_id&&row.content_digest&&row.expected_revision!==null&&row.expires_at?
   {id:row.preview_id,contentDigest:row.content_digest,
    expectedRevision:row.expected_revision,expiresAt:row.expires_at}:null;
  return {livePreview:binding!==null,confirmed:row?.confirmed===true,binding};
 }

 /** Read-only context for the parallel RangeKeeper open acceptance
  * (rangekeeper-paper-open-acceptance.ts). Composing the existing reads here
  * does not work: rangeKeeperPaperConfirmationEnvelope never returns the
  * confirmation's open_preview_id, and rangeKeeperPaperConfirmationContextSnapshot
  * accepts lifecycle 'active' too and requires a loaded, matching runtime
  * identity that open admission has no business depending on. This returns the
  * campaign's current paper/strategy/lifecycle/chain state, the preview named
  * by the caller (whichever kind, so a mismatch is reported rather than read as
  * a plain miss), and the confirmation envelope published for the campaign's
  * current revision, if any. All judgment -- preview-to-envelope binding,
  * envelope integrity, status and anchor re-verification -- stays in the
  * acceptance module; this method only reads. */
 /** Campaign and exit-preview facts a RangeKeeper exit acceptance checks before
  * calling the bare acceptOperation. Read-only, and it deliberately returns the
  * preview's whole proposal rather than a parsed view: the acceptance hash-binds
  * the exit model itself, which it cannot do from a projection. The lifecycle and
  * kind decisions stay in the acceptance, and acceptOperation re-reads everything
  * under its own lock. */
 async rangeKeeperPaperExitAcceptanceContext(input:{campaignId:string;previewId:string}){
  if(!z.uuid().safeParse(input.campaignId).success||!z.uuid().safeParse(input.previewId).success)
   return null;
  const row=(await this.readPool.query<{mode:string;lifecycle:string;chain_id:number;
   strategy_id:string;current_revision:number;profile_hash:string;config_hash:string;
   preview_kind:string|null;preview_content_digest:string|null;
   preview_expected_revision:number|null;preview_expires_at:Date|null;
   preview_proposal:unknown|null}>(`
   SELECT c.mode,c.lifecycle,c.chain_id,r.strategy_id,c.current_revision,
    p.profile_hash,r.config_hash,
    v.kind AS preview_kind,v.content_digest AS preview_content_digest,
    v.expected_revision AS preview_expected_revision,v.expires_at AS preview_expires_at,
    v.proposal AS preview_proposal
   FROM deployment_campaigns c
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
   JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   LEFT JOIN deployment_previews v ON v.id=$2 AND v.campaign_id=c.id
   WHERE c.id=$1`,[input.campaignId,input.previewId])).rows[0];
  if(!row)return null;
  return {mode:row.mode,lifecycle:row.lifecycle,chainId:row.chain_id,strategyId:row.strategy_id,
   currentRevision:row.current_revision,profileHash:row.profile_hash,configHash:row.config_hash,
   preview:row.preview_kind===null?null:{kind:row.preview_kind,
    contentDigest:row.preview_content_digest as string,
    expectedRevision:row.preview_expected_revision as number,
    expiresAt:row.preview_expires_at as Date,proposal:row.preview_proposal}};
 }

 async rangeKeeperPaperOpenAcceptanceContext(input:{campaignId:string;previewId:string}){
  if(!z.uuid().safeParse(input.campaignId).success||!z.uuid().safeParse(input.previewId).success)
   return null;
  const row=(await this.readPool.query<{mode:string;lifecycle:string;chain_id:number;
   strategy_id:string;current_revision:number;preview_kind:string|null;
   preview_content_digest:string|null;preview_expected_revision:number|null;
   confirmation_revision:number|null;confirmation_open_preview_id:string|null;
   confirmation_envelope:unknown|null;confirmation_envelope_hash:string|null}>(`
   SELECT c.mode,c.lifecycle,c.chain_id,r.strategy_id,c.current_revision,
    v.kind AS preview_kind,v.content_digest AS preview_content_digest,
    v.expected_revision AS preview_expected_revision,
    proof.revision AS confirmation_revision,
    proof.open_preview_id::text AS confirmation_open_preview_id,
    proof.envelope AS confirmation_envelope,proof.envelope_hash AS confirmation_envelope_hash
   FROM deployment_campaigns c
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
   LEFT JOIN deployment_previews v ON v.id=$2 AND v.campaign_id=c.id
   LEFT JOIN deployment_rangekeeper_paper_confirmations proof
    ON proof.campaign_id=c.id AND proof.revision=c.current_revision
   WHERE c.id=$1`,[input.campaignId,input.previewId])).rows[0];
  if(!row)return null;
  return {mode:row.mode,lifecycle:row.lifecycle,chainId:row.chain_id,strategyId:row.strategy_id,
   currentRevision:row.current_revision,
   preview:row.preview_kind===null?null:{kind:row.preview_kind,
    contentDigest:row.preview_content_digest as string,
    expectedRevision:row.preview_expected_revision as number},
   confirmation:row.confirmation_revision===null?null:{revision:row.confirmation_revision,
    openPreviewId:row.confirmation_open_preview_id as string,
    envelope:row.confirmation_envelope,envelopeHash:row.confirmation_envelope_hash as string}};
 }

 async readRangeKeeperPaperConfirmationEnvelope(input:{campaignId:string;frame:PaperOpenFrame;
  client:RobinhoodClient;marketGasPriceWei:bigint|null;marketGasPriceObservedAt:number|null;
  /** Internal producer staging mode; final publication is atomic below. */
  prepareOnly?:boolean;
  pinnedQuoteCache?:RangeKeeperPaperPinnedQuoteCache;
  preparation?:RangeKeeperPaperConfirmationPreparation;
  simulate:(candidate:import('../strategy/rangekeeper/domain.js').RangeKeeperCandidate)=>
   Promise<RangeKeeperPaperConfirmationSimulation>;
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>;now?:number}){
  const now=input.now??Date.now(),runtime=loadRuntimeIdentity();
  if(!runtime)throw new DeploymentConflict('rangekeeper_runtime_identity_unavailable');
  {
   const row=(await this.readPool.query<{mode:string;lifecycle:string;revision:number;chain_id:number;
    allocation:unknown;profile:unknown;profile_hash:string;config:unknown;config_hash:string;
    strategy_id:string;strategy_version:string;state_schema_version:number;runtime_identity:unknown;
    open_preview_id:string;request:Record<string,unknown>;proposal:Record<string,unknown>;
    evidence:Record<string,unknown>;content_digest:string;expected_revision:number;expires_at:Date;
    pending:boolean}>(`
    SELECT c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,c.allocation,p.profile,p.profile_hash,
     r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version,c.runtime_identity,
     v.id::text AS open_preview_id,v.request,v.proposal,v.evidence,v.content_digest,
     v.expected_revision,v.expires_at,
     EXISTS(SELECT 1 FROM deployment_operations op WHERE op.campaign_id=c.id AND op.status IN
      ('queued','preflighting','executing','confirming','reconciling','blocked')) AS pending
    FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN LATERAL (SELECT preview.id,preview.request,preview.proposal,preview.evidence,
     preview.content_digest,preview.expected_revision,preview.expires_at
     FROM deployment_previews preview WHERE preview.campaign_id=c.id AND preview.kind='open'
     ORDER BY preview.created_at DESC,preview.id DESC LIMIT 1) v ON true
     WHERE c.id=$1`,[input.campaignId])).rows[0];
   const profile=marketProfileSchema.safeParse(row?.profile),storedRuntime=sealedRuntimeIdentitySchema.safeParse(row?.runtime_identity);
   if(!row||row.mode!=='paper'||row.lifecycle!=='draft'||row.pending||row.chain_id!==4663||
    row.strategy_id!=='rangekeeper_v1'||row.strategy_version!=='1.0.0'||row.state_schema_version!==1||
    row.expected_revision!==row.revision||row.expires_at.getTime()<now||
    !profile.success||!storedRuntime.success||contentHash(storedRuntime.data)!==contentHash(runtime)||
    contentHash(profile.data)!==row.profile_hash||!row.config||typeof row.config!=='object'||
    Array.isArray(row.config)||contentHash(row.config)!==row.config_hash)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_campaign_unavailable');
   if(previewDigest({campaignId:input.campaignId,expectedRevision:row.expected_revision,kind:'open',
    request:row.request,proposal:row.proposal,evidence:row.evidence,expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_preview_integrity');
   const config=row.config as Record<string,unknown>;
   if(config.strategyId!=='rangekeeper_v1'||config.strategyVersion!=='1.0.0'||config.stateSchemaVersion!==1)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_config_invalid');
   const {strategyId:_id,strategyVersion:_version,stateSchemaVersion:_schema,...parameters}=config;
   parseStrategyParameters('rangekeeper_v1',parameters);
   const draft={id:input.campaignId,revision:row.revision,
    allocation:allocationSchema.parse(row.allocation),profile:profile.data,profileHash:row.profile_hash,
    configHash:row.config_hash,strategyId:'rangekeeper_v1' as const,parameters},
    openModel=row.proposal.rangekeeperPaperOpenModel;
   if(!openModel||typeof openModel!=='object'||Array.isArray(openModel)||
    contentHash(openModel)!==row.proposal.rangekeeperPaperOpenModelHash&&
     row.proposal.rangekeeperPaperOpenModelHash!==undefined)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_open_model_invalid');
   if(input.pinnedQuoteCache&&
    !input.pinnedQuoteCache.matches(input.client,profile.data))
    throw new DeploymentConflict('rangekeeper_confirmation_quote_cache_context_mismatch');
   try{
    const result=await buildRangeKeeperPaperConfirmation({draft,firstModel:openModel as never,
     frame:input.frame,buildId:runtime.buildId,client:input.client,
     readGasProfiles:query=>this.rangeKeeperPaperGasProfiles(query.poolAddress,query.pathVersion,query.sizeBand),
     marketGasPriceWei:input.marketGasPriceWei,marketGasPriceObservedAt:input.marketGasPriceObservedAt,
     simulate:input.simulate,pinnedQuoteCache:input.pinnedQuoteCache,preparation:input.preparation,now});
    if(result.status==='unavailable')throw new DeploymentConflict(result.reason);
    if(!input.prepareOnly){
     const sources=result.status==='confirmed'?[result.firstObservation.source,
      result.confirmationObservation.source]:[(openModel as {source:PaperCanonicalAnchor}).source,result.source];
     try{await input.verifyAnchors(row.chain_id,sources);}
     catch(error){if(error instanceof AssertionError)
       throw new DeploymentConflict('rangekeeper_paper_confirmation_source_not_canonical');throw error;}
     if(result.status==='confirmed')await this.persistRangeKeeperPaperConfirmationEnvelope({
      campaignId:input.campaignId,openPreviewId:row.open_preview_id,envelope:result,
      verifyAnchors:input.verifyAnchors});
    }
    const prepared={...result,actionAvailable:false as const};
    if(input.prepareOnly&&result.status==='confirmed')preparedRangeKeeperConfirmationBindings.set(prepared,
     {campaignId:input.campaignId,revision:row.revision,openPreviewId:row.open_preview_id,
      previewDigest:row.content_digest,expiresAtMs:row.expires_at.getTime(),owner:this.rangeKeeperProducerStoreToken});
    return prepared;
   }catch(error){
    if(error instanceof DeploymentConflict)throw error;
    throw new DeploymentConflict('rangekeeper_paper_confirmation_replay_unavailable');
   }
  }
 }

 /** Transactionally stores one validated confirmation per draft revision.
  * Canonical anchors are checked inside and again immediately before commit. */
 private async persistRangeKeeperPaperConfirmationEnvelope(input:{campaignId:string;openPreviewId:string;
  envelope:unknown;verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}){
  const envelope=validateRangeKeeperPaperConfirmationEnvelope(input.envelope,
   {campaignId:input.campaignId,revision:(input.envelope as {revision:number}).revision});
  return this.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`deployment-rangekeeper-paper-confirmation:${input.campaignId}`]);
   const row=(await db.query<{mode:string;lifecycle:string;revision:number;chain_id:number;
    strategy_id:string;profile_hash:string;config_hash:string;preview_id:string;
    preview_revision:number;open_model:unknown;content_digest:string}>(`
    SELECT c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,r.strategy_id,p.profile_hash,
     r.config_hash,v.id::text AS preview_id,v.expected_revision AS preview_revision,
     v.proposal->'rangekeeperPaperOpenModel' AS open_model,v.content_digest
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_previews v ON v.id=$2 AND v.campaign_id=c.id AND v.kind='open'
    WHERE c.id=$1 FOR UPDATE OF c`,[input.campaignId,input.openPreviewId])).rows[0];
   if(!row||row.mode!=='paper'||!['draft','active'].includes(row.lifecycle)||row.chain_id!==4663||
    row.strategy_id!=='rangekeeper_v1'||row.revision!==envelope.revision||
    row.preview_revision!==row.revision||row.profile_hash!==envelope.profileHash||
    row.config_hash!==envelope.draftConfigHash||!row.open_model||
    contentHash(row.open_model)!==envelope.firstObservation.modelHash)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_campaign_changed');
   const openModel=row.open_model as {source?:PaperCanonicalAnchor};
   if(!openModel.source||contentHash(row.open_model)!==envelope.firstObservation.modelHash||
    openModel.source.block!==envelope.firstObservation.source.block||
    openModel.source.hash.toLowerCase()!==envelope.firstObservation.source.hash.toLowerCase()||
    openModel.source.timestamp!==envelope.firstObservation.source.timestamp)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_first_observation_changed');
   const sources=[envelope.firstObservation.source,envelope.confirmationObservation.source];
   const existing=(await db.query<{envelope_hash:string;envelope:unknown}>(`
    SELECT envelope_hash,envelope FROM deployment_rangekeeper_paper_confirmations
    WHERE campaign_id=$1 AND revision=$2`,[input.campaignId,envelope.revision])).rows[0];
   if(existing){
    const prior=validateRangeKeeperPaperConfirmationEnvelope(existing.envelope,
     {campaignId:input.campaignId,revision:envelope.revision});
    if(existing.envelope_hash!==envelope.envelopeHash||prior.envelopeHash!==envelope.envelopeHash)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_replay_conflict');
    try{await input.verifyAnchors(row.chain_id,sources);}
    catch(error){if(error instanceof AssertionError)
      throw new DeploymentConflict('rangekeeper_paper_confirmation_source_not_canonical');throw error;}
    return {campaignId:input.campaignId,revision:envelope.revision,
     envelopeHash:envelope.envelopeHash,replayed:true,actionAvailable:false as const};
   }
   try{await input.verifyAnchors(row.chain_id,sources);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_source_not_canonical');throw error;}
   await db.query(`INSERT INTO deployment_rangekeeper_paper_confirmations
    (campaign_id,revision,open_preview_id,first_source_block,first_source_hash,
     confirmation_source_block,confirmation_source_hash,envelope_hash,envelope)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[input.campaignId,envelope.revision,
    input.openPreviewId,envelope.firstObservation.source.block,envelope.firstObservation.source.hash,
    envelope.confirmationObservation.source.block,envelope.confirmationObservation.source.hash,
    envelope.envelopeHash,JSON.stringify(envelope)]);
   try{await input.verifyAnchors(row.chain_id,sources);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_source_changed_during_write');throw error;}
   return {campaignId:input.campaignId,revision:envelope.revision,
    envelopeHash:envelope.envelopeHash,replayed:false,actionAvailable:false as const};
  });
 }

 /** Atomically publishes a producer-prepared confirmation and its receipt.
  * Only a result prepared by this store instance and marked by the server
  * producer can enter this path. Canonical anchors bracket both inserts. */
 async persistRangeKeeperPaperConfirmationWithProducerReceipt(input:{envelope:unknown;
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>} ){
  if(!isRangeKeeperPaperServerProduced(input.envelope))
   throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_untrusted');
  const binding=preparedRangeKeeperConfirmationBindings.get(input.envelope);
  if(!binding||binding.owner!==this.rangeKeeperProducerStoreToken)
   throw new DeploymentConflict('rangekeeper_paper_confirmation_prepare_unavailable');
  const envelope=validateRangeKeeperPaperConfirmationEnvelope(input.envelope,
   {campaignId:binding.campaignId,revision:binding.revision});
  if(envelope.status!=='confirmed'||envelope.campaignId!==binding.campaignId||
   envelope.revision!==binding.revision)
   throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_binding_invalid');
  return this.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`deployment-rangekeeper-paper-confirmation:${binding.campaignId}`]);
   const row=(await db.query<{mode:string;lifecycle:string;revision:number;chain_id:number;
    strategy_id:string;strategy_version:string;state_schema_version:number;runtime_identity:unknown;
    config:unknown;config_hash:string;profile:unknown;profile_hash:string;preview_id:string;
    preview_kind:string;preview_revision:number;preview_request:Record<string,unknown>;
    preview_proposal:Record<string,unknown>;preview_evidence:Record<string,unknown>;
    preview_digest:string;preview_expires_at:Date;open_model:unknown;pending:boolean;
    proof_envelope:unknown|null;proof_hash:string|null;proof_preview_id:string|null;
    existing_receipt:unknown|null;existing_receipt_hash:string|null}>(`
    SELECT c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,r.strategy_id,
     r.strategy_version,r.state_schema_version,c.runtime_identity,r.config,r.config_hash,
     p.profile,p.profile_hash,v.id::text AS preview_id,v.kind AS preview_kind,
     v.expected_revision AS preview_revision,v.request AS preview_request,v.proposal AS preview_proposal,
     v.evidence AS preview_evidence,v.content_digest AS preview_digest,v.expires_at AS preview_expires_at,
     v.proposal->'rangekeeperPaperOpenModel' AS open_model,
     EXISTS(SELECT 1 FROM deployment_operations op WHERE op.campaign_id=c.id AND op.status IN
      ('queued','preflighting','executing','confirming','reconciling','blocked')) AS pending,
     proof.envelope AS proof_envelope,proof.envelope_hash AS proof_hash,
     proof.open_preview_id::text AS proof_preview_id,receipt.receipt AS existing_receipt,
     receipt.receipt_hash AS existing_receipt_hash
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_previews v ON v.id=$2 AND v.campaign_id=c.id
    LEFT JOIN deployment_rangekeeper_paper_confirmations proof
     ON proof.campaign_id=c.id AND proof.revision=r.revision
    LEFT JOIN deployment_rangekeeper_paper_confirmation_producers receipt
     ON receipt.campaign_id=c.id AND receipt.revision=r.revision
    WHERE c.id=$1 FOR UPDATE OF c,v`,[binding.campaignId,binding.openPreviewId])).rows[0];
   const runtime=sealedRuntimeIdentitySchema.safeParse(row?.runtime_identity);
   let currentRuntime:RuntimeIdentity|null=null;
   try{currentRuntime=loadRuntimeIdentity()??null;}catch{/* Fail closed below. */}
   const expiry=row?.preview_expires_at?.getTime();
   if(!row||row.mode!=='paper'||row.lifecycle!=='draft'||row.pending||row.chain_id!==4663||
    row.strategy_id!=='rangekeeper_v1'||row.strategy_version!=='1.0.0'||row.state_schema_version!==1||
    row.revision!==binding.revision||row.preview_kind!=='open'||row.preview_id!==binding.openPreviewId||
    row.preview_revision!==row.revision||row.preview_digest!==binding.previewDigest||
    expiry!==binding.expiresAtMs||expiry===undefined||
    row.config_hash!==envelope.draftConfigHash||row.profile_hash!==envelope.profileHash||
    !runtime.success||!currentRuntime||contentHash(runtime.data)!==contentHash(currentRuntime)||
    contentHash(row.config)!==row.config_hash||contentHash(row.profile)!==row.profile_hash||
    (envelope.strategyState as {buildId?:unknown}).buildId!==runtime.data.buildId||!row.open_model||
    contentHash(row.open_model)!==envelope.firstObservation.modelHash||
    contentHash(row.preview_proposal.rangekeeperPaperOpenModel)!==envelope.firstObservation.modelHash||
    previewDigest({campaignId:binding.campaignId,expectedRevision:row.preview_revision,kind:'open',
     request:row.preview_request,proposal:row.preview_proposal,evidence:row.preview_evidence,
     expiresAt:row.preview_expires_at})!==row.preview_digest)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_binding_invalid');
   const firstModelSource=(row.open_model as {source?:PaperCanonicalAnchor}).source;
   if(!firstModelSource||firstModelSource.block!==envelope.firstObservation.source.block||
    firstModelSource.hash.toLowerCase()!==envelope.firstObservation.source.hash.toLowerCase()||
    firstModelSource.timestamp!==envelope.firstObservation.source.timestamp)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_first_observation_changed');
   const firstCandidateExpiry=(row.open_model as {candidate?:{expiresAt?:unknown}}).candidate?.expiresAt,
    confirmationCandidateExpiry=(envelope.confirmationObservation.candidate as {expiresAt:number}).expiresAt;
   if(Date.now()>=expiry||typeof firstCandidateExpiry!=='number'||!Number.isSafeInteger(firstCandidateExpiry)||
    !Number.isSafeInteger(confirmationCandidateExpiry)||Date.now()>=firstCandidateExpiry*1000||
    Date.now()>=confirmationCandidateExpiry*1000)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_preview_expired');
   const sources=[envelope.firstObservation.source,envelope.confirmationObservation.source];
   if(row.proof_envelope!==null){
    let prior;
    try{prior=validateRangeKeeperPaperConfirmationEnvelope(row.proof_envelope,
     {campaignId:binding.campaignId,revision:binding.revision});}
    catch{throw new DeploymentConflict('rangekeeper_paper_confirmation_replay_conflict');}
    if(row.proof_hash!==envelope.envelopeHash||row.proof_preview_id!==binding.openPreviewId||
     prior.envelopeHash!==envelope.envelopeHash||contentHash(prior)!==contentHash(envelope))
     throw new DeploymentConflict('rangekeeper_paper_confirmation_replay_conflict');
   }
   let priorReceipt;
   if(row.existing_receipt!==null){
    if(row.proof_envelope===null)throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_receipt_invalid');
    try{priorReceipt=validateRangeKeeperPaperConfirmationProducerReceipt(row.existing_receipt,
     {campaignId:binding.campaignId,revision:binding.revision,openPreviewId:binding.openPreviewId,envelope});}
    catch{throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_receipt_invalid');}
    if(priorReceipt.receiptHash!==row.existing_receipt_hash)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_receipt_invalid');
   }
   let receipt;
   try{receipt=priorReceipt??buildRangeKeeperPaperConfirmationProducerReceipt({envelope,
    openPreviewId:binding.openPreviewId});}
   catch{throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_receipt_invalid');}
   const verify=async(code:string)=>{
    try{await input.verifyAnchors(row.chain_id,sources);}
    catch(error){if(error instanceof AssertionError)throw new DeploymentConflict(code);throw error;}
    if(Date.now()>=expiry||Date.now()>=firstCandidateExpiry*1000||
     Date.now()>=confirmationCandidateExpiry*1000)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_preview_expired');
   };
   await verify('rangekeeper_paper_confirmation_source_not_canonical');
   if(row.proof_envelope===null)await db.query(`INSERT INTO deployment_rangekeeper_paper_confirmations
    (campaign_id,revision,open_preview_id,first_source_block,first_source_hash,
     confirmation_source_block,confirmation_source_hash,envelope_hash,envelope)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[binding.campaignId,binding.revision,
    binding.openPreviewId,envelope.firstObservation.source.block,envelope.firstObservation.source.hash,
    envelope.confirmationObservation.source.block,envelope.confirmationObservation.source.hash,
    envelope.envelopeHash,JSON.stringify(envelope)]);
   if(!priorReceipt)await db.query(`INSERT INTO deployment_rangekeeper_paper_confirmation_producers
    (campaign_id,revision,open_preview_id,envelope_hash,producer_run_id,producer_build_id,
     receipt_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[binding.campaignId,binding.revision,
    binding.openPreviewId,envelope.envelopeHash,receipt.producerRunId,receipt.producerBuildId,
    receipt.receiptHash,JSON.stringify(receipt)]);
   await verify('rangekeeper_paper_confirmation_source_changed_during_write');
   return {receipt,replayed:row.proof_envelope!==null&&priorReceipt!==undefined,
    actionAvailable:false as const};
  });
 }

 /** Persists an append-only receipt only for the exact in-process result
  * returned by the server-owned producer. The receipt attests the producer
  * path and bindings, not execution success or actionability. */
 async recordRangeKeeperPaperConfirmationProducerReceipt(input:{envelope:unknown;
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}){
  if(!isRangeKeeperPaperServerProduced(input.envelope))
   throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_untrusted');
  const envelope=validateRangeKeeperPaperConfirmationEnvelope(input.envelope,
   {campaignId:input.envelope.campaignId,revision:input.envelope.revision});
  return this.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`deployment-rangekeeper-paper-confirmation:${envelope.campaignId}`]);
   const row=(await db.query<{mode:string;lifecycle:string;revision:number;chain_id:number;
    runtime_identity:unknown;config:unknown;config_hash:string;profile:unknown;profile_hash:string;preview_id:string;
    preview_revision:number;preview_request:Record<string,unknown>;preview_proposal:Record<string,unknown>;
    preview_evidence:Record<string,unknown>;preview_digest:string;preview_expires_at:Date;
    stored_envelope:unknown;stored_envelope_hash:string;proof_preview_id:string;
    existing_receipt:unknown;existing_receipt_hash:string|null}>(`
    SELECT c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,c.runtime_identity,
     r.config,r.config_hash,p.profile,p.profile_hash,v.id::text AS preview_id,v.expected_revision AS preview_revision,
     v.request AS preview_request,v.proposal AS preview_proposal,v.evidence AS preview_evidence,
     v.content_digest AS preview_digest,v.expires_at AS preview_expires_at,
     proof.envelope AS stored_envelope,proof.envelope_hash AS stored_envelope_hash,
     proof.open_preview_id::text AS proof_preview_id,receipt.receipt AS existing_receipt,
     receipt.receipt_hash AS existing_receipt_hash
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_rangekeeper_paper_confirmations proof
     ON proof.campaign_id=c.id AND proof.revision=c.current_revision
    JOIN deployment_previews v ON v.id=proof.open_preview_id AND v.campaign_id=c.id
    LEFT JOIN deployment_rangekeeper_paper_confirmation_producers receipt
     ON receipt.campaign_id=proof.campaign_id AND receipt.revision=proof.revision
    WHERE c.id=$1 FOR UPDATE OF c`,[envelope.campaignId])).rows[0];
   const runtime=sealedRuntimeIdentitySchema.safeParse(row?.runtime_identity);
   if(!row||row.mode!=='paper'||row.lifecycle!=='draft'||row.revision!==envelope.revision||
    row.preview_id!==row.proof_preview_id||row.preview_revision!==row.revision||
    row.preview_expires_at.getTime()<Date.now()||row.config_hash!==envelope.draftConfigHash||
    row.profile_hash!==envelope.profileHash||!runtime.success||
    contentHash(row.config)!==row.config_hash||contentHash(row.profile)!==row.profile_hash||
    (envelope.strategyState as {buildId?:unknown}).buildId!==runtime.data.buildId||
    row.stored_envelope_hash!==envelope.envelopeHash)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_binding_invalid');
   if(previewDigest({campaignId:envelope.campaignId,expectedRevision:row.preview_revision,
    kind:'open',request:row.preview_request,proposal:row.preview_proposal,
    evidence:row.preview_evidence,expiresAt:row.preview_expires_at})!==row.preview_digest||
    contentHash(row.stored_envelope)!==contentHash(envelope)||
    contentHash(row.preview_proposal.rangekeeperPaperOpenModel)!==envelope.firstObservation.modelHash)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_binding_invalid');
   const sources=[envelope.firstObservation.source,envelope.confirmationObservation.source];
   if(row.existing_receipt){
    let prior;
    try{prior=validateRangeKeeperPaperConfirmationProducerReceipt(row.existing_receipt,{campaignId:
     envelope.campaignId,revision:envelope.revision,openPreviewId:row.preview_id,envelope});}
    catch{throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_receipt_invalid');}
    if(prior.receiptHash!==row.existing_receipt_hash)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_receipt_invalid');
    try{await input.verifyAnchors(row.chain_id,sources);}
    catch(error){if(error instanceof AssertionError)
      throw new DeploymentConflict('rangekeeper_paper_confirmation_source_not_canonical');throw error;}
    return {receipt:prior,replayed:true as const,actionAvailable:false as const};
   }
   try{await input.verifyAnchors(row.chain_id,sources);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_source_not_canonical');throw error;}
   const receipt=buildRangeKeeperPaperConfirmationProducerReceipt({envelope,
    openPreviewId:row.preview_id});
   await db.query(`INSERT INTO deployment_rangekeeper_paper_confirmation_producers
    (campaign_id,revision,open_preview_id,envelope_hash,producer_run_id,producer_build_id,
     receipt_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[envelope.campaignId,
    envelope.revision,row.preview_id,envelope.envelopeHash,receipt.producerRunId,
    receipt.producerBuildId,receipt.receiptHash,JSON.stringify(receipt)]);
   try{await input.verifyAnchors(row.chain_id,sources);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_source_changed_during_write');throw error;}
   return {receipt,replayed:false as const,actionAvailable:false as const};
  });
 }

 /** Restart-safe exact binding check for the server-produced preview/envelope
  * pair. It never upgrades the underlying simulation evidence or enables an
  * operation; consumers must recheck canonical anchors again before writing. */
 async rangeKeeperPaperConfirmationProducerSnapshot(input:{campaignId:string;openPreviewId:string;
  envelopeHash:string;verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}){
  const row=(await this.readPool.query<{mode:string;lifecycle:string;revision:number;chain_id:number;
   runtime_identity:unknown;config:unknown;config_hash:string;profile:unknown;profile_hash:string;
   preview_id:string;preview_revision:number;preview_request:Record<string,unknown>;
   preview_proposal:Record<string,unknown>;preview_evidence:Record<string,unknown>;
   preview_digest:string;preview_expires_at:Date;envelope:unknown;envelope_hash:string;
   receipt:unknown;receipt_hash:string}>(`
   SELECT c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,c.runtime_identity,
    r.config,r.config_hash,p.profile,p.profile_hash,
    v.id::text AS preview_id,v.expected_revision AS preview_revision,v.request AS preview_request,
    v.proposal AS preview_proposal,v.evidence AS preview_evidence,v.content_digest AS preview_digest,
    v.expires_at AS preview_expires_at,proof.envelope,proof.envelope_hash,
    producer.receipt,producer.receipt_hash
   FROM deployment_rangekeeper_paper_confirmation_producers producer
   JOIN deployment_rangekeeper_paper_confirmations proof
    ON proof.campaign_id=producer.campaign_id AND proof.revision=producer.revision
   JOIN deployment_campaigns c ON c.id=proof.campaign_id
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
   JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   JOIN deployment_previews v ON v.id=proof.open_preview_id AND v.campaign_id=c.id
   WHERE c.id=$1 AND v.id=$2 AND c.current_revision=producer.revision`,
   [input.campaignId,input.openPreviewId])).rows[0];
  if(!row||row.mode!=='paper'||row.lifecycle!=='draft'||row.preview_id!==input.openPreviewId||
   row.preview_revision!==row.revision||row.preview_expires_at.getTime()<Date.now()||
   row.envelope_hash!==input.envelopeHash||row.config_hash===undefined||row.profile_hash===undefined)
   throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_snapshot_unavailable');
  let envelope,receipt;
  try{
   envelope=validateRangeKeeperPaperConfirmationEnvelope(row.envelope,
    {campaignId:input.campaignId,revision:row.revision});
   receipt=validateRangeKeeperPaperConfirmationProducerReceipt(row.receipt,{campaignId:input.campaignId,
    revision:row.revision,openPreviewId:row.preview_id,envelope});
  }catch{throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_snapshot_integrity');}
  const runtime=sealedRuntimeIdentitySchema.safeParse(row.runtime_identity);
  if(envelope.envelopeHash!==row.envelope_hash||receipt.receiptHash!==row.receipt_hash||
   !runtime.success||runtime.data.buildId!==receipt.producerBuildId||
   row.config_hash!==envelope.draftConfigHash||row.profile_hash!==envelope.profileHash||
   contentHash(row.config)!==row.config_hash||contentHash(row.profile)!==row.profile_hash||
   previewDigest({campaignId:input.campaignId,expectedRevision:row.preview_revision,kind:'open',
    request:row.preview_request,proposal:row.preview_proposal,evidence:row.preview_evidence,
    expiresAt:row.preview_expires_at})!==row.preview_digest||
   contentHash(row.preview_proposal.rangekeeperPaperOpenModel)!==envelope.firstObservation.modelHash)
   throw new DeploymentConflict('rangekeeper_paper_confirmation_producer_snapshot_integrity');
  try{await input.verifyAnchors(row.chain_id,[envelope.firstObservation.source,
   envelope.confirmationObservation.source]);}
  catch(error){if(error instanceof AssertionError)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_source_not_canonical');throw error;}
  return {campaignId:input.campaignId,revision:row.revision,openPreviewId:row.preview_id,
   envelope,producerReceipt:receipt,simulationEvidenceStatus:'source_bound_caller_simulation_evidence_unverified' as const,
   actionAvailable:false as const,openingBooked:false as const};
 }

 /** Read-only worker binding check for a claimed RangeKeeper open. It proves
  * that the operation targets the exact preview and producer receipt, but does
  * not make the current caller-claimed simulation eligible for booking. */
 async rangeKeeperPaperConfirmationOperationSnapshot(input:{operationId:string;workerId:string;
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}){
  if(!z.uuid().safeParse(input.operationId).success||
   !/^[a-zA-Z0-9._:-]{8,128}$/.test(input.workerId))
   throw new DeploymentConflict('rangekeeper_paper_confirmation_operation_binding_invalid');
  const db=await this.readPool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const row=(await db.query<{operation_id:string;operation_campaign_id:string;operation_kind:string;
    operation_status:string;claimed_by:string|null;claim_valid:boolean|null;accepted_at:Date;
    mode:string;lifecycle:string;revision:number;chain_id:number;allocation:unknown;runtime_identity:unknown;
    strategy_id:string;strategy_version:string;state_schema_version:number;config:unknown;
    config_hash:string;profile:unknown;profile_hash:string;preview_id:string;preview_kind:string;
    preview_revision:number;preview_request:Record<string,unknown>;preview_proposal:Record<string,unknown>;
    preview_evidence:Record<string,unknown>;preview_digest:string;preview_created_at:Date;
    preview_expires_at:Date;proof_preview_id:string;envelope:unknown;envelope_hash:string;receipt:unknown;
    receipt_hash:string;competing_operation:boolean}>(`
    SELECT o.id::text AS operation_id,o.campaign_id::text AS operation_campaign_id,
     o.kind AS operation_kind,o.status AS operation_status,o.claimed_by,
     (o.claim_until>=clock_timestamp()) AS claim_valid,o.created_at AS accepted_at,
     c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,c.allocation,c.runtime_identity,
     r.strategy_id,r.strategy_version,r.state_schema_version,r.config,r.config_hash,
     p.profile,p.profile_hash,v.id::text AS preview_id,v.kind AS preview_kind,
     v.expected_revision AS preview_revision,v.request AS preview_request,v.proposal AS preview_proposal,
     v.evidence AS preview_evidence,v.content_digest AS preview_digest,v.created_at AS preview_created_at,
     v.expires_at AS preview_expires_at,proof.open_preview_id::text AS proof_preview_id,
     proof.envelope,proof.envelope_hash,producer.receipt,producer.receipt_hash,
     EXISTS(SELECT 1 FROM deployment_operations other WHERE other.campaign_id=o.campaign_id AND
      other.id<>o.id AND other.status IN ('queued','preflighting','executing','confirming',
       'reconciling','blocked')) AS competing_operation
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_previews v ON v.id=o.preview_id AND v.campaign_id=c.id
    JOIN deployment_rangekeeper_paper_confirmations proof
     ON proof.campaign_id=c.id AND proof.revision=c.current_revision
    JOIN deployment_rangekeeper_paper_confirmation_producers producer
     ON producer.campaign_id=proof.campaign_id AND producer.revision=proof.revision
    WHERE o.id=$1`,[input.operationId])).rows[0];
   const runtime=sealedRuntimeIdentitySchema.safeParse(row?.runtime_identity),
    currentRuntime=loadRuntimeIdentity(),profile=marketProfileSchema.safeParse(row?.profile);
   const completed=row?.operation_status==='succeeded';
   if(!row||row.operation_kind!=='open'||
    (!completed&&!['preflighting','executing','confirming','reconciling'].includes(row.operation_status))||
    (completed?(row.claimed_by!==null):(row.claimed_by!==input.workerId||!row.claim_valid))||
    row.mode!=='paper'||row.lifecycle!==(completed?'active':'opening')||
    row.competing_operation||
    row.strategy_id!=='rangekeeper_v1'||row.strategy_version!=='1.0.0'||row.state_schema_version!==1||
    row.preview_kind!=='open'||row.preview_id!==row.proof_preview_id||
    row.preview_revision!==row.revision||row.accepted_at.getTime()<row.preview_created_at.getTime()||
    row.accepted_at.getTime()>row.preview_expires_at.getTime()||!runtime.success||!currentRuntime||
    contentHash(runtime.data)!==contentHash(currentRuntime)||!profile.success||
    contentHash(profile.data)!==row.profile_hash||!row.config||typeof row.config!=='object'||
    Array.isArray(row.config)||contentHash(row.config)!==row.config_hash)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_operation_binding_invalid');
   let envelope,receipt;
   try{
    envelope=validateRangeKeeperPaperConfirmationEnvelope(row.envelope,
     {campaignId:row.operation_campaign_id,revision:row.revision});
    receipt=validateRangeKeeperPaperConfirmationProducerReceipt(row.receipt,{campaignId:
     row.operation_campaign_id,revision:row.revision,openPreviewId:row.preview_id,envelope});
   }catch{throw new DeploymentConflict('rangekeeper_paper_confirmation_operation_evidence_invalid');}
   const config=row.config as Record<string,unknown>,
    {strategyId:_id,strategyVersion:_version,stateSchemaVersion:_schema,...parameters}=config;
   if(config.strategyId!=='rangekeeper_v1'||config.strategyVersion!=='1.0.0'||
    config.stateSchemaVersion!==1||envelope.envelopeHash!==row.envelope_hash||receipt.receiptHash!==row.receipt_hash||
    receipt.producerBuildId!==runtime.data.buildId||row.config_hash!==envelope.draftConfigHash||
    row.profile_hash!==envelope.profileHash||
    previewDigest({campaignId:row.operation_campaign_id,expectedRevision:row.preview_revision,
     kind:'open',request:row.preview_request,proposal:row.preview_proposal,
     evidence:row.preview_evidence,expiresAt:row.preview_expires_at})!==row.preview_digest||
    contentHash(row.preview_proposal.rangekeeperPaperOpenModel)!==envelope.firstObservation.modelHash)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_operation_binding_invalid');
   try{parseStrategyParameters('rangekeeper_v1',parameters);}
   catch{throw new DeploymentConflict('rangekeeper_paper_confirmation_operation_config_invalid');}
   const draft={id:row.operation_campaign_id,revision:row.revision,
    allocation:allocationSchema.parse(row.allocation),profile:profile.data,profileHash:row.profile_hash,
    configHash:row.config_hash,strategyId:'rangekeeper_v1' as const,parameters},
    openModel=row.preview_proposal.rangekeeperPaperOpenModel;
   if(!openModel||typeof openModel!=='object'||Array.isArray(openModel))
    throw new DeploymentConflict('rangekeeper_paper_confirmation_operation_binding_invalid');
   const sources=[envelope.firstObservation.source,envelope.confirmationObservation.source];
   try{await input.verifyAnchors(row.chain_id,sources);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_source_not_canonical');throw error;}
   const contextBody={schemaVersion:1 as const,kind:'rangekeeper_paper_confirmation_context_v1' as const,
    campaignId:row.operation_campaign_id,revision:row.revision,mode:'paper' as const,
    lifecycle:'opening' as const,runtimeIdentity:runtime.data,draft,openModel,
    openModelHash:contentHash(openModel),envelope},
    contextSnapshot={...contextBody,snapshotHash:contentHash(contextBody)},
    body={operationId:row.operation_id,campaignId:row.operation_campaign_id,
    revision:row.revision,openPreviewId:row.preview_id,acceptedAt:row.accepted_at,
    runtimeIdentity:runtime.data,draft,openModel,envelope,producerReceipt:receipt,
    confirmationContext:contextSnapshot,
    simulationEvidenceStatus:'source_bound_caller_simulation_evidence_unverified' as const,
    bookingAvailable:false as const,actionAvailable:false as const};
   try{await input.verifyAnchors(row.chain_id,sources);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_source_changed_during_read');throw error;}
   await db.query('COMMIT');
   return {...body,snapshotHash:contentHash(body)};
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
  finally{db.release();}
 }

 /** Atomically persists the confirmation-derived first mark and capital-in
  * ledger after operation-snapshot and owned-fork replay verification. */
 async completeRangeKeeperPaperConfirmedOpen(input:{operationId:string;workerId:string;
  snapshot:{operationId:string;campaignId:string;revision:number;openPreviewId:string;acceptedAt:Date;
   runtimeIdentity:unknown;draft:import('./rangekeeper-paper-open-model.js').RangeKeeperPaperDraft;
   openModel:unknown;envelope:unknown;producerReceipt:unknown;confirmationContext:unknown;
   simulationEvidenceStatus:'source_bound_caller_simulation_evidence_unverified';
   bookingAvailable:false;actionAvailable:false;snapshotHash:string};
  adapter:RangeKeeperPaperConfirmedOpenAdapterResult;replay:RangeKeeperPaperConfirmationReplayResult;
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>} ){
  const {snapshot}=input,{snapshotHash:_hash,...snapshotBody}=snapshot;
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(input.workerId)||input.operationId!==snapshot.operationId||
   contentHash(snapshotBody)!==snapshot.snapshotHash||snapshot.bookingAvailable!==false||
   snapshot.actionAvailable!==false||snapshot.simulationEvidenceStatus!==
    'source_bound_caller_simulation_evidence_unverified'||
   !isRangeKeeperPaperConfirmationReplayCapability(input.replay,{operationId:input.operationId,
    openPreviewId:snapshot.openPreviewId,operationSnapshotHash:snapshot.snapshotHash,
    campaignId:snapshot.campaignId,revision:snapshot.revision,envelopeHash:input.replay.envelopeHash,
    candidateHash:input.replay.candidateHash,simulationHash:input.replay.simulationHash}))
   throw new DeploymentConflict('rangekeeper_paper_confirmation_replay_provenance_unavailable');
  return this.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`deployment-rangekeeper-paper-open:${input.operationId}`]);
   const row=(await db.query<{operation_id:string;campaign_id:string;preview_id:string;kind:string;status:string;
    stage:string;
    claimed_by:string|null;claim_valid:boolean|null;accepted_at:Date;mode:string;lifecycle:string;
    revision:number;chain_id:number;allocation:unknown;runtime_identity:unknown;strategy_id:string;
    strategy_version:string;state_schema_version:number;config:unknown;config_hash:string;profile:unknown;
    profile_hash:string;preview_kind:string;preview_revision:number;request:Record<string,unknown>;
    proposal:Record<string,unknown>;evidence:Record<string,unknown>;preview_digest:string;
    preview_created_at:Date;expires_at:Date;envelope:unknown;envelope_hash:string;receipt:unknown;
    receipt_hash:string;competing:boolean}>(`
    SELECT o.id::text AS operation_id,o.campaign_id::text,o.preview_id::text,o.kind,o.status,o.stage,o.claimed_by,
     (o.claim_until>=clock_timestamp()) AS claim_valid,o.created_at AS accepted_at,
     c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,c.allocation,c.runtime_identity,
     r.strategy_id,r.strategy_version,r.state_schema_version,r.config,r.config_hash,
     p.profile,p.profile_hash,v.kind AS preview_kind,v.expected_revision AS preview_revision,
     v.request,v.proposal,v.evidence,v.content_digest AS preview_digest,v.created_at AS preview_created_at,
     v.expires_at,proof.envelope,proof.envelope_hash,producer.receipt,producer.receipt_hash,
     EXISTS(SELECT 1 FROM deployment_operations x WHERE x.campaign_id=o.campaign_id AND
      x.id<>o.id AND x.status IN ('queued','preflighting','executing','confirming','reconciling','blocked'))
      AS competing
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_previews v ON v.id=o.preview_id AND v.campaign_id=c.id
    JOIN deployment_rangekeeper_paper_confirmations proof
     ON proof.campaign_id=c.id AND proof.revision=c.current_revision
    JOIN deployment_rangekeeper_paper_confirmation_producers producer
     ON producer.campaign_id=proof.campaign_id AND producer.revision=proof.revision
    WHERE o.id=$1 FOR UPDATE OF o,c`,[input.operationId])).rows[0];
   const completedReplay=row?.status==='succeeded';
   if(!row||row.campaign_id!==snapshot.campaignId||row.preview_id!==snapshot.openPreviewId||
    row.kind!=='open'||(!completedReplay&&(row.status!=='reconciling'||
     row.stage!=='paper_model_reconciling'))||
    (completedReplay&&row.stage!=='rangekeeper_paper_open_recorded')||
    (completedReplay?row.claimed_by!==null:(row.claimed_by!==input.workerId||!row.claim_valid))||
    row.mode!=='paper'||row.lifecycle!==(completedReplay?'active':'opening')||row.competing||
    row.revision!==snapshot.revision||
    row.preview_kind!=='open'||row.preview_revision!==snapshot.revision||
    row.accepted_at.getTime()!==snapshot.acceptedAt.getTime()||
    row.accepted_at.getTime()<row.preview_created_at.getTime()||row.accepted_at.getTime()>row.expires_at.getTime())
    throw new DeploymentConflict('rangekeeper_paper_confirmation_operation_changed');
   const runtime=sealedRuntimeIdentitySchema.safeParse(row.runtime_identity),profile=marketProfileSchema.safeParse(row.profile);
   if(!runtime.success||!profile.success||contentHash(runtime.data)!==contentHash(snapshot.runtimeIdentity)||
    row.strategy_id!=='rangekeeper_v1'||row.strategy_version!=='1.0.0'||row.state_schema_version!==1||
    contentHash(row.profile)!==row.profile_hash||contentHash(row.config)!==row.config_hash||
    contentHash(row.profile)!==contentHash(snapshot.draft.profile)||
    contentHash(row.allocation)!==contentHash(snapshot.draft.allocation))
    throw new DeploymentConflict('rangekeeper_paper_confirmation_campaign_changed');
   const config=row.config as Record<string,unknown>,
    {strategyId,strategyVersion,stateSchemaVersion,...parameters}=config;
   if(strategyId!=='rangekeeper_v1'||strategyVersion!=='1.0.0'||stateSchemaVersion!==1||
    snapshot.draft.id!==row.campaign_id||snapshot.draft.revision!==row.revision||
    snapshot.draft.strategyId!=='rangekeeper_v1'||snapshot.draft.configHash!==row.config_hash||
    snapshot.draft.profileHash!==row.profile_hash||
    contentHash(parseStrategyParameters('rangekeeper_v1',parameters))!==
     contentHash(snapshot.draft.parameters))
    throw new DeploymentConflict('rangekeeper_paper_confirmation_campaign_changed');
   let envelope,receipt;
   try{
    envelope=validateRangeKeeperPaperConfirmationEnvelope(row.envelope,
     {campaignId:row.campaign_id,revision:row.revision});
    receipt=validateRangeKeeperPaperConfirmationProducerReceipt(row.receipt,{campaignId:row.campaign_id,
     revision:row.revision,openPreviewId:row.preview_id,envelope});
   }catch{throw new DeploymentConflict('rangekeeper_paper_confirmation_evidence_invalid');}
   if(envelope.envelopeHash!==row.envelope_hash||receipt.receiptHash!==row.receipt_hash||
    receipt.producerBuildId!==runtime.data.buildId||contentHash(envelope)!==contentHash(snapshot.envelope)||
    contentHash(receipt)!==contentHash(snapshot.producerReceipt)||row.config_hash!==envelope.draftConfigHash||
    row.profile_hash!==envelope.profileHash||contentHash(row.proposal.rangekeeperPaperOpenModel)!==
     contentHash(snapshot.openModel)||contentHash(row.proposal.rangekeeperPaperOpenModel)!==
     envelope.firstObservation.modelHash||previewDigest({campaignId:row.campaign_id,
      expectedRevision:row.preview_revision,kind:'open',request:row.request,proposal:row.proposal,
      evidence:row.evidence,expiresAt:row.expires_at})!==row.preview_digest)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_operation_snapshot_changed');
   const sources=[envelope.firstObservation.source,envelope.confirmationObservation.source];
   try{await input.verifyAnchors(row.chain_id,sources);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_source_not_canonical');throw error;}
   const confirmation=await loadRangeKeeperPaperConfirmationContext({campaignId:row.campaign_id,
    runtimeIdentity:runtime.data,readSnapshot:async()=>snapshot.confirmationContext,
    readGasProfiles:query=>this.rangeKeeperPaperGasProfiles(query.poolAddress,query.pathVersion,query.sizeBand),
    now:snapshot.acceptedAt.getTime()});
   if(confirmation.status!=='available')throw new DeploymentConflict(confirmation.reason);
   const adapter=adaptRangeKeeperConfirmedOpenContext(confirmation);
   if(contentHash(adapter)!==contentHash(input.adapter)||!isRangeKeeperPaperConfirmationReplayCapability(
    input.replay,{operationId:row.operation_id,openPreviewId:row.preview_id,
     operationSnapshotHash:snapshot.snapshotHash,campaignId:row.campaign_id,revision:row.revision,
     envelopeHash:envelope.envelopeHash,candidateHash:envelope.confirmationObservation.candidateHash,
     simulationHash:envelope.decision.simulation.simulationHash}))
    throw new DeploymentConflict('rangekeeper_paper_confirmation_completion_binding_invalid');
   const confirmedOpen=createRangeKeeperPaperConfirmedOpenRecord({adapter,previewId:row.preview_id,
    operationId:input.operationId,replay:input.replay});
   try{validateRangeKeeperPaperConfirmedOpenRecord(confirmedOpen,{campaignId:row.campaign_id,
    revision:row.revision,previewId:row.preview_id,operationId:input.operationId,
    firstModel:snapshot.openModel,confirmationEnvelopeHash:envelope.envelopeHash,
    confirmationEnvelope:envelope});}
   catch{throw new DeploymentConflict('rangekeeper_paper_confirmation_completion_model_invalid');}
   const model=adapter.model,candidate=model.candidate,costs=model.costs,reference=model.reference;
   if(model.status!=='indicative'||!candidate||!costs||!reference.price0||!reference.price1||
    !reference.nativePrice||!reference.proofHash)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_completion_model_unavailable');
   const allocation=allocationSchema.parse(row.allocation),inventory=buildRangeKeeperPaperConfirmedOpenInventory({
    model,allocation,decimals0:profile.data.pool.decimals0,decimals1:profile.data.pool.decimals1}),
    source=paperFeeMarkSourceSchema.parse(model.source),modelHash=adapter.modelHash;
   const provenance={classification:'rangekeeper_paper_open_v1',previewId:row.preview_id,
    operationId:input.operationId,modelHash,candidateHash:model.candidateHash,source,
    confirmationEnvelopeHash:envelope.envelopeHash,replayHash:input.replay.replayHash,
    reference,referenceProofHash:reference.proofHash,
    confirmedOpen,paidCostsAvailable:false},
    economics={modeledCosts:costs,paidCosts:null,feeIncome:null,netNav:null,alpha:null},
    p=profile.data.pool,value=(amount:string,price:string,decimals:number)=>
     String(BigInt(amount)*BigInt(price)/10n**BigInt(decimals)),
    ledgerSource={classification:'rangekeeper_paper_confirmed_open_capital_in_v1',
     previewId:row.preview_id,operationId:input.operationId,modelHash,
     confirmationEnvelopeHash:envelope.envelopeHash,replayHash:input.replay.replayHash,
     source,reference,referenceProofHash:reference.proofHash,
     modeledCostsAvailable:false,paidCostsAvailable:false};
   const capitalRows=[...[
    ['token0',p.token0,allocation.token0Raw,reference.price0,p.decimals0],
    ['token1',p.token1,allocation.token1Raw,reference.price1,p.decimals1],
    ['native',null,allocation.nativeWei,reference.nativePrice,18],
   ] as const].map(([asset,token,amount,price,decimals])=>({asset,token,amount,
    value:value(amount,price,decimals),source:{...ledgerSource,asset}}));
   const expectedMark={revision:row.revision,source_block:source.block,source_hash:source.hash,
    inventory,economics,calibration_profile_ids:costs.profileIds.map(stage=>stage.id),provenance},
    existing=(await db.query<{id:string;revision:number;source_block:string;source_hash:string;
     inventory:unknown;economics:unknown;calibration_profile_ids:string[];provenance:Record<string,unknown>}>(`
     SELECT id::text,revision,source_block::text,source_hash,inventory,economics,
      calibration_profile_ids,provenance FROM deployment_marks
     WHERE campaign_id=$1 AND provenance->>'operationId'=$2`,[row.campaign_id,input.operationId])).rows;
   if(completedReplay){
    const ledger=(await db.query<{entry_key:string;kind:string;token_address:string|null;
     amount_raw:string;value_raw:string;source:unknown}>(`SELECT entry_key,kind,token_address,amount_raw,
      value_raw,source FROM deployment_ledger WHERE campaign_id=$1 AND operation_id=$2 ORDER BY entry_key`,
      [row.campaign_id,input.operationId])).rows;
    const exactMark=existing.length===1&&existing[0]!.revision===expectedMark.revision&&
     existing[0]!.source_block===expectedMark.source_block&&
     existing[0]!.source_hash.toLowerCase()===expectedMark.source_hash.toLowerCase()&&
     contentHash(existing[0]!.inventory)===contentHash(expectedMark.inventory)&&
     contentHash(existing[0]!.economics)===contentHash(expectedMark.economics)&&
     contentHash(existing[0]!.calibration_profile_ids)===contentHash(expectedMark.calibration_profile_ids)&&
     contentHash(existing[0]!.provenance)===contentHash(expectedMark.provenance),
     exactLedger=ledger.length===3&&capitalRows.every(item=>ledger.some(saved=>
      saved.entry_key===`rangekeeper_open:${input.operationId}:${item.asset}`&&saved.kind==='capital_in'&&
      saved.token_address===item.token&&saved.amount_raw===item.amount&&saved.value_raw===item.value&&
      contentHash(saved.source)===contentHash(item.source)));
    if(!exactMark||!exactLedger)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_open_replay_conflict');
    try{await input.verifyAnchors(row.chain_id,sources);}
    catch(error){if(error instanceof AssertionError)
      throw new DeploymentConflict('rangekeeper_paper_confirmation_source_not_canonical');throw error;}
    return {markId:existing[0]!.id,replayed:true,actionAvailable:false as const};
   }
   const markCount=(await db.query<{n:number}>(`SELECT count(*)::int AS n FROM deployment_marks
    WHERE campaign_id=$1`,[row.campaign_id])).rows[0]?.n,
    ledgerCount=(await db.query<{n:number}>(`SELECT count(*)::int AS n FROM deployment_ledger
     WHERE campaign_id=$1 AND operation_id=$2`,[row.campaign_id,input.operationId])).rows[0]?.n;
   if(markCount!==0)throw new DeploymentConflict('rangekeeper_paper_confirmation_open_mark_exists');
   if(ledgerCount!==0)throw new DeploymentConflict('rangekeeper_paper_confirmation_open_ledger_exists');
   for(const item of capitalRows){
    await db.query(`INSERT INTO deployment_ledger
     (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
     VALUES($1,$2,$3,'capital_in',$4,$5,$6,$7)`,
     [row.campaign_id,input.operationId,`rangekeeper_open:${input.operationId}:${item.asset}`,item.token,
      item.amount,item.value,JSON.stringify(item.source)]);
   }
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`,
    [row.campaign_id,row.revision,source.block,source.hash,JSON.stringify(inventory),JSON.stringify(economics),
     costs.profileIds.map(stage=>stage.id),JSON.stringify(provenance)])).rows[0]!;
   try{await input.verifyAnchors(row.chain_id,sources);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_source_changed_during_completion');throw error;}
   await db.query(`UPDATE deployment_campaigns SET lifecycle='active',range_state=$2,
    updated_at=clock_timestamp() WHERE id=$1 AND lifecycle='opening'`,
    [row.campaign_id,candidate.range.tickLower<=model.poolState.tick&&
     model.poolState.tick<candidate.range.tickUpper?'inside':'outside']);
   const updated=(await db.query(`UPDATE deployment_operations SET status='succeeded',
    stage='rangekeeper_paper_open_recorded',claimed_by=NULL,claim_until=NULL,
    updated_at=clock_timestamp() WHERE id=$1 AND status='reconciling' AND claimed_by=$2`,
    [input.operationId,input.workerId])).rowCount;
   if(updated!==1)throw new DeploymentConflict('rangekeeper_paper_confirmation_claim_lost');
   return {markId:mark.id,replayed:false,actionAvailable:false as const};
  });
 }

 /** Read-only dashboard projection. It verifies the stored content hash and
  * both canonical observations on every read; revoked or missing proof fails closed. */
 async rangeKeeperPaperConfirmationEnvelope(input:{campaignId:string;
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}){
  const row=(await this.readPool.query<{revision:number;chain_id:number;envelope:unknown;
   envelope_hash:string;mode:string;strategy_id:string}>(`
   SELECT c.current_revision AS revision,c.chain_id,c.mode,r.strategy_id,
    proof.envelope,proof.envelope_hash
   FROM deployment_rangekeeper_paper_confirmations proof
   JOIN deployment_campaigns c ON c.id=proof.campaign_id
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=proof.revision
   WHERE proof.campaign_id=$1 AND proof.revision=c.current_revision`,[input.campaignId])).rows[0];
  if(!row||row.mode!=='paper'||row.strategy_id!=='rangekeeper_v1')return null;
  let envelope;
  try{envelope=validateRangeKeeperPaperConfirmationEnvelope(row.envelope,
   {campaignId:input.campaignId,revision:row.revision});}
  catch{throw new DeploymentConflict('rangekeeper_paper_confirmation_envelope_integrity_invalid');}
  if(envelope.envelopeHash!==row.envelope_hash)
   throw new DeploymentConflict('rangekeeper_paper_confirmation_envelope_integrity_invalid');
  try{await input.verifyAnchors(row.chain_id,[envelope.firstObservation.source,
   envelope.confirmationObservation.source]);}
  catch(error){if(error instanceof AssertionError)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_source_not_canonical');throw error;}
  return {...envelope,actionAvailable:false as const};
 }

 /** Read-only, repeatable-read snapshot for the restart-safe confirmation
  * consumer. Campaign config, runtime, open preview and the envelope are read
  * together; both anchors are rechecked before the snapshot is returned. */
 async rangeKeeperPaperConfirmationContextSnapshot(input:{campaignId:string;
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}):Promise<unknown>{
  const db=await this.readPool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const row=(await db.query<{campaign_id:string;mode:string;lifecycle:string;revision:number;chain_id:number;
    allocation:unknown;runtime_identity:unknown;profile:unknown;profile_hash:string;config:unknown;
    config_hash:string;strategy_id:string;strategy_version:string;state_schema_version:number;
    envelope:unknown;envelope_hash:string;open_preview_id:string;open_request:Record<string,unknown>;
    open_proposal:Record<string,unknown>;open_evidence:Record<string,unknown>;open_digest:string;
    open_expected_revision:number;open_expires_at:Date;pending:boolean}>(`
    SELECT c.id AS campaign_id,c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,
     c.allocation,c.runtime_identity,p.profile,p.profile_hash,r.config,r.config_hash,
     r.strategy_id,r.strategy_version,r.state_schema_version,proof.envelope,proof.envelope_hash,
     v.id::text AS open_preview_id,v.request AS open_request,v.proposal AS open_proposal,
     v.evidence AS open_evidence,v.content_digest AS open_digest,
     v.expected_revision AS open_expected_revision,v.expires_at AS open_expires_at,
     EXISTS(SELECT 1 FROM deployment_operations op WHERE op.campaign_id=c.id AND op.status IN
      ('queued','preflighting','executing','confirming','reconciling','blocked')) AS pending
    FROM deployment_rangekeeper_paper_confirmations proof
    JOIN deployment_campaigns c ON c.id=proof.campaign_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=proof.revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_previews v ON v.id=proof.open_preview_id AND v.campaign_id=c.id
    WHERE proof.campaign_id=$1 AND proof.revision=c.current_revision`,[input.campaignId])).rows[0];
   const runtime=sealedRuntimeIdentitySchema.safeParse(row?.runtime_identity),
    currentRuntime=loadRuntimeIdentity(),profile=marketProfileSchema.safeParse(row?.profile);
   if(!row||row.mode!=='paper'||!['draft','active'].includes(row.lifecycle)||row.chain_id!==4663||
    row.strategy_id!=='rangekeeper_v1'||row.strategy_version!=='1.0.0'||row.state_schema_version!==1||
    row.pending||
    row.open_expected_revision!==row.revision||!runtime.success||!currentRuntime||
    contentHash(runtime.data)!==contentHash(currentRuntime)||!profile.success||
    contentHash(profile.data)!==row.profile_hash||!row.config||typeof row.config!=='object'||
    Array.isArray(row.config)||contentHash(row.config)!==row.config_hash)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_context_unavailable');
   if(previewDigest({campaignId:input.campaignId,expectedRevision:row.open_expected_revision,kind:'open',
    request:row.open_request,proposal:row.open_proposal,evidence:row.open_evidence,
    expiresAt:row.open_expires_at})!==row.open_digest)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_preview_integrity');
   const openModel=(row.open_proposal as Record<string,unknown>).rangekeeperPaperOpenModel,
    envelope=validateRangeKeeperPaperConfirmationEnvelope(row.envelope,
     {campaignId:input.campaignId,revision:row.revision});
   if(!openModel||typeof openModel!=='object'||Array.isArray(openModel)||
    contentHash(openModel)!==envelope.firstObservation.modelHash||
    envelope.envelopeHash!==row.envelope_hash||envelope.draftConfigHash!==row.config_hash||
    envelope.profileHash!==row.profile_hash)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_context_integrity');
   const config=row.config as Record<string,unknown>;
   if(config.strategyId!==row.strategy_id||config.strategyVersion!==row.strategy_version||
    config.stateSchemaVersion!==row.state_schema_version)
    throw new DeploymentConflict('rangekeeper_paper_confirmation_config_invalid');
   const {strategyId:_id,strategyVersion:_version,stateSchemaVersion:_schema,...parameters}=config,
    draft={id:input.campaignId,revision:row.revision,allocation:allocationSchema.parse(row.allocation),
     profile:profile.data,profileHash:row.profile_hash,configHash:row.config_hash,
     strategyId:'rangekeeper_v1' as const,parameters},
    sources=[envelope.firstObservation.source,envelope.confirmationObservation.source];
   parseStrategyParameters('rangekeeper_v1',parameters);
   try{await input.verifyAnchors(row.chain_id,sources);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_source_not_canonical');throw error;}
   const body={schemaVersion:1 as const,kind:'rangekeeper_paper_confirmation_context_v1' as const,
    campaignId:input.campaignId,revision:row.revision,mode:'paper' as const,
    lifecycle:row.lifecycle as 'draft'|'active',runtimeIdentity:runtime.data,draft,
    openModel,openModelHash:contentHash(openModel),envelope};
   const snapshot={...body,snapshotHash:contentHash(body)};
   try{await input.verifyAnchors(row.chain_id,sources);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_confirmation_source_changed_during_read');throw error;}
   await db.query('COMMIT');
   return snapshot;
  }catch(error){
   await db.query('ROLLBACK').catch(()=>{});
   throw error;
  }finally{db.release();}
 }

 /** A consistent, read-only seed for the first and later paper observations.
  * The terminal snapshot deliberately requires a post-open mark; maintenance
  * must also be able to start directly from the verified booked opening. */
 async rangeKeeperPaperMaintenanceSnapshot(campaignId:string){
  const db=await this.readPool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const row=(await db.query<{mode:string;lifecycle:string;revision:number;chain_id:number;
    runtime_identity:unknown;allocation:unknown;profile:unknown;profile_hash:string;evidence:unknown;
    config:unknown;config_hash:string;strategy_id:string;strategy_version:string;state_schema_version:number;
    open_id:string;open_source_block:string;open_source_hash:string;open_inventory:unknown;
    open_provenance:Record<string,unknown>;first_model:unknown;envelope:unknown;envelope_hash:string;
    previous_id:string;previous_source_block:string;previous_source_hash:string;
    previous_inventory:unknown;previous_provenance:Record<string,unknown>;pending:boolean}>(`
    SELECT c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,c.runtime_identity,c.allocation,
     p.profile,p.profile_hash,p.evidence,r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version,
     o.id::text AS open_id,o.source_block::text AS open_source_block,o.source_hash AS open_source_hash,
     o.inventory AS open_inventory,o.provenance AS open_provenance,
     v.proposal->'rangekeeperPaperOpenModel' AS first_model,proof.envelope,proof.envelope_hash,
     m.id::text AS previous_id,m.source_block::text AS previous_source_block,m.source_hash AS previous_source_hash,
     m.inventory AS previous_inventory,m.provenance AS previous_provenance,
     EXISTS(SELECT 1 FROM deployment_operations op WHERE op.campaign_id=c.id AND op.status IN
      ('queued','preflighting','executing','confirming','reconciling','blocked')) AS pending
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id AND p.retired_at IS NULL
    JOIN LATERAL (SELECT id,source_block,source_hash,inventory,provenance FROM deployment_marks
     WHERE campaign_id=c.id AND provenance->>'classification'='rangekeeper_paper_open_v1'
     ORDER BY id LIMIT 1) o ON true
    JOIN deployment_previews v ON v.id::text=o.provenance->>'previewId' AND v.campaign_id=c.id
    JOIN deployment_rangekeeper_paper_confirmations proof
     ON proof.campaign_id=c.id AND proof.revision=c.current_revision
    JOIN LATERAL (SELECT id,source_block,source_hash,inventory,provenance FROM deployment_marks
     WHERE campaign_id=c.id ORDER BY id DESC LIMIT 1) m ON true
    WHERE c.id=$1`,[campaignId])).rows[0];
   const runtime=sealedRuntimeIdentitySchema.safeParse(row?.runtime_identity),current=loadRuntimeIdentity();
   const runtimeMatches=row&&await campaignRuntimeMatches(db,campaignId,row.runtime_identity,current);
   if(!row||row.mode!=='paper'||!['active','paused'].includes(row.lifecycle)||row.pending||
    row.strategy_id!=='rangekeeper_v1'||row.strategy_version!=='1.0.0'||row.state_schema_version!==1)
    throw new DeploymentConflict('rangekeeper_paper_maintenance_campaign_unavailable');
   if(!runtime.success||!runtimeMatches)
    throw new DeploymentConflict('rangekeeper_paper_maintenance_runtime_mismatch');
   const profile=marketProfileSchema.parse(row.profile),evidence=marketProfileEvidenceSchema.parse(row.evidence);
   if(profile.pool.chainId!==row.chain_id||contentHash(profile)!==row.profile_hash||
    referenceProofHash(evidence.referenceProof)!==evidence.references.proofHash)
    throw new DeploymentConflict('market_profile_integrity');
   for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
    if(profile.pool[key].toLowerCase()!==evidence.contractHashes[key].toLowerCase())
     throw new DeploymentConflict('market_profile_integrity');
   const known=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
    WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=$3 AND fee=$4 AND enabled=true
     AND target_set_hash=$5 AND lower(rwa_address)=lower($6)) AS found`,[evidence.streamKey,
     profile.pool.pool,row.chain_id,profile.pool.fee,evidence.indexerTargetSetHash,
     profile.pool.quoteToken===0?profile.pool.token1:profile.pool.token0])).rows[0]?.found;
   if(!known)throw new DeploymentConflict('market_profile_indexer_changed');
   if(!row.config||typeof row.config!=='object'||Array.isArray(row.config)||contentHash(row.config)!==row.config_hash)
    throw new DeploymentConflict('campaign_config_integrity');
   const {strategyId,strategyVersion,stateSchemaVersion,...parameters}=row.config as Record<string,unknown>;
   if(strategyId!==row.strategy_id||strategyVersion!==row.strategy_version||stateSchemaVersion!==row.state_schema_version)
    throw new DeploymentConflict('campaign_config_integrity');
   parseStrategyParameters('rangekeeper_v1',parameters);
   const allocation=allocationSchema.parse(row.allocation),envelope=validateRangeKeeperPaperConfirmationEnvelope(
    row.envelope,{campaignId,revision:row.revision});
   if(envelope.envelopeHash!==row.envelope_hash)
    throw new DeploymentConflict('rangekeeper_paper_confirmed_open_integrity');
   const booked=validateRangeKeeperPaperConfirmedOpenRecord(row.open_provenance.confirmedOpen,{
    campaignId,revision:row.revision,previewId:String(row.open_provenance.previewId),
    operationId:String(row.open_provenance.operationId),firstModel:row.first_model,
    confirmationEnvelopeHash:envelope.envelopeHash,confirmationEnvelope:envelope});
   const model=booked.model,openSource=paperFeeMarkSourceSchema.parse(row.open_provenance.source),
    previousSource=paperFeeMarkSourceSchema.parse(row.previous_provenance.source);
   const inventory=buildRangeKeeperPaperConfirmedOpenInventory({model,allocation,
    decimals0:profile.pool.decimals0,decimals1:profile.pool.decimals1});
   if(contentHash(inventory)!==contentHash(row.open_inventory)||booked.modelHash!==row.open_provenance.modelHash||
    contentHash(model.source)!==contentHash(openSource)||openSource.block!==row.open_source_block||
    openSource.hash.toLowerCase()!==row.open_source_hash.toLowerCase()||
    previousSource.block!==row.previous_source_block||previousSource.hash.toLowerCase()!==row.previous_source_hash.toLowerCase())
    throw new DeploymentConflict('rangekeeper_paper_maintenance_mark_integrity');
   let kernelSnapshot:unknown=null,epoch=0,candidate:unknown=model.candidate;
   if(row.previous_id!==row.open_id){
    if(row.previous_provenance.classification==='rangekeeper_paper_recenter_v1'){
     const savedEpoch=Number(row.previous_provenance.epoch),savedInventory=row.previous_provenance.inventory,
      savedCandidate=row.previous_provenance.candidate,savedKernel=row.previous_provenance.kernelSnapshot;
     if(!Number.isInteger(savedEpoch)||savedEpoch<1||!savedCandidate||!savedKernel||
      typeof row.previous_provenance.modelHash!=='string'||
      !/^[0-9a-f]{64}$/.test(row.previous_provenance.modelHash)||
      contentHash(savedInventory)!==contentHash(row.previous_inventory)||
      contentHash(savedKernel&&typeof savedKernel==='object'?
       (savedKernel as Record<string,unknown>).source:null)!==contentHash(previousSource))
      throw new DeploymentConflict('rangekeeper_paper_maintenance_mark_integrity');
     epoch=savedEpoch;candidate=savedCandidate;kernelSnapshot=savedKernel;
    }else{
     const saved=row.previous_provenance.kernelSnapshot as Record<string,unknown>|undefined,
      savedPositionEpoch=row.previous_provenance.epoch??0,
      poolState=row.previous_provenance.poolState as {tick?:unknown;sqrtPriceX96?:unknown;
       poolLiquidity?:unknown}|undefined;
     if(row.previous_provenance.classification!=='rangekeeper_paper_mark_v1'||
      row.previous_provenance.candidateHash!==model.candidateHash||!saved||
      row.previous_provenance.initialModeledOpenCost!==undefined||savedPositionEpoch!==0||
      !poolState||typeof poolState.sqrtPriceX96!=='string'||
      contentHash(rangeKeeperPositionIdleProjection(row.previous_inventory))!==
       contentHash(rangeKeeperPositionIdleProjection(inventory)))
      throw new DeploymentConflict('rangekeeper_paper_maintenance_mark_integrity');
     try{
      const state=parseRangeKeeperPaperState(saved.state),normalized=serializeRangeKeeperPaperKernelSnapshot({
       source:previousSource,state,wallet0:BigInt(String(saved.wallet0)),wallet1:BigInt(String(saved.wallet1)),
       released0:BigInt(String(saved.released0)),released1:BigInt(String(saved.released1)),
       nativeWei:BigInt(String(saved.nativeWei)),campaignStartValue:BigInt(String(saved.campaignStartValue)),
       highWaterValue:BigInt(String(saved.highWaterValue)),rollingSpentCost:BigInt(String(saved.rollingSpentCost)),
       campaignSpentCost:BigInt(String(saved.campaignSpentCost)),reservedCost:BigInt(String(saved.reservedCost)),
       recenters:Number(saved.recenters),pending:saved.pending===true,entryAllowed:saved.entryAllowed===true,
       safeExitRequired:saved.safeExitRequired===true,executionReady:saved.executionReady===true}),
       previousInventory=row.previous_inventory as {idle?:unknown;position?:unknown},
       idle=previousInventory.idle as {token0?:unknown;token1?:unknown},
       position=previousInventory.position as {tickLower?:unknown;tickUpper?:unknown;liquidity?:unknown};
      const sqrtPriceX96=BigInt(poolState.sqrtPriceX96),principal=principalAmounts({
       liquidity:BigInt(String(position.liquidity)),tickLower:Number(position.tickLower),
       tickUpper:Number(position.tickUpper),sqrtPriceX96});
      if(contentHash(normalized)!==contentHash(saved)||state.buildId!==model.kernelBuildId||
       state.configHash.toLowerCase()!==`0x${model.kernelPolicyHash}`.toLowerCase()||
       normalized.source.block!==previousSource.block||
       normalized.source.hash.toLowerCase()!==previousSource.hash.toLowerCase()||
       normalized.recenters!==0||normalized.pending||normalized.wallet0!==String(idle.token0)||
       normalized.wallet1!==String(idle.token1)||normalized.released0!==String(principal.amount0)||
       normalized.released1!==String(principal.amount1)||normalized.campaignSpentCost!=='0'||
       normalized.rollingSpentCost!=='0'||normalized.nativeWei!==allocation.nativeWei)
       throw new Error('legacy initial observation invariant mismatch');
      kernelSnapshot=normalized;
     }catch{throw new DeploymentConflict('rangekeeper_paper_maintenance_legacy_kernel_invalid');}
    }
   }
   const snapshot={draft:{id:campaignId,revision:row.revision,allocation,profile,
    profileHash:row.profile_hash,configHash:row.config_hash,strategyId:'rangekeeper_v1' as const,parameters},
    lifecycle:row.lifecycle as 'active'|'paused',runtimeIdentity:runtime.data,
    openMark:{id:row.open_id,source:openSource,model,inventory,kernelState:envelope.strategyState},
    previousMark:{id:row.previous_id,source:previousSource,inventory:row.previous_inventory,
     kernelSnapshot,epoch,candidate}};
   await db.query('COMMIT');return snapshot;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }

 /** Read-only state for epoch planning. The opening mark is kept distinct and
  * immutable; previousMark always names the exact latest position/epoch. */
 async rangeKeeperPaperEpochSnapshot(campaignId:string,claimedOperationId?:string){
  const db=await this.readPool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const row=(await db.query<{mode:string;lifecycle:string;revision:number;chain_id:number;
    runtime_identity:unknown;allocation:unknown;profile:unknown;profile_hash:string;config:unknown;
    config_hash:string;strategy_id:string;strategy_version:string;state_schema_version:number;
    open_id:string;open_revision:number;open_source_block:string|null;open_source_hash:string|null;
    open_inventory:Record<string,unknown>;open_economics:unknown;open_provenance:Record<string,unknown>;
    open_preview_model:Record<string,unknown>|null;
    latest_id:string;latest_revision:number;latest_source_block:string|null;latest_source_hash:string|null;
    latest_inventory:Record<string,unknown>;latest_economics:unknown;latest_provenance:Record<string,unknown>;
    pending:boolean}>(`
    SELECT c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,c.runtime_identity,c.allocation,
     p.profile,p.profile_hash,r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version,
     o.id::text AS open_id,o.revision AS open_revision,o.source_block::text AS open_source_block,
     o.source_hash AS open_source_hash,o.inventory AS open_inventory,o.economics AS open_economics,
     o.provenance AS open_provenance,ov.proposal->'rangekeeperPaperOpenModel' AS open_preview_model,
     m.id::text AS latest_id,m.revision AS latest_revision,m.source_block::text AS latest_source_block,
     m.source_hash AS latest_source_hash,m.inventory AS latest_inventory,m.economics AS latest_economics,
     m.provenance AS latest_provenance,
     EXISTS(SELECT 1 FROM deployment_operations op WHERE op.campaign_id=c.id AND
      ($2::uuid IS NULL OR op.id<>$2::uuid) AND op.status IN
      ('queued','preflighting','executing','confirming','reconciling','blocked')) AS pending
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN LATERAL (SELECT * FROM deployment_marks WHERE campaign_id=c.id AND
     provenance->>'classification'='rangekeeper_paper_open_v1' ORDER BY id LIMIT 1) o ON true
    LEFT JOIN deployment_previews ov ON ov.id::text=o.provenance->>'previewId' AND ov.campaign_id=c.id
    JOIN LATERAL (SELECT * FROM deployment_marks WHERE campaign_id=c.id ORDER BY id DESC LIMIT 1) m ON true
    WHERE c.id=$1`,[campaignId,claimedOperationId??null])).rows[0];
   const runtime=sealedRuntimeIdentitySchema.safeParse(row?.runtime_identity),current=loadRuntimeIdentity(),
    profile=marketProfileSchema.safeParse(row?.profile),
    runtimeMatches=row&&await campaignRuntimeMatches(db,campaignId,row.runtime_identity,current);
   if(!row||row.mode!=='paper'||!['active','paused','closing'].includes(row.lifecycle)||row.pending||
    row.chain_id!==4663||row.strategy_id!=='rangekeeper_v1'||row.strategy_version!=='1.0.0'||
    row.state_schema_version!==1||row.open_revision!==row.revision||row.latest_revision!==row.revision||
    !runtime.success||!runtimeMatches||!profile.success||
    contentHash(profile.data)!==row.profile_hash||!row.config||typeof row.config!=='object'||
    Array.isArray(row.config)||contentHash(row.config)!==row.config_hash)
    throw new DeploymentConflict('rangekeeper_paper_epoch_snapshot_unavailable');
   const openSource=paperFeeMarkSourceSchema.safeParse(row.open_provenance.source),
    latestSource=paperFeeMarkSourceSchema.safeParse(row.latest_provenance.source);
   if(!openSource.success||!latestSource.success||row.open_source_block===null||row.open_source_hash===null||
    row.latest_source_block===null||row.latest_source_hash===null||
    openSource.data.block!==row.open_source_block||openSource.data.hash.toLowerCase()!==row.open_source_hash.toLowerCase()||
    latestSource.data.block!==row.latest_source_block||latestSource.data.hash.toLowerCase()!==row.latest_source_hash.toLowerCase()||
    row.open_provenance.classification!=='rangekeeper_paper_open_v1'||
    row.latest_provenance.classification!== (row.latest_id===row.open_id?'rangekeeper_paper_open_v1':
     row.latest_provenance.classification)||
    !['rangekeeper_paper_open_v1','rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1']
     .includes(String(row.latest_provenance.classification)))
    throw new DeploymentConflict('rangekeeper_paper_epoch_mark_integrity');
   const openBody={revision:row.open_revision,source_block:row.open_source_block,
    source_hash:row.open_source_hash,inventory:row.open_inventory,economics:row.open_economics,
    provenance:row.open_provenance},latestBody={revision:row.latest_revision,
    source_block:row.latest_source_block,source_hash:row.latest_source_hash,
    inventory:row.latest_inventory,economics:row.latest_economics,provenance:row.latest_provenance};
   const openModel=((row.open_provenance.confirmedOpen as Record<string,unknown>|undefined)?.model??
    row.open_provenance.model??row.open_preview_model) as Record<string,unknown>|undefined;
   if(!openModel||!openModel.candidate)
    throw new DeploymentConflict('rangekeeper_paper_epoch_open_model_unavailable');
   const openMark={id:row.open_id,markHash:contentHash(openBody),source:openSource.data,epoch:0,
    classification:'rangekeeper_paper_open_v1' as const,model:openModel,candidate:openModel?.candidate,
    inventory:row.open_inventory,...(row.open_provenance.kernelSnapshot===undefined?{}:
     {kernelSnapshot:row.open_provenance.kernelSnapshot}),
    provenance:row.open_provenance};
   const classification=row.latest_provenance.classification as
    'rangekeeper_paper_open_v1'|'rangekeeper_paper_mark_v1'|'rangekeeper_paper_recenter_v1',
    epoch=row.latest_provenance.epoch??0,
    candidate=row.latest_provenance.candidate??
     (row.latest_provenance.positionEpoch as Record<string,unknown>|undefined)?.candidate??
     openModel?.candidate;
   if(!Number.isInteger(epoch)||Number(epoch)<0||!candidate)
    throw new DeploymentConflict('rangekeeper_paper_epoch_mark_integrity');
   const candidateHash=typeof row.latest_provenance.candidateHash==='string'?
    row.latest_provenance.candidateHash:openModel?.candidateHash;
   if(typeof candidateHash!=='string'||! /^[0-9a-f]{64}$/.test(candidateHash))
    throw new DeploymentConflict('rangekeeper_paper_epoch_candidate_hash_invalid');
   const previousMark={id:row.latest_id,markHash:contentHash(latestBody),source:latestSource.data,
    epoch:Number(epoch),classification,candidate,candidateHash,inventory:row.latest_inventory,
    ...(row.latest_provenance.kernelSnapshot===undefined?{}:
     {kernelSnapshot:row.latest_provenance.kernelSnapshot}),provenance:row.latest_provenance};
   const config=row.config as Record<string,unknown>,{strategyId:_,strategyVersion:__,stateSchemaVersion:___,...parameters}=config;
   const draft={id:campaignId,revision:row.revision,allocation:allocationSchema.parse(row.allocation),
    profile:profile.data,profileHash:row.profile_hash,configHash:row.config_hash,
    strategyId:'rangekeeper_v1' as const,parameters};
   const adoptions=(await db.query<{source:Record<string,unknown>}>(`SELECT source FROM deployment_ledger
    WHERE campaign_id=$1 AND kind='attribution_boundary' AND
     entry_key LIKE 'rangekeeper_runtime_adoption:%' ORDER BY id`,[campaignId])).rows,
    runtimeAdoption=rangeKeeperRuntimeAdoptionProjection(adoptions),
    body={schemaVersion:1,kind:'rangekeeper_paper_epoch_snapshot_v1',draft,
     runtimeIdentity:current??runtime.data,runtimeAdoption,openMark,previousMark,
     currentEpoch:Number(epoch),pending:false};
   await db.query('COMMIT');return {...body,snapshotHash:contentHash(body)};
  }catch(error){await db.query('ROLLBACK');if(error instanceof DeploymentConflict)throw error;
   throw error;}finally{db.release();}
 }

 /** Append-only runtime lineage for an already-active RangeKeeper paper
  * campaign. It records a non-economic attribution boundary in the existing
  * ledger; historical models, marks and the immutable opening baseline stay
  * byte-for-byte intact. */
 async adoptRangeKeeperPaperRuntime(input:{campaignId:string;actor:string;
  fromRuntimeIdentity:unknown;toRuntimeIdentity:unknown;expectedLatestMark:{id:string;markHash:string;
   source:{block:string;hash:string;timestamp:number}};releaseProof:unknown;compatibilityProof:unknown;
  verifyPinnedRelease:(identity:ReturnType<typeof sealedRuntimeIdentitySchema.parse>,proof:unknown)=>Promise<void>;
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}){
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(input.actor))throw new DeploymentConflict('invalid_actor');
  const from=sealedRuntimeIdentitySchema.safeParse(input.fromRuntimeIdentity),to=sealedRuntimeIdentitySchema.safeParse(
   input.toRuntimeIdentity),current=loadRuntimeIdentity();
  if(!from.success||!to.success)
   throw new DeploymentConflict('rangekeeper_runtime_adoption_identity_invalid');
  if(from.data.configHash!==to.data.configHash||from.data.nodeVersion!==to.data.nodeVersion)
   throw new DeploymentConflict('rangekeeper_runtime_adoption_changes_config_or_node');
  const compatibility=z.object({schemaVersion:z.literal(1),kind:z.literal('rangekeeper_paper_runtime_compatibility_v1'),
   fromBuildId:z.string().regex(/^[a-f0-9]{64}$/),toBuildId:z.string().regex(/^[a-f0-9]{64}$/),
   strategyId:z.literal('rangekeeper_v1'),configHash:z.string().regex(/^[a-f0-9]{64}$/),
   profileHash:z.string().regex(/^[a-f0-9]{64}$/),latestMarkHash:z.string().regex(/^[a-f0-9]{64}$/),
   openModelHash:z.string().regex(/^[a-f0-9]{64}$/),historicalKernelBuildId:z.string().regex(/^[a-f0-9]{64}$/),
   validatorVersion:z.string().min(1)}).strict().safeParse(input.compatibilityProof);
  if(!compatibility.success||compatibility.data.fromBuildId!==from.data.buildId||
   compatibility.data.toBuildId!==to.data.buildId||
   compatibility.data.latestMarkHash!==input.expectedLatestMark.markHash)
   throw new DeploymentConflict('rangekeeper_runtime_adoption_compatibility_invalid');
  try{await input.verifyPinnedRelease(from.data,input.releaseProof);}
  catch{throw new DeploymentConflict('rangekeeper_runtime_adoption_predecessor_release_unverified');}
  return this.transaction(async db=>{
   const row=(await db.query<{mode:string;lifecycle:string;revision:number;chain_id:number;
    runtime_identity:unknown;profile:unknown;profile_hash:string;config:unknown;config_hash:string;
    strategy_id:string;strategy_version:string;state_schema_version:number}>(`
    SELECT c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,c.runtime_identity,
     p.profile,p.profile_hash,r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    WHERE c.id=$1 FOR UPDATE OF c`,[input.campaignId])).rows[0];
   if(!row||row.mode!=='paper'||!['active','paused'].includes(row.lifecycle)||
    row.strategy_id!=='rangekeeper_v1'||row.strategy_version!=='1.0.0'||row.state_schema_version!==1||
    contentHash(row.config)!==row.config_hash||row.config_hash!==compatibility.data.configHash||
    row.profile_hash!==compatibility.data.profileHash||!row.profile||contentHash(row.profile)!==row.profile_hash)
    throw new DeploymentConflict('rangekeeper_runtime_adoption_campaign_mismatch');
   const openingRow=(await db.query<{provenance:Record<string,unknown>;preview_model:Record<string,unknown>|null}>(`
    SELECT m.provenance,v.proposal->'rangekeeperPaperOpenModel' AS preview_model
    FROM deployment_marks m LEFT JOIN deployment_previews v ON v.id::text=m.provenance->>'previewId'
     AND v.campaign_id=m.campaign_id WHERE m.campaign_id=$1 AND
    m.provenance->>'classification'='rangekeeper_paper_open_v1' ORDER BY m.id LIMIT 1 FOR SHARE OF m`,
    [input.campaignId])).rows[0],opening=openingRow?.provenance;
   const openingModel=((opening?.confirmedOpen as Record<string,unknown>|undefined)?.model ??
    opening?.model??openingRow?.preview_model) as Record<string,unknown>|undefined;
   const openingModelHash=typeof opening?.modelHash==='string'?opening.modelHash:
    openingModel?contentHash(openingModel):null;
   const openingKernelBuild=typeof openingModel?.kernelBuildId==='string'?openingModel.kernelBuildId:
    typeof opening?.kernelBuildId==='string'?opening.kernelBuildId:null;
   if(!opening||!openingModelHash||!openingKernelBuild||
    compatibility.data.openModelHash!==openingModelHash||
    compatibility.data.historicalKernelBuildId!==openingKernelBuild)
    throw new DeploymentConflict('rangekeeper_runtime_adoption_opening_model_mismatch');
   const body={schemaVersion:1,kind:'rangekeeper_paper_runtime_adoption_v1',campaignId:input.campaignId,
    revision:row.revision,fromRuntimeIdentity:from.data,toRuntimeIdentity:to.data,
    fromIdentityHash:contentHash(from.data),toIdentityHash:contentHash(to.data),
    configHash:row.config_hash,profileHash:row.profile_hash,
    latestMark:input.expectedLatestMark,releaseProof:input.releaseProof,compatibilityProof:compatibility.data};
   const adoptionHash=contentHash(body),entryKey=`rangekeeper_runtime_adoption:${adoptionHash}`;
   const existing=(await db.query<{source:Record<string,unknown>}>(`SELECT source FROM deployment_ledger
    WHERE campaign_id=$1 AND entry_key=$2`,[input.campaignId,entryKey])).rows[0];
   if(existing){const stored={...existing.source},storedHash=stored.adoptionHash;
    delete stored.adoptionHash;delete stored.actor;
    if(storedHash!==adoptionHash||contentHash(stored)!==adoptionHash)
     throw new DeploymentConflict('rangekeeper_runtime_adoption_replay_integrity');
    return {adoptionHash,replayed:true};}
   if(!current||contentHash(to.data)!==contentHash(current))
    throw new DeploymentConflict('rangekeeper_runtime_adoption_identity_invalid');
   const effective=await campaignEffectiveRuntimeIdentity(db,input.campaignId,row.runtime_identity);
   if(!effective||contentHash(effective)!==contentHash(from.data))
    throw new DeploymentConflict('rangekeeper_runtime_adoption_predecessor_mismatch');
   const pending=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_operations
    WHERE campaign_id=$1 AND status IN ('queued','preflighting','executing','confirming',
     'reconciling','blocked')) AS found`,[input.campaignId])).rows[0]?.found;
   if(pending)throw new DeploymentConflict('rangekeeper_runtime_adoption_operation_pending');
   const latest=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
    inventory:unknown;economics:unknown;provenance:Record<string,unknown>}>(`
    SELECT m.id::text,revision,source_block::text,source_hash,inventory,economics,provenance
    FROM deployment_marks m WHERE m.campaign_id=$1 ORDER BY m.id DESC LIMIT 1 FOR UPDATE`,[input.campaignId])).rows[0];
   const latestSource=paperFeeMarkSourceSchema.safeParse(latest?.provenance.source),
    latestHash=latest?contentHash({revision:latest.revision,source_block:latest.source_block,
     source_hash:latest.source_hash,inventory:latest.inventory,economics:latest.economics,
     provenance:latest.provenance}):null;
   if(!latest||!latestSource.success||latest.id!==input.expectedLatestMark.id||
    latestHash!==input.expectedLatestMark.markHash||latestHash!==compatibility.data.latestMarkHash||
    contentHash(latestSource.data)!==contentHash(input.expectedLatestMark.source)||
    latest.revision!==row.revision)
    throw new DeploymentConflict('rangekeeper_runtime_adoption_latest_mark_changed');
   const source:PaperCanonicalAnchor={block:latestSource.data.block,hash:latestSource.data.hash,
    timestamp:latestSource.data.timestamp};
   try{await input.verifyAnchors(row.chain_id,[source]);}
   catch(error){if(error instanceof AssertionError)
    throw new DeploymentConflict('rangekeeper_runtime_adoption_source_not_canonical');throw error;}
   if(contentHash(latestSource.data)!==contentHash(input.expectedLatestMark.source))
    throw new DeploymentConflict('rangekeeper_runtime_adoption_latest_mark_changed');
   await db.query(`INSERT INTO deployment_ledger
    (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
    VALUES($1,NULL,$2,'attribution_boundary',NULL,NULL,NULL,$3)`,
    [input.campaignId,entryKey,JSON.stringify({...body,adoptionHash,actor:input.actor})]);
   return {adoptionHash,replayed:false};
  });
 }

 /** Appends one source-pinned RangeKeeper paper mark and its kernel snapshot.
  * This persists hypothetical state only; it cannot create an operation or
  * make an action available. The open model remains the source of position and
  * idle balances so a restarted worker cannot substitute inventory. */
 async recordRangeKeeperPaperMark(input:{campaignId:string;source:PaperCanonicalAnchor;
  frame?:PaperOpenFrame;decision?:{action:string;reason:string};
  kernelSnapshot:unknown;verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}){
  return this.transaction(async db=>{
   await this.assertPaperPreparationMutationAllowed(db,input.campaignId);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`deployment-rangekeeper-paper-mark:${input.campaignId}`]);
   const row=(await db.query<{mode:string;lifecycle:string;revision:number;chain_id:number;runtime_identity:unknown;
    allocation:unknown;profile:unknown;strategy_id:string;strategy_version:string;state_schema_version:number;
    config:unknown;config_hash:string;profile_hash:string;open_id:string;open_source_block:string|null;
    open_source_hash:string|null;open_provenance:Record<string,unknown>;
    open_model:unknown;preview_open_model:unknown;open_inventory:unknown;
    confirmation_envelope_hash:string|null;confirmation_envelope:unknown;
    latest_id:string|null;latest_revision:number|null;latest_source_block:string|null;latest_source_hash:string|null;
    latest_inventory:unknown;latest_economics:unknown;latest_provenance:Record<string,unknown>|null;
    open_revision:number;open_economics:unknown;pending:boolean}>(`
    SELECT c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,c.runtime_identity,c.allocation,p.profile,
     r.strategy_id,r.strategy_version,r.state_schema_version,r.config,r.config_hash,p.profile_hash,
     o.id::text AS open_id,o.source_block::text AS open_source_block,o.source_hash AS open_source_hash,
     o.provenance AS open_provenance,o.revision AS open_revision,o.economics AS open_economics,
     COALESCE(o.provenance->'confirmedOpen'->'model',v.proposal->'rangekeeperPaperOpenModel') AS open_model,
     v.proposal->'rangekeeperPaperOpenModel' AS preview_open_model,o.inventory AS open_inventory,
     proof.envelope_hash AS confirmation_envelope_hash,proof.envelope AS confirmation_envelope,
     latest.id::text AS latest_id,latest.revision AS latest_revision,
     latest.source_block::text AS latest_source_block,
     latest.source_hash AS latest_source_hash,latest.inventory AS latest_inventory,
     latest.economics AS latest_economics,
     latest.provenance AS latest_provenance,
     EXISTS(SELECT 1 FROM deployment_operations op WHERE op.campaign_id=c.id AND op.status IN
      ('queued','preflighting','executing','confirming','reconciling','blocked')) AS pending
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN LATERAL (SELECT m.id,m.revision,m.source_block,m.source_hash,m.inventory,m.economics,m.provenance FROM deployment_marks m
     WHERE m.campaign_id=c.id AND m.provenance->>'classification'='rangekeeper_paper_open_v1'
     ORDER BY m.id LIMIT 1) o ON true
    JOIN deployment_previews v ON v.id::text=o.provenance->>'previewId' AND v.campaign_id=c.id
    LEFT JOIN deployment_rangekeeper_paper_confirmations proof
     ON proof.campaign_id=c.id AND proof.revision=c.current_revision
    LEFT JOIN LATERAL (SELECT m.id,m.revision,m.source_block,m.source_hash,m.inventory,m.economics,m.provenance FROM deployment_marks m
     WHERE m.campaign_id=c.id ORDER BY m.id DESC LIMIT 1) latest ON true
    WHERE c.id=$1 FOR UPDATE OF c`,[input.campaignId])).rows[0];
   if(!row||row.mode!=='paper'||!['active','paused'].includes(row.lifecycle)||row.pending||
    row.strategy_id!=='rangekeeper_v1'||row.strategy_version!=='1.0.0'||row.state_schema_version!==1||
    !row.config||typeof row.config!=='object'||Array.isArray(row.config)||contentHash(row.config)!==row.config_hash||
    (row.config as Record<string,unknown>).strategyId!=='rangekeeper_v1'||
    (row.config as Record<string,unknown>).strategyVersion!=='1.0.0'||
    (row.config as Record<string,unknown>).stateSchemaVersion!==1||row.open_source_block===null||
    row.open_source_hash===null)
    throw new DeploymentConflict('rangekeeper_paper_mark_campaign_unavailable');
   const runtime=sealedRuntimeIdentitySchema.safeParse(row.runtime_identity),currentRuntime=loadRuntimeIdentity();
   if(!runtime.success||!currentRuntime||
    !await campaignRuntimeMatches(db,input.campaignId,runtime.data,currentRuntime))
    throw new DeploymentConflict('rangekeeper_paper_maintenance_runtime_mismatch');
   let confirmedAnchors:PaperCanonicalAnchor[]=[];
   if(Object.hasOwn(row.open_provenance,'confirmedOpen')){
    try{
     const envelope=validateRangeKeeperPaperConfirmationEnvelope(row.confirmation_envelope,
      {campaignId:input.campaignId,revision:row.revision});
     if(envelope.envelopeHash!==row.confirmation_envelope_hash)
      throw new Error('confirmed_open_envelope_hash');
     confirmedAnchors=[envelope.firstObservation.source,envelope.confirmationObservation.source];
     const confirmed=validateRangeKeeperPaperConfirmedOpenRecord(row.open_provenance.confirmedOpen,{
      campaignId:input.campaignId,revision:row.revision,
      previewId:String(row.open_provenance.previewId),operationId:String(row.open_provenance.operationId),
      firstModel:row.preview_open_model,confirmationEnvelopeHash:envelope.envelopeHash,
      confirmationEnvelope:envelope});
     if(confirmed.modelHash!==row.open_provenance.modelHash||
      confirmed.model.candidateHash!==row.open_provenance.candidateHash||
      contentHash(confirmed.model.source)!==contentHash(row.open_provenance.source))
      throw new Error('confirmed_open_provenance_identity');
     const inventory=buildRangeKeeperPaperConfirmedOpenInventory({model:confirmed.model,
      allocation:allocationSchema.parse(row.allocation),
      decimals0:marketProfileSchema.parse(row.profile).pool.decimals0,
      decimals1:marketProfileSchema.parse(row.profile).pool.decimals1});
     if(contentHash(inventory)!==contentHash(row.open_inventory))
      throw new Error('confirmed_open_inventory_identity');
    }catch{throw new DeploymentConflict('rangekeeper_paper_confirmed_open_integrity');}
   }
   const openSource=paperFeeMarkSourceSchema.safeParse(row.open_provenance.source),
    source=paperFeeMarkSourceSchema.safeParse(input.source);
   if(row.open_provenance.classification!=='rangekeeper_paper_open_v1'||
    row.open_provenance.modelHash===undefined||row.open_provenance.candidateHash===undefined||
    contentHash(row.open_model)!==row.open_provenance.modelHash||
    !openSource.success||!source.success||openSource.data.block!==row.open_source_block||
    openSource.data.hash.toLowerCase()!==row.open_source_hash.toLowerCase()||
    BigInt(source.data.block)<=BigInt(openSource.data.block))
    throw new DeploymentConflict('rangekeeper_paper_mark_open_identity_invalid');
   const frame=input.frame,profile=marketProfileSchema.parse(row.profile);
   const priorSource=paperFeeMarkSourceSchema.safeParse(
    row.latest_provenance?.source??row.open_provenance.source);
   if(!priorSource.success||!row.latest_id||!row.latest_inventory)
    throw new DeploymentConflict('rangekeeper_paper_mark_previous_invalid');
   const priorProvenance=row.latest_provenance??row.open_provenance,
    priorClass=String(priorProvenance.classification),priorEpoch=Number(priorProvenance.epoch??0),
    priorRevision=row.latest_revision??row.open_revision,
    priorEconomics=row.latest_id===row.open_id?row.open_economics:row.latest_economics,
    priorMarkHash=contentHash({revision:priorRevision,source_block:row.latest_source_block??row.open_source_block,
     source_hash:row.latest_source_hash??row.open_source_hash,inventory:row.latest_inventory,
     economics:priorEconomics,provenance:priorProvenance}),
    priorCandidate=priorProvenance.candidate??
     (priorProvenance.positionEpoch as Record<string,unknown>|undefined)?.candidate??
     (row.open_model as Record<string,unknown>).candidate,
    priorMark={id:row.latest_id,markHash:priorMarkHash,source:priorSource.data,epoch:priorEpoch,
     classification:priorClass as 'rangekeeper_paper_open_v1'|'rangekeeper_paper_mark_v1'|
      'rangekeeper_paper_recenter_v1',candidate:priorCandidate,
     candidateHash:String(priorProvenance.candidateHash??row.open_provenance.candidateHash),
     inventory:row.latest_inventory,kernelSnapshot:priorProvenance.kernelSnapshot,provenance:priorProvenance};
   if(!Number.isInteger(priorEpoch)||priorEpoch<0||!priorCandidate)
    throw new DeploymentConflict('rangekeeper_paper_mark_previous_invalid');
   let payload:{inventory:RangeKeeperPaperMarkPayload['inventory'];provenance:Record<string,unknown>};
   if(priorEpoch>0||priorClass==='rangekeeper_paper_recenter_v1'){
    if(!frame)throw new DeploymentConflict('rangekeeper_paper_mark_epoch_frame_required');
    try{payload=buildRangeKeeperPaperEpochObservationPayload({epoch:priorEpoch,
     source:source.data,previousMark:priorMark,frame:{source:source.data,
      sqrtPriceX96:frame.sqrtPriceX96,tick:frame.tick,poolLiquidity:frame.poolLiquidity},
     kernelSnapshot:input.kernelSnapshot});}
    catch{throw new DeploymentConflict('rangekeeper_paper_mark_epoch_replay_invalid');}
   }else{
    payload=buildRangeKeeperPaperMarkPayload({source:source.data,openSource:openSource.data,
     openModel:row.open_model,allocation:allocationSchema.parse(row.allocation),
     candidateHash:String(row.open_provenance.candidateHash),kernelSnapshot:input.kernelSnapshot});
   }
   if(frame&&(contentHash(frame.source)!==contentHash(source.data)||frame.sqrtPriceX96<=0n||
    !Number.isSafeInteger(frame.tick)||!frame.referenceProof||
    referenceProofHash(frame.referenceProof)!==frame.referenceProofHash))
    throw new DeploymentConflict('rangekeeper_paper_mark_frame_integrity');
   const principal=frame?principalAmounts({liquidity:BigInt(payload.inventory.position.liquidity),
    tickLower:payload.inventory.position.tickLower,tickUpper:payload.inventory.position.tickUpper,
    sqrtPriceX96:frame.sqrtPriceX96}):null;
   const markKernel=payload.provenance.kernelSnapshot as {released0?:unknown;released1?:unknown};
   if(principal&&(markKernel.released0!==String(principal.amount0)||
    markKernel.released1!==String(principal.amount1)))
    throw new DeploymentConflict('rangekeeper_paper_mark_principal_mismatch');
   const valued=frame?.referenceEligible&&frame.price0!==null&&frame.price1!==null&&
    frame.price0>0n&&frame.price1>0n;
   const principalOnlyValue=valued&&principal&&frame?
    String((principal.amount0+BigInt(payload.inventory.idle.token0))*frame.price0!/10n**BigInt(profile.pool.decimals0)+
     (principal.amount1+BigInt(payload.inventory.idle.token1))*frame.price1!/10n**BigInt(profile.pool.decimals1)):null;
   const valuation=frame?{poolState:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),
    poolLiquidity:String(frame.poolLiquidity)},reference:{price0:valued?String(frame.price0):null,
     price1:valued?String(frame.price1):null,nativePrice:frame.nativePrice===null?null:String(frame.nativePrice),
     proofHash:frame.referenceProofHash,proof:frame.referenceProof},referenceProofHash:frame.referenceProofHash,
    referenceUnavailable:frame.referenceReasons}:{};
   const decision=input.decision?z.object({action:z.enum(['wait','confirm','safety_exit']),
    reason:z.string().regex(/^[a-z0-9_]{1,100}$/)}).strict().parse(input.decision):null;
   if(decision?.action==='confirm'&&
    !(payload.provenance.kernelSnapshot as {state?:{confirmation?:unknown}}).state?.confirmation)
    throw new DeploymentConflict('rangekeeper_paper_mark_confirmation_decision_unbound');
   const existing=(await db.query<{id:string;inventory:unknown;economics:unknown;provenance:Record<string,unknown>}>(`
    SELECT id::text,inventory,economics,provenance FROM deployment_marks
    WHERE campaign_id=$1 AND source_block=$2::numeric AND lower(source_hash)=lower($3)
    LIMIT 2`,[input.campaignId,source.data.block,source.data.hash])).rows;
   if(existing.length){
    if(existing.length!==1||!row.latest_id||existing[0]!.id!==row.latest_id)
     throw new DeploymentConflict('rangekeeper_paper_mark_source_conflict');
    if(contentHash(existing[0]!.inventory)!==contentHash(payload.inventory)||
     existing[0]!.provenance.classification!==payload.provenance.classification||
     contentHash(existing[0]!.provenance.source)!==contentHash(payload.provenance.source)||
     existing[0]!.provenance.candidateHash!==payload.provenance.candidateHash||
     (frame&&contentHash(existing[0]!.provenance.poolState)!==contentHash(valuation.poolState))||
     (frame&&contentHash(existing[0]!.provenance.reference)!==contentHash(valuation.reference))||
     (frame&&contentHash(existing[0]!.economics)!==contentHash({principalOnlyValue}))||
     (decision&&contentHash(existing[0]!.provenance.managementDecision)!==contentHash(decision))||
     contentHash(existing[0]!.provenance.kernelSnapshot)!==contentHash(payload.provenance.kernelSnapshot))
     throw new DeploymentConflict('rangekeeper_paper_mark_replay_conflict');
    try{await input.verifyAnchors(row.chain_id,[...confirmedAnchors,openSource.data,source.data]
     .filter((anchor,index,array)=>array.findIndex(other=>other.block===anchor.block)===index));}
    catch(error){if(error instanceof AssertionError)
      throw new DeploymentConflict('rangekeeper_paper_mark_source_not_canonical');throw error;}
    return {markId:existing[0]!.id,replayed:true,actionAvailable:false as const};
   }
   if(row.latest_id){
    if(row.latest_source_block===null||row.latest_source_hash===null||!row.latest_provenance)
     throw new DeploymentConflict('rangekeeper_paper_mark_previous_invalid');
    const previousSource=paperFeeMarkSourceSchema.safeParse(row.latest_provenance.source);
    if(!previousSource.success||previousSource.data.block!==row.latest_source_block||
     previousSource.data.hash.toLowerCase()!==row.latest_source_hash.toLowerCase()||
     BigInt(source.data.block)<=BigInt(row.latest_source_block)||
     source.data.timestamp<previousSource.data.timestamp)
     throw new DeploymentConflict('rangekeeper_paper_mark_source_order_invalid');
    if(row.latest_id!==row.open_id){
     if(row.latest_provenance.classification==='rangekeeper_paper_recenter_v1'){
      const previewId=String(row.latest_provenance.previewId),savedPreview=(await db.query<{
       proposal:Record<string,unknown>}>(`SELECT proposal FROM deployment_previews
       WHERE id=$1 AND campaign_id=$2`,[previewId,input.campaignId])).rows[0],
       savedBooking=validateRangeKeeperPaperRecenterBooking(
        savedPreview?.proposal.rangekeeperPaperRecenterModel),
       parent=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
        inventory:unknown;economics:unknown;provenance:Record<string,unknown>}>(`
        SELECT id::text,revision,source_block::text,source_hash,inventory,economics,provenance
        FROM deployment_marks WHERE campaign_id=$1 AND id=$2`,
        [input.campaignId,savedBooking.priorMark.id])).rows[0];
      const parentSource=paperFeeMarkSourceSchema.safeParse(parent?.provenance.source),
       parentHash=parent?contentHash({revision:parent.revision,source_block:parent.source_block,
        source_hash:parent.source_hash,inventory:parent.inventory,economics:parent.economics,
        provenance:parent.provenance}):null,
       parentCandidate=parent?.provenance.candidate??
        (row.open_model as Record<string,unknown>).candidate,
       parentEpoch=Number(parent?.provenance.epoch??0),
       parentClass=parent?.provenance.classification as
        'rangekeeper_paper_open_v1'|'rangekeeper_paper_mark_v1'|'rangekeeper_paper_recenter_v1'|undefined;
      if(!parent||!parentSource.success||!parentCandidate||!parentClass||
       parentHash!==savedBooking.priorMark.markHash||parent.id!==savedBooking.priorMark.id||
       parent.source_block!==savedBooking.priorMark.source.block||
       parent.source_hash?.toLowerCase()!==savedBooking.priorMark.source.hash.toLowerCase()||
       row.latest_provenance.modelHash!==savedBooking.modelHash||row.latest_provenance.epoch!==savedBooking.epoch||
       row.latest_provenance.operationId===undefined||row.latest_provenance.previewId!==previewId)
       throw new DeploymentConflict('rangekeeper_paper_mark_previous_identity_invalid');
      const priorMark={id:parent.id,markHash:parentHash,source:parentSource.data,epoch:parentEpoch,
       classification:parentClass,candidate:parentCandidate,
       candidateHash:String(parent.provenance.candidateHash??row.open_provenance.candidateHash),
       inventory:parent.inventory,kernelSnapshot:parent.provenance.kernelSnapshot,
       provenance:parent.provenance};
      let replay;
      try{replay=buildRangeKeeperPaperRecenterBooking({draft:{id:input.campaignId,revision:row.revision,
       configHash:row.config_hash,profileHash:row.profile_hash,profile:{pool:{
        decimals0:profile.pool.decimals0,decimals1:profile.pool.decimals1}}},previousMark:priorMark,
       booking:savedBooking,frame:{source:savedBooking.source,
        sqrtPriceX96:BigInt(savedBooking.poolState.sqrtPriceX96)}});}
      catch{throw new DeploymentConflict('rangekeeper_paper_mark_previous_kernel_invalid');}
      const {operationId:_operationId,previewId:_previewId,actionAvailable:_action,
       ...storedBooking}=row.latest_provenance;
      if(contentHash(replay.inventory)!==contentHash(row.latest_inventory)||
       contentHash(replay.provenance)!==contentHash(storedBooking))
       throw new DeploymentConflict('rangekeeper_paper_mark_previous_inventory_invalid');
     }else if(priorEpoch>0){
      // An observation after a recenter must be replayed from the mark that
      // immediately preceded it. Replaying against the opening allocation
      // would silently restore the retired range and balances.
      const parent=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
       inventory:unknown;economics:unknown;provenance:Record<string,unknown>}>(`
       SELECT m.id::text,revision,source_block::text,source_hash,inventory,economics,provenance
       FROM deployment_marks m WHERE m.campaign_id=$1 AND m.id<$2::bigint ORDER BY m.id DESC LIMIT 1`,
       [input.campaignId,row.latest_id])).rows[0],
       poolState=row.latest_provenance.poolState as {tick?:unknown;sqrtPriceX96?:unknown;
        poolLiquidity?:unknown}|undefined,
       parentSource=paperFeeMarkSourceSchema.safeParse(parent?.provenance.source),
       parentHash=parent?contentHash({revision:parent.revision,source_block:parent.source_block,
        source_hash:parent.source_hash,inventory:parent.inventory,economics:parent.economics,
        provenance:parent.provenance}):null,
       lineage=row.latest_provenance.positionEpoch as Record<string,unknown>|undefined,
       parentCandidate=parent?.provenance.candidate??lineage?.candidate??
        (row.open_model as Record<string,unknown>).candidate,
       parentEpoch=Number(parent?.provenance.epoch??0),
       parentClass=parent?.provenance.classification as
        'rangekeeper_paper_open_v1'|'rangekeeper_paper_mark_v1'|'rangekeeper_paper_recenter_v1'|undefined;
      if(row.latest_provenance.classification!=='rangekeeper_paper_mark_v1'||!poolState||
       typeof poolState.sqrtPriceX96!=='string'||typeof poolState.tick!=='number'||
       typeof poolState.poolLiquidity!=='string'||!parent||!parentHash||!parentSource.success||!parentCandidate||
       !parentClass)
       throw new DeploymentConflict('rangekeeper_paper_mark_previous_identity_invalid');
      const previousMark={id:parent.id,markHash:parentHash,source:parentSource.data,epoch:parentEpoch,
       classification:parentClass,candidate:parentCandidate,
       candidateHash:String(parent.provenance.candidateHash??lineage?.candidateHash??row.open_provenance.candidateHash),
       inventory:parent.inventory,kernelSnapshot:parent.provenance.kernelSnapshot,
       provenance:parent.provenance};
      let replay;
      try{replay=buildRangeKeeperPaperEpochObservationPayload({epoch:priorEpoch,
       source:previousSource.data,previousMark,frame:{source:previousSource.data,
        sqrtPriceX96:BigInt(poolState.sqrtPriceX96),tick:poolState.tick,
        poolLiquidity:BigInt(poolState.poolLiquidity)},kernelSnapshot:row.latest_provenance.kernelSnapshot});}
      catch{throw new DeploymentConflict('rangekeeper_paper_mark_previous_kernel_invalid');}
      const stored=row.latest_provenance;
      if(contentHash(replay.inventory)!==contentHash(row.latest_inventory)||
       contentHash(replay.provenance.source)!==contentHash(stored.source)||
       replay.provenance.epoch!==stored.epoch||replay.provenance.candidateHash!==stored.candidateHash||
       replay.provenance.candidateReferenceProofHash!==stored.candidateReferenceProofHash||
       contentHash(replay.provenance.positionEpoch)!==contentHash(stored.positionEpoch)||
       contentHash(replay.provenance.kernelSnapshot)!==contentHash(stored.kernelSnapshot))
       throw new DeploymentConflict('rangekeeper_paper_mark_previous_inventory_invalid');
     }else{
      if(row.latest_provenance.classification!=='rangekeeper_paper_mark_v1'||
       row.latest_provenance.candidateHash!==row.open_provenance.candidateHash||
       row.latest_provenance.kernelSnapshot===undefined)
       throw new DeploymentConflict('rangekeeper_paper_mark_previous_identity_invalid');
      if(row.latest_provenance.initialModeledOpenCost===undefined){
       try{validateLegacyRangeKeeperInitialObservation({provenance:row.latest_provenance,
        inventory:row.latest_inventory,openModel:row.open_model as Record<string,unknown>,
        allocation:allocationSchema.parse(row.allocation),source:previousSource.data});}
       catch{throw new DeploymentConflict('rangekeeper_paper_mark_previous_kernel_invalid');}
       if(contentHash(rangeKeeperPositionIdleProjection(row.latest_inventory))!==
        contentHash(rangeKeeperPositionIdleProjection(row.open_inventory)))
        throw new DeploymentConflict('rangekeeper_paper_mark_previous_inventory_invalid');
      }else{
       let priorPayload;
       try{priorPayload=buildRangeKeeperPaperMarkPayload({source:previousSource.data,
        openSource:openSource.data,openModel:row.open_model,allocation:allocationSchema.parse(row.allocation),
        candidateHash:String(row.open_provenance.candidateHash),
        kernelSnapshot:row.latest_provenance.kernelSnapshot});}
       catch{throw new DeploymentConflict('rangekeeper_paper_mark_previous_kernel_invalid');}
       if(contentHash(priorPayload.inventory)!==contentHash(row.latest_inventory))
        throw new DeploymentConflict('rangekeeper_paper_mark_previous_inventory_invalid');
      }
     }
    }else if(row.latest_provenance.classification!=='rangekeeper_paper_open_v1')
     throw new DeploymentConflict('rangekeeper_paper_mark_previous_identity_invalid');
    const anchors=[...confirmedAnchors,openSource.data,previousSource.data,source.data].filter((anchor,index,array)=>
     array.findIndex(other=>other.block===anchor.block)===index);
    try{await input.verifyAnchors(row.chain_id,anchors);}
    catch(error){if(error instanceof AssertionError)
      throw new DeploymentConflict('rangekeeper_paper_mark_source_not_canonical');throw error;}
   }else{
    try{await input.verifyAnchors(row.chain_id,[...confirmedAnchors,openSource.data,source.data]
     .filter((anchor,index,array)=>array.findIndex(other=>other.block===anchor.block)===index));}
    catch(error){if(error instanceof AssertionError)
      throw new DeploymentConflict('rangekeeper_paper_mark_source_not_canonical');throw error;}
   }
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,$7,'{}'::uuid[],$6) RETURNING id::text`,
    [input.campaignId,row.revision,source.data.block,source.data.hash,JSON.stringify(payload.inventory),
     JSON.stringify({...payload.provenance,...valuation,managementDecision:decision,
      openMarkId:row.open_id,paidCostsAvailable:false,
      actionAvailable:false,unavailable:['fees','paid_costs','net_economics','final_custody']}),
     frame?JSON.stringify({principalOnlyValue}):null])).rows[0]!;
   return {markId:mark.id,replayed:false,actionAvailable:false as const};
  });
 }

 /** Read-only, repeatable snapshot for the RangeKeeper terminal-preview loader.
  * The mark/provenance classes below are the persisted lifecycle contract; no
  * request field can supply campaign state, candidate, inventory or kernel. */
 async rangeKeeperPaperExitContextSnapshot(campaignId:string,
  claimedOperationId?:string):Promise<unknown>{
  const db=await this.readPool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const row=(await db.query<{campaign_id:string;mode:string;lifecycle:string;current_revision:number;
    chain_id:number;allocation:unknown;runtime_identity:unknown;retired_at:Date|null;profile:unknown;profile_evidence:unknown;
    profile_hash:string;profile_indexed:boolean;config:unknown;config_hash:string;strategy_id:string;
    strategy_version:string;state_schema_version:number;open_mark_id:string;open_source_block:string|null;
    open_source_hash:string|null;open_provenance:Record<string,unknown>;open_proposal:Record<string,unknown>;
    confirmation_envelope_hash:string|null;
    confirmation_envelope:unknown;open_inventory:unknown;open_revision:number;open_economics:unknown;
    open_request:Record<string,unknown>;open_evidence:Record<string,unknown>;open_digest:string;
    open_expected_revision:number;open_expires_at:Date;previous_mark_id:string;previous_mark_revision:number;
    previous_mark_economics:unknown;previous_source_block:string|null;
    previous_source_hash:string|null;previous_inventory:Record<string,unknown>;
    previous_provenance:Record<string,unknown>;pending_operation_id:string|null}>(`
    SELECT c.id AS campaign_id,c.mode,c.lifecycle,c.current_revision,c.chain_id,c.allocation,c.runtime_identity,
     p.retired_at,p.profile,p.evidence AS profile_evidence,p.profile_hash,
     COALESCE(i.enabled AND i.target_set_hash=(p.evidence->>'indexerTargetSetHash')
      AND lower(i.rwa_address)=lower(CASE WHEN p.quote_token=0 THEN p.token1_address ELSE p.token0_address END),false)
      AS profile_indexed,
     r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version,
     confirmation.envelope_hash AS confirmation_envelope_hash,
     confirmation.envelope AS confirmation_envelope,
     o.id::text AS open_mark_id,o.revision AS open_revision,o.economics AS open_economics,
     o.source_block::text AS open_source_block,o.source_hash AS open_source_hash,
     o.inventory AS open_inventory,
     o.provenance AS open_provenance,v.proposal AS open_proposal,v.request AS open_request,
     v.evidence AS open_evidence,v.content_digest AS open_digest,v.expected_revision AS open_expected_revision,
     v.expires_at AS open_expires_at,m.id::text AS previous_mark_id,
     m.revision AS previous_mark_revision,m.economics AS previous_mark_economics,
     m.source_block::text AS previous_source_block,m.source_hash AS previous_source_hash,
     m.inventory AS previous_inventory,m.provenance AS previous_provenance,pending.id AS pending_operation_id
    FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    LEFT JOIN deployment_rangekeeper_paper_confirmations confirmation
     ON confirmation.campaign_id=c.id AND confirmation.revision=c.current_revision
    LEFT JOIN indexer_pools i ON i.stream_key=p.evidence->>'streamKey'
     AND lower(i.pool_address)=lower(p.pool_address) AND i.chain_id=p.chain_id AND i.fee=p.fee
    JOIN LATERAL (SELECT mark.id,mark.revision,mark.source_block,mark.source_hash,mark.inventory,mark.economics,mark.provenance
     FROM deployment_marks mark WHERE mark.campaign_id=c.id AND
      mark.provenance->>'classification'='rangekeeper_paper_open_v1'
     ORDER BY mark.id LIMIT 1) o ON true
    JOIN deployment_previews v ON v.id::text=o.provenance->>'previewId' AND v.campaign_id=c.id
    JOIN LATERAL (SELECT mark.id,mark.revision,mark.source_block,mark.source_hash,
      mark.inventory,mark.economics,mark.provenance FROM deployment_marks mark
     WHERE mark.campaign_id=c.id AND mark.id>o.id ORDER BY mark.id DESC LIMIT 1) m ON true
    LEFT JOIN LATERAL (SELECT op.id::text FROM deployment_operations op
     WHERE op.campaign_id=c.id AND ($2::uuid IS NULL OR op.id<>$2::uuid) AND op.status IN
      ('queued','preflighting','executing','confirming','reconciling','blocked')
     ORDER BY op.created_at,op.id LIMIT 1) pending ON true
    WHERE c.id=$1 AND c.mode='paper' AND c.lifecycle IN ('active','paused','closing')`,
    [campaignId,claimedOperationId??null])).rows[0];
   if(!row||row.pending_operation_id!==null||row.retired_at!==null||!row.profile_indexed||
    row.strategy_id!=='rangekeeper_v1'||row.strategy_version!=='1.0.0'||row.state_schema_version!==1||
    row.open_expected_revision!==row.current_revision||row.open_source_block===null||row.open_source_hash===null||
    row.previous_source_block===null||row.previous_source_hash===null)
    throw new DeploymentConflict('rangekeeper_paper_exit_context_unavailable');
   const currentRuntime=loadRuntimeIdentity(),effectiveRuntime=
    await campaignEffectiveRuntimeIdentity(db,campaignId,row.runtime_identity);
   if(!currentRuntime||!effectiveRuntime||contentHash(effectiveRuntime)!==contentHash(currentRuntime))
    throw new DeploymentConflict('rangekeeper_paper_exit_context_runtime_mismatch');
   const profile=marketProfileSchema.safeParse(row.profile),
    profileEvidence=marketProfileEvidenceSchema.safeParse(row.profile_evidence);
   if(!profile.success||!profileEvidence.success||profile.data.pool.chainId!==row.chain_id||
    contentHash(profile.data)!==row.profile_hash||
    referenceProofHash(profileEvidence.data.referenceProof)!==profileEvidence.data.references.proofHash||
    contentHash(row.config)!==row.config_hash||!row.config||typeof row.config!=='object'||Array.isArray(row.config))
    throw new DeploymentConflict('rangekeeper_paper_exit_context_integrity');
   for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
    if(profile.data.pool[key].toLowerCase()!==profileEvidence.data.contractHashes[key].toLowerCase())
     throw new DeploymentConflict('rangekeeper_paper_exit_context_integrity');
   const config=row.config as Record<string,unknown>;
   if(config.strategyId!==row.strategy_id||config.strategyVersion!==row.strategy_version||
    config.stateSchemaVersion!==row.state_schema_version)
    throw new DeploymentConflict('rangekeeper_paper_exit_context_integrity');
   const {strategyId:_strategyId,strategyVersion:_strategyVersion,
    stateSchemaVersion:_stateSchemaVersion,...parameters}=config;
   parseStrategyParameters('rangekeeper_v1',parameters);
   const indexed=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
    WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=$3 AND fee=$4
     AND enabled=true AND target_set_hash=$5 AND lower(rwa_address)=lower($6)) AS found`,
    [profileEvidence.data.streamKey,profile.data.pool.pool,row.chain_id,profile.data.pool.fee,
     profileEvidence.data.indexerTargetSetHash,
     profile.data.pool.quoteToken===0?profile.data.pool.token1:profile.data.pool.token0])).rows[0]?.found;
   if(!indexed)throw new DeploymentConflict('rangekeeper_paper_exit_context_indexer_changed');
   if(row.open_provenance.previewId===undefined||row.open_provenance.modelHash===undefined||
    row.open_provenance.source===undefined||row.open_provenance.candidateHash===undefined||
    row.open_digest!==previewDigest({campaignId,expectedRevision:row.open_expected_revision,kind:'open',
     request:row.open_request,proposal:row.open_proposal,evidence:row.open_evidence,
     expiresAt:row.open_expires_at}))
    throw new DeploymentConflict('rangekeeper_paper_open_preview_integrity');
   const previewOpenModel=row.open_proposal.rangekeeperPaperOpenModel;
   let openModel=previewOpenModel;
   if(Object.hasOwn(row.open_provenance,'confirmedOpen')){
    try{
     const envelope=validateRangeKeeperPaperConfirmationEnvelope(row.confirmation_envelope,
      {campaignId,revision:row.current_revision});
     if(envelope.envelopeHash!==row.confirmation_envelope_hash)
      throw new Error('confirmed_open_envelope_hash');
     const confirmed=validateRangeKeeperPaperConfirmedOpenRecord(row.open_provenance.confirmedOpen,{
      campaignId,revision:row.current_revision,
      previewId:String(row.open_provenance.previewId),operationId:String(row.open_provenance.operationId),
      firstModel:previewOpenModel,confirmationEnvelopeHash:envelope.envelopeHash,
      confirmationEnvelope:envelope});
     if(confirmed.modelHash!==row.open_provenance.modelHash||
      confirmed.model.candidateHash!==row.open_provenance.candidateHash||
      contentHash(confirmed.model.source)!==contentHash(row.open_provenance.source))
      throw new Error('confirmed_open_provenance_identity');
     const profile=marketProfileSchema.parse(row.profile),inventory=buildRangeKeeperPaperConfirmedOpenInventory({
      model:confirmed.model,allocation:allocationSchema.parse(row.allocation),
      decimals0:profile.pool.decimals0,decimals1:profile.pool.decimals1});
     if(contentHash(inventory)!==contentHash(row.open_inventory))
      throw new Error('confirmed_open_inventory_identity');
     openModel=confirmed.model;
    }catch{throw new DeploymentConflict('rangekeeper_paper_confirmed_open_integrity');}
   }
   if(!openModel||typeof openModel!=='object'||Array.isArray(openModel)||
    contentHash(openModel)!==row.open_provenance.modelHash)
    throw new DeploymentConflict('rangekeeper_paper_open_model_integrity');
   const open= openModel as Record<string,unknown>,openSource=paperFeeMarkSourceSchema.safeParse(open.source),
    persistedOpenSource=paperFeeMarkSourceSchema.safeParse(row.open_provenance.source);
   if(!openSource.success||!persistedOpenSource.success||
    openSource.data.block!==row.open_source_block||openSource.data.hash.toLowerCase()!==row.open_source_hash.toLowerCase()||
    contentHash(openSource.data)!==contentHash(persistedOpenSource.data)||
    row.open_provenance.candidateHash!==open.candidateHash)
    throw new DeploymentConflict('rangekeeper_paper_open_source_integrity');
   const previousSource=paperFeeMarkSourceSchema.safeParse(row.previous_provenance.source),
    position=z.object({tickLower:z.number().int(),tickUpper:z.number().int(),
     liquidity:z.string().regex(/^[1-9][0-9]*$/)}).strict().safeParse(row.previous_inventory.position),
    idle=z.object({token0:z.string().regex(/^(0|[1-9][0-9]*)$/),
     token1:z.string().regex(/^(0|[1-9][0-9]*)$/)}).strict().safeParse(row.previous_inventory.idle),
    kernel=z.record(z.string(),z.unknown()).safeParse(row.previous_provenance.kernelSnapshot);
   const previousClass=row.previous_provenance.classification,
    previousEpoch=Number.isInteger(row.previous_provenance.epoch)?
     Number(row.previous_provenance.epoch):0,
    previousCandidate=(previousEpoch>0||previousClass==='rangekeeper_paper_recenter_v1')?
     row.previous_provenance.candidate:open.candidate,
    previousCandidateReferenceProofHash=typeof row.previous_provenance.candidateReferenceProofHash==='string'?
     row.previous_provenance.candidateReferenceProofHash:
     (open.reference as Record<string,unknown>|undefined)?.proofHash;
   if(!['rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1'].includes(String(previousClass))||
    !previousSource.success||!position.success||!idle.success||!kernel.success||
    previousSource.data.block!==row.previous_source_block||
    previousSource.data.hash.toLowerCase()!==row.previous_source_hash.toLowerCase()||
    !Number.isInteger(previousEpoch)||previousEpoch<0||
    (previousEpoch===0&&previousClass==='rangekeeper_paper_mark_v1'&&
     row.previous_provenance.candidateHash!==open.candidateHash)||
    (previousEpoch>0&&typeof row.previous_provenance.candidateHash!=='string')||
    (previousClass==='rangekeeper_paper_recenter_v1'&&
     (typeof row.previous_provenance.modelHash!=='string'||
      !/^[0-9a-f]{64}$/.test(row.previous_provenance.modelHash))))
    throw new DeploymentConflict('rangekeeper_paper_previous_mark_integrity');
   const draft={id:campaignId,revision:row.current_revision,
    allocation:allocationSchema.parse(row.allocation),profile:profile.data,profileHash:row.profile_hash,
    configHash:row.config_hash,strategyId:'rangekeeper_v1',parameters};
   const positionEpoch=(previousEpoch>0&&row.previous_provenance.positionEpoch&&
    typeof row.previous_provenance.positionEpoch==='object'?
     row.previous_provenance.positionEpoch as Record<string,unknown>:row.previous_provenance),
    openCandidate=open.candidate as {swap?:{priceAfter?:unknown}|null},
    openReference=open.reference as Record<string,unknown>,
    openPoolState=open.poolState as Record<string,unknown>,
    allocation=allocationSchema.parse(row.allocation),
    currentEpochSource=paperFeeMarkSourceSchema.parse(previousEpoch===0?open.source:
     positionEpoch.source??open.source),
    currentCandidate=previousEpoch===0?open.candidate:positionEpoch.candidate??previousCandidate,
    currentCandidateHash=previousEpoch===0?open.candidateHash:
     positionEpoch.candidateHash??row.previous_provenance.candidateHash,
    currentReferenceProofHash=previousEpoch===0?openReference.proofHash:
     positionEpoch.candidateReferenceProofHash??previousCandidateReferenceProofHash,
    currentKernel=positionEpoch.kernelSnapshot??kernel.data,
    mintSqrtPriceX96=previousEpoch===0?(openCandidate.swap?.priceAfter??openPoolState.sqrtPriceX96):
     positionEpoch.mintSqrtPriceX96??(openCandidate.swap?.priceAfter??openPoolState.sqrtPriceX96),
    fundingBeforeSwap=previousEpoch===0?{token0:allocation.token0Raw,token1:allocation.token1Raw}:
     positionEpoch.fundingBeforeSwap??{token0:allocation.token0Raw,token1:allocation.token1Raw},
    currentReferenceRaw=(previousEpoch===0?openReference:
     positionEpoch.reference??row.previous_provenance.reference??openReference) as
     Record<string,unknown>,
    currentReference={price0:String(currentReferenceRaw.price0),price1:String(currentReferenceRaw.price1),
     nativePrice:String(currentReferenceRaw.nativePrice),proofHash:String(currentReferenceRaw.proofHash),
     proof:currentReferenceRaw.proof as Record<string,unknown>},
    previousMarkHash=contentHash({revision:row.previous_mark_revision,
     source_block:row.previous_source_block,source_hash:row.previous_source_hash,
     inventory:row.previous_inventory,economics:row.previous_mark_economics,
     provenance:row.previous_provenance}),
    epochCreator=previousEpoch===0?{id:row.open_mark_id,markHash:contentHash({
     revision:row.open_revision,source_block:row.open_source_block,source_hash:row.open_source_hash,
     inventory:row.open_inventory,economics:row.open_economics,provenance:row.open_provenance})}:
     await (async()=>{const mark=(await db.query<{id:string;revision:number;source_block:string|null;
      source_hash:string|null;inventory:unknown;economics:unknown;provenance:Record<string,unknown>}>(`
      SELECT m.id::text,revision,source_block::text,source_hash,inventory,economics,provenance
      FROM deployment_marks m WHERE m.campaign_id=$1 AND
       provenance->>'classification'='rangekeeper_paper_recenter_v1' AND
       (provenance->>'epoch')::integer=$2 ORDER BY m.id DESC LIMIT 1`,[campaignId,previousEpoch])).rows[0];
      if(!mark)throw new DeploymentConflict('rangekeeper_paper_epoch_creator_unavailable');
      return {id:mark.id,markHash:contentHash({revision:mark.revision,source_block:mark.source_block,
       source_hash:mark.source_hash,inventory:mark.inventory,economics:mark.economics,
       provenance:mark.provenance})};})();
   const currentEpoch={epoch:previousEpoch,markId:epochCreator.id,markHash:epochCreator.markHash,
     source:currentEpochSource,candidate:currentCandidate,candidateHash:currentCandidateHash,
     candidateReferenceProofHash:currentReferenceProofHash,inventory:{position:position.data,idle:idle.data},
     kernelSnapshot:currentKernel,mintSqrtPriceX96,fundingBeforeSwap,reference:currentReference,
     allowancesCleared:previousEpoch===0?false:Boolean(positionEpoch.allowancesCleared??true)};
   const adoptionRows=await db.query<{source:Record<string,unknown>}>(`SELECT source FROM deployment_ledger
    WHERE campaign_id=$1 AND kind='attribution_boundary' AND
     entry_key LIKE 'rangekeeper_runtime_adoption:%' ORDER BY id`,[campaignId]),
    runtimeAdoption=rangeKeeperRuntimeAdoptionProjection(adoptionRows.rows);
   const body={schemaVersion:1,kind:'rangekeeper_paper_persisted_context_v1',campaignId,
    revision:row.current_revision,mode:'paper',lifecycle:row.lifecycle,pendingOperationId:null,
    runtimeIdentity:effectiveRuntime,runtimeAdoption,
    draft,openMark:{id:row.open_mark_id,classification:'rangekeeper_paper_open_v1',
     modelHash:row.open_provenance.modelHash,model:open},
    previousMark:{id:row.previous_mark_id,classification:previousClass,epoch:previousEpoch,
     source:previousSource.data,candidateHash:row.previous_provenance.candidateHash,
     candidate:previousCandidate,candidateReferenceProofHash:previousCandidateReferenceProofHash,
     position:position.data,idle:idle.data},currentEpoch,kernel:kernel.data};
   await db.query('COMMIT');
   return {...body,snapshotHash:contentHash(body)};
  }catch(error){
   await db.query('ROLLBACK');
   if(error instanceof DeploymentConflict||error instanceof z.ZodError)
    return {status:'unavailable',reason:error instanceof DeploymentConflict?error.code:
     'rangekeeper_paper_persisted_context_invalid',campaignId,actionAvailable:false};
   throw error;
  }finally{db.release();}
 }

 /** Replays the candidate through the trusted verifier while the campaign is
  * locked, then atomically appends its complete stage sequence. */
 async registerRangeKeeperPaperGasEvidence(input:{report:unknown;client:RobinhoodClient;
  replayPersistedContext:RangeKeeperPaperGasSourceReplayVerifier}){
  const now=Date.now(),report=verifyRangeKeeperPaperGasReport(input.report,now),
   profile=marketProfileSchema.safeParse(report.profile),runtime=loadRuntimeIdentity(),
   sampledAt=Date.parse(report.sampledAt),source=report.frame.source;
  if(!profile.success||!runtime||runtime.buildId!==report.buildId)
   throw new DeploymentConflict('rangekeeper_paper_gas_campaign_binding_invalid');
  if(now-sampledAt<0||now-sampledAt>86_400_000||sampledAt-source.timestamp*1000<0||
   sampledAt-source.timestamp*1000>180_000)
   throw new DeploymentConflict('rangekeeper_paper_gas_evidence_stale');
  if(profile.data.pool.chainId!==4663||profile.data.pool.pool.toLowerCase()!==report.scope.poolAddress.toLowerCase())
   throw new DeploymentConflict('rangekeeper_paper_gas_profile_mismatch');
  const path=report.pathVersion,sizeBand=report.sizeBand;
  return this.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`deployment-rangekeeper-paper-gas:${profile.data.pool.chainId}:${profile.data.pool.pool.toLowerCase()}:${path}:${sizeBand}`]);
   // Keep this campaign FOR SHARE lock through the nested snapshot and append.
   // Acceptances and every mark writer take FOR UPDATE OF c; claimNext only
   // moves operations within the pending statuses checked below.
   const campaign=(await db.query<{mode:string;lifecycle:string;current_revision:number;chain_id:number;
    allocation:unknown;runtime_identity:unknown;profile:unknown;profile_evidence:unknown;
    profile_hash:string;retired_at:Date|null;config:unknown;config_hash:string;strategy_id:string;
    strategy_version:string;state_schema_version:number}>(`
    SELECT c.mode,c.lifecycle,c.current_revision,c.chain_id,c.allocation,c.runtime_identity,
     p.profile,p.evidence AS profile_evidence,p.profile_hash,p.retired_at,
     r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version
    FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    WHERE c.id=$1 FOR SHARE OF c`,[report.campaignId])).rows[0];
   const persistedProfile=marketProfileSchema.safeParse(campaign?.profile),
    evidence=marketProfileEvidenceSchema.safeParse(campaign?.profile_evidence),
    storedRuntime=sealedRuntimeIdentitySchema.safeParse(campaign?.runtime_identity),
    effectiveRuntime=campaign?await campaignEffectiveRuntimeIdentity(db,report.campaignId,
     campaign.runtime_identity):null;
   if(!campaign||campaign.mode!=='paper'||campaign.chain_id!==profile.data.pool.chainId||
    campaign.current_revision!==report.revision||campaign.strategy_id!=='rangekeeper_v1'||
    campaign.strategy_version!=='1.0.0'||campaign.state_schema_version!==1||campaign.retired_at||
    !persistedProfile.success||!evidence.success||!storedRuntime.success||!effectiveRuntime||
    contentHash(effectiveRuntime)!==contentHash(runtime)||
    persistedProfile.data.pool.chainId!==campaign.chain_id||
    contentHash(persistedProfile.data)!==campaign.profile_hash||campaign.profile_hash!==report.profileHash||
    contentHash(profile.data)!==campaign.profile_hash||!campaign.config||
    typeof campaign.config!=='object'||Array.isArray(campaign.config)||
    contentHash(campaign.config)!==campaign.config_hash||campaign.config_hash!==report.configHash)
    throw new DeploymentConflict('rangekeeper_paper_gas_campaign_binding_invalid');
   const pending=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_operations
    WHERE campaign_id=$1 AND status IN
     ('queued','preflighting','executing','confirming','reconciling','blocked')) AS found`,
    [report.campaignId])).rows[0]?.found;
   if(pending)throw new DeploymentConflict('rangekeeper_paper_gas_operation_pending');
   for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
    if(persistedProfile.data.pool[key].toLowerCase()!==evidence.data.contractHashes[key].toLowerCase())
     throw new DeploymentConflict('rangekeeper_paper_gas_profile_integrity');
   if(referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash)
    throw new DeploymentConflict('rangekeeper_paper_gas_profile_integrity');
   const indexed=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
    WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=$3 AND fee=$4
     AND enabled=true AND target_set_hash=$5 AND lower(rwa_address)=lower($6)
     AND created_block<=$7::numeric) AS found`,[evidence.data.streamKey,profile.data.pool.pool,
     campaign.chain_id,profile.data.pool.fee,evidence.data.indexerTargetSetHash,
     profile.data.pool.quoteToken===0?profile.data.pool.token1:profile.data.pool.token0,source.block])).rows[0]?.found;
   if(!indexed)throw new DeploymentConflict('rangekeeper_paper_gas_indexer_changed');
   const config=campaign.config as Record<string,unknown>;
   if(config.strategyId!=='rangekeeper_v1'||config.strategyVersion!=='1.0.0'||config.stateSchemaVersion!==1)
    throw new DeploymentConflict('rangekeeper_paper_gas_config_integrity');
   const {strategyId:_strategyId,strategyVersion:_strategyVersion,
    stateSchemaVersion:_stateSchemaVersion,...parameters}=config;
   parseStrategyParameters('rangekeeper_v1',parameters);
   const draft={id:report.campaignId,revision:campaign.current_revision,
    allocation:allocationSchema.parse(campaign.allocation),profile:profile.data,
    profileHash:campaign.profile_hash,configHash:campaign.config_hash,
    strategyId:'rangekeeper_v1' as const,parameters};
   const policy=resolveRangeKeeperPaperPolicy(draft,report.buildId);
   if(!policy.policy||policy.unavailable.length||policy.policy.buildId!==report.buildId)
    throw new DeploymentConflict('rangekeeper_paper_gas_policy_unavailable');
   const attestation=rangeKeeperPaperGasAttestationSchema.parse(
    await verifyRangeKeeperPaperGasEvidenceSource({client:input.client,report,
     replayPersistedContext:input.replayPersistedContext})),
    verifiedAt=Date.parse(attestation.verifiedAt),verifiedNow=Date.now();
   if(attestation.reportHash!==report.reportHash||
    attestation.sourceHash.toLowerCase()!==source.hash.toLowerCase()||
    attestation.profileHash!==report.profileHash||attestation.candidateHash!==report.candidateHash||
    !/^[0-9a-f]{64}$/.test(attestation.replayHash))
    throw new DeploymentConflict('rangekeeper_paper_gas_attestation_mismatch');
   if(verifiedAt<sampledAt||verifiedNow<verifiedAt||verifiedNow-verifiedAt>300_000)
    throw new DeploymentConflict('rangekeeper_paper_gas_evidence_stale');
   if(report.reportKind==='open'){
    if(campaign.lifecycle!=='draft'||report.openMarkId!==null||report.openModelHash!==null)
     throw new DeploymentConflict('rangekeeper_paper_open_gas_campaign_unavailable');
   }else{
    if(!['active','paused'].includes(campaign.lifecycle))
     throw new DeploymentConflict('rangekeeper_paper_exit_gas_campaign_unavailable');
    const snapshot=await this.rangeKeeperPaperExitContextSnapshot(report.campaignId),
     frame:PaperOpenFrame={source:report.frame.source,tick:report.frame.tick,
      sqrtPriceX96:BigInt(report.frame.sqrtPriceX96),poolLiquidity:BigInt(report.frame.poolLiquidity),
      price0:BigInt(report.frame.price0),price1:BigInt(report.frame.price1),
      nativePrice:BigInt(report.frame.nativePrice),referenceEligible:true,referenceReasons:[],
      referenceProofHash:report.frame.referenceProofHash,referenceProof:report.frame.referenceProof};
    const context=await loadRangeKeeperPaperExitContext({campaignId:report.campaignId,
     buildId:report.buildId,frame,now:verifiedAt,readSnapshot:async()=>snapshot,
     readGasProfiles:query=>this.rangeKeeperPaperGasProfiles(query.poolAddress,query.pathVersion,query.sizeBand)});
    const epochCandidate=context.status==='available'?
     serializeRangeKeeperPaperCandidate(context.currentEpoch.candidate):null;
    if(context.status!=='available'||context.draft.configHash!==report.configHash||
     context.draft.profileHash!==report.profileHash||context.openMarkId!==report.openMarkId||
     contentHash(context.openModel)!==report.openModelHash||
     context.currentEpoch.candidateHash!==report.candidateHash||
     !epochCandidate||contentHash(epochCandidate)!==contentHash(report.candidate)||
     contentHash(context.currentEpoch.source)!==contentHash(report.candidateSource)||
     context.currentEpoch.candidateReferenceProofHash!==report.candidateReferenceProofHash)
     throw new DeploymentConflict('rangekeeper_paper_exit_gas_context_changed');
   const latestKernel=rangeKeeperTerminalInventoryHash(context,report);
   if(latestKernel!==report.scope.inventoryHash)
    throw new DeploymentConflict('rangekeeper_paper_exit_gas_inventory_changed');
   }
   const existing=(await db.query<{id:string;stage:string;allowanceState:string;version:number;
    validation:Record<string,unknown>;model:unknown;sourceHash:string;observedUntil:Date|null}>(`
    SELECT id::text,stage,allowance_state AS "allowanceState",version,validation,model,
     source_hash AS "sourceHash",observed_until AS "observedUntil"
    FROM deployment_calibration_profiles WHERE chain_id=$1 AND lower(pool_address)=lower($2)
     AND path_version=$3 AND size_band=$4 AND component='gas_units'
    ORDER BY stage,allowance_state,version DESC LIMIT 201`,
    [profile.data.pool.chainId,profile.data.pool.pool,path,sizeBand])).rows;
   if(existing.length>200)throw new DeploymentConflict('rangekeeper_paper_gas_profile_query_bound');
   const matching=existing.filter(row=>row.validation?.reportHash===report.reportHash);
   if(matching.length){
    const version=matching[0]!.version,expected=rangeKeeperPaperGasProfileInserts(report,attestation,version,verifiedNow);
    if(matching.length!==expected.length||matching.some(row=>row.version!==version)||
     existing.some(row=>row.version>version)||expected.some(item=>{
      const row=matching.find(candidate=>candidate.stage===item.stage&&
       candidate.allowanceState===item.allowanceState);
      return !row||row.sourceHash!==item.sourceHash||contentHash(row.model)!==contentHash(item.model)||
       row.validation.candidateHash!==report.candidateHash||row.validation.replayHash!==attestation.replayHash||
       contentHash(row.validation.localEvidence)!==contentHash(item.validation.localEvidence);
     }))throw new DeploymentConflict('rangekeeper_paper_gas_partial_previous_import');
    return {created:false,version,profileIds:expected.map(item=>
     matching.find(row=>row.stage===item.stage&&row.allowanceState===item.allowanceState)!.id),
     reportHash:report.reportHash,sizeBand};
   }
   if(existing.some(row=>row.validation?.reportHash===report.reportHash))
    throw new DeploymentConflict('rangekeeper_paper_gas_report_superseded');
   if(existing.some(row=>row.observedUntil&&sampledAt<=row.observedUntil.getTime()))
    throw new DeploymentConflict('rangekeeper_paper_gas_sample_not_newer');
   const version=existing.reduce((max,row)=>Math.max(max,row.version),0)+1,
    inserts=rangeKeeperPaperGasProfileInserts(report,attestation,version,verifiedNow),profileIds:string[]=[];
   try{await verifyCanonicalPaperAnchors(input.client,profile.data.pool.chainId,
    [report.candidateSource,report.frame.source]);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_gas_source_not_canonical');throw error;}
   for(const item of inserts){
    const id=randomUUID(),validation={...item.validation,campaignId:report.campaignId,
     revision:report.revision,configHash:report.configHash,buildId:report.buildId,
     candidateHash:report.candidateHash,replayHash:attestation.replayHash,scope:report.scope,
     sequenceHash:report.sequenceHash};
    await db.query(`INSERT INTO deployment_calibration_profiles
     (id,version,chain_id,pool_address,path_version,stage,allowance_state,size_band,
      component,status,evidence_class,model,validation,source_hash,observed_until)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'gas_units','provisional','fork_estimated',
      $9,$10,$11,$12)`,[id,version,profile.data.pool.chainId,profile.data.pool.pool.toLowerCase(),
      item.pathVersion,item.stage,item.allowanceState,item.sizeBand,JSON.stringify(item.model),
      JSON.stringify(validation),item.sourceHash,item.observedUntil]);
    profileIds.push(id);
   }
   return {created:true,version,profileIds,reportHash:report.reportHash,sizeBand};
  });
 }

 private async assertPersistedPaperCloseConvertGasEvidence(db:PoolClient,
  input:PaperCloseConvertGasPersistedEvidence,lockCampaign=false){
  const campaign=(await db.query<{mode:string;lifecycle:string;current_revision:number;
   runtime_identity:unknown;open_mark_id:string;chain_id:number;profile:unknown;
   profile_evidence:unknown;profile_hash:string;config:unknown;config_hash:string;
   strategy_id:string;strategy_version:string;state_schema_version:number}>(`
   SELECT c.mode,c.lifecycle,c.current_revision,c.runtime_identity,open_mark.id::text AS open_mark_id,c.chain_id,
    p.profile,p.evidence AS profile_evidence,p.profile_hash,r.config,r.config_hash,
    r.strategy_id,r.strategy_version,r.state_schema_version
   FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
   JOIN LATERAL (SELECT id FROM deployment_marks WHERE campaign_id=c.id
    AND provenance->>'classification'='paper_model_provisional' ORDER BY id LIMIT 1) open_mark ON TRUE
   WHERE c.id=$1${lockCampaign?' FOR SHARE OF c':''}`,[input.campaignId])).rows[0];
  const runtime=sealedRuntimeIdentitySchema.safeParse(campaign?.runtime_identity),
   profile=marketProfileSchema.safeParse(campaign?.profile),
   profileEvidence=marketProfileEvidenceSchema.safeParse(campaign?.profile_evidence),
   open=paperOpenModelSchema.safeParse(input.openModel),
   scope=paperCloseConvertGasScopeV2Schema.safeParse(input.scope);
  if(!campaign||campaign.mode!=='paper'||!['closing','closed'].includes(campaign.lifecycle)||
   campaign.current_revision!==input.revision||!runtime.success||
   contentHash(runtime.data)!==contentHash(input.runtimeIdentity)||
   !profile.success||!profileEvidence.success||!open.success||!scope.success||
   contentHash(campaign.profile)!==campaign.profile_hash||campaign.profile_hash!==input.profileHash||
   contentHash(profile.data)!==input.profileHash||contentHash(open.data)!==input.openModelHash||
   contentHash(input.profile)!==input.profileHash||contentHash(input.openModel)!==input.openModelHash||
   open.data.campaignId!==input.campaignId||
   open.data.revision!==input.revision||open.data.profileHash!==input.profileHash||
   open.data.configHash!==campaign.config_hash||
   referenceProofHash(profileEvidence.data.referenceProof)!==profileEvidence.data.references.proofHash||
   campaign.strategy_id!=='static_manual_v1'||campaign.strategy_version!=='1.0.0'||
   campaign.state_schema_version!==1||!campaign.config||
   contentHash(campaign.config)!==campaign.config_hash)
   throw new DeploymentConflict('paper_close_convert_gas_campaign_binding_invalid');
  for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
   if(profile.data.pool[key].toLowerCase()!==profileEvidence.data.contractHashes[key].toLowerCase())
    throw new DeploymentConflict('paper_close_convert_gas_profile_integrity');
  const indexed=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
   WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=$3 AND fee=$4
    AND enabled=true AND target_set_hash=$5 AND lower(rwa_address)=lower($6)
    AND created_block<=$7::numeric) AS found`,[profileEvidence.data.streamKey,
    profile.data.pool.pool,campaign.chain_id,profile.data.pool.fee,
    profileEvidence.data.indexerTargetSetHash,
    profile.data.pool.quoteToken===0?profile.data.pool.token1:profile.data.pool.token0,
    input.closeSource.block])).rows[0]?.found;
  if(!indexed)throw new DeploymentConflict('paper_close_convert_gas_indexer_changed');

  const openMark=(await db.query<{revision:number;source_block:string|null;source_hash:string|null;
   provenance:Record<string,unknown>}>(`SELECT revision,source_block::text,source_hash,provenance
   FROM deployment_marks WHERE id=$1 AND campaign_id=$2`,[campaign.open_mark_id,input.campaignId])).rows[0];
  if(!openMark||openMark.revision!==input.revision||openMark.source_block!==open.data.source.block||
   openMark.source_hash?.toLowerCase()!==open.data.source.hash.toLowerCase()||
   openMark.provenance.classification!=='paper_model_provisional'||
   openMark.provenance.modelHash!==input.openModelHash||
   openMark.provenance.source===undefined||contentHash(openMark.provenance.source)!==contentHash(open.data.source))
   throw new DeploymentConflict('paper_close_convert_gas_open_mark_invalid');
  if(contentHash(open.data.source)!==contentHash(input.openSource))
   throw new DeploymentConflict('paper_close_convert_gas_open_source_mismatch');

  const terminal=(await db.query<{revision:number;source_block:string|null;source_hash:string|null;
   inventory:Record<string,unknown>;calibration_profile_ids:string[];
   provenance:Record<string,unknown>}>(`SELECT revision,source_block::text,source_hash,inventory,
    calibration_profile_ids,provenance FROM deployment_marks
    WHERE id=$1 AND campaign_id=$2`,[input.terminalMarkId,input.campaignId])).rows[0];
  if(!terminal||terminal.revision!==input.revision||terminal.source_block!==input.closeSource.block||
   terminal.source_hash?.toLowerCase()!==input.closeSource.hash.toLowerCase()||
   terminal.provenance.classification!=='paper_model_converted_close'||
   terminal.inventory.position!==null||terminal.provenance.openMarkId!==campaign.open_mark_id||
   terminal.provenance.openModelHash!==input.openModelHash)
   throw new DeploymentConflict('paper_close_convert_gas_terminal_mark_invalid');
  const laterMark=(await db.query<{found:boolean}>(`SELECT EXISTS(
   SELECT 1 FROM deployment_marks WHERE campaign_id=$1 AND id>$2) AS found`,
   [input.campaignId,input.terminalMarkId])).rows[0]?.found;
  if(laterMark)throw new DeploymentConflict('paper_close_convert_gas_terminal_not_latest');
  const previousMark=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
   provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
   FROM deployment_marks WHERE campaign_id=$1 AND id<$2 ORDER BY deployment_marks.id DESC LIMIT 1`,
   [input.campaignId,input.terminalMarkId])).rows[0];
  if(!previousMark||previousMark.id!==input.previousMarkId)
   throw new DeploymentConflict('paper_close_convert_gas_previous_mark_invalid');
  const terminalPreviewId=terminal.provenance.previewId;
  const terminalPreview=(await db.query<{proposal:Record<string,unknown>}>(`
   SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
   [terminalPreviewId,input.campaignId])).rows[0];
  const closeModel=paperCloseConvertModelSchema.safeParse(terminalPreview?.proposal.paperCloseConvertModel);
  if(!closeModel.success||closeModel.data.campaignId!==input.campaignId||
   closeModel.data.revision!==input.revision||closeModel.data.openMarkId!==campaign.open_mark_id||
   closeModel.data.previousMarkId!==input.previousMarkId||
   closeModel.data.openModelHash!==input.openModelHash||
   closeModel.data.source.block!==input.closeSource.block||
   closeModel.data.source.hash.toLowerCase()!==input.closeSource.hash.toLowerCase()||
   closeModel.data.source.timestamp!==input.closeSource.timestamp||
   closeModel.data.poolState.tick!==input.frame.tick||
   closeModel.data.poolState.sqrtPriceX96!==input.frame.sqrtPriceX96||
   closeModel.data.poolState.poolLiquidity!==input.frame.poolLiquidity||
   closeModel.data.reference.price0!==input.frame.price0||
   closeModel.data.reference.price1!==input.frame.price1||
   closeModel.data.reference.nativePrice!==input.frame.nativePrice||
   closeModel.data.referenceProofHash!==input.frame.referenceProofHash||
   contentHash(closeModel.data.referenceProof)!==contentHash(input.frame.referenceProof)||
   referenceProofHash(input.frame.referenceProof)!==input.frame.referenceProofHash||
   contentHash(terminal.provenance.source)!==contentHash(closeModel.data.source)||
   contentHash(terminal.provenance.reference)!==contentHash(closeModel.data.reference)||
   contentHash(closeModel.data.conversionRoute)!==contentHash(input.route)||
   terminal.provenance.closeConvertModelHash!==contentHash(closeModel.data)||
   contentHash(terminal.provenance.modeledCosts)!==contentHash(closeModel.data.costs)||
   contentHash(terminal.provenance.conversionRoute)!==contentHash(closeModel.data.conversionRoute)||
   contentHash(terminal.inventory.retainedPrincipalLowerBound)!==contentHash(closeModel.data.principal)||
   contentHash(terminal.inventory.idleLowerBound)!==contentHash(closeModel.data.idle)||
   contentHash(terminal.calibration_profile_ids)!==contentHash(
    closeModel.data.costs.stages.map(stage=>stage.profileId)))
   throw new DeploymentConflict('paper_close_convert_gas_saved_model_invalid');
  if(previousMark.source_block!==closeModel.data.previousSource.block||
   previousMark.source_hash?.toLowerCase()!==closeModel.data.previousSource.hash.toLowerCase())
   throw new DeploymentConflict('paper_close_convert_gas_previous_source_invalid');

  const feeRow=(await db.query<{id:string;from_mark_id:string;proof:unknown;proof_hash:string;
   carry:PaperFeeCarry;carry_hash:string}>(`SELECT id::text,from_mark_id::text,proof,proof_hash,carry,carry_hash
   FROM deployment_paper_fee_evidence WHERE campaign_id=$1 AND to_mark_id=$2`,
   [input.campaignId,input.terminalMarkId])).rows[0];
  if(!feeRow||feeRow.from_mark_id!==input.previousMarkId||
   contentHash(feeRow.proof)!==feeRow.proof_hash||contentHash(feeRow.carry)!==feeRow.carry_hash||
   feeRow.id!==input.feeEvidence.id||feeRow.proof_hash!==input.feeEvidence.proofHash||
   feeRow.carry_hash!==input.feeEvidence.carryHash||contentHash(feeRow.carry)!==contentHash(input.feeCarry))
   throw new DeploymentConflict('paper_close_convert_gas_fee_evidence_invalid');
  const proof=feeRow.proof as CanonicalPaperFeeInterval;
  if(proof.coverage.stream!==profileEvidence.data.streamKey||
   proof.coverage.targetSetHash!==profileEvidence.data.indexerTargetSetHash)
   throw new DeploymentConflict('paper_close_convert_gas_fee_coverage_invalid');
  const priorFee=(await db.query<{id:string;proof:unknown;proof_hash:string;
   carry:PaperFeeCarry;carry_hash:string}>(`SELECT id::text,proof,proof_hash,carry,carry_hash
   FROM deployment_paper_fee_evidence WHERE campaign_id=$1 AND to_mark_id=$2`,
   [input.campaignId,input.previousMarkId])).rows[0];
  if(previousMark.provenance.classification==='paper_model_provisional'&&priorFee||
   previousMark.provenance.classification!=='paper_model_provisional'&&(!priorFee||
    contentHash(priorFee.proof)!==priorFee.proof_hash||contentHash(priorFee.carry)!==priorFee.carry_hash))
   throw new DeploymentConflict('paper_close_convert_gas_prior_fee_invalid');
  let carry:PaperFeeCarry;
  try{carry=advancePaperFeeCarry(priorFee?.carry??null,proof,open.data.source);}
  catch{throw new DeploymentConflict('paper_close_convert_gas_fee_replay_invalid');}
  if(contentHash(carry)!==feeRow.carry_hash||contentHash(carry)!==contentHash(input.feeCarry))
   throw new DeploymentConflict('paper_close_convert_gas_fee_replay_invalid');

  const expectedInventory={token0Raw:String(BigInt(closeModel.data.principal.amount0Raw)+
    BigInt(closeModel.data.idle.amount0Raw)+BigInt(carry.token0.lowerAmountRaw)),
   token1Raw:String(BigInt(closeModel.data.principal.amount1Raw)+
    BigInt(closeModel.data.idle.amount1Raw)+BigInt(carry.token1.lowerAmountRaw))};
  const expectedScope=closeConvertGasScopeV2(profile.data,open.data,closeModel.data,expectedInventory);
  if(contentHash(scope.data)!==contentHash(expectedScope)||input.scopeHash!==paperCloseConvertGasScopeHashV2(expectedScope)||
   contentHash(input.route)!==contentHash(closeModel.data.conversionRoute)||
   contentHash(input.quote.path)!==contentHash(input.route.path)||
   input.quote.router.toLowerCase()!==input.route.router.toLowerCase()||
   input.quote.quoter.toLowerCase()!==input.route.quoter.toLowerCase()||
   input.quote.fee!==input.route.fee||input.quote.pathVersion!==input.route.pathVersion||
   input.quote.inputAsset!==input.route.inputAsset||
   input.quote.inputAmountRaw!==expectedScope.inputAmountRaw||
   input.quote.source.block!==input.closeSource.block||
   input.quote.source.hash.toLowerCase()!==input.closeSource.hash.toLowerCase()||
   input.quote.source.timestamp!==input.closeSource.timestamp)
   throw new DeploymentConflict('paper_close_convert_gas_scope_mismatch');
  return {campaign,profile:profile.data,openModel:open.data,closeModel:closeModel.data,
   terminal,feeEvidence:{id:feeRow.id,proofHash:feeRow.proof_hash,carryHash:feeRow.carry_hash,
    carry},scope:expectedScope};
 }

 /** Read-only persisted-input check used after canonical and owned-fork source
  * verification. Registration repeats it under its atomic insert lock. */
 async verifyPersistedPaperCloseConvertGasEvidence(input:PaperCloseConvertGasPersistedEvidence){
  const db=await this.readPool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await this.assertPersistedPaperCloseConvertGasEvidence(db,input);
   await db.query('COMMIT');
  }catch(error){
   await db.query('ROLLBACK');throw error;
  }finally{db.release();}
 }

 /** Atomically registers one complete seven-stage conversion-gas report. The
  * quote route remains v1; only gas path/version and scoped stage set are v2. */
 async registerPaperCloseConvertGasEvidence(raw:unknown,rawAttestation:unknown){
  const report=verifyPaperCloseConvertGasEvidence(raw),attestation=
   paperCloseConvertGasAttestationSchema.parse(rawAttestation),
   runtimeIdentity=loadRuntimeIdentity();
  if(!runtimeIdentity)throw new DeploymentConflict('paper_close_convert_gas_runtime_unavailable');
  if(contentHash(runtimeIdentity)!==contentHash(report.runtimeIdentity)||
   contentHash(runtimeIdentity)!==contentHash(attestation.runtimeIdentity)||
   attestation.reportHash!==report.reportHash||
   attestation.sourceHash.toLowerCase()!==report.source.hash.toLowerCase()||
   attestation.profileHash!==report.profileHash||attestation.scopeHash!==report.scopeHash||
   attestation.sequenceHash!==report.sequenceHash)
   throw new DeploymentConflict('paper_close_convert_gas_attestation_mismatch');
  const sampledAt=Date.parse(report.sampledAt),verifiedAt=Date.parse(attestation.verifiedAt),now=Date.now();
  if(now-sampledAt<0||now-sampledAt>86_400_000||verifiedAt<sampledAt||
   now-verifiedAt<0||now-verifiedAt>300_000||sampledAt-report.source.timestamp*1000<0||
   sampledAt-report.source.timestamp*1000>180_000||
   attestation.ownedForkReplayBudget.requests>attestation.ownedForkReplayBudget.maxRequests||
   attestation.ownedForkReplayBudget.requests<1||attestation.ownedForkReplayBudget.rejected!==0||
   attestation.ownedForkReplayBudget.maxRequests>2000)
   throw new DeploymentConflict('paper_close_convert_gas_evidence_stale');
  const input:PaperCloseConvertGasPersistedEvidence={campaignId:report.campaignId,
   revision:report.revision,terminalMarkId:report.terminalMarkId,previousMarkId:report.previousMarkId,
   runtimeIdentity:report.runtimeIdentity as RuntimeIdentity,
   profile:report.profile as MarketProfile,profileHash:report.profileHash as string,
   openModel:report.openModel as PaperOpenModel,openModelHash:report.openModelHash as string,
   openSource:report.openModel.source,closeSource:report.source as PaperCloseConvertGasPersistedEvidence['closeSource'],
   frame:report.frame as PaperCloseConvertGasPersistedEvidence['frame'],
   route:report.route as PaperCloseConvertGasPersistedEvidence['route'],
   quote:report.quote as PaperCloseConvertGasPersistedEvidence['quote'],
   scope:report.scope as PaperCloseConvertGasPersistedEvidence['scope'],
   scopeHash:report.scopeHash as string,sequenceHash:report.sequenceHash as string,
   reportHash:report.reportHash as string,postWithdrawReplayHash:attestation.postWithdrawReplayHash,
   sourceReplayHash:attestation.sourceReplayHash,
   feeEvidence:report.feeEvidence as PaperCloseConvertGasPersistedEvidence['feeEvidence'],
   feeCarry:report.feeCarry as PaperCloseConvertGasPersistedEvidence['feeCarry']};
  const profile=marketProfileSchema.parse(report.profile),scope=paperCloseConvertGasScopeV2Schema.parse(report.scope),
   sizeBand=paperCloseConvertGasSizeBandV2(scope),allowanceStates=paperCloseConvertGasAllowanceStatesV2(scope);
  if(report.sizeBand!==sizeBand||report.scopeHash!==paperCloseConvertGasScopeHashV2(scope))
   throw new DeploymentConflict('paper_close_convert_gas_scope_invalid');
  return this.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`deployment-close-convert-gas:${profile.pool.pool.toLowerCase()}:${PAPER_STATIC_CONVERT_GAS_PATH_V2}:${sizeBand}`]);
   const persisted=await this.assertPersistedPaperCloseConvertGasEvidence(db,input,true);
   const previous=(await db.query<{id:string;stage:string;allowanceState:string;version:number;
    validation:Record<string,unknown>;observedUntil:Date|null;model:unknown;sourceHash:string}>(`
    SELECT id::text,stage,allowance_state AS "allowanceState",version,validation,
     observed_until AS "observedUntil",model,source_hash AS "sourceHash"
    FROM deployment_calibration_profiles WHERE chain_id=$1 AND lower(pool_address)=lower($2)
     AND path_version=$3 AND size_band=$4 AND component='gas_units'
    ORDER BY stage,allowance_state,version DESC`,
    [persisted.profile.pool.chainId,persisted.profile.pool.pool,
     PAPER_STATIC_CONVERT_GAS_PATH_V2,sizeBand])).rows;
   const matching=previous.filter(row=>row.validation?.reportHash===report.reportHash);
   if(matching.length){
    if(matching.length!==PAPER_STATIC_CONVERT_GAS_STAGES_V2.length||
     matching.some(row=>row.version!==matching[0]!.version)||
     previous.some(row=>row.version>matching[0]!.version)||
     PAPER_STATIC_CONVERT_GAS_STAGES_V2.some((stage,index)=>{
      const evidenceStage=report.stageProfiles[index] as Record<string,unknown>;
      const row=matching.find(item=>item.stage===stage&&
       item.allowanceState===allowanceStates[stage]);
      return !row||row.validation.campaignId!==report.campaignId||
       row.validation.revision!==report.revision||
       row.validation.terminalMarkId!==report.terminalMarkId||
       row.validation.previousMarkId!==report.previousMarkId||
       contentHash(row.validation.runtimeIdentity)!==contentHash(runtimeIdentity)||
       row.validation.scopeHash!==report.scopeHash||
       row.validation.sequenceHash!==report.sequenceHash||
       row.validation.postWithdrawReplayHash!==attestation.postWithdrawReplayHash||
       row.validation.sourceReplayHash!==attestation.sourceReplayHash||
       contentHash(row.model)!==contentHash(evidenceStage.model)||
       contentHash(row.validation.localEvidence)!==contentHash(evidenceStage.evidence)||
       row.sourceHash!==evidenceStage.sourceHash;
     }))throw new DeploymentConflict('paper_close_convert_gas_partial_previous_import');
    const orderedIds=PAPER_STATIC_CONVERT_GAS_STAGES_V2.map(stage=>matching.find(row=>row.stage===stage&&
     row.allowanceState===allowanceStates[stage])!.id);
    return {created:false,version:matching[0]!.version,profileIds:orderedIds,
     reportHash:report.reportHash,sizeBand};
   }
   if(persisted.campaign.lifecycle==='closed')
    throw new DeploymentConflict('paper_close_convert_gas_campaign_closed');
   if(previous.some(row=>row.validation?.reportHash===report.reportHash))
    throw new DeploymentConflict('paper_close_convert_gas_report_superseded');
   if(previous.some(row=>row.observedUntil&&sampledAt<=row.observedUntil.getTime()))
    throw new DeploymentConflict('paper_close_convert_gas_sample_not_newer');
   const version=previous.reduce((max,row)=>Math.max(max,row.version),0)+1,profileIds:string[]=[];
   for(const rawStage of report.stageProfiles as Record<string,unknown>[]){
    const stage=rawStage.stage as typeof PAPER_STATIC_CONVERT_GAS_STAGES_V2[number],
     allowanceState=rawStage.allowanceState as string;
    if(allowanceState!==allowanceStates[stage])
     throw new DeploymentConflict('paper_close_convert_gas_allowance_scope_invalid');
    const id=randomUUID(),validation={validationPolicy:'paper_close_convert_gas_v2',
     statusReason:'one_owned_fork_post_withdraw_replay',sampleCount:1,distinctCampaigns:1,
     reportHash:report.reportHash,canonicalAttestation:attestation,
     runtimeIdentity,campaignId:report.campaignId,revision:report.revision,
     terminalMarkId:report.terminalMarkId,previousMarkId:report.previousMarkId,
     profileHash:report.profileHash,openModelHash:report.openModelHash,
     feeEvidence:report.feeEvidence,scope,scopeHash:report.scopeHash,
     sequenceHash:report.sequenceHash,sizeBand,postWithdrawReplayHash:attestation.postWithdrawReplayHash,
     sourceReplayHash:attestation.sourceReplayHash,localEvidence:rawStage.evidence};
    await db.query(`INSERT INTO deployment_calibration_profiles
     (id,version,chain_id,pool_address,path_version,stage,allowance_state,size_band,
      component,status,evidence_class,model,validation,source_hash,observed_until)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'gas_units','provisional','fork_estimated',
      $9,$10,$11,$12)`,[id,version,persisted.profile.pool.chainId,
       persisted.profile.pool.pool.toLowerCase(),PAPER_STATIC_CONVERT_GAS_PATH_V2,
       stage,allowanceState,sizeBand,JSON.stringify(rawStage.model),JSON.stringify(validation),
       rawStage.sourceHash,report.sampledAt]);
    profileIds.push(id);
   }
   return {created:true,version,profileIds,reportHash:report.reportHash,sizeBand};
  });
 }

 private async selectRegisteredPaperCloseConvertGasV2(db:PoolClient,input:{
  campaignId:string;revision:number;terminalMarkId:string;previousMarkId:string;
  runtimeIdentity:RuntimeIdentity;profile:MarketProfile;open:PaperOpenModel;
  model:PaperCloseConvertModel;inventory:{token0Raw:string;token1Raw:string};
  feeEvidence:{id:string;proofHash:string;carryHash:string};now?:number;
 }):Promise<{costs:PaperCloseConvertCostsV2;binding:{reportHash:string;scopeHash:string;
  sequenceHash:string;sizeBand:string;profileIds:string[]}}>{
  const scope=closeConvertGasScopeV2(input.profile,input.open,input.model,input.inventory),
   scopeHash=paperCloseConvertGasScopeHashV2(scope),sizeBand=paperCloseConvertGasSizeBandV2(scope),
   allowances=paperCloseConvertGasAllowanceStatesV2(scope),now=input.now??Date.now();
  const rows=(await db.query<PaperGasProfileRow&{validation:Record<string,unknown>}>(`
   SELECT id::text,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
    allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
    evidence_class AS "evidenceClass",model,validation,source_hash AS "sourceHash",
    observed_until AS "observedUntil"
   FROM deployment_calibration_profiles WHERE chain_id=$1 AND lower(pool_address)=lower($2)
    AND path_version=$3 AND size_band=$4 AND component='gas_units'
    AND stage=ANY($5::text[]) AND allowance_state=ANY($6::text[])
   ORDER BY stage,version DESC LIMIT 201`,[input.profile.pool.chainId,input.profile.pool.pool,
    PAPER_STATIC_CONVERT_GAS_PATH_V2,sizeBand,[...PAPER_STATIC_CONVERT_GAS_STAGES_V2],
    [...new Set(Object.values(allowances))]])).rows;
  if(rows.length>200)throw new DeploymentConflict('paper_close_convert_gas_profile_query_bound');
  const groups=new Map<string,typeof rows>();
  for(const row of rows){
   const validation=row.validation,reportHash=validation?.reportHash;
   if(typeof reportHash!=='string'||!(/^[0-9a-f]{64}$/.test(reportHash)))continue;
   const attestation=paperCloseConvertGasAttestationSchema.safeParse(validation.canonicalAttestation);
   if(!attestation.success)continue;
   const exact=validation.campaignId===input.campaignId&&validation.revision===input.revision&&
    validation.terminalMarkId===input.terminalMarkId&&validation.previousMarkId===input.previousMarkId&&
    validation.profileHash===input.open.profileHash&&validation.openModelHash===contentHash(input.open)&&
    validation.scopeHash===scopeHash&&validation.sizeBand===sizeBand&&
    contentHash(validation.scope)===contentHash(scope)&&
    contentHash(validation.runtimeIdentity)===contentHash(input.runtimeIdentity)&&
    contentHash(validation.feeEvidence)===contentHash(input.feeEvidence)&&
    validation.sequenceHash===attestation.data.sequenceHash&&
    validation.scopeHash===attestation.data.scopeHash&&
    reportHash===attestation.data.reportHash&&
    validation.postWithdrawReplayHash===attestation.data.postWithdrawReplayHash&&
    validation.sourceReplayHash===attestation.data.sourceReplayHash&&
    contentHash(attestation.data.runtimeIdentity)===contentHash(input.runtimeIdentity);
   if(!exact||row.pathVersion!==PAPER_STATIC_CONVERT_GAS_PATH_V2||
    row.sizeBand!==sizeBand||row.allowanceState!==allowances[row.stage as keyof typeof allowances])continue;
   const group=groups.get(reportHash)??[];group.push(row);groups.set(reportHash,group);
  }
  const candidates=[...groups].filter(([,group])=>group.length===PAPER_STATIC_CONVERT_GAS_STAGES_V2.length&&
   new Set(group.map(row=>row.version)).size===1&&PAPER_STATIC_CONVERT_GAS_STAGES_V2.every(stage=>
    group.filter(row=>row.stage===stage&&row.allowanceState===allowances[stage]).length===1));
  if(candidates.length===0)throw new DeploymentConflict('paper_close_convert_gas_v2_profiles_unavailable');
  candidates.sort((a,b)=>Math.max(...b[1].map(row=>row.version))-Math.max(...a[1].map(row=>row.version)));
  const [reportHash,selected]=candidates[0]!,sequenceHash=String(selected[0]!.validation.sequenceHash);
  if(candidates.length>1&&Math.max(...candidates[0]![1].map(row=>row.version))===
   Math.max(...candidates[1]![1].map(row=>row.version)))
   throw new DeploymentConflict('paper_close_convert_gas_v2_profiles_ambiguous');
  const ordered=PAPER_STATIC_CONVERT_GAS_STAGES_V2.map(stage=>selected.find(row=>row.stage===stage)!);
  const costs=(()=>{try{return costPaperCloseConvertGasV2(ordered,scope,
   BigInt(input.model.reference.nativePrice),BigInt(input.model.costs.gasPriceWei),now,
   input.model.costs.gasPriceObservedAt);}catch{throw new DeploymentConflict('paper_close_convert_gas_v2_profiles_invalid');}})();
  if(costs.scopeHash!==scopeHash||costs.sequenceHash!==sequenceHash||
   costs.stages.some((stage,index)=>stage.profileId!==ordered[index]!.id))
   throw new DeploymentConflict('paper_close_convert_gas_v2_selection_changed');
  return {costs,binding:{reportHash,scopeHash,sequenceHash,sizeBand,
   profileIds:ordered.map(row=>row.id)}};
 }

 /** Trusted ingestion after verifyPaperGasSource has replayed the candidate
  * on canonical chain data. Gas estimates remain provisional fork evidence. */
 async registerPaperGasEvidence(raw:unknown,rawAttestation:unknown){
  const report=verifyPaperGasEvidence(raw),attestation=paperGasAttestationSchema.parse(rawAttestation);
  const source=report.source as {block:string;hash:string;timestamp:number};
  const profile=marketProfileSchema.parse(report.profile),sampledAt=Date.parse(report.sampledAt as string);
  const now=Date.now(),verifiedAt=Date.parse(attestation.verifiedAt);
  if(attestation.reportHash!==report.reportHash||attestation.sourceHash.toLowerCase()!==source.hash.toLowerCase()||
   attestation.profileHash!==report.profileHash)throw new DeploymentConflict('paper_gas_attestation_mismatch');
  if(now-sampledAt<0||now-sampledAt>86_400_000||verifiedAt<sampledAt||
   now-verifiedAt<0||now-verifiedAt>300_000||sampledAt-source.timestamp*1000<0||
   sampledAt-source.timestamp*1000>180_000)
   throw new DeploymentConflict('paper_gas_evidence_stale');
  const candidate=report.candidate as {deployedValue:string;dilutedSharePpm:string;
   range:{tickLower:number;tickUpper:number}};
  // Keyed on the pool and the exact tick range only. Size and share are banded
  // in the model itself because they do not move this path's gas, so keeping
  // them in the key would mint a fresh single-use band per sample and grow the
  // table without buying any precision. Re-sampling the same range now appends
  // a new version of one band, which the resolver already prefers, instead.
  const sizeBand=`range_${contentHash({pool:profile.pool.pool.toLowerCase(),
   lower:candidate.range.tickLower,upper:candidate.range.tickUpper}).slice(0,32)}`;
  return this.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`deployment-paper-gas:${profile.pool.pool.toLowerCase()}:${sizeBand}`]);
   const known=(await db.query<{id:string;profile:unknown;evidence:unknown;retired_at:Date|null}>(`
    SELECT id,profile,evidence,retired_at FROM deployment_market_profiles
    WHERE chain_id=4663 AND lower(pool_address)=lower($1) AND profile_hash=$2 FOR SHARE`,
    [profile.pool.pool,report.profileHash])).rows[0];
   if(!known||known.retired_at||contentHash(known.profile)!==report.profileHash)
    throw new DeploymentConflict('paper_gas_market_profile_unavailable');
   const evidence=marketProfileEvidenceSchema.safeParse(known.evidence);
   if(!evidence.success)throw new DeploymentConflict('paper_gas_market_profile_unavailable');
   for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
    if(profile.pool[key].toLowerCase()!==evidence.data.contractHashes[key].toLowerCase())
     throw new DeploymentConflict('paper_gas_market_profile_integrity');
   const indexed=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
    WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=4663 AND fee=$3
     AND enabled=true AND target_set_hash=$4 AND lower(rwa_address)=lower($5)
     AND created_block<=$6::numeric) AS found`,
    [evidence.data.streamKey,profile.pool.pool,profile.pool.fee,evidence.data.indexerTargetSetHash,
     profile.pool.quoteToken===0?profile.pool.token1:profile.pool.token0,source.block])).rows[0]?.found;
   if(!indexed)throw new DeploymentConflict('paper_gas_indexer_changed');
   const previous=(await db.query<{id:string;stage:string;version:number;validation:Record<string,unknown>;
    observed_until:Date|null}>(`
    SELECT DISTINCT ON (stage) id,stage,version,validation,observed_until
    FROM deployment_calibration_profiles WHERE chain_id=4663 AND lower(pool_address)=lower($1)
     AND path_version=$2 AND allowance_state='zero' AND size_band=$3 AND component='gas_units'
    ORDER BY stage,version DESC`,[profile.pool.pool,PAPER_STATIC_GAS_PATH,sizeBand])).rows;
   const matching=previous.filter(row=>row.validation?.reportHash===report.reportHash);
   if(matching.length){
    if(matching.length!==PAPER_STATIC_GAS_STAGES.length||previous.length!==PAPER_STATIC_GAS_STAGES.length||
     matching.some(row=>row.version!==matching[0]!.version))
     throw new DeploymentConflict('paper_gas_partial_previous_import');
    return {created:false,version:matching[0]!.version,profileIds:matching.map(row=>row.id),
     reportHash:report.reportHash,sizeBand};
   }
   const older=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1
    FROM deployment_calibration_profiles WHERE chain_id=4663 AND lower(pool_address)=lower($1)
     AND path_version=$2 AND allowance_state='zero' AND size_band=$3 AND component='gas_units'
     AND validation->>'reportHash'=$4) AS found`,
    [profile.pool.pool,PAPER_STATIC_GAS_PATH,sizeBand,report.reportHash])).rows[0]?.found;
   if(older)throw new DeploymentConflict('paper_gas_report_superseded');
   if(previous.some(row=>row.observed_until&&sampledAt<=row.observed_until.getTime()))
    throw new DeploymentConflict('paper_gas_sample_not_newer');
   const version=previous.reduce((max,row)=>Math.max(max,row.version),0)+1;
   const profileIds:string[]=[];
   for(const rawStage of report.stageProfiles as Record<string,unknown>[]){
    const id=randomUUID(),stage=rawStage.stage as string;
    const validation={validationPolicy:'calibration_v1',statusReason:'one_owned_fork_sample',
     sampleCount:1,distinctCampaigns:0,reportHash:report.reportHash,
     canonicalAttestation:attestation,localEvidence:rawStage.evidence};
    // The class is derived from the method the stage's own model records, never
    // assumed: the resolver refuses a row whose class and method disagree, so
    // writing a fixed class here would silently make simulated stages uncostable.
    const evidenceClass=paperGasEvidenceClassFor(
     paperGasModelSchema.parse(rawStage.model).source.method);
    await db.query(`INSERT INTO deployment_calibration_profiles
     (id,version,chain_id,pool_address,path_version,stage,allowance_state,size_band,
      component,status,evidence_class,model,validation,source_hash,observed_until)
     VALUES($1,$2,4663,$3,$4,$5,'zero',$6,'gas_units','provisional',$11,
      $7,$8,$9,$10)`,[id,version,profile.pool.pool.toLowerCase(),PAPER_STATIC_GAS_PATH,
      stage,sizeBand,JSON.stringify(rawStage.model),JSON.stringify(validation),rawStage.sourceHash,
      report.sampledAt,evidenceClass]);
    profileIds.push(id);
   }
   return {created:true,version,profileIds,reportHash:report.reportHash,sizeBand};
  });
 }

 /** Only a trusted preflight service may create a preview. HTTP never supplies
  * proposal/evidence; it supplies only the operator's requested action. */
 async recordPreview(raw:PreviewInput){
  const input=previewInput.parse(raw),id=randomUUID(),digest=previewDigest(input);
  const remainingMs=input.expiresAt.getTime()-Date.now();
  if(remainingMs<=0)throw new DeploymentConflict('preview_expired');
  if(remainingMs>120_000)throw new DeploymentConflict('preview_expiry_too_distant');
  return this.transaction(async db=>{
   const campaign=(await db.query<{current_revision:number}>(
    'SELECT current_revision FROM deployment_campaigns WHERE id=$1 FOR SHARE',[input.campaignId])).rows[0];
   if(!campaign||campaign.current_revision!==input.expectedRevision)throw new DeploymentConflict('stale_revision');
   await db.query(`INSERT INTO deployment_previews
    (id,campaign_id,expected_revision,kind,request,proposal,evidence,content_digest,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id,input.campaignId,input.expectedRevision,input.kind,JSON.stringify(input.request),
     JSON.stringify(input.proposal),JSON.stringify(input.evidence),digest,input.expiresAt]);
   return {id,contentDigest:digest,expiresAt:input.expiresAt};
  });
 }

 /** Persists a no-economics pause/resume preview only for the exact current
  * PAPER static/manual lifecycle. The campaign row lock binds lifecycle and
  * revision together before the immutable proposal is written. */
 async recordPaperLifecyclePreview(campaignId:string,kind:'pause'|'resume'){
  const id=randomUUID();
  return this.transaction(async db=>{
   const campaign=(await db.query<{mode:string;current_revision:number;lifecycle:string;
    strategy_id:string;strategy_version:string;state_schema_version:number;config:unknown;config_hash:string}>(`
    SELECT c.mode,c.current_revision,c.lifecycle,r.strategy_id,r.strategy_version,
     r.state_schema_version,r.config,r.config_hash
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    WHERE c.id=$1 FOR UPDATE OF c`,[campaignId])).rows[0];
   const from=kind==='pause'?'active':'paused',to=kind==='pause'?'paused':'active';
   if(!campaign||campaign.mode!=='paper'||campaign.strategy_id!=='static_manual_v1'||
    campaign.lifecycle!==from)
    throw new DeploymentConflict('paper_lifecycle_state_unavailable');
   if(!campaign.config||typeof campaign.config!=='object'||Array.isArray(campaign.config)||
    contentHash(campaign.config)!==campaign.config_hash)
    throw new DeploymentConflict('campaign_config_integrity');
   const config=campaign.config as Record<string,unknown>;
   if(config.strategyId!==campaign.strategy_id||config.strategyVersion!==campaign.strategy_version||
    config.stateSchemaVersion!==campaign.state_schema_version)
    throw new DeploymentConflict('campaign_config_integrity');
   const {strategyId:_id,strategyVersion:_version,stateSchemaVersion:_schema,...parameters}=config;
   parseStrategyParameters('static_manual_v1',parameters);
   const pending=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_operations
    WHERE campaign_id=$1 AND status IN ('queued','preflighting','executing','confirming',
     'reconciling','blocked')) AS found`,[campaignId])).rows[0]?.found;
   if(pending)throw new DeploymentConflict('operation_in_progress');
   const expiresAt=new Date(Date.now()+60_000),input=previewInput.parse({campaignId,
    expectedRevision:campaign.current_revision,kind,request:{kind},
    proposal:{paperLifecycle:{from,to}},evidence:{},expiresAt});
   const contentDigest=previewDigest(input);
   await db.query(`INSERT INTO deployment_previews
    (id,campaign_id,expected_revision,kind,request,proposal,evidence,content_digest,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id,campaignId,input.expectedRevision,kind,JSON.stringify(input.request),
     JSON.stringify(input.proposal),JSON.stringify(input.evidence),contentDigest,expiresAt]);
   return {id,kind,status:'indicative' as const,expectedRevision:input.expectedRevision,
    contentDigest,expiresAt:expiresAt.toISOString(),source:null,economics:null,
    proposal:input.proposal.paperLifecycle,actionAvailable:false,draftCreationAvailable:false,
    operationAcceptanceAvailable:false};
  });
 }

 /** Strict admission for a retained-model RangeKeeper convert exit. The route
  * may precheck, but this transaction binds the exact latest epoch and preview. */
 async acceptRangeKeeperPaperConvertOperation(campaignId:string,raw:AcceptInput,actor:string,
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>){
  const input=acceptInput.parse(raw);
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(actor))throw new DeploymentConflict('invalid_actor');
  const requestDigest=contentHash({campaignId,previewId:input.previewId,
   contentDigest:input.contentDigest,expectedRevision:input.expectedRevision});
  return this.transaction(async db=>{
   const campaign=(await db.query<{mode:string;lifecycle:string;revision:number;chain_id:number;
    runtime_identity:unknown;profile:unknown;profile_hash:string;config:unknown;config_hash:string;
    strategy_id:string;strategy_version:string;state_schema_version:number}>(`
    SELECT c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,c.runtime_identity,
     p.profile,p.profile_hash,r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    WHERE c.id=$1 FOR UPDATE OF c`,[campaignId])).rows[0];
   if(!campaign||campaign.mode!=='paper'||campaign.strategy_id!=='rangekeeper_v1'||
    campaign.revision!==input.expectedRevision)
    throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_campaign_unavailable');
   const runtime=sealedRuntimeIdentitySchema.safeParse(campaign.runtime_identity),current=loadRuntimeIdentity(),
    profile=marketProfileSchema.safeParse(campaign.profile),configOk=!!campaign.config&&
     typeof campaign.config==='object'&&!Array.isArray(campaign.config)&&
     contentHash(campaign.config)===campaign.config_hash;
   if(!runtime.success||!await campaignRuntimeMatches(db,campaignId,runtime.data,current)||!profile.success||
    !configOk||contentHash(profile.data)!==campaign.profile_hash)
    throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_campaign_integrity');
   const replay=(await db.query<{id:string;status:string;request_digest:string;preview_id:string;kind:string}>(`
    SELECT id::text,status,request_digest,preview_id::text,kind FROM deployment_operations
    WHERE campaign_id=$1 AND idempotency_key=$2`,[campaignId,input.idempotencyKey])).rows[0];
   if(replay){if(replay.request_digest!==requestDigest||replay.preview_id!==input.previewId||
     replay.kind!=='close_convert')throw new DeploymentConflict('idempotency_conflict');
    return {id:replay.id,status:replay.status,replayed:true};}
   if(!['active','paused'].includes(campaign.lifecycle))
    throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_campaign_unavailable');
   const preview=(await db.query<{kind:string;expected_revision:number;content_digest:string;
    expires_at:Date;request:Record<string,unknown>;proposal:Record<string,unknown>;
    evidence:Record<string,unknown>}>(`SELECT kind,expected_revision,content_digest,expires_at,
    request,proposal,evidence FROM deployment_previews WHERE id=$1 AND campaign_id=$2 FOR UPDATE`,
    [input.previewId,campaignId])).rows[0];
   if(!preview||preview.kind!=='close_convert'||preview.expected_revision!==campaign.revision||
    preview.content_digest!==input.contentDigest||preview.expires_at.getTime()<=Date.now()||
    previewDigest({campaignId,expectedRevision:preview.expected_revision,kind:'close_convert',
     request:preview.request,proposal:preview.proposal,evidence:preview.evidence,
     expiresAt:preview.expires_at})!==preview.content_digest)
    throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_preview_invalid');
   const model=preview.proposal.rangekeeperPaperExitModel,
    modelHash=preview.proposal.rangekeeperPaperExitModelHash,
    source=paperFeeMarkSourceSchema.safeParse((model as Record<string,unknown>|undefined)?.source);
   if(!model||typeof model!=='object'||Array.isArray(model)||contentHash(model)!==modelHash||
    !source.success||(model as Record<string,unknown>).campaignId!==campaignId||
    (model as Record<string,unknown>).revision!==campaign.revision||
    (model as Record<string,unknown>).exitKind!=='convert'||
    preview.request.strategyId!=='rangekeeper_v1'||preview.request.exitKind!=='convert'||
    preview.request.profileHash!==campaign.profile_hash||preview.request.configHash!==campaign.config_hash||
    preview.request.candidateHash!==(model as Record<string,unknown>).candidateHash||
    preview.evidence.verificationClass!=='canonical_rangekeeper_paper_exit_model_v1'||
    preview.evidence.profileHash!==campaign.profile_hash||preview.evidence.paidCostsAvailable!==false)
    throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_model_invalid');
   const latest=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`SELECT m.id::text,source_block::text,source_hash,provenance
    FROM deployment_marks m WHERE m.campaign_id=$1 ORDER BY m.id DESC LIMIT 1 FOR UPDATE`,[campaignId])).rows[0],
    previous=(model as {previousMark:{id:string;source:PaperCanonicalAnchor;candidateHash:string}}).previousMark;
   if(!latest||!previous||latest.id!==previous.id||latest.source_block!==previous.source.block||
    latest.source_hash?.toLowerCase()!==previous.source.hash.toLowerCase()||
    latest.provenance.candidateHash!==previous.candidateHash||
    contentHash(latest.provenance.source)!==contentHash(previous.source))
    throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_latest_mark_changed');
   const pending=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_operations
    WHERE campaign_id=$1 AND status IN ('queued','preflighting','executing','confirming',
     'reconciling','blocked')) AS found`,[campaignId])).rows[0]?.found;
   if(pending)throw new DeploymentConflict('operation_in_progress');
   try{await verifyAnchors(campaign.chain_id,[source.data,previous.source]);}
   catch(error){if(error instanceof AssertionError)
    throw new DeploymentConflict('rangekeeper_paper_exit_acceptance_source_not_canonical');throw error;}
   const id=randomUUID();
   await db.query(`INSERT INTO deployment_operations
    (id,campaign_id,preview_id,actor,idempotency_key,request_digest,kind,status,stage)
    VALUES($1,$2,$3,$4,$5,$6,'close_convert','queued','accepted')`,
    [id,campaignId,input.previewId,actor,input.idempotencyKey,requestDigest]);
   await db.query('SELECT pg_notify($1,$2)',[PAPER_OPERATION_NOTIFY_CHANNEL,id]);
   await db.query(`UPDATE deployment_campaigns SET lifecycle='closing',updated_at=clock_timestamp()
    WHERE id=$1`,[campaignId]);
   return {id,status:'queued',replayed:false};
  });
 }

 /** Strict admission for one already-prepared automatic epoch transition.
  * This path is intentionally separate from generic operator acceptance. */
 async acceptRangeKeeperPaperRecenterOperation(campaignId:string,raw:AcceptInput,actor:string,
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>){
  const input=acceptInput.parse(raw);
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(actor))throw new DeploymentConflict('invalid_actor');
  const requestDigest=contentHash({campaignId,previewId:input.previewId,
   contentDigest:input.contentDigest,expectedRevision:input.expectedRevision});
  return this.transaction(async db=>{
   const campaign=(await db.query<{mode:string;lifecycle:string;revision:number;chain_id:number;
    runtime_identity:unknown;profile:unknown;profile_hash:string;config:unknown;config_hash:string;
    strategy_id:string;strategy_version:string;state_schema_version:number}>(`
    SELECT c.mode,c.lifecycle,c.current_revision AS revision,c.chain_id,c.runtime_identity,
     p.profile,p.profile_hash,r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    WHERE c.id=$1 FOR UPDATE OF c`,[campaignId])).rows[0];
   if(!campaign||campaign.mode!=='paper'||campaign.strategy_id!=='rangekeeper_v1')
    throw new DeploymentConflict('rangekeeper_paper_recenter_admission_unavailable');
   const existing=(await db.query<{id:string;status:string;request_digest:string;preview_id:string}>(`
    SELECT id::text,status,request_digest,preview_id::text FROM deployment_operations
    WHERE campaign_id=$1 AND idempotency_key=$2`,[campaignId,input.idempotencyKey])).rows[0];
   if(existing){if(existing.request_digest!==requestDigest||existing.preview_id!==input.previewId)
     throw new DeploymentConflict('idempotency_conflict');
    return {id:existing.id,status:existing.status,replayed:true};}
   if(campaign.lifecycle!=='active'||campaign.revision!==input.expectedRevision)
    throw new DeploymentConflict('rangekeeper_paper_recenter_admission_unavailable');
   const runtime=sealedRuntimeIdentitySchema.safeParse(campaign.runtime_identity),current=loadRuntimeIdentity(),
    runtimeMatches=await campaignRuntimeMatches(db,campaignId,campaign.runtime_identity,current),
    profile=marketProfileSchema.safeParse(campaign.profile);
   if(!runtime.success||!current||!runtimeMatches||!profile.success||
    contentHash(profile.data)!==campaign.profile_hash||!campaign.config||typeof campaign.config!=='object'||
    Array.isArray(campaign.config)||contentHash(campaign.config)!==campaign.config_hash)
    throw new DeploymentConflict('rangekeeper_paper_recenter_campaign_integrity');
   const preview=(await db.query<{kind:string;expected_revision:number;content_digest:string;expires_at:Date;
    request:Record<string,unknown>;proposal:Record<string,unknown>;evidence:Record<string,unknown>}>(`
    SELECT kind,expected_revision,content_digest,expires_at,request,proposal,evidence
    FROM deployment_previews WHERE id=$1 AND campaign_id=$2 FOR UPDATE`,[input.previewId,campaignId])).rows[0];
   if(!preview||preview.kind!=='change_range'||preview.expected_revision!==campaign.revision||
    preview.content_digest!==input.contentDigest||preview.expires_at.getTime()<=Date.now()||
    previewDigest({campaignId,expectedRevision:preview.expected_revision,kind:'change_range',
     request:preview.request,proposal:preview.proposal,evidence:preview.evidence,
     expiresAt:preview.expires_at})!==preview.content_digest)
    throw new DeploymentConflict('rangekeeper_paper_recenter_preview_invalid');
   const model=validateRangeKeeperPaperRecenterBooking(preview.proposal.rangekeeperPaperRecenterModel),
    modelHash=preview.proposal.rangekeeperPaperRecenterModelHash;
   if(modelHash!==model.modelHash||model.campaignId!==campaignId||model.revision!==campaign.revision||
    model.candidate.kind!=='recenter'||preview.request.kind!=='automatic_paper_recenter_v1'||
    preview.request.epoch!==model.epoch||preview.request.priorMarkId!==model.priorMark.id||
    preview.request.priorMarkHash!==model.priorMark.markHash||
    preview.evidence.modelHash!==model.modelHash||preview.evidence.candidateHash!==model.candidateHash)
    throw new DeploymentConflict('rangekeeper_paper_recenter_model_binding_invalid');
   const latest=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
    inventory:unknown;economics:unknown;provenance:Record<string,unknown>}>(`
    SELECT m.id::text,revision,source_block::text,source_hash,inventory,economics,provenance
    FROM deployment_marks m WHERE m.campaign_id=$1 ORDER BY m.id DESC LIMIT 1 FOR UPDATE`,[campaignId])).rows[0];
   const latestHash=latest?contentHash({revision:latest.revision,source_block:latest.source_block,
    source_hash:latest.source_hash,inventory:latest.inventory,economics:latest.economics,
    provenance:latest.provenance}):null;
   if(!latest||latest.id!==model.priorMark.id||latestHash!==model.priorMark.markHash||
    latest.revision!==campaign.revision||latest.source_block!==model.priorMark.source.block||
    latest.source_hash?.toLowerCase()!==model.priorMark.source.hash.toLowerCase()||
    model.previousEpoch!==Number(latest.provenance.epoch??0)||model.epoch!==model.previousEpoch+1)
    throw new DeploymentConflict('rangekeeper_paper_recenter_prior_mark_changed');
   const pending=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_operations
    WHERE campaign_id=$1 AND status IN ('queued','preflighting','executing','confirming',
     'reconciling','blocked')) AS found`,[campaignId])).rows[0]?.found;
   if(pending)throw new DeploymentConflict('operation_in_progress');
   const priorSource=paperFeeMarkSourceSchema.parse(latest.provenance.source);
   try{await verifyAnchors(campaign.chain_id,[priorSource,model.source]);}
   catch(error){if(error instanceof AssertionError)
    throw new DeploymentConflict('rangekeeper_paper_recenter_source_not_canonical');throw error;}
   const id=randomUUID();
   await db.query(`INSERT INTO deployment_operations
    (id,campaign_id,preview_id,actor,idempotency_key,request_digest,kind,status,stage)
    VALUES($1,$2,$3,$4,$5,$6,'change_range','queued','accepted')`,
    [id,campaignId,input.previewId,actor,input.idempotencyKey,requestDigest]);
   await db.query('SELECT pg_notify($1,$2)',[PAPER_OPERATION_NOTIFY_CHANNEL,id]);
   return {id,status:'queued',replayed:false};
  });
 }

 /** Dedicated V3 close-convert admission. The slow source/fork verifier runs
  * before the write transaction; the saved preview, fee predecessor, latest
  * mark, profile rows, lifecycle and idempotency binding are then rechecked
  * under the campaign lock. This method is intentionally not wired to HTTP
  * until the V3 atomic completion path passes restart integration. */
 async acceptStaticPaperCloseConvertV3Operation(campaignId:string,raw:AcceptInput,actor:string,
  verifyTerminal:(model:PaperStaticCloseConvertTerminalModel)=>Promise<{
   status:'verified';modelHash:string;feeReplayHash:string;intervalHash:string;gasReportHash:string;
   quoteHash:string;
   source:PaperCanonicalAnchor;actionAvailable:false;bookingAvailable:false}>,
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>){
  const input=acceptInput.parse(raw);
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(actor))throw new DeploymentConflict('invalid_actor');
  const requestDigest=contentHash({campaignId,previewId:input.previewId,
   contentDigest:input.contentDigest,expectedRevision:input.expectedRevision});
  const replay=await this.readPool.query<{id:string;request_digest:string;status:string;
   kind:string;preview_id:string}>(`SELECT id::text,request_digest,status,kind,preview_id::text
    FROM deployment_operations WHERE campaign_id=$1 AND idempotency_key=$2`,
   [campaignId,input.idempotencyKey]);
  if(replay.rows[0]){
   const row=replay.rows[0]!;
   if(row.request_digest!==requestDigest||row.preview_id!==input.previewId||row.kind!=='close_convert')
    throw new DeploymentConflict('idempotency_conflict');
   return {id:row.id,status:row.status,replayed:true};
  }
  const saved=(await this.readPool.query<{expected_revision:number;kind:string;
   content_digest:string;expires_at:Date;request:Record<string,unknown>;
   proposal:Record<string,unknown>;evidence:Record<string,unknown>}>(`
   SELECT expected_revision,kind,content_digest,expires_at,request,proposal,evidence
   FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,[input.previewId,campaignId])).rows[0];
  if(!saved||saved.kind!=='close_convert'||saved.expected_revision!==input.expectedRevision||
   saved.content_digest!==input.contentDigest||saved.expires_at.getTime()<=Date.now())
   throw new DeploymentConflict('stale_preview');
  let model:PaperStaticCloseConvertTerminalModel;
  try{model=parsePaperStaticCloseConvertTerminalV3(saved.proposal.paperCloseConvertTerminalV3);}
  catch{throw new DeploymentConflict('paper_close_convert_v3_preview_invalid');}
  const verification=await verifyTerminal(model);
  if(verification.status!=='verified'||verification.actionAvailable!==false||
   verification.bookingAvailable!==false||verification.modelHash!==model.modelHash||
   verification.feeReplayHash!==model.feeReplay.replayHash||
   verification.intervalHash!==model.feeReplay.intervalHash||
   verification.gasReportHash!==model.gasReport.reportHash||
   verification.quoteHash!==model.quote.quoteHash||
   contentHash(verification.source)!==contentHash(model.source))
   throw new DeploymentConflict('paper_close_convert_v3_terminal_verification_unavailable');
  return this.transaction(async db=>{
   const campaign=(await db.query<{mode:string;chain_id:number;lifecycle:string;
    current_revision:number;strategy_id:string;profile:unknown;profile_hash:string;
    profile_evidence:unknown;config:unknown;config_hash:string;open_mark_id:string|null}>(`
    SELECT c.mode,c.chain_id,c.lifecycle,c.current_revision,o.id::text AS open_mark_id,r.strategy_id,p.profile,
     p.profile_hash,p.evidence AS profile_evidence,r.config,r.config_hash
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN LATERAL (SELECT (array_agg(id ORDER BY id))[1] AS id FROM deployment_marks
     WHERE campaign_id=c.id AND provenance->>'classification'='paper_model_provisional'
     HAVING count(*)=1) o ON TRUE
    WHERE c.id=$1 FOR UPDATE OF c`,[campaignId])).rows[0];
   if(!campaign||campaign.mode!=='paper'||campaign.strategy_id!=='static_manual_v1')
    throw new DeploymentConflict('paper_close_convert_v3_admission_unavailable');
   const existing=(await db.query<{id:string;request_digest:string;status:string;kind:string;
    preview_id:string}>(`SELECT id::text,request_digest,status,kind,preview_id::text
    FROM deployment_operations WHERE campaign_id=$1 AND idempotency_key=$2`,
    [campaignId,input.idempotencyKey])).rows[0];
   if(existing){
    if(existing.request_digest!==requestDigest||existing.preview_id!==input.previewId||
     existing.kind!=='close_convert')throw new DeploymentConflict('idempotency_conflict');
    return {id:existing.id,status:existing.status,replayed:true};
   }
   if(!['active','paused'].includes(campaign.lifecycle))
    throw new DeploymentConflict('paper_close_convert_v3_admission_unavailable');
   if(campaign.current_revision!==input.expectedRevision)
    throw new DeploymentConflict('stale_revision');
   const preview=(await db.query<{expected_revision:number;kind:string;content_digest:string;
    expires_at:Date;request:Record<string,unknown>;proposal:Record<string,unknown>;
    evidence:Record<string,unknown>}>(`SELECT expected_revision,kind,content_digest,expires_at,
    request,proposal,evidence FROM deployment_previews WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [input.previewId,campaignId])).rows[0];
   if(!preview)throw new DeploymentConflict('paper_close_convert_v3_preview_stale_or_changed');
   if(preview.kind!=='close_convert'||preview.expected_revision!==campaign.current_revision||
    preview.content_digest!==input.contentDigest||preview.expires_at.getTime()<=Date.now())
    throw new DeploymentConflict('paper_close_convert_v3_preview_stale_or_changed');
   let calculatedDigest:string;
   try{calculatedDigest=previewDigest({campaignId,expectedRevision:preview.expected_revision,
    kind:preview.kind,request:preview.request,proposal:preview.proposal,
    evidence:preview.evidence,expiresAt:preview.expires_at});}
   catch{throw new DeploymentConflict('paper_close_convert_v3_preview_stale_or_changed');}
   if(calculatedDigest!==preview.content_digest)
    throw new DeploymentConflict('paper_close_convert_v3_preview_stale_or_changed');
   let current:PaperStaticCloseConvertTerminalModel;
   try{current=parsePaperStaticCloseConvertTerminalV3(preview.proposal.paperCloseConvertTerminalV3);}
   catch{throw new DeploymentConflict('paper_close_convert_v3_preview_invalid');}
   if(contentHash(current)!==contentHash(model)||current.campaignId!==campaignId||
    current.revision!==campaign.current_revision||current.modelHash!==model.modelHash)
    throw new DeploymentConflict('paper_close_convert_v3_preview_changed');
   const profile=marketProfileSchema.safeParse(campaign.profile),
    profileEvidence=marketProfileEvidenceSchema.safeParse(campaign.profile_evidence),
    config=campaign.config&&typeof campaign.config==='object'&&!Array.isArray(campaign.config)?
     campaign.config as Record<string,unknown>:null;
   if(!profile.success||!profileEvidence.success||contentHash(profile.data)!==campaign.profile_hash||
    referenceProofHash(profileEvidence.data.referenceProof)!==profileEvidence.data.references.proofHash||
    !config||contentHash(config)!==campaign.config_hash||current.scope.profileHash!==campaign.profile_hash||
    current.prestateReport.openModel.campaignId!==campaignId||
    current.prestateReport.openModel.revision!==campaign.current_revision||
    current.prestateReport.openModel.profileHash!==campaign.profile_hash||
    current.prestateReport.openModel.configHash!==campaign.config_hash||
    current.openModelHash!==contentHash(current.prestateReport.openModel)||
    profileEvidence.data.streamKey!==current.feeReplay.stream||
    profileEvidence.data.indexerTargetSetHash!==current.feeReplay.targetSetHash)
    throw new DeploymentConflict('paper_close_convert_v3_profile_or_config_changed');
   for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash',
    'quoterCodeHash'] as const)
    if(profile.data.pool[key].toLowerCase()!==profileEvidence.data.contractHashes[key].toLowerCase())
     throw new DeploymentConflict('paper_close_convert_v3_profile_integrity');
   const openMark=(await db.query<{revision:number;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`SELECT revision,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [current.openMarkId,campaignId])).rows[0],
    openPreview=(await db.query<{proposal:Record<string,unknown>}>(`SELECT proposal
    FROM deployment_previews WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [openMark?.provenance.previewId,campaignId])).rows[0],
    open=paperOpenModelSchema.safeParse(openPreview?.proposal.paperOpenModel);
   if(!openMark||!open.success||campaign.open_mark_id!==current.openMarkId||
    openMark.revision!==campaign.current_revision||
    openMark.provenance.classification!=='paper_model_provisional'||
    openMark.source_block!==open.data.source.block||
    openMark.source_hash?.toLowerCase()!==open.data.source.hash.toLowerCase()||
    contentHash(open.data)!==current.openModelHash||
    contentHash(open.data)!==contentHash(current.prestateReport.openModel))
    throw new DeploymentConflict('paper_close_convert_v3_open_mark_changed');
   const request=preview.request,evidence=preview.evidence;
   if(Object.keys(request).length!==7||request.kind!=='close_convert'||
    request.strategyId!=='static_manual_v1'||request.profileHash!==campaign.profile_hash||
    request.openMarkId!==current.openMarkId||request.previousMarkId!==current.previousMarkId||
    request.modelHash!==current.modelHash||request.scopeHash!==paperCloseConvertGasScopeHashV2(current.scope)||
    evidence.verificationClass!=='canonical_static_paper_close_convert_terminal_v3'||
    evidence.classification!=='paper_model_provisional'||evidence.profileHash!==campaign.profile_hash||
    evidence.modelHash!==current.modelHash||evidence.prestateReportHash!==current.prestateReport.reportHash||
    evidence.feeEvidenceId!==current.feeReplay.previousFeeEvidenceId||
    evidence.feeCarryHash!==current.feeReplay.feeCarryHash||
    evidence.feeIntervalHash!==current.feeReplay.intervalHash||
    evidence.feeReplayHash!==current.feeReplay.replayHash||
    evidence.gasReportHash!==current.prestateReport.reportHash||
    evidence.gasScopeHash!==current.costs.scopeHash||
    evidence.gasSequenceHash!==current.costs.sequenceHash||
    evidence.costProfileIds===undefined||contentHash(evidence.costProfileIds)!==
     contentHash(current.costs.stages.map(stage=>stage.profileId))||
    evidence.paidCostsAvailable!==false||evidence.feeAccrualAvailable!==false)
    throw new DeploymentConflict('paper_close_convert_v3_preview_evidence_changed');
   const latest=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE campaign_id=$1 ORDER BY deployment_marks.id DESC LIMIT 1 FOR UPDATE`,
    [campaignId])).rows[0];
   if(!latest||latest.id!==current.previousMarkId||latest.source_block!==current.feeReplay.from.block||
    latest.source_hash?.toLowerCase()!==current.feeReplay.from.hash.toLowerCase()||
    !['paper_model_provisional','paper_model_principal_valuation'].includes(
     String(latest.provenance.classification)))
    throw new DeploymentConflict('paper_close_convert_v3_previous_mark_changed');
   const fee=(await db.query<{id:string;to_mark_id:string;proof_hash:string;carry_hash:string}>(`
    SELECT id::text,to_mark_id::text,proof_hash,carry_hash FROM deployment_paper_fee_evidence
    WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [current.feeReplay.previousFeeEvidenceId,campaignId])).rows[0];
   if(!fee||fee.to_mark_id!==latest.id||fee.proof_hash!==evidence.feeEvidenceHash||
    fee.carry_hash!==current.feeReplay.previousFeeCarryHash)
    throw new DeploymentConflict('paper_close_convert_v3_fee_predecessor_changed');
   const exactProfileIds=current.costs.stages.map(stage=>stage.profileId),
    rows=(await db.query<PaperCloseConvertPrestateGasProfileRow>(`
    SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
     allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
     evidence_class AS "evidenceClass",model,validation,source_hash AS "sourceHash",
     observed_until AS "observedUntil"
    FROM deployment_calibration_profiles WHERE chain_id=$1 AND lower(pool_address)=lower($2)
     AND path_version=$3 AND component='gas_units' AND size_band=$4
     AND validation->>'reportHash'=$5 AND id=ANY($6::uuid[])
     ORDER BY stage,version DESC`,[campaign.chain_id,profile.data.pool.pool,
     PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1,current.costs.sizeBand,
     current.prestateReport.reportHash,exactProfileIds])).rows;
   let selected;
   try{selected=selectPaperCloseConvertPrestateCostsV1({report:current.prestateReport,
    rows,
    gasPriceWei:BigInt(current.costs.gasPriceWei),gasPriceObservedAt:current.costs.gasPriceObservedAt});}
   catch{throw new DeploymentConflict('paper_close_convert_v3_gas_profiles_changed');}
   if(contentHash(selected)!==contentHash(current.costs))
    throw new DeploymentConflict('paper_close_convert_v3_gas_costs_changed');
   const priorAccountingRow=(await db.query<{snapshot:unknown;snapshot_hash:string;
    fee_evidence_id:string|null}>(`SELECT snapshot,snapshot_hash,fee_evidence_id::text
    FROM deployment_paper_accounting WHERE campaign_id=$1 AND source_mark_id=$2
     AND policy_version=$3 FOR SHARE`,[campaignId,latest.id,
      PAPER_CONVERSION_ACCOUNTING_POLICY_V2])).rows[0],
    priorAccounting=paperConversionAccountingV2Schema.safeParse(priorAccountingRow?.snapshot),
    activeRuntime=loadRuntimeIdentity();
   if(!priorAccountingRow||!priorAccounting.success||
    contentHash(priorAccounting.data)!==priorAccountingRow.snapshot_hash||
    priorAccounting.data.sourceMarkId!==latest.id||priorAccounting.data.markKind==='close_convert'||
    !activeRuntime||contentHash(priorAccounting.data.runtimeIdentity)!==contentHash(activeRuntime)||
    priorAccountingRow.fee_evidence_id!==fee.id)
    throw new DeploymentConflict('paper_close_convert_v3_prior_accounting_unavailable');
   try{assertPaperConversionV3GasWithinReserve({
    cumulativeGasWei:BigInt(priorAccounting.data.inventory.cumulativeGasWei),
    expectedGasWei:BigInt(current.costs.expectedWei),boundGasWei:BigInt(current.costs.boundWei),
    reservedNativeWei:BigInt(open.data.allocation.nativeWei)});}
   catch{throw new DeploymentConflict('paper_close_convert_v3_native_gas_reserve_exceeded');}
   const pending=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_operations
    WHERE campaign_id=$1 AND status IN ('queued','preflighting','executing','confirming',
     'reconciling','blocked')) AS found`,[campaignId])).rows[0]?.found;
   if(pending)throw new DeploymentConflict('operation_in_progress');
   const now=Date.now(),sourceAt=current.source.timestamp*1000,
    gasAt=Date.parse(current.costs.gasPriceObservedAt);
   if(sourceAt>now||now-sourceAt>180_000||gasAt>now||now-gasAt>120_000)
    throw new DeploymentConflict('paper_close_convert_v3_preview_expired');
   try{await verifyAnchors(campaign.chain_id,[current.prestateReport.openModel.source,
    current.prestateReport.previousSource,current.source]);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('paper_close_convert_v3_source_not_canonical');throw error;}
   const id=randomUUID();
   await db.query(`INSERT INTO deployment_operations
    (id,campaign_id,preview_id,actor,idempotency_key,request_digest,kind,status,stage)
    VALUES($1,$2,$3,$4,$5,$6,'close_convert','queued','accepted')`,
    [id,campaignId,input.previewId,actor,input.idempotencyKey,requestDigest]);
   await db.query('SELECT pg_notify($1,$2)',[PAPER_OPERATION_NOTIFY_CHANNEL,id]);
   await db.query(`UPDATE deployment_campaigns SET lifecycle='closing',updated_at=clock_timestamp()
    WHERE id=$1`,[campaignId]);
   return {id,status:'queued',replayed:false};
  });
 }

 async acceptStaticPaperRetainOperation(campaignId:string,raw:AcceptInput,actor:string,
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>){
  return this.acceptOperation(campaignId,raw,actor,{kind:'close_retain',verifyAnchors});
 }

 async acceptStaticPaperOpenOperation(campaignId:string,raw:AcceptInput,actor:string,
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>){
  return this.acceptOperation(campaignId,raw,actor,{kind:'open',verifyAnchors});
 }

 async acceptStaticPaperLifecycleOperation(campaignId:string,raw:AcceptInput,actor:string){
  return this.acceptOperation(campaignId,raw,actor,{kind:'lifecycle'});
 }

 async acceptOperation(campaignId:string,raw:AcceptInput,actor:string,
  staticPaperAdmission?:{kind:'open'|'close_retain';verifyAnchors:(chainId:number,
   sources:readonly PaperCanonicalAnchor[])=>Promise<void>}|{kind:'lifecycle'}){
  const input=acceptInput.parse(raw);
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(actor))throw new DeploymentConflict('invalid_actor');
  const requestDigest=contentHash({campaignId,previewId:input.previewId,
   contentDigest:input.contentDigest,expectedRevision:input.expectedRevision});
  return this.transaction(async db=>{
   const campaign=(await db.query<{mode:'paper'|'live';chain_id:number;wallet:string;allocation:unknown;current_revision:number;
    lifecycle:string;strategy_id:string;profile_hash:string;config_hash:string;profile:unknown;config:unknown}>(`SELECT c.mode,c.chain_id,c.wallet,c.allocation,c.current_revision,c.lifecycle,
     r.strategy_id,p.profile_hash,r.config_hash,p.profile,r.config
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   WHERE c.id=$1 FOR UPDATE OF c`,[campaignId])).rows[0];
   if(!campaign)throw new DeploymentConflict('campaign_not_found');
   const existing=(await db.query<{id:string;request_digest:string;status:string;kind:string;preview_id:string}>(
    'SELECT id,request_digest,status,kind,preview_id FROM deployment_operations WHERE campaign_id=$1 AND idempotency_key=$2',
    [campaignId,input.idempotencyKey])).rows[0];
   if(existing){
    if(existing.request_digest!==requestDigest)throw new DeploymentConflict('idempotency_conflict');
    if(staticPaperAdmission&&(
     (staticPaperAdmission.kind!=='lifecycle'&&existing.kind!==staticPaperAdmission.kind)||
     (staticPaperAdmission.kind==='lifecycle'&&!['pause','resume'].includes(existing.kind))||
     existing.preview_id!==input.previewId))throw new DeploymentConflict('idempotency_conflict');
    return {id:existing.id,status:existing.status,replayed:true};
   }
   if(campaign.current_revision!==input.expectedRevision)throw new DeploymentConflict('stale_revision');
   const preview=(await db.query<{kind:string;expected_revision:number;content_digest:string;expires_at:Date;
    request:Record<string,unknown>;proposal:Record<string,unknown>;evidence:Record<string,unknown>}>(
    `SELECT kind,expected_revision,content_digest,expires_at,request,proposal,evidence FROM deployment_previews
     WHERE id=$1 AND campaign_id=$2 FOR UPDATE`,[input.previewId,campaignId])).rows[0];
   if(!preview||preview.expected_revision!==campaign.current_revision||preview.content_digest!==input.contentDigest)
    throw new DeploymentConflict('stale_preview');
   if(preview.expires_at.getTime()<=Date.now())throw new DeploymentConflict('preview_expired');
   if(staticPaperAdmission?.kind==='lifecycle'){
    let canonicalDigest:string;
    try{canonicalDigest=previewDigest(previewInput.parse({campaignId,
     expectedRevision:preview.expected_revision,kind:preview.kind,request:preview.request,
     proposal:preview.proposal,evidence:preview.evidence,expiresAt:preview.expires_at}));}
    catch{throw new DeploymentConflict('paper_lifecycle_preview_integrity');}
    if(canonicalDigest!==preview.content_digest)
     throw new DeploymentConflict('paper_lifecycle_preview_integrity');
   }
   if(staticPaperAdmission?.kind==='open'){
    let canonicalDigest:string;
    try{canonicalDigest=previewDigest(previewInput.parse({campaignId,
     expectedRevision:preview.expected_revision,kind:preview.kind,request:preview.request,
     proposal:preview.proposal,evidence:preview.evidence,expiresAt:preview.expires_at}));}
    catch{throw new DeploymentConflict('paper_open_preview_integrity');}
    if(canonicalDigest!==preview.content_digest)
     throw new DeploymentConflict('paper_open_preview_integrity');
   }
   if(staticPaperAdmission?.kind==='open'){
    if(campaign.mode!=='paper'||campaign.strategy_id!=='static_manual_v1'||
     campaign.lifecycle!=='draft'||preview.kind!=='open')
     throw new DeploymentConflict('paper_open_admission_unavailable');
    if(!preview.proposal||typeof preview.proposal!=='object'||Array.isArray(preview.proposal))
     throw new DeploymentConflict('paper_open_admission_model_unavailable');
    const modelResult=paperOpenModelSchema.safeParse(preview.proposal.paperOpenModel),
     request=preview.request,evidence=preview.evidence;
    if(!modelResult.success||!request||typeof request!=='object'||Array.isArray(request)||
     !evidence||typeof evidence!=='object'||Array.isArray(evidence))
     throw new DeploymentConflict('paper_open_admission_model_unavailable');
    const model=modelResult.data,profile=marketProfileSchema.safeParse(campaign.profile),
     sourceEvidence=paperFeeMarkSourceSchema.safeParse(evidence.source);
    if(!profile.success||contentHash(profile.data)!==campaign.profile_hash||
     profile.data.pool.chainId!==campaign.chain_id||!campaign.config||
     typeof campaign.config!=='object'||Array.isArray(campaign.config)||
     contentHash(campaign.config)!==campaign.config_hash)
     throw new DeploymentConflict('paper_open_current_profile_or_config_invalid');
    const requestKeys=['kind','strategyId','profileHash','configHash','allocationHash','candidateHash'],
     evidenceKeys=['verificationClass','classification','source','profileHash','referenceProofHash',
      'costEvidenceClass','costProfileIds','paidCostsAvailable','feeAccrualAvailable'];
    if(Object.keys(preview.proposal).length!==1||Object.keys(request).length!==requestKeys.length||
     requestKeys.some(key=>!Object.hasOwn(request,key))||Object.keys(evidence).length!==evidenceKeys.length||
     evidenceKeys.some(key=>!Object.hasOwn(evidence,key))||
     model.campaignId!==campaignId||model.revision!==campaign.current_revision||
     model.profileHash!==campaign.profile_hash||model.configHash!==campaign.config_hash||
     model.strategyId!=='static_manual_v1'||referenceProofHash(model.referenceProof)!==model.referenceProofHash||
     request.kind!=='open'||request.strategyId!=='static_manual_v1'||
     request.profileHash!==campaign.profile_hash||request.configHash!==campaign.config_hash||
     request.candidateHash!==model.candidateHash||!sourceEvidence.success||
     contentHash(sourceEvidence.data)!==contentHash(model.source)||
     evidence.verificationClass!=='canonical_paper_open_preflight_v1'||
     evidence.classification!=='paper_model_provisional'||evidence.profileHash!==campaign.profile_hash||
     evidence.referenceProofHash!==model.referenceProofHash||evidence.costEvidenceClass!=='fork_estimated'||
     evidence.paidCostsAvailable!==false||evidence.feeAccrualAvailable!==false||
     !Array.isArray(evidence.costProfileIds)||contentHash(evidence.costProfileIds)!==
      contentHash(model.costs.stages.map(stage=>stage.profileId)))
     throw new DeploymentConflict('paper_open_admission_integrity');
    let allocation;
    try{allocation=allocationSchema.parse(campaign.allocation);}
    catch{throw new DeploymentConflict('paper_open_current_allocation_invalid');}
    if(contentHash(allocation)!==contentHash(model.allocation)||
     request.allocationHash!==contentHash(allocation))
     throw new DeploymentConflict('paper_open_current_allocation_changed');
    const config=campaign.config as Record<string,unknown>;
    if(config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||
     config.stateSchemaVersion!==1)
     throw new DeploymentConflict('paper_open_current_config_invalid');
    const {strategyId:_strategyId,strategyVersion:_strategyVersion,
     stateSchemaVersion:_stateSchemaVersion,...rawParameters}=config;
    let parameters;
    try{parameters=parseStrategyParameters('static_manual_v1',rawParameters);}
    catch{throw new DeploymentConflict('paper_open_current_config_invalid');}
    const acceptedAt=Date.now(),sourceAt=model.source.timestamp*1000,
     gasObservedAt=Date.parse(model.costs.gasPriceObservedAt);
    if(sourceAt>acceptedAt||acceptedAt-sourceAt>180_000||gasObservedAt>acceptedAt||
     acceptedAt-gasObservedAt>120_000)
     throw new DeploymentConflict('paper_open_source_stale');
    const frame={source:model.source,tick:model.poolState.tick,
     sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),poolLiquidity:BigInt(model.poolState.poolLiquidity),
     price0:BigInt(model.reference.price0),price1:BigInt(model.reference.price1),
     nativePrice:BigInt(model.reference.nativePrice),referenceEligible:true,referenceReasons:[],
     referenceProofHash:model.referenceProofHash,referenceProof:model.referenceProof};
    const draft={id:campaignId,revision:campaign.current_revision,allocation,profile:profile.data,
     profileHash:campaign.profile_hash,configHash:campaign.config_hash,strategyId:'static_manual_v1' as const,
     strategyVersion:'1.0.0' as const,stateSchemaVersion:1 as const,parameters};
    let indicative;
    try{indicative=buildIndicativePaperOpenPreview(draft,frame,acceptedAt);}
    catch{throw new DeploymentConflict('paper_open_candidate_replay_invalid');}
    if(indicative.status!=='indicative'||indicative.candidateHash!==model.candidateHash||
     contentHash(indicative.candidate)!==contentHash(model.candidate))
     throw new DeploymentConflict('paper_open_candidate_replay_changed');
    // Scoped to the replayed candidate's exact tick range: costIndicativePaperOpenPreview's
    // valid() rejects any other range regardless, so excluding it here only keeps the
    // 201-row bound reachable as unrelated ranges accumulate rows.
    const gasRows=(await db.query<PaperGasProfileRow>(`
     SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
      allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
      evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
      observed_until AS "observedUntil"
     FROM deployment_calibration_profiles WHERE chain_id=$1 AND lower(pool_address)=lower($2)
      AND path_version=$3 AND component='gas_units' AND allowance_state='zero'
      AND model->'tickLower'=to_jsonb($4::int) AND model->'tickUpper'=to_jsonb($5::int)
     ORDER BY size_band,stage,version DESC LIMIT 201`,
     [profile.data.pool.chainId,profile.data.pool.pool,PAPER_STATIC_GAS_PATH,
      indicative.candidate.range.tickLower,indicative.candidate.range.tickUpper])).rows;
    let costed;
    try{costed=costIndicativePaperOpenPreview(indicative,gasRows,profile.data.pool.pool,
     BigInt(model.reference.nativePrice),BigInt(model.costs.gasPriceWei),Date.parse(model.costs.gasPriceObservedAt));}
    catch{throw new DeploymentConflict('paper_open_cost_profiles_invalid');}
    if(costed.costs.status!=='provisional'||contentHash(costed.costs)!==contentHash(model.costs))
     throw new DeploymentConflict('paper_open_cost_evidence_changed');
    let rebuilt;
    try{rebuilt=buildPaperOpenModel(draft,frame,costed);}
    catch{throw new DeploymentConflict('paper_open_model_replay_invalid');}
    if(contentHash(rebuilt)!==contentHash(model))
     throw new DeploymentConflict('paper_open_model_replay_changed');
    const previous=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_marks
     WHERE campaign_id=$1) AS found`,[campaignId])).rows[0]?.found;
    if(previous)throw new DeploymentConflict('paper_open_previous_mark');
    try{await staticPaperAdmission.verifyAnchors(profile.data.pool.chainId,[model.source]);}
    catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('paper_open_source_not_canonical');throw error;}
   }
   if(staticPaperAdmission?.kind==='close_retain'){
    if(campaign.mode!=='paper'||campaign.strategy_id!=='static_manual_v1'||
     !['active','paused'].includes(campaign.lifecycle)||preview.kind!=='close_retain')
     throw new DeploymentConflict('paper_close_retain_admission_unavailable');
    const parsed=paperCloseRetainModelSchema.safeParse(preview.proposal.paperCloseRetainModel),
     request=preview.request,evidence=preview.evidence;
    if(!parsed.success||!request||typeof request!=='object'||Array.isArray(request)||
     !evidence||typeof evidence!=='object'||Array.isArray(evidence))
     throw new DeploymentConflict('paper_close_retain_admission_model_unavailable');
    const model=parsed.data,sourceEvidence=paperFeeMarkSourceSchema.safeParse(evidence.source);
    if(model.campaignId!==campaignId||model.revision!==campaign.current_revision||
     referenceProofHash(model.referenceProof)!==model.referenceProofHash||request.kind!=='close_retain'||
     request.strategyId!=='static_manual_v1'||request.profileHash!==campaign.profile_hash||
     request.openMarkId!==model.openMarkId||request.previousMarkId!==model.previousMarkId||
     request.modelHash!==contentHash(model)||evidence.verificationClass!==
      'canonical_paper_close_retain_preflight_v1'||evidence.classification!==
      'paper_model_provisional'||evidence.profileHash!==campaign.profile_hash||
     evidence.modelHash!==contentHash(model)||evidence.referenceProofHash!==model.referenceProofHash||
     evidence.openModelHash!==model.openModelHash||evidence.costEvidenceClass!=='fork_estimated'||
     evidence.paidCostsAvailable!==false||evidence.feeAccrualAvailable!==false||
     !Array.isArray(evidence.costProfileIds)||contentHash(evidence.costProfileIds)!==
      contentHash(model.costs.stages.map(stage=>stage.profileId))||!sourceEvidence.success||
     contentHash(sourceEvidence.data)!==contentHash(model.source))
     throw new DeploymentConflict('paper_close_retain_admission_integrity');
    const openMark=(await db.query<{revision:number;source_block:string|null;source_hash:string|null;
     provenance:Record<string,unknown>}>(`SELECT revision,source_block::text,source_hash,provenance
     FROM deployment_marks WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
     [model.openMarkId,campaignId])).rows[0];
    if(!openMark||openMark.revision!==campaign.current_revision||
     openMark.provenance.classification!=='paper_model_provisional'||
     typeof openMark.provenance.previewId!=='string'||openMark.source_block===null||
     openMark.source_hash===null)
     throw new DeploymentConflict('paper_close_retain_open_mark_changed');
    const openPreview=(await db.query<{proposal:Record<string,unknown>}>(
     'SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2 FOR SHARE',
     [openMark.provenance.previewId,campaignId])).rows[0];
    const open=paperOpenModelSchema.safeParse(openPreview?.proposal.paperOpenModel);
    if(!open.success||open.data.campaignId!==campaignId||
     open.data.revision!==campaign.current_revision||open.data.profileHash!==campaign.profile_hash||
     open.data.configHash!==campaign.config_hash||
     contentHash(open.data)!==openMark.provenance.modelHash||
     contentHash(open.data)!==model.openModelHash||
     open.data.source.block!==openMark.source_block||
     open.data.source.hash.toLowerCase()!==openMark.source_hash.toLowerCase())
     throw new DeploymentConflict('paper_close_retain_open_model_changed');
    const latest=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
     provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
     FROM deployment_marks WHERE campaign_id=$1 ORDER BY deployment_marks.id DESC LIMIT 1`,[campaignId])).rows[0];
    const priorSource=paperFeeMarkSourceSchema.safeParse(latest?.provenance.source);
    if(!latest||latest.id!==model.previousMarkId||latest.source_block===null||
     latest.source_hash===null||!priorSource.success||
     priorSource.data.block!==latest.source_block||
     priorSource.data.hash.toLowerCase()!==latest.source_hash.toLowerCase()||
     model.previousSource.block!==latest.source_block||
     model.previousSource.hash.toLowerCase()!==latest.source_hash.toLowerCase()||
     BigInt(model.source.block)<=BigInt(latest.source_block))
     throw new DeploymentConflict('paper_close_retain_previous_mark_changed');
    const profile=marketProfileSchema.safeParse(campaign.profile);
    if(!profile.success||contentHash(profile.data)!==campaign.profile_hash||!campaign.config||
     typeof campaign.config!=='object'||Array.isArray(campaign.config)||
     contentHash(campaign.config)!==campaign.config_hash)
     throw new DeploymentConflict('paper_close_retain_current_profile_or_config_invalid');
    const config=campaign.config as Record<string,unknown>;
    if(config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||
     config.stateSchemaVersion!==1)throw new DeploymentConflict('paper_close_retain_current_config_invalid');
    const {strategyId:_strategyId,strategyVersion:_strategyVersion,
     stateSchemaVersion:_stateSchemaVersion,...rawParameters}=config;
    const parameters=parseStrategyParameters('static_manual_v1',rawParameters);
    // Scoped to the open model's exact tick range: costIndicativePaperOpenPreview's
    // valid() rejects any other range regardless, so excluding it here only keeps the
    // 201-row bound reachable as unrelated ranges accumulate rows.
    const gasRows=(await db.query<PaperGasProfileRow>(`
     SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
      allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
      evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
      observed_until AS "observedUntil"
     FROM deployment_calibration_profiles
     WHERE chain_id=4663 AND lower(pool_address)=lower($1) AND path_version=$2
      AND component='gas_units' AND allowance_state='zero'
      AND model->'tickLower'=to_jsonb($3::int) AND model->'tickUpper'=to_jsonb($4::int)
     ORDER BY size_band,stage,version DESC LIMIT 201`,
     [profile.data.pool.pool,PAPER_STATIC_GAS_PATH,
      open.data.candidate.range.tickLower,open.data.candidate.range.tickUpper])).rows;
    let replayedCosts;
    try{replayedCosts=costIndicativePaperOpenPreview({status:'indicative',candidate:open.data.candidate},
     gasRows,profile.data.pool.pool,BigInt(model.reference.nativePrice),
     BigInt(model.costs.gasPriceWei),Date.parse(model.costs.gasPriceObservedAt));}
    catch{throw new DeploymentConflict('paper_close_retain_cost_profiles_invalid');}
    if(replayedCosts.costs.status!=='provisional'||
     contentHash(replayedCosts.costs)!==contentHash(model.costs))
     throw new DeploymentConflict('paper_close_retain_cost_evidence_changed');
    const frame={source:model.source,tick:model.poolState.tick,
     sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),
     poolLiquidity:BigInt(model.poolState.poolLiquidity),
     price0:BigInt(model.reference.price0),price1:BigInt(model.reference.price1),
     nativePrice:BigInt(model.reference.nativePrice),referenceEligible:true,
     referenceReasons:[],referenceProofHash:model.referenceProofHash,
     referenceProof:model.referenceProof};
    let rebuilt;
    try{rebuilt=buildPaperCloseRetainModel(open.data,model.openMarkId,
     {markId:latest.id,sourceBlock:latest.source_block,sourceHash:latest.source_hash},
     frame,profile.data,parameters,replayedCosts,model.source.timestamp*1000);}
    catch{throw new DeploymentConflict('paper_close_retain_model_replay_invalid');}
    if(contentHash(rebuilt)!==contentHash(model))
     throw new DeploymentConflict('paper_close_retain_model_replay_changed');
    const now=Date.now(),sourceAt=model.source.timestamp*1000,
     gasObservedAt=Date.parse(model.costs.gasPriceObservedAt);
    if(sourceAt>now||now-sourceAt>180_000||gasObservedAt>now||now-gasObservedAt>120_000)
     throw new DeploymentConflict('paper_close_retain_source_stale');
    try{await staticPaperAdmission.verifyAnchors(campaign.chain_id,
     [open.data.source,priorSource.data,model.source]);}
    catch(error){if(error instanceof AssertionError)
      throw new DeploymentConflict('paper_close_retain_source_not_canonical');throw error;}
   }
   if(preview.kind==='pause'||preview.kind==='resume'){
    const expectedLifecycle=preview.kind==='pause'?'active':'paused',targetLifecycle=preview.kind==='pause'?'paused':'active';
    const lifecycle=preview.proposal?.paperLifecycle;
    if(campaign.mode!=='paper'||campaign.strategy_id!=='static_manual_v1')
     throw new DeploymentConflict('paper_lifecycle_operation_unavailable');
    if(campaign.lifecycle!==expectedLifecycle)throw new DeploymentConflict('invalid_lifecycle');
    if(!preview.request||typeof preview.request!=='object'||Array.isArray(preview.request)||
     Object.keys(preview.request).length!==1||preview.request.kind!==preview.kind||
     !preview.proposal||typeof preview.proposal!=='object'||Array.isArray(preview.proposal)||
     Object.keys(preview.proposal).length!==1||!lifecycle||typeof lifecycle!=='object'||
     Array.isArray(lifecycle)||Object.keys(lifecycle).length!==2||
     (lifecycle as Record<string,unknown>).from!==expectedLifecycle||
     (lifecycle as Record<string,unknown>).to!==targetLifecycle||
     !preview.evidence||typeof preview.evidence!=='object'||Array.isArray(preview.evidence)||
     Object.keys(preview.evidence).length!==0)
     throw new DeploymentConflict('paper_lifecycle_preview_invalid');
   }
   if(staticPaperAdmission?.kind==='lifecycle'&&preview.kind!=='pause'&&preview.kind!=='resume')
    throw new DeploymentConflict('paper_lifecycle_operation_unavailable');
   const pending=(await db.query<{id:string}>(`SELECT id FROM deployment_operations WHERE campaign_id=$1 AND status IN
    ('queued','preflighting','executing','confirming','reconciling','blocked') LIMIT 1`,[campaignId])).rows[0];
   if(pending)throw new DeploymentConflict('operation_in_progress');
   if(preview.kind==='open'&&campaign.lifecycle!=='draft')throw new DeploymentConflict('invalid_lifecycle');
   if(!['open','pause','resume'].includes(preview.kind)&&campaign.lifecycle==='draft')
    throw new DeploymentConflict('invalid_lifecycle');
   if(campaign.lifecycle==='closed')throw new DeploymentConflict('campaign_closed');
   if(campaign.mode==='live'&&preview.kind==='open')await this.reserveLiveWallet(db,campaignId,campaign.chain_id,campaign.wallet);
   const id=randomUUID();
   await db.query(`INSERT INTO deployment_operations
    (id,campaign_id,preview_id,actor,idempotency_key,request_digest,kind,status,stage)
    VALUES($1,$2,$3,$4,$5,$6,$7,'queued','accepted')`,
    [id,campaignId,input.previewId,actor,input.idempotencyKey,requestDigest,preview.kind]);
   await db.query('SELECT pg_notify($1,$2)',[PAPER_OPERATION_NOTIFY_CHANNEL,id]);
   await db.query(`UPDATE deployment_campaigns SET lifecycle=$2,updated_at=clock_timestamp() WHERE id=$1`,
    [campaignId,preview.kind==='open'?'opening':preview.kind.startsWith('close_')?'closing':campaign.lifecycle]);
   return {id,status:'queued',replayed:false};
  });
 }

 /** Claims only a persisted operation. A recovered claim retains its stage so
  * the worker can reconcile the linked signed intent before any new action. */
 async claimNext(workerId:string,leaseSeconds:number,mode:'paper'|'live',
  strategyFilter?:z.infer<typeof strategyId>){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>300)throw new DeploymentConflict('invalid_lease');
  if(mode!=='paper'&&mode!=='live')throw new DeploymentConflict('invalid_worker_mode');
  if(strategyFilter!==undefined&&!strategyId.safeParse(strategyFilter).success)
   throw new DeploymentConflict('invalid_worker_strategy_filter');
  return this.transaction(async db=>{
   const result=await db.query<{id:string;campaign_id:string;status:string;stage:string;attempts:number}>(`
    WITH candidate AS (
      SELECT o.id FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
      JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
      WHERE c.mode=$3 AND o.status IN ('queued','preflighting','executing','confirming','reconciling')
        AND ($4::text IS NULL OR r.strategy_id=$4)
        AND (o.claim_until IS NULL OR o.claim_until<clock_timestamp())
        AND (o.claimed_by IS NOT NULL OR o.reason IS DISTINCT FROM 'paper_operation_transient_error'
          OR o.updated_at<=clock_timestamp()-($5::integer*interval '1 second'))
      ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1
    )
    UPDATE deployment_operations o SET
      claimed_by=$1,claim_until=clock_timestamp()+($2::integer*interval '1 second'),
      attempts=o.attempts+1,status=CASE WHEN o.status='queued' THEN 'preflighting' ELSE o.status END,
      updated_at=clock_timestamp()
    FROM candidate WHERE o.id=candidate.id
    RETURNING o.id,o.campaign_id,o.status,o.stage,o.attempts`,
   [workerId,leaseSeconds,mode,strategyFilter??null,PAPER_OPERATION_TRANSIENT_RETRY_BACKOFF_SECONDS]);
   return result.rows[0]??null;
  });
 }

 async operation(id:string){
  const result=await this.readPool.query<{id:string;campaign_id:string;kind:string;status:string;stage:string;
   reason:string|null;attempts:number;created_at:Date;updated_at:Date}>(
   `SELECT id,campaign_id,kind,status,stage,reason,attempts,created_at,updated_at
    FROM deployment_operations WHERE id=$1`,[id]);
  return result.rows[0]??null;
 }

 /** Read-only idempotency reconciliation before a command route checks worker
  * readiness. A later lease failure must not hide an already accepted action. */
 async acceptedOperationReplay(campaignId:string,raw:AcceptInput,
  allowedKinds:readonly ('open'|'pause'|'resume'|'close_retain'|'close_convert'|'change_range')[]){
  const id=z.uuid().parse(campaignId),input=acceptInput.parse(raw);
  const digest=contentHash({campaignId:id,previewId:input.previewId,
   contentDigest:input.contentDigest,expectedRevision:input.expectedRevision});
  const row=(await this.readPool.query<{id:string;status:string;kind:string;
   preview_id:string;request_digest:string}>(`SELECT id::text,status,kind,
    preview_id::text,request_digest FROM deployment_operations
    WHERE campaign_id=$1 AND idempotency_key=$2`,[id,input.idempotencyKey])).rows[0];
  if(!row)return null;
  if(row.request_digest!==digest||row.preview_id!==input.previewId||
   !allowedKinds.includes(row.kind as 'open'|'pause'|'resume'|'close_retain'|'close_convert'|'change_range'))
   throw new DeploymentConflict('idempotency_conflict');
  return {id:row.id,status:row.status,replayed:true as const};
 }

 async advanceClaim(id:string,workerId:string,stage:string,
  status:'preflighting'|'executing'|'confirming'|'reconciling'|'blocked',
  reason:string|null){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId)||!/^[a-z][a-z0-9_]{0,63}$/.test(stage))
   throw new DeploymentConflict('invalid_claim_transition');
  const prior:{[key:string]:string[]}={
   preflighting:['preflighting'],executing:['preflighting','executing'],
   confirming:['executing','confirming'],reconciling:['executing','confirming','reconciling'],
   blocked:['preflighting','executing','confirming','reconciling'],
  };
  const allowed=prior[status];
  if(!allowed)throw new DeploymentConflict('invalid_claim_transition');
  const result=await this.pool.query(`UPDATE deployment_operations SET status=$3,stage=$4,reason=$5,
   claimed_by=CASE WHEN $3='blocked' THEN NULL ELSE claimed_by END,
   claim_until=CASE WHEN $3='blocked' THEN NULL ELSE claim_until END,
   updated_at=clock_timestamp()
   WHERE id=$1 AND claimed_by=$2 AND claim_until>=clock_timestamp() AND
     status=ANY($6::text[]) RETURNING id`,
   [id,workerId,status,stage,reason,allowed]);
  if(result.rowCount!==1)throw new DeploymentConflict('claim_lost_or_transition_disallowed');
 }

 async renewClaim(id:string,workerId:string,leaseSeconds:number){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId)||!Number.isSafeInteger(leaseSeconds)||
   leaseSeconds<5||leaseSeconds>300)throw new DeploymentConflict('invalid_lease');
  const result=await this.pool.query(`UPDATE deployment_operations SET
   claim_until=clock_timestamp()+($3::integer*interval '1 second'),updated_at=clock_timestamp()
   WHERE id=$1 AND claimed_by=$2 AND claim_until>=clock_timestamp() AND
    status IN ('preflighting','executing','confirming','reconciling') RETURNING id`,
   [id,workerId,leaseSeconds]);
  if(result.rowCount!==1)throw new DeploymentConflict('claim_lost');
 }

 /** Release only the current, unexpired owner claim after a transient failure.
  * The persisted stage remains intact for another worker to resume safely. */
 async releaseClaim(id:string,workerId:string){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  const result=await this.pool.query(`UPDATE deployment_operations SET
   claimed_by=NULL,claim_until=NULL,reason='paper_operation_transient_error',
   updated_at=clock_timestamp()
   WHERE id=$1 AND claimed_by=$2 AND claim_until>=clock_timestamp() AND
    status IN ('preflighting','executing','confirming','reconciling') RETURNING id`,
   [id,workerId]);
  if(result.rowCount!==1)throw new DeploymentConflict('claim_lost');
 }

 /** Completes a paper pause/resume without writing an economic mark. The
  * journal preview binds the direction and revision; lifecycle and operation
  * completion commit atomically under the live worker claim. */
 async completeTrustedPaperLifecycleOperation(operationId:string,workerId:string){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  return this.transaction(async db=>{
   const row=(await db.query<{id:string;campaign_id:string;kind:string;status:string;stage:string;
    claimed_by:string|null;claim_valid:boolean|null;mode:string;lifecycle:string;current_revision:number;
    strategy_id:string;expected_revision:number;preview_kind:string;request:Record<string,unknown>;
    proposal:Record<string,unknown>;evidence:Record<string,unknown>}>(`
    SELECT o.id,o.campaign_id,o.kind,o.status,o.stage,o.claimed_by,
     (o.claim_until>=clock_timestamp()) AS claim_valid,c.mode,c.lifecycle,c.current_revision,
     r.strategy_id,v.expected_revision,v.kind AS preview_kind,v.request,v.proposal,v.evidence
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_previews v ON v.id=o.preview_id
    WHERE o.id=$1 FOR UPDATE OF o,c`,[operationId])).rows[0];
   if(!row||row.claimed_by!==workerId||!row.claim_valid||
    !['preflighting','executing','confirming','reconciling'].includes(row.status))
    throw new DeploymentConflict('paper_lifecycle_claim_lost');
   if(row.mode!=='paper'||row.strategy_id!=='static_manual_v1'||
    !['pause','resume'].includes(row.kind)||row.preview_kind!==row.kind||
    row.expected_revision!==row.current_revision)
    throw new DeploymentConflict('paper_lifecycle_operation_unavailable');
   const from=row.kind==='pause'?'active':'paused',to=row.kind==='pause'?'paused':'active',
    lifecycle=row.proposal?.paperLifecycle;
   if(row.lifecycle!==from||row.request?.kind!==row.kind||!lifecycle||
    typeof lifecycle!=='object'||Array.isArray(lifecycle)||Object.keys(lifecycle).length!==2||
    (lifecycle as Record<string,unknown>).from!==from||
    (lifecycle as Record<string,unknown>).to!==to||!row.evidence||
    typeof row.evidence!=='object'||Array.isArray(row.evidence)||Object.keys(row.evidence).length!==0)
    throw new DeploymentConflict('paper_lifecycle_state_changed');
   await db.query(`UPDATE deployment_campaigns SET lifecycle=$2,updated_at=clock_timestamp() WHERE id=$1`,
    [row.campaign_id,to]);
   await db.query(`UPDATE deployment_operations SET status='succeeded',stage=$2,reason=NULL,
    claimed_by=NULL,claim_until=NULL,updated_at=clock_timestamp() WHERE id=$1`,
    [operationId,row.kind==='pause'?'paper_paused':'paper_resumed']);
   return {id:operationId,status:'succeeded',lifecycle:to};
  });
 }

 /** Commits one modeled paper open under the operation claim. It writes no
  * transaction intent, paid gas, or net economics. Retrying a committed open
  * returns its existing mark without appending capital twice. */
 async completeTrustedPaperOpen(operationId:string,workerId:string,
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  return this.transaction(async db=>{
   const row=(await db.query<{id:string;campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_until:Date|null;claim_valid:boolean|null;
    mode:string;lifecycle:string;current_revision:number;
    allocation:unknown;profile:unknown;profile_hash:string;config:unknown;config_hash:string;
    strategy_id:string;strategy_version:string;state_schema_version:number;
    proposal:Record<string,unknown>;request:Record<string,unknown>;evidence:Record<string,unknown>;
    content_digest:string;expected_revision:number;preview_created_at:Date;accepted_at:Date;
    expires_at:Date}>(`
    SELECT o.id,o.campaign_id,o.preview_id,o.kind,o.status,o.claimed_by,o.claim_until,
     (o.claim_until>=clock_timestamp()) AS claim_valid,
     c.mode,c.lifecycle,c.current_revision,c.allocation,p.profile,p.profile_hash,
     r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version,
     v.proposal,v.request,v.evidence,v.content_digest,v.expected_revision,v.created_at AS preview_created_at,
     o.created_at AS accepted_at,v.expires_at
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_previews v ON v.id=o.preview_id
    WHERE o.id=$1 FOR UPDATE OF o,c`,[operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='open')throw new DeploymentConflict('paper_open_operation_unavailable');
   if(row.status==='succeeded'){
    const existing=(await db.query<{id:string}>(`SELECT id::text FROM deployment_marks
     WHERE campaign_id=$1 AND provenance->>'operationId'=$2 LIMIT 2`,
     [row.campaign_id,operationId])).rows;
    if(existing.length!==1)throw new DeploymentConflict('paper_open_replay_integrity');
    return {markId:existing[0]!.id,replayed:true};
   }
   if(row.lifecycle!=='opening'||row.status!=='reconciling'||row.claimed_by!==workerId||
    !row.claim_valid)throw new DeploymentConflict('paper_open_claim_lost');
   if(row.current_revision!==row.expected_revision||row.accepted_at.getTime()>row.expires_at.getTime()||
    row.accepted_at.getTime()<row.preview_created_at.getTime())
    throw new DeploymentConflict('paper_open_preview_stale');
   if(previewDigest({campaignId:row.campaign_id,expectedRevision:row.expected_revision,kind:'open',
    request:row.request,proposal:row.proposal,evidence:row.evidence,expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('paper_open_preview_integrity');
   const parsed=paperOpenModelSchema.safeParse(row.proposal.paperOpenModel);
   if(!parsed.success)throw new DeploymentConflict('paper_open_model_unavailable');
   const model=parsed.data,profile=marketProfileSchema.safeParse(row.profile);
   if(!profile.success||model.campaignId!==row.campaign_id||model.revision!==row.current_revision||
    model.profileHash!==row.profile_hash||contentHash(row.profile)!==row.profile_hash||
    !row.config||typeof row.config!=='object'||contentHash(row.config)!==row.config_hash||
    model.configHash!==row.config_hash||row.strategy_id!=='static_manual_v1'||
    row.strategy_version!=='1.0.0'||row.state_schema_version!==1||
    model.strategyId!==row.strategy_id||referenceProofHash(model.referenceProof)!==model.referenceProofHash)
    throw new DeploymentConflict('paper_open_model_integrity');
   const config=row.config as Record<string,unknown>;
   const {strategyId:_id,strategyVersion:_version,stateSchemaVersion:_schema,...parameters}=config;
   if(_id!==row.strategy_id||_version!==row.strategy_version||_schema!==row.state_schema_version)
    throw new DeploymentConflict('paper_open_config_integrity');
   const allocation=allocationSchema.parse(row.allocation);
   const draft={id:row.campaign_id,revision:row.current_revision,allocation,profile:profile.data,
    profileHash:row.profile_hash,configHash:row.config_hash,strategyId:'static_manual_v1' as const,
    strategyVersion:row.strategy_version,stateSchemaVersion:row.state_schema_version,
    parameters:parseStrategyParameters('static_manual_v1',parameters)};
   const acceptedAt=row.accepted_at.getTime(),sourceAt=model.source.timestamp*1000,
    gasObservedAt=Date.parse(model.costs.gasPriceObservedAt);
   if(sourceAt>acceptedAt||acceptedAt-sourceAt>180_000||gasObservedAt>acceptedAt||
    acceptedAt-gasObservedAt>120_000)
    throw new DeploymentConflict('paper_open_source_stale');
   const frame={source:model.source,tick:model.poolState.tick,
    sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),
    poolLiquidity:BigInt(model.poolState.poolLiquidity),
    price0:BigInt(model.reference.price0),price1:BigInt(model.reference.price1),
    nativePrice:BigInt(model.reference.nativePrice),referenceEligible:true,referenceReasons:[],
    referenceProofHash:model.referenceProofHash,referenceProof:model.referenceProof};
   const indicative=buildIndicativePaperOpenPreview(draft,frame,acceptedAt);
   if(indicative.status!=='indicative'||indicative.candidateHash!==model.candidateHash||
    contentHash(indicative.candidate)!==contentHash(model.candidate)||
    contentHash(allocation)!==contentHash(model.allocation))
    throw new DeploymentConflict('paper_open_candidate_mismatch');
   // Scoped to the accepted model's exact tick range: costIndicativePaperOpenPreview's
   // valid() rejects any other range regardless, so excluding it here only keeps the
   // 201-row bound reachable as unrelated ranges accumulate rows.
   const gasRows=(await db.query<PaperGasProfileRow>(`
    SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
     allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
     evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
     observed_until AS "observedUntil" FROM deployment_calibration_profiles
    WHERE chain_id=4663 AND lower(pool_address)=lower($1) AND path_version=$2
     AND component='gas_units' AND allowance_state='zero'
     AND model->'tickLower'=to_jsonb($3::int) AND model->'tickUpper'=to_jsonb($4::int)
    ORDER BY size_band,stage,version DESC LIMIT 201`,
    [profile.data.pool.pool,PAPER_STATIC_GAS_PATH,
     model.candidate.range.tickLower,model.candidate.range.tickUpper])).rows;
   const costed=costIndicativePaperOpenPreview(indicative,gasRows,profile.data.pool.pool,
    frame.nativePrice,BigInt(model.costs.gasPriceWei),Date.parse(model.costs.gasPriceObservedAt));
   if(costed.costs.status!=='provisional'||contentHash(costed.costs)!==contentHash(model.costs))
    throw new DeploymentConflict('paper_open_cost_profile_changed');
   let replayed;
   try{replayed=buildPaperOpenModel(draft,frame,costed);}
   catch{throw new DeploymentConflict('paper_open_limits_or_model_changed');}
   if(contentHash(replayed)!==contentHash(model))throw new DeploymentConflict('paper_open_model_changed');
   const previous=(await db.query<{n:number}>(`SELECT count(*)::int AS n FROM deployment_marks
    WHERE campaign_id=$1`,[row.campaign_id])).rows[0]?.n;
   if(previous!==0)throw new DeploymentConflict('paper_open_previous_mark');
   try{await verifyAnchors(profile.data.pool.chainId,[model.source]);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('paper_open_source_not_canonical');throw error;}
   const p=profile.data.pool;
   const value=(amount:string,price:string,decimals:number)=>
    String(BigInt(amount)*BigInt(price)/10n**BigInt(decimals));
   const source={classification:'paper_model_provisional',previewId:row.preview_id,
    modelHash:contentHash(model),referenceProofHash:model.referenceProofHash,
    source:model.source,poolState:model.poolState,reference:model.reference};
   for(const [asset,token,amount,price,decimals] of [
    ['token0',p.token0,allocation.token0Raw,model.reference.price0,p.decimals0],
    ['token1',p.token1,allocation.token1Raw,model.reference.price1,p.decimals1],
    ['native',null,allocation.nativeWei,model.reference.nativePrice,18],
   ] as const){
    await db.query(`INSERT INTO deployment_ledger
     (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
     VALUES($1,$2,$3,'capital_in',$4,$5,$6,$7)`,
     [row.campaign_id,operationId,`paper_open:${operationId}:${asset}`,token,amount,
      value(amount,price,decimals),JSON.stringify({...source,asset})]);
   }
   const inventory={classification:'paper_model_provisional',token0Raw:allocation.token0Raw,
    token1Raw:allocation.token1Raw,nativeWei:allocation.nativeWei,
    position:{liquidity:model.candidate.liquidity,tickLower:model.candidate.range.tickLower,
     tickUpper:model.candidate.range.tickUpper,amount0Minted:model.candidate.amount0Minted,
     amount1Minted:model.candidate.amount1Minted},
    idle0:String(BigInt(allocation.token0Raw)-BigInt(model.candidate.amount0Minted)),
    idle1:String(BigInt(allocation.token1Raw)-BigInt(model.candidate.amount1Minted))};
   const provenance={...source,operationId,candidateHash:model.candidateHash,
    modeledCosts:model.costs,paidCostsAvailable:false};
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,NULL,$6,$7) RETURNING id::text`,
    [row.campaign_id,row.current_revision,model.source.block,model.source.hash,
     JSON.stringify(inventory),model.costs.stages.map(stage=>stage.profileId),
     JSON.stringify(provenance)])).rows[0]!;
   await db.query(`UPDATE deployment_campaigns SET lifecycle='active',
    range_state=$2,updated_at=clock_timestamp() WHERE id=$1`,
    [row.campaign_id,model.candidate.feeEarningAtEntry?'inside':'outside']);
   await db.query(`UPDATE deployment_operations SET status='succeeded',stage='paper_open_recorded',
    claimed_by=NULL,claim_until=NULL,updated_at=clock_timestamp() WHERE id=$1`,[operationId]);
   return {markId:mark.id,replayed:false};
  });
 }

 /** Append one later principal-only observation under the campaign lock.
  * The caller supplies a confirmed canonical frame and independent proof;
  * stored open math is replayed before this mark becomes visible. */
 async recordTrustedPaperPrincipalValuation(raw:unknown){
  const model=paperPrincipalValuationSchema.parse(raw),modelHash=contentHash(model);
  return this.transaction(async db=>{
   await this.assertPaperPreparationMutationAllowed(db,model.campaignId);
   const row=(await db.query<{mode:string;lifecycle:string;current_revision:number;
    profile:unknown;profile_hash:string;config_hash:string}>(`
    SELECT c.mode,c.lifecycle,c.current_revision,p.profile,p.profile_hash,r.config_hash
    FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    WHERE c.id=$1 FOR UPDATE OF c`,[model.campaignId])).rows[0];
   if(!row||row.mode!=='paper'||row.current_revision!==model.revision)
    throw new DeploymentConflict('paper_valuation_campaign_unavailable');
   const sameBlock=(await db.query<{id:string;source_hash:string;provenance:Record<string,unknown>}>(`
    SELECT id::text,source_hash,provenance FROM deployment_marks
    WHERE campaign_id=$1 AND source_block=$2 AND
     provenance->>'classification'='paper_model_principal_valuation' LIMIT 2`,
    [model.campaignId,model.source.block])).rows;
   if(sameBlock.length>1)throw new DeploymentConflict('paper_valuation_duplicate_source');
   if(sameBlock.length===1){
    const existing=sameBlock[0]!;
    if(existing.source_hash.toLowerCase()===model.source.hash.toLowerCase()&&
     existing.provenance.modelHash===modelHash)return {markId:existing.id,replayed:true};
    throw new DeploymentConflict('paper_valuation_conflicting_source');
   }
   const profile=marketProfileSchema.safeParse(row.profile);
   if(!profile.success||contentHash(row.profile)!==row.profile_hash)
    throw new DeploymentConflict('paper_valuation_profile_integrity');
   const openMark=(await db.query<{id:string;revision:number;provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,provenance FROM deployment_marks
    WHERE id=$1 AND campaign_id=$2`,[model.openMarkId,model.campaignId])).rows[0];
   if(!openMark||openMark.revision!==model.revision||
    openMark.provenance.classification!=='paper_model_provisional'||
    !openMark.provenance.previewId)throw new DeploymentConflict('paper_valuation_open_mark_unavailable');
   const preview=(await db.query<{proposal:Record<string,unknown>}>(`
    SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
    [openMark.provenance.previewId,model.campaignId])).rows[0];
   const parsed=paperOpenModelSchema.safeParse(preview?.proposal.paperOpenModel);
   if(!parsed.success||parsed.data.campaignId!==model.campaignId||
    parsed.data.profileHash!==row.profile_hash||parsed.data.configHash!==row.config_hash||
    contentHash(parsed.data)!==openMark.provenance.modelHash||
    contentHash(parsed.data)!==model.openModelHash)
    throw new DeploymentConflict('paper_valuation_open_model_integrity');
   const previous=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE campaign_id=$1 ORDER BY deployment_marks.id DESC LIMIT 1`,[model.campaignId])).rows[0];
   if(!previous||previous.source_block===null||previous.source_hash===null)
    throw new DeploymentConflict('paper_valuation_prior_mark_unavailable');
   if(BigInt(model.source.block)===BigInt(previous.source_block))
    throw new DeploymentConflict('paper_valuation_conflicting_source');
   if(!['active','paused'].includes(row.lifecycle))
    throw new DeploymentConflict('paper_valuation_campaign_unavailable');
   const priorTimestamp=(previous.provenance.source as {timestamp?:unknown}|undefined)?.timestamp;
   if(!Number.isSafeInteger(priorTimestamp)||model.source.timestamp<(priorTimestamp as number))
    throw new DeploymentConflict('paper_valuation_source_time_regressed');
   if(previous.id!==model.previousMarkId||
    !['paper_model_provisional','paper_model_principal_valuation'].includes(
     String(previous.provenance.classification)))
    throw new DeploymentConflict('paper_valuation_prior_mark_changed');
   const now=Date.now();
   const frame={source:model.source,tick:model.poolState.tick,
    sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),
    poolLiquidity:BigInt(model.poolState.poolLiquidity),
    price0:BigInt(model.reference.price0),price1:BigInt(model.reference.price1),
    nativePrice:BigInt(model.reference.nativePrice),referenceEligible:true,referenceReasons:[],
    referenceProofHash:model.referenceProofHash,referenceProof:model.referenceProof};
   let replayed;
   try{replayed=buildPaperPrincipalValuation(parsed.data,openMark.id,
    {markId:previous.id,sourceBlock:previous.source_block,sourceHash:previous.source_hash},
    frame,profile.data,now);}
   catch{throw new DeploymentConflict('paper_valuation_model_rejected');}
   if(contentHash(replayed)!==modelHash)throw new DeploymentConflict('paper_valuation_model_changed');
   const inventory={classification:'paper_model_principal_valuation',position:{
    liquidity:parsed.data.candidate.liquidity,tickLower:parsed.data.candidate.range.tickLower,
    tickUpper:parsed.data.candidate.range.tickUpper},
    token0Raw:null,token1Raw:null,nativeWei:null,
    idle0:model.idle.amount0Raw,idle1:model.idle.amount1Raw,
    principal:model.principal,knownLowerBound:model.lowerBound,
    fee0Raw:null,fee1Raw:null};
   const economics={principalOnlyValue:model.lowerBound.principalOnlyValue,
    passiveTokenValue:model.passiveTokenValue,feeIncome:null,paidCosts:null,
    nativeBalance:null,netNav:null,alpha:null};
   const provenance={classification:'paper_model_principal_valuation',modelHash,
    openMarkId:openMark.id,previousMarkId:previous.id,openModelHash:model.openModelHash,
    referenceProofHash:model.referenceProofHash,source:model.source,
    poolState:model.poolState,reference:model.reference,
    unavailable:model.unavailable};
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,provenance)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
    [model.campaignId,model.revision,model.source.block,model.source.hash,
     JSON.stringify(inventory),JSON.stringify(economics),JSON.stringify(provenance)])).rows[0]!;
   await db.query(`UPDATE deployment_campaigns SET range_state=$2,updated_at=clock_timestamp()
    WHERE id=$1`,[model.campaignId,model.poolState.tick>=parsed.data.candidate.range.tickLower&&
     model.poolState.tick<parsed.data.candidate.range.tickUpper?'inside':'outside']);
   return {markId:mark.id,replayed:false};
  });
 }

 /** Stores verified hypothetical fee bounds beside, never inside, the earned
  * fee ledger. The caller must be the canonical chain/indexer reader. */
 async recordTrustedPaperFeeEvidence(campaignId:string,fromMarkId:string,toMarkId:string,
  interval:CanonicalPaperFeeInterval){
  const proofHash=contentHash(interval);
  return this.transaction(async db=>{
   await this.assertPaperPreparationMutationAllowed(db,campaignId);
   const campaign=(await db.query<{mode:string;profile:unknown;profile_hash:string;
    evidence:unknown}>(`SELECT c.mode,p.profile,p.profile_hash,p.evidence
    FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    WHERE c.id=$1 FOR UPDATE OF c`,[campaignId])).rows[0];
   const profile=marketProfileSchema.safeParse(campaign?.profile),
    evidence=marketProfileEvidenceSchema.safeParse(campaign?.evidence);
   if(!campaign||campaign.mode!=='paper'||!profile.success||!evidence.success||
    contentHash(campaign.profile)!==campaign.profile_hash||
    referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash||
    (['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash',
     'quoterCodeHash'] as const).some(key=>profile.data.pool[key].toLowerCase()!==
      evidence.data.contractHashes[key].toLowerCase()))
    throw new DeploymentConflict('paper_fee_campaign_unavailable');
   const p=profile.data.pool;
   if(interval.pool!==p.pool.toLowerCase()||interval.token0Address!==p.token0.toLowerCase()||
    interval.token1Address!==p.token1.toLowerCase()||interval.fee!==p.fee||
    interval.tickSpacing!==p.tickSpacing||
    interval.coverage.stream!==evidence.data.streamKey||
    interval.coverage.targetSetHash!==evidence.data.indexerTargetSetHash)
    throw new DeploymentConflict('paper_fee_profile_mismatch');
   const marks=(await db.query<{id:string;revision:number;source_block:string|null;
    source_hash:string|null;inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,source_block::text,source_hash,inventory,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND id IN ($2,$3) ORDER BY deployment_marks.id`,
    [campaignId,fromMarkId,toMarkId])).rows;
   if(marks.length!==2||marks[0]!.id!==fromMarkId||marks[1]!.id!==toMarkId||
    marks[0]!.revision!==marks[1]!.revision)
    throw new DeploymentConflict('paper_fee_marks_unavailable');
   const [from,to]=marks as [typeof marks[number],typeof marks[number]];
    const closeClass=String(to.provenance.classification),
     closing=closeClass==='paper_model_partial_close'||closeClass==='paper_model_converted_close';
    if(!['paper_model_provisional','paper_model_principal_valuation'].includes(
    String(from.provenance.classification))||
    !['paper_model_principal_valuation','paper_model_partial_close',
     'paper_model_converted_close'].includes(closeClass)||
    from.source_block!==interval.from.block||to.source_block!==interval.to.block||
    from.source_hash?.toLowerCase()!==interval.from.hash.toLowerCase()||
    to.source_hash?.toLowerCase()!==interval.to.hash.toLowerCase())
    throw new DeploymentConflict('paper_fee_mark_source_mismatch');
   for(const mark of closing?[from]:[from,to]){
    const position=mark.inventory.position as Record<string,unknown>|undefined;
    if(!position||position.liquidity!==interval.liquidity||
     position.tickLower!==interval.range.tickLower||
     position.tickUpper!==interval.range.tickUpper)
     throw new DeploymentConflict('paper_fee_position_mismatch');
   }
   if(closing){
    const preview=(await db.query<{proposal:Record<string,unknown>}>(`
     SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
     [to.provenance.previewId,campaignId])).rows[0];
    if(closeClass==='paper_model_partial_close'){
     const close=paperCloseRetainModelSchema.safeParse(preview?.proposal.paperCloseRetainModel);
     if(!close.success||close.data.previousMarkId!==from.id||
      close.data.openMarkId!==to.provenance.openMarkId||
      close.data.openModelHash!==to.provenance.openModelHash||
      contentHash(close.data.source)!==contentHash(to.provenance.source)||
      contentHash(close.data.poolState)!==contentHash(to.provenance.poolState)||
      to.inventory.position!==null)
      throw new DeploymentConflict('paper_fee_close_endpoint_unavailable');
    }else{
     const close=paperCloseConvertModelSchema.safeParse(preview?.proposal.paperCloseConvertModel);
     if(!close.success||close.data.previousMarkId!==from.id||
      close.data.openMarkId!==to.provenance.openMarkId||
      close.data.openModelHash!==to.provenance.openModelHash||
      contentHash(close.data.source)!==contentHash(to.provenance.source)||
      contentHash(close.data.poolState)!==contentHash(to.provenance.poolState)||
      contentHash(close.data)!==to.provenance.closeConvertModelHash||
      to.inventory.position!==null)
      throw new DeploymentConflict('paper_fee_close_endpoint_unavailable');
    }
   }
   const skipped=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_marks
    WHERE campaign_id=$1 AND id>$2 AND id<$3) AS found`,[campaignId,fromMarkId,toMarkId])).rows[0]?.found;
   if(skipped)throw new DeploymentConflict('paper_fee_mark_gap');
   const existing=(await db.query<{id:string;from_mark_id:string;proof_hash:string}>(`
    SELECT id::text,from_mark_id::text,proof_hash FROM deployment_paper_fee_evidence
    WHERE campaign_id=$1 AND to_mark_id=$2`,[campaignId,toMarkId])).rows[0];
   if(existing){
    if(existing.from_mark_id===fromMarkId&&existing.proof_hash===proofHash)
     return {evidenceId:existing.id,replayed:true};
    throw new DeploymentConflict('paper_fee_conflicting_interval');
   }
   const open=(await db.query<{source_block:string|null;source_hash:string|null}>(`
    SELECT source_block::text,source_hash FROM deployment_marks WHERE campaign_id=$1
     AND provenance->>'classification'='paper_model_provisional' ORDER BY id LIMIT 2`,
    [campaignId])).rows;
   if(open.length!==1||!open[0]!.source_block||!open[0]!.source_hash)
    throw new DeploymentConflict('paper_fee_open_mark_unavailable');
   const prior=(await db.query<{carry:PaperFeeCarry;carry_hash:string}>(`
    SELECT carry,carry_hash FROM deployment_paper_fee_evidence
    WHERE campaign_id=$1 AND to_mark_id=$2`,[campaignId,fromMarkId])).rows[0];
   if(from.provenance.classification==='paper_model_provisional'&&prior||
    from.provenance.classification!=='paper_model_provisional'&&!prior)
    throw new DeploymentConflict('paper_fee_prior_evidence_unavailable');
   if(prior&&contentHash(prior.carry)!==prior.carry_hash)
    throw new DeploymentConflict('paper_fee_prior_evidence_integrity');
   let carry:PaperFeeCarry;
   try{carry=advancePaperFeeCarry(prior?.carry??null,interval,
    {block:open[0]!.source_block,hash:open[0]!.source_hash});}
   catch{throw new DeploymentConflict('paper_fee_interval_rejected');}
   const inserted=(await db.query<{id:string}>(`INSERT INTO deployment_paper_fee_evidence
    (campaign_id,from_mark_id,to_mark_id,proof,proof_hash,carry,carry_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
    [campaignId,fromMarkId,toMarkId,JSON.stringify(interval),proofHash,
     JSON.stringify(carry),contentHash(carry)])).rows[0]!;
   return {evidenceId:inserted.id,replayed:false};
  });
 }

 /** Appends canonical flow evidence for a RangeKeeper epoch. Carry resets at
  * recenter boundaries; cumulative amounts are kept separate from strategy
  * inventory and never feed a historical swap or mint. */
 async recordTrustedRangeKeeperPaperFeeEvidence(campaignId:string,fromMarkId:string,toMarkId:string,
  interval:CanonicalPaperFeeInterval){
  const proofHash=contentHash(interval);
  return this.transaction(async db=>{
   await this.assertPaperPreparationMutationAllowed(db,campaignId);
   const campaign=(await db.query<{mode:string;strategy_id:string;profile:unknown;profile_hash:string;
    evidence:unknown}>(`SELECT c.mode,r.strategy_id,p.profile,p.profile_hash,p.evidence
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id WHERE c.id=$1 FOR UPDATE OF c`,
    [campaignId])).rows[0];
   const profile=marketProfileSchema.safeParse(campaign?.profile),ev=marketProfileEvidenceSchema.safeParse(campaign?.evidence);
   if(!campaign||campaign.mode!=='paper'||campaign.strategy_id!=='rangekeeper_v1'||!profile.success||!ev.success||
    contentHash(profile.data)!==campaign.profile_hash||referenceProofHash(ev.data.referenceProof)!==ev.data.references.proofHash||
    interval.coverage.stream!==ev.data.streamKey||interval.coverage.targetSetHash!==ev.data.indexerTargetSetHash||
    interval.pool!==profile.data.pool.pool.toLowerCase()||interval.token0Address!==profile.data.pool.token0.toLowerCase()||
    interval.token1Address!==profile.data.pool.token1.toLowerCase()||interval.fee!==profile.data.pool.fee||
    interval.tickSpacing!==profile.data.pool.tickSpacing)
    throw new DeploymentConflict('rangekeeper_paper_fee_profile_or_coverage_mismatch');
   const rows=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`SELECT id::text,revision,
    source_block::text,source_hash,inventory,provenance FROM deployment_marks
    WHERE campaign_id=$1 AND id IN ($2,$3) ORDER BY deployment_marks.id FOR SHARE`,
    [campaignId,fromMarkId,toMarkId])).rows;
   if(rows.length!==2||rows[0]!.id!==fromMarkId||rows[1]!.id!==toMarkId||rows[0]!.revision!==rows[1]!.revision||
    rows.some(r=>!['rangekeeper_paper_open_v1','rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1',
     'rangekeeper_paper_close_retain_v1','rangekeeper_paper_close_convert_v1'].includes(String(r.provenance.classification))))
    throw new DeploymentConflict('rangekeeper_paper_fee_marks_unavailable');
   const [from,to]=rows as [typeof rows[number],typeof rows[number]],fromSource=paperFeeMarkSourceSchema.safeParse(from.provenance.source),
    toSource=paperFeeMarkSourceSchema.safeParse(to.provenance.source),pos=paperFeePositionSchema.safeParse(
     (from.inventory as {position?:unknown}).position);
   if(!fromSource.success||!toSource.success||!pos.success||from.source_block!==interval.from.block||
    to.source_block!==interval.to.block||fromSource.data.hash.toLowerCase()!==interval.from.hash.toLowerCase()||
    toSource.data.hash.toLowerCase()!==interval.to.hash.toLowerCase()||
    fromSource.data.block!==interval.from.block||toSource.data.block!==interval.to.block||
    pos.data.tickLower!==interval.range.tickLower||pos.data.tickUpper!==interval.range.tickUpper||
    pos.data.liquidity!==interval.liquidity)
    throw new DeploymentConflict('rangekeeper_paper_fee_source_or_position_mismatch');
   const skipped=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`SELECT id::text,revision,
    source_block::text,source_hash,inventory,provenance FROM deployment_marks WHERE campaign_id=$1
    AND id>$2 AND id<$3 ORDER BY deployment_marks.id`,[campaignId,fromMarkId,toMarkId])).rows;
   if(skipped.length>10000)throw new DeploymentConflict('rangekeeper_paper_fee_skipped_mark_bound');
   let priorBlock=BigInt(fromSource.data.block);
   for(const middle of skipped){
    const source=paperFeeMarkSourceSchema.safeParse(middle.provenance.source),
     middlePosition=paperFeePositionSchema.safeParse((middle.inventory as {position?:unknown}).position);
    if(middle.revision!==from.revision||middle.provenance.classification!=='rangekeeper_paper_mark_v1'||
     Number(middle.provenance.epoch??0)!==Number(from.provenance.epoch??0)||!source.success||
     source.data.block!==middle.source_block||source.data.hash.toLowerCase()!==middle.source_hash?.toLowerCase()||
     BigInt(source.data.block)<=priorBlock||BigInt(source.data.block)>=BigInt(toSource.data.block)||
     !middlePosition.success||middlePosition.data.tickLower!==pos.data.tickLower||
     middlePosition.data.tickUpper!==pos.data.tickUpper||middlePosition.data.liquidity!==pos.data.liquidity)
     throw new DeploymentConflict('rangekeeper_paper_fee_skipped_mark_not_unchanged_valuation');
    priorBlock=BigInt(source.data.block);
   }
   const existing=(await db.query<{id:string;from_mark_id:string;proof_hash:string}>(`SELECT id::text,
    from_mark_id::text,proof_hash FROM deployment_paper_fee_evidence WHERE campaign_id=$1 AND to_mark_id=$2`,
    [campaignId,toMarkId])).rows[0];
   if(existing){if(existing.from_mark_id===fromMarkId&&existing.proof_hash===proofHash)
    return {evidenceId:existing.id,replayed:true};throw new DeploymentConflict('rangekeeper_paper_fee_conflict');}
   let prior:PaperFeeCarry|null=null,opening:{block:string;hash:string}={
    block:fromSource.data.block,hash:fromSource.data.hash};
   if(from.provenance.classification!=='rangekeeper_paper_open_v1'&&
    from.provenance.classification!=='rangekeeper_paper_recenter_v1'){
    const p=(await db.query<{proof:CanonicalPaperFeeInterval;proof_hash:string;carry:PaperFeeCarry;carry_hash:string}>(`
     SELECT proof,proof_hash,carry,carry_hash FROM deployment_paper_fee_evidence
     WHERE campaign_id=$1 AND to_mark_id=$2`,[campaignId,fromMarkId])).rows[0];
    if(!p||contentHash(p.proof)!==p.proof_hash||contentHash(p.carry)!==p.carry_hash)
     throw new DeploymentConflict('rangekeeper_paper_fee_prior_carry_unavailable');
    prior=p.carry;opening=p.carry.from;
    if(prior.range.tickLower!==interval.range.tickLower||prior.range.tickUpper!==interval.range.tickUpper||
     prior.liquidity!==interval.liquidity)
     throw new DeploymentConflict('rangekeeper_paper_fee_epoch_changed_without_boundary');
   }
   let carry:PaperFeeCarry;
   try{carry=advancePaperFeeCarry(prior,interval,{block:opening.block,hash:opening.hash});}
   catch{throw new DeploymentConflict('rangekeeper_paper_fee_interval_rejected');}
   const inserted=(await db.query<{id:string}>(`INSERT INTO deployment_paper_fee_evidence
    (campaign_id,from_mark_id,to_mark_id,proof,proof_hash,carry,carry_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,[campaignId,fromMarkId,toMarkId,
    JSON.stringify(interval),proofHash,JSON.stringify(carry),contentHash(carry)])).rows[0]!;
   return {evidenceId:inserted.id,replayed:false};
  });
 }

 /** Reads and replays the complete append-only fee carry from a static/manual
  * paper open mark through the campaign's exact latest mark. This is read-only;
  * chain anchors still need an external canonical recheck before use. */
 async registerStaticPaperCloseConvertPrestateGas(input:{report:unknown;
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>;
  verifyFeeReplay:(report:import('./paper-close-convert-prestate-sampler.js').PaperCloseConvertPrestateReport)=>
   Promise<EphemeralStaticPaperCloseConvertFeeReplay>}){
  return registerProspectivePaperCloseConvertPrestateGasProfiles({pool:this.pool,
   report:input.report,verifyAnchors:input.verifyAnchors,verifyFeeReplay:input.verifyFeeReplay});
 }

 async staticPaperCloseConvertPrestateGasProfiles(input:{chainId:number;poolAddress:string;
  sizeBand:string;reportHash:string}){
  if(!Number.isSafeInteger(input.chainId)||input.chainId!==4663||
   !/^0x[0-9a-fA-F]{40}$/.test(input.poolAddress)||!/^[0-9a-f]{64}$/.test(input.reportHash)||
   !input.sizeBand||input.sizeBand.length>128)
   throw new DeploymentConflict('paper_close_convert_prestate_profile_query_invalid');
  const rows=(await this.readPool.query<PaperCloseConvertPrestateGasProfileRow>(`
   SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
    allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
    evidence_class AS "evidenceClass",model,validation,source_hash AS "sourceHash",
    observed_until AS "observedUntil"
   FROM deployment_calibration_profiles WHERE chain_id=$1 AND lower(pool_address)=lower($2)
    AND path_version=$3 AND size_band=$4 AND component='gas_units'
    AND validation->>'reportHash'=$5 ORDER BY stage,version DESC LIMIT 8`,
   [input.chainId,input.poolAddress,PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1,
    input.sizeBand,input.reportHash])).rows;
  if(rows.length>7)throw new DeploymentConflict('paper_close_convert_prestate_profile_query_bound');
  return rows;
 }

 async readStaticPaperCloseConvertFeeCarry(input:{campaignId:string;revision:number;
  operation?:{id:string;workerId:string;modelHash:string}}){
  const db=await this.readPool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   try{
   const pending=(await db.query<{id:string;kind:string;status:string;claimed_by:string|null;
    claim_valid:boolean;preview_kind:string;expected_revision:number;model_hash:string|null;
    request_model_hash:string|null}>(`
    SELECT o.id::text,o.kind,o.status,o.claimed_by,(o.claim_until>=clock_timestamp()) AS claim_valid,
     v.kind AS preview_kind,v.expected_revision,
     v.proposal->'paperCloseConvertTerminalV3'->>'modelHash' AS model_hash,
     v.request->>'modelHash' AS request_model_hash
    FROM deployment_operations o JOIN deployment_previews v ON v.id=o.preview_id
    WHERE o.campaign_id=$1 AND o.status IN ('queued','preflighting','executing','confirming',
     'reconciling') ORDER BY o.id`,[input.campaignId])).rows;
   const operationBound=input.operation!==undefined&&pending.length===1&&
    pending[0]!.id===input.operation.id&&pending[0]!.kind==='close_convert'&&
    pending[0]!.status==='reconciling'&&pending[0]!.claimed_by===input.operation.workerId&&
    pending[0]!.claim_valid&&pending[0]!.preview_kind==='close_convert'&&
    pending[0]!.expected_revision===input.revision&&
    pending[0]!.model_hash===input.operation.modelHash&&
    pending[0]!.request_model_hash===input.operation.modelHash;
   if(input.operation&&!operationBound)
    throw new DeploymentConflict('paper_close_convert_fee_operation_binding_invalid');
   if(!input.operation&&pending.length)
    throw new DeploymentConflict('paper_close_convert_fee_operation_pending');

   const campaign=(await db.query<{mode:string;lifecycle:string;current_revision:number;
    open_mark_id:string|null;strategy_id:string;strategy_version:string;state_schema_version:number;
    config:unknown;config_hash:string;profile:unknown;profile_hash:string;evidence:unknown}>(`
    SELECT c.mode,c.lifecycle,c.current_revision,o.id::text AS open_mark_id,
     r.strategy_id,r.strategy_version,
     r.state_schema_version,r.config,r.config_hash,p.profile,p.profile_hash,p.evidence
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN LATERAL (SELECT id FROM deployment_marks WHERE campaign_id=c.id
     AND provenance->>'classification'='paper_model_provisional' ORDER BY id LIMIT 1) o ON TRUE
    WHERE c.id=$1`,
    [input.campaignId])).rows[0];
   const profile=marketProfileSchema.safeParse(campaign?.profile),
    evidence=marketProfileEvidenceSchema.safeParse(campaign?.evidence);
   if(!campaign||campaign.mode!=='paper'||!['active','paused'].includes(campaign.lifecycle)&&
    !(campaign.lifecycle==='closing'&&operationBound)||
    campaign.current_revision!==input.revision||!campaign.open_mark_id||
    campaign.strategy_id!=='static_manual_v1'||campaign.strategy_version!=='1.0.0'||
    campaign.state_schema_version!==1||!campaign.config||contentHash(campaign.config)!==campaign.config_hash||
    !profile.success||!evidence.success||
    contentHash(profile.data)!==campaign.profile_hash||
    referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash)
    throw new DeploymentConflict('paper_close_convert_fee_campaign_binding_invalid');
   for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash',
    'quoterCodeHash'] as const)
    if(profile.data.pool[key].toLowerCase()!==evidence.data.contractHashes[key].toLowerCase())
     throw new DeploymentConflict('paper_close_convert_fee_profile_integrity');
   const latest=(await db.query<{id:string}>(`SELECT id::text FROM deployment_marks
    WHERE campaign_id=$1 ORDER BY deployment_marks.id DESC LIMIT 1`,[input.campaignId])).rows[0];
   if(!latest)throw new DeploymentConflict('paper_close_convert_fee_mark_sequence_invalid');
   const marks=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,source_block::text,source_hash,inventory,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND id >= $2 AND id <= $3 ORDER BY deployment_marks.id LIMIT 101`,
    [input.campaignId,campaign.open_mark_id,latest.id])).rows;
   if(marks.length>100)
    throw new DeploymentConflict('paper_close_convert_fee_mark_budget_exceeded');
   if(marks.length<2||
    marks[0]!.id!==campaign.open_mark_id||marks.at(-1)!.id!==latest.id||
    marks.some(mark=>mark.revision!==input.revision))
    throw new DeploymentConflict('paper_close_convert_fee_mark_sequence_invalid');
   const indexed=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
    WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=$3 AND fee=$4
     AND enabled=true AND target_set_hash=$5 AND lower(rwa_address)=lower($6)
     AND created_block<=$7::numeric) AS found`,[evidence.data.streamKey,profile.data.pool.pool,
     profile.data.pool.chainId,profile.data.pool.fee,evidence.data.indexerTargetSetHash,
     profile.data.pool.quoteToken===0?profile.data.pool.token1:profile.data.pool.token0,
     marks.at(-1)!.source_block]));
   if(!indexed.rows[0]?.found)throw new DeploymentConflict('paper_close_convert_fee_indexer_changed');
   const open=marks[0]!,openSource=paperFeeMarkSourceSchema.safeParse(open.provenance.source),
    openPreview=(await db.query<{proposal:Record<string,unknown>}>(`
     SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
     [open.provenance.previewId,input.campaignId])).rows[0],
    openModel=paperOpenModelSchema.safeParse(openPreview?.proposal.paperOpenModel);
   if(!openModel.success||open.provenance.classification!=='paper_model_provisional'||
    !openSource.success||open.source_block!==openSource.data.block||
    open.source_hash?.toLowerCase()!==openSource.data.hash.toLowerCase()||
    openModel.data.campaignId!==input.campaignId||openModel.data.revision!==input.revision||
    openModel.data.profileHash!==campaign.profile_hash||openModel.data.configHash!==campaign.config_hash||
    contentHash(openModel.data)!==open.provenance.modelHash||
    contentHash(open.provenance.source)!==contentHash(openModel.data.source))
    throw new DeploymentConflict('paper_close_convert_fee_open_model_invalid');
   const intervals=(await db.query<{id:string;from_mark_id:string;to_mark_id:string;
    proof:unknown;proof_hash:string;carry:PaperFeeCarry;carry_hash:string}>(`
    SELECT id::text,from_mark_id::text,to_mark_id::text,proof,proof_hash,carry,carry_hash
    FROM deployment_paper_fee_evidence WHERE campaign_id=$1 AND to_mark_id>$2 AND to_mark_id<=$3
    ORDER BY deployment_paper_fee_evidence.to_mark_id LIMIT 101`,
    [input.campaignId,campaign.open_mark_id,latest.id])).rows;
   if(intervals.length!==marks.length-1)
    throw new DeploymentConflict('paper_close_convert_fee_interval_gap');
   let carry:PaperFeeCarry|null=null,prior=marks[0]!;
   const sources:{block:string;hash:string;timestamp:number}[]=[openSource.data];
   for(let index=1;index<marks.length;index++){
    const mark=marks[index]!,row=intervals[index-1]!,source=paperFeeMarkSourceSchema.safeParse(mark.provenance.source),
     position=mark.inventory.position as Record<string,unknown>|undefined,
     proof=canonicalPaperFeeIntervalSchema.safeParse(row.proof),savedCarry=paperFeeCarrySchema.safeParse(row.carry);
    if(!proof.success||!savedCarry.success)
     throw new DeploymentConflict('paper_close_convert_fee_interval_schema_invalid');
    const evidenceProof=proof.data,recordedCarry=savedCarry.data;
    if(!source.success||mark.id!==row.to_mark_id||row.from_mark_id!==prior.id||
     mark.source_block!==source.data.block||mark.source_hash?.toLowerCase()!==source.data.hash.toLowerCase()||
     mark.provenance.classification!=='paper_model_principal_valuation'||!position||
     position.liquidity!==openModel.data.candidate.liquidity||
     position.tickLower!==openModel.data.candidate.range.tickLower||
     position.tickUpper!==openModel.data.candidate.range.tickUpper||
     evidenceProof.pool.toLowerCase()!==profile.data.pool.pool.toLowerCase()||
     evidenceProof.token0Address.toLowerCase()!==profile.data.pool.token0.toLowerCase()||
     evidenceProof.token1Address.toLowerCase()!==profile.data.pool.token1.toLowerCase()||
     evidenceProof.fee!==profile.data.pool.fee||
     evidenceProof.tickSpacing!==profile.data.pool.tickSpacing||
     evidenceProof.liquidity!==openModel.data.candidate.liquidity||
     evidenceProof.range.tickLower!==openModel.data.candidate.range.tickLower||
     evidenceProof.range.tickUpper!==openModel.data.candidate.range.tickUpper||
     contentHash(evidenceProof)!==row.proof_hash||contentHash(recordedCarry)!==row.carry_hash||
     evidenceProof.from.block!==prior.source_block||
     evidenceProof.from.hash.toLowerCase()!==prior.source_hash?.toLowerCase()||
     evidenceProof.to.block!==mark.source_block||
     evidenceProof.to.hash.toLowerCase()!==mark.source_hash?.toLowerCase()||
     evidenceProof.coverage.stream!==evidence.data.streamKey||
     evidenceProof.coverage.targetSetHash!==evidence.data.indexerTargetSetHash||
     BigInt(evidenceProof.coverage.completeThroughBlock)<BigInt(evidenceProof.to.block)||
     (evidenceProof.coverage.completeThroughBlock===evidenceProof.to.block&&
      evidenceProof.coverage.completeThroughHash?.toLowerCase()!==evidenceProof.to.hash.toLowerCase()))
     throw new DeploymentConflict('paper_close_convert_fee_interval_binding_invalid');
    try{carry=advancePaperFeeCarry(carry,evidenceProof,openModel.data.source);}
    catch{throw new DeploymentConflict('paper_close_convert_fee_replay_invalid');}
    if(contentHash(carry)!==row.carry_hash||contentHash(carry)!==contentHash(recordedCarry))
     throw new DeploymentConflict('paper_close_convert_fee_replay_invalid');
    sources.push(source.data);prior=mark;
   }
   if(!carry||carry.intervals<1)
    throw new DeploymentConflict('paper_close_convert_fee_carry_unavailable');
   const previous=marks.at(-1)!,previousSource=paperFeeMarkSourceSchema.parse(previous.provenance.source),
    config=campaign.config as Record<string,unknown>,
    {strategyId:_strategyId,strategyVersion:_strategyVersion,stateSchemaVersion:_stateSchemaVersion,
     ...parameters}=config;
   await db.query('COMMIT');
   return {campaignId:input.campaignId,revision:input.revision,openMarkId:open.id,
    openModel:openModel.data,openModelHash:contentHash(openModel.data),profile:profile.data,
    profileHash:campaign.profile_hash,configHash:campaign.config_hash,
    stream:evidence.data.streamKey,targetSetHash:evidence.data.indexerTargetSetHash,
    parameters:parseStrategyParameters(campaign.strategy_id,parameters),
    previous:{markId:previous.id,sourceBlock:previous.source_block!,sourceHash:previous.source_hash!,
     source:previousSource},feeCarry:carry,feeEvidence:{id:intervals.at(-1)!.id,
     proofHash:intervals.at(-1)!.proof_hash,carryHash:intervals.at(-1)!.carry_hash},sources};
   }catch(error){await db.query('ROLLBACK');throw error;}
  }finally{db.release();}
 }

 /** Materializes one source mark into a separate provisional accounting
  * journal. Fee intervals must already be verified and adjacent; no historical
  * mark or actual-paid ledger row is rewritten. Call through
  * recordCanonicalNextPaperAccounting outside isolated fixtures. */
 async recordNextPaperAccounting(campaignId:string,
  verifyAnchors:(chainId:number,sources:readonly {block:string;hash:string;timestamp:number}[])=>Promise<void>,
  policyVersion:string=PAPER_ACCOUNTING_POLICY,
  verifyCloseConvert?:(chainId:number,model:PaperCloseConvertModel,
   inputAmountRaw:string)=>Promise<PaperCloseConvertQuote>){
  if(![PAPER_ACCOUNTING_POLICY,PAPER_CONVERSION_ACCOUNTING_POLICY,
   PAPER_CONVERSION_ACCOUNTING_POLICY_V2].includes(policyVersion))
   throw new DeploymentConflict('paper_accounting_policy_unsupported');
  const conversionPolicy=policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY;
  const conversionPolicyV2=policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY_V2;
  const conversionEnabled=conversionPolicy||conversionPolicyV2;
  const currentRuntime=conversionPolicyV2?loadRuntimeIdentity():undefined;
  if(conversionPolicyV2&&!currentRuntime)
   throw new DeploymentConflict('paper_accounting_runtime_unavailable');
  return this.transaction(async db=>{
   await this.assertPaperPreparationMutationAllowed(db,campaignId);
   const campaign=(await db.query<{mode:string;current_revision:number;allocation:unknown;
    profile:unknown;profile_hash:string;evidence:unknown;config_hash:string;config:unknown;open_mark_id:string;
    runtime_identity:unknown;open_provenance:Record<string,unknown>;proposal:Record<string,unknown>}>(`
    SELECT c.mode,c.current_revision,c.allocation,c.runtime_identity,p.profile,p.profile_hash,p.evidence,r.config_hash,r.config,
     o.id::text AS open_mark_id,o.provenance AS open_provenance,v.proposal
    FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN LATERAL (SELECT id,provenance FROM deployment_marks WHERE campaign_id=c.id
     AND provenance->>'classification'='paper_model_provisional' ORDER BY id LIMIT 1) o ON TRUE
    JOIN deployment_previews v ON v.id=(o.provenance->>'previewId')::uuid
    WHERE c.id=$1 FOR UPDATE OF c`,[campaignId])).rows[0];
   const profile=marketProfileSchema.safeParse(campaign?.profile),
    profileEvidence=marketProfileEvidenceSchema.safeParse(campaign?.evidence),
    open=paperOpenModelSchema.safeParse(campaign?.proposal.paperOpenModel);
   if(!campaign||campaign.mode!=='paper'||!profile.success||!profileEvidence.success||!open.success||
    contentHash(campaign.profile)!==campaign.profile_hash||
    referenceProofHash(profileEvidence.data.referenceProof)!==
     profileEvidence.data.references.proofHash||
    open.data.profileHash!==campaign.profile_hash||
    open.data.configHash!==campaign.config_hash||
    open.data.campaignId!==campaignId||open.data.revision!==campaign.current_revision||
    contentHash(open.data)!==campaign.open_provenance.modelHash)
    throw new DeploymentConflict('paper_accounting_campaign_unavailable');
   if(conversionPolicyV2){
    const storedRuntime=sealedRuntimeIdentitySchema.safeParse(campaign.runtime_identity);
    if(!storedRuntime.success||contentHash(storedRuntime.data)!==contentHash(currentRuntime))
     throw new DeploymentConflict('paper_accounting_runtime_mismatch');
   }
   const invalidated=(await db.query<{found:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM deployment_paper_accounting_invalidations WHERE campaign_id=$1) AS found`,
    [campaignId])).rows[0]?.found;
   if(invalidated)throw new DeploymentConflict('paper_accounting_history_invalidated');
   const allocation=allocationSchema.parse(campaign.allocation);
   if(contentHash(allocation)!==contentHash(open.data.allocation))
    throw new DeploymentConflict('paper_accounting_allocation_changed');
   const mark=(await db.query<{id:string;revision:number;source_block:string|null;
    source_hash:string|null;inventory:Record<string,unknown>;economics:unknown;
    provenance:Record<string,unknown>;calibration_profile_ids:string[]}>(`
    SELECT m.id::text,m.revision,m.source_block::text,m.source_hash,m.inventory,m.economics,
     m.provenance,m.calibration_profile_ids FROM deployment_marks m
    LEFT JOIN deployment_paper_accounting a ON a.source_mark_id=m.id
     AND a.campaign_id=m.campaign_id AND a.policy_version=$2
    WHERE m.campaign_id=$1 AND a.id IS NULL ORDER BY m.id LIMIT 1`,
    [campaignId,policyVersion])).rows[0];
   if(!mark)return null;
   if(mark.revision!==campaign.current_revision||!mark.source_block||!mark.source_hash)
    throw new DeploymentConflict('paper_accounting_mark_unavailable');
   const source=paperFeeMarkSourceSchema.safeParse(mark.provenance.source),
    reference=z.object({price0:z.string().regex(/^(0|[1-9][0-9]*)$/),
     price1:z.string().regex(/^(0|[1-9][0-9]*)$/),
     nativePrice:z.string().regex(/^(0|[1-9][0-9]*)$/)}).strict().safeParse(
      mark.provenance.reference);
   if(!source.success||!reference.success||source.data.block!==mark.source_block||
    source.data.hash.toLowerCase()!==mark.source_hash.toLowerCase())
    throw new DeploymentConflict('paper_accounting_mark_source_invalid');
   const classification=mark.provenance.classification;
   const kind=classification==='paper_model_provisional'?'open':
    classification==='paper_model_principal_valuation'?'valuation':
    classification==='paper_model_partial_close'?'close_retain':
    classification==='paper_model_converted_close'?'close_convert':null;
   if(!kind)throw new DeploymentConflict('paper_accounting_mark_unsupported');
   if(kind==='close_convert'&&!conversionEnabled)
    throw new DeploymentConflict('paper_accounting_mark_unsupported');
   const priorMark=(await db.query<{id:string}>(`SELECT id::text FROM deployment_marks
    WHERE campaign_id=$1 AND id<$2 ORDER BY deployment_marks.id DESC LIMIT 1`,[campaignId,mark.id])).rows[0];
   const prior=priorMark?(await db.query<{snapshot:unknown;snapshot_hash:string}>(`
    SELECT snapshot,snapshot_hash FROM deployment_paper_accounting
    WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
    [campaignId,priorMark.id,policyVersion])).rows[0]:null;
   const parsedPriorV1=conversionEnabled?null:paperAccountingSchema.safeParse(prior?.snapshot);
   const parsedPriorConversionV1=conversionPolicy?paperConversionAccountingSchema.safeParse(prior?.snapshot):null;
   const parsedPriorConversionV2=conversionPolicyV2?
    paperConversionAccountingV2Schema.safeParse(prior?.snapshot):null;
   const priorData=parsedPriorConversionV2?.success?parsedPriorConversionV2.data:
    parsedPriorConversionV1?.success?parsedPriorConversionV1.data:
    parsedPriorV1?.success?parsedPriorV1.data:null;
   const priorValid=priorData!==null&&contentHash(priorData)===prior?.snapshot_hash;
   if(conversionPolicyV2&&parsedPriorConversionV2?.success&&
    contentHash(parsedPriorConversionV2.data.runtimeIdentity)!==contentHash(currentRuntime))
    throw new DeploymentConflict('paper_accounting_prior_runtime_mismatch');
   if(kind==='open'?mark.id!==campaign.open_mark_id||priorMark!==undefined:
    !priorMark||!priorValid)
    throw new DeploymentConflict('paper_accounting_prior_snapshot_unavailable');
   const feeRow=kind==='open'?null:(await db.query<{id:string;from_mark_id:string;
    proof:unknown;proof_hash:string;carry:PaperFeeCarry;carry_hash:string}>(`
    SELECT id::text,from_mark_id::text,proof,proof_hash,carry,carry_hash
    FROM deployment_paper_fee_evidence WHERE campaign_id=$1 AND to_mark_id=$2`,
    [campaignId,mark.id])).rows[0];
   if(kind!=='open'&&(!feeRow||feeRow.from_mark_id!==priorMark?.id||
    contentHash(feeRow.proof)!==feeRow.proof_hash||
    contentHash(feeRow.carry)!==feeRow.carry_hash))
    throw new DeploymentConflict('paper_accounting_fee_evidence_unavailable');
   if(feeRow){
    const priorFee=priorMark?(await db.query<{id:string;proof:unknown;proof_hash:string;
     carry:PaperFeeCarry;carry_hash:string}>(`
     SELECT id::text,proof,proof_hash,carry,carry_hash FROM deployment_paper_fee_evidence
     WHERE campaign_id=$1 AND to_mark_id=$2`,[campaignId,priorMark.id])).rows[0]:null;
    if(!priorData||
     (priorData.markKind==='open'?priorFee!==undefined:
      !priorFee||contentHash(priorFee.carry)!==priorFee.carry_hash||
       contentHash(priorFee.proof)!==priorFee.proof_hash||
       priorData.feeEvidence?.id!==priorFee.id||
       priorData.feeEvidence?.proofHash!==priorFee.proof_hash||
       priorData.feeEvidence?.carryHash!==priorFee.carry_hash))
     throw new DeploymentConflict('paper_accounting_prior_fee_unavailable');
    let replayedCarry:PaperFeeCarry;
    try{
     const proof=feeRow.proof as CanonicalPaperFeeInterval;
     if(proof.coverage.stream!==profileEvidence.data.streamKey||
      proof.coverage.targetSetHash!==profileEvidence.data.indexerTargetSetHash)
      throw Error('paper_accounting_coverage_changed');
     replayedCarry=advancePaperFeeCarry(priorFee?.carry??null,proof,open.data.source);
    }catch{throw new DeploymentConflict('paper_accounting_fee_replay_invalid');}
    if(contentHash(replayedCarry)!==feeRow.carry_hash)
     throw new DeploymentConflict('paper_accounting_fee_replay_invalid');
   }
   let close=null,closeConvert:PaperCloseConvertModel|null=null;
   if(kind==='close_retain'){
    const preview=(await db.query<{proposal:Record<string,unknown>}>(`
     SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
     [mark.provenance.previewId,campaignId])).rows[0];
    const parsed=paperCloseRetainModelSchema.safeParse(preview?.proposal.paperCloseRetainModel);
    if(!parsed.success||parsed.data.previousMarkId!==priorMark?.id||
     parsed.data.openMarkId!==campaign.open_mark_id||
     parsed.data.openModelHash!==contentHash(open.data)||
     contentHash(parsed.data.source)!==contentHash(source.data)||
     contentHash(parsed.data.reference)!==contentHash(reference.data)||
     contentHash(parsed.data.retainedLowerBound)!==
      contentHash(mark.inventory.retainedPrincipalLowerBound)||
     contentHash(parsed.data.costs)!==contentHash(mark.provenance.modeledCosts))
     throw new DeploymentConflict('paper_accounting_close_model_invalid');
    close=parsed.data;
   }
   if(kind==='close_convert'){
    const preview=(await db.query<{proposal:Record<string,unknown>}>(`
     SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
     [mark.provenance.previewId,campaignId])).rows[0];
    const parsed=paperCloseConvertModelSchema.safeParse(preview?.proposal.paperCloseConvertModel);
    if(!conversionEnabled||!parsed.success||parsed.data.previousMarkId!==priorMark?.id||
     parsed.data.openMarkId!==campaign.open_mark_id||
     parsed.data.openModelHash!==contentHash(open.data)||
     contentHash(parsed.data.source)!==contentHash(source.data)||
     contentHash(parsed.data.reference)!==contentHash(reference.data)||
     contentHash(parsed.data.principal)!==contentHash(mark.inventory.retainedPrincipalLowerBound)||
     contentHash(parsed.data.idle)!==contentHash(mark.inventory.idleLowerBound)||
     contentHash(parsed.data.costs)!==contentHash(mark.provenance.modeledCosts)||
     contentHash(parsed.data.conversionRoute)!==contentHash(mark.provenance.conversionRoute))
     throw new DeploymentConflict('paper_accounting_convert_model_invalid');
    const profileIds=parsed.data.costs.stages.map(stage=>stage.profileId);
    if(contentHash(profileIds)!==contentHash(mark.calibration_profile_ids))
     throw new DeploymentConflict('paper_accounting_gas_profiles_changed');
    const config=campaign.config&&typeof campaign.config==='object'?
     campaign.config as Record<string,unknown>:null;
    if(!config||contentHash(config)!==campaign.config_hash||
     config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||
     config.stateSchemaVersion!==1)
     throw new DeploymentConflict('paper_accounting_convert_config_changed');
    const {strategyId:_strategyId,strategyVersion:_strategyVersion,
     stateSchemaVersion:_stateSchemaVersion,...parameters}=config;
    await replayPaperCloseConvert(db,parsed.data,open.data,profile.data,parameters,
     Date.parse(parsed.data.costs.gasPriceObservedAt));
    closeConvert=parsed.data;
   }
   if(kind==='open'&&contentHash(open.data.costs)!==contentHash(mark.provenance.modeledCosts))
    throw new DeploymentConflict('paper_accounting_open_cost_invalid');
   if(['open','close_retain'].includes(kind)){
    const ids=(kind==='open'?open.data.costs:close!.costs).stages.map(stage=>stage.profileId);
    if(contentHash(ids)!==contentHash(mark.calibration_profile_ids))
     throw new DeploymentConflict('paper_accounting_gas_profiles_changed');
   }
   const amount=(record:unknown,key:string)=>{
    const raw=record&&typeof record==='object'&&!Array.isArray(record)?
     (record as Record<string,unknown>)[key]:null;
    if(typeof raw!=='string'||!/^(0|[1-9][0-9]*)$/.test(raw))
     throw new DeploymentConflict('paper_accounting_principal_unavailable');
    return raw;
   };
   const principal=kind==='open'?{token0Raw:allocation.token0Raw,token1Raw:allocation.token1Raw}:
    kind==='valuation'?mark.inventory.knownLowerBound:mark.inventory.retainedPrincipalLowerBound;
   const accountingMark={id:mark.id,kind:kind as 'open'|'valuation'|'close_retain'|'close_convert',
    source:source.data,reference:reference.data,
    principal0Raw:closeConvert?String(BigInt(closeConvert.principal.amount0Raw)+
     BigInt(closeConvert.idle.amount0Raw)):amount(principal,'token0Raw'),
    principal1Raw:closeConvert?String(BigInt(closeConvert.principal.amount1Raw)+
     BigInt(closeConvert.idle.amount1Raw)):amount(principal,'token1Raw')};
   const feeEvidence=feeRow?{id:feeRow.id,proofHash:feeRow.proof_hash,
    carryHash:feeRow.carry_hash,carry:feeRow.carry}:null;
   await verifyAnchors(profile.data.pool.chainId,[open.data.source,
    ...(priorData?[priorData.source]:[]),source.data]);
   let closeQuote:PaperCloseConvertQuote|null=null;
   let closeGasV2:PaperCloseConvertCostsV2|null=null,
    closeGasBindingV2:{reportHash:string;scopeHash:string;sequenceHash:string;
     sizeBand:string;profileIds:string[]}|null=null;
   if(closeConvert){
    if(!verifyCloseConvert)throw new DeploymentConflict('paper_accounting_convert_quote_verifier_unavailable');
    const priorStandard=conversionPolicyV2?
     paperAccountingFromConversionV2Snapshot(parsedPriorConversionV2?.success?
      parsedPriorConversionV2.data:null):
     paperAccountingFromConversionSnapshot(parsedPriorConversionV1?.success?
      parsedPriorConversionV1.data:null),
     baseMark={...accountingMark,kind:'valuation' as const};
    let beforeConversion:ReturnType<typeof buildPaperAccounting>;
    try{beforeConversion=buildPaperAccounting(open.data,profile.data,baseMark,
     priorStandard,feeEvidence,null);}
    catch{throw new DeploymentConflict('paper_accounting_convert_input_unavailable');}
    const inputAsset=closeConvert.conversionRoute.inputAsset,
     quoteAsset=profile.data.pool.quoteToken===0?'token0':'token1';
    if(inputAsset===quoteAsset)throw new DeploymentConflict('paper_accounting_convert_direction_invalid');
    const inputAmountRaw=inputAsset==='token0'?beforeConversion.inventory.token0Raw:
     beforeConversion.inventory.token1Raw;
    try{closeQuote=await verifyCloseConvert(profile.data.pool.chainId,closeConvert,inputAmountRaw);}
    catch{throw new DeploymentConflict('paper_accounting_convert_quote_invalid');}
    if(conversionPolicyV2){
     const selected=await this.selectRegisteredPaperCloseConvertGasV2(db,{campaignId,
      revision:campaign.current_revision,terminalMarkId:mark.id,previousMarkId:priorMark!.id,
      runtimeIdentity:currentRuntime!,profile:profile.data,open:open.data,model:closeConvert,
      inventory:beforeConversion.inventory,feeEvidence:{id:feeEvidence!.id,
       proofHash:feeEvidence!.proofHash,carryHash:feeEvidence!.carryHash}});
     closeGasV2=selected.costs;closeGasBindingV2=selected.binding;
    }
   }
   let accounting:unknown;
   if(conversionPolicy){
    const priorConversion=parsedPriorConversionV1?.success?parsedPriorConversionV1.data:null;
    try{accounting=buildPaperConversionAccounting(open.data,profile.data,accountingMark,
     priorConversion,feeEvidence,close,closeConvert,closeQuote);}
    catch{throw new DeploymentConflict('paper_accounting_convert_projection_invalid');}
   }else if(conversionPolicyV2){
    const priorConversion=parsedPriorConversionV2?.success?parsedPriorConversionV2.data:null;
    try{accounting=buildPaperConversionAccountingV2(open.data,profile.data,accountingMark,
     priorConversion,feeEvidence,close,closeConvert,closeQuote,closeGasV2,closeGasBindingV2,
     currentRuntime!);}
    catch{throw new DeploymentConflict('paper_accounting_convert_v2_projection_invalid');}
   }else{
    if(kind==='close_convert')throw new DeploymentConflict('paper_accounting_mark_unsupported');
    const priorStandard=parsedPriorV1?.success?parsedPriorV1.data:null;
    const standardMark={...accountingMark,kind:kind as 'open'|'valuation'|'close_retain'};
    try{accounting=buildPaperAccounting(open.data,profile.data,standardMark,
     priorStandard,feeEvidence,close);}
    catch{throw new DeploymentConflict('paper_accounting_projection_invalid');}
   }
   // Exact Quoter replay may span several RPC reads; bracket it with another
   // canonical pass before persisting this append-only snapshot.
   await verifyAnchors(profile.data.pool.chainId,[open.data.source,
    ...(priorData?[priorData.source]:[]),source.data]);
   const saved=(await db.query<{id:string}>(`INSERT INTO deployment_paper_accounting
    (campaign_id,source_mark_id,policy_version,fee_evidence_id,snapshot,snapshot_hash)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,
    [campaignId,mark.id,policyVersion,feeRow?.id??null,
     JSON.stringify(accounting),contentHash(accounting)])).rows[0]!;
   return {snapshotId:saved.id,markId:mark.id,kind};
  });
 }

 /** Validates the terminal V3 snapshot and its adjacent fee row before
  * maintenance treats the campaign as complete. V3 terminal booking is
  * already atomic; this read never projects it through the V2 path. */
 async hasTrustedStaticPaperCloseConvertV3Terminal(campaignId:string){
  const rows=(await this.readPool.query<{accounting_id:string;campaign_id:string;source_mark_id:string;
   snapshot:unknown;snapshot_hash:string;fee_evidence_id:string|null;
   mark_source_block:string|null;mark_source_hash:string|null;mark_provenance:Record<string,unknown>;
   fee_id:string|null;fee_from_mark_id:string|null;fee_to_mark_id:string|null;
   fee_proof:unknown;fee_proof_hash:string|null;fee_carry:unknown;fee_carry_hash:string|null;
   previous_source_block:string|null;previous_source_hash:string|null;
   profile_evidence:unknown;campaign_lifecycle:string;campaign_runtime:unknown;operation_status:string|null;
   operation_kind:string|null;operation_preview_id:string|null}>(`
   SELECT a.id::text AS accounting_id,a.campaign_id::text,a.source_mark_id::text,
    a.snapshot,a.snapshot_hash,
    a.fee_evidence_id::text,m.source_block::text AS mark_source_block,m.source_hash AS mark_source_hash,
    m.provenance AS mark_provenance,f.id::text AS fee_id,f.from_mark_id::text AS fee_from_mark_id,
    f.to_mark_id::text AS fee_to_mark_id,f.proof AS fee_proof,f.proof_hash AS fee_proof_hash,
    f.carry AS fee_carry,f.carry_hash AS fee_carry_hash,
    previous.source_block::text AS previous_source_block,previous.source_hash AS previous_source_hash,
    p.evidence AS profile_evidence,c.lifecycle AS campaign_lifecycle,
    c.runtime_identity AS campaign_runtime,
    o.status AS operation_status,o.kind AS operation_kind,o.preview_id::text AS operation_preview_id
   FROM deployment_paper_accounting a JOIN deployment_marks m
    ON m.campaign_id=a.campaign_id AND m.id=a.source_mark_id
   LEFT JOIN deployment_paper_fee_evidence f ON f.campaign_id=a.campaign_id
    AND f.id=a.fee_evidence_id
   LEFT JOIN deployment_marks previous ON previous.campaign_id=a.campaign_id
    AND previous.id=f.from_mark_id
   JOIN deployment_campaigns c ON c.id=a.campaign_id
   JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   LEFT JOIN deployment_operations o ON o.campaign_id=a.campaign_id
    AND o.id::text=m.provenance->>'operationId'
   WHERE a.campaign_id=$1 AND a.policy_version=$2 AND a.snapshot->>'markKind'='close_convert'
   ORDER BY a.id`,[campaignId,PAPER_CONVERSION_ACCOUNTING_POLICY_V3])).rows;
  if(!rows.length)return false;
  if(rows.length!==1)throw new DeploymentConflict('paper_close_convert_v3_terminal_lineage_ambiguous');
  const row=rows[0]!,snapshot=paperConversionAccountingV3Schema.safeParse(row.snapshot),
   evidence=marketProfileEvidenceSchema.safeParse(row.profile_evidence),
   interval=canonicalPaperFeeIntervalSchema.safeParse(row.fee_proof),
   runtime=sealedRuntimeIdentitySchema.safeParse(row.campaign_runtime),
   provenance=row.mark_provenance,
   markSource=provenance.source&&typeof provenance.source==='object'&&
    !Array.isArray(provenance.source)?provenance.source as Record<string,unknown>:null;
  if(!snapshot.success||!evidence.success||!interval.success||
   contentHash(snapshot.data)!==row.snapshot_hash||snapshot.data.sourceMarkId!==row.source_mark_id||
   snapshot.data.campaignId!==row.campaign_id||snapshot.data.markKind!=='close_convert'||
   snapshot.data.source.block!==row.mark_source_block||
   snapshot.data.source.hash.toLowerCase()!==row.mark_source_hash?.toLowerCase()||
   snapshot.data.source.block!==interval.data.to.block||
   snapshot.data.source.hash.toLowerCase()!==interval.data.to.hash.toLowerCase()||
   !runtime.success||contentHash(snapshot.data.runtimeIdentity)!==contentHash(runtime.data)||
   !markSource||markSource.block!==snapshot.data.source.block||
   typeof markSource.hash!=='string'||markSource.hash.toLowerCase()!==snapshot.data.source.hash.toLowerCase()||
   markSource.timestamp!==snapshot.data.source.timestamp||
   snapshot.data.feeEvidence?.id!==row.fee_id||
   snapshot.data.feeEvidence?.proofHash!==row.fee_proof_hash||
   snapshot.data.feeEvidence?.carryHash!==row.fee_carry_hash||
   !row.fee_evidence_id||row.fee_evidence_id!==row.fee_id||
   contentHash(row.fee_proof)!==row.fee_proof_hash||contentHash(row.fee_carry)!==row.fee_carry_hash||
   !row.previous_source_block||!row.previous_source_hash||
   row.fee_from_mark_id===null||row.fee_to_mark_id!==row.source_mark_id||
   row.mark_source_block!==interval.data.to.block||
   row.mark_source_hash?.toLowerCase()!==interval.data.to.hash.toLowerCase()||
   row.previous_source_block!==interval.data.from.block||
   row.previous_source_hash.toLowerCase()!==interval.data.from.hash.toLowerCase()||
   interval.data.coverage.stream!==evidence.data.streamKey||
   interval.data.coverage.targetSetHash!==evidence.data.indexerTargetSetHash||
   provenance.classification!=='paper_model_converted_close'||
   row.campaign_lifecycle!=='closed'||row.operation_status!=='succeeded'||
   row.operation_kind!=='close_convert'||
   provenance.terminalModelHash!==snapshot.data.closeModelHash||
   provenance.previewId!==row.operation_preview_id||
   provenance.previousMarkId!==row.fee_from_mark_id||provenance.feeEvidenceId!==row.fee_id||
   provenance.feeIntervalHash!==row.fee_proof_hash||provenance.feeCarryHash!==row.fee_carry_hash)
   throw new DeploymentConflict('paper_close_convert_v3_terminal_lineage_invalid');
  return true;
 }

 /** Rechecks every saved paper-accounting source and permanently revokes the
  * detected snapshot plus its dependent descendants after a canonical hash or
  * timestamp change. RPC/read failures throw and never create a revocation. */
 /** Appends exactly one RangeKeeper source-mark projection from already
  * persisted, adjacent fee evidence. No fee interval is inferred here. */
 async recordNextRangeKeeperPaperAccounting(campaignId:string,
  verifyAnchors:(chainId:number,sources:readonly {block:string;hash:string;timestamp:number}[])=>Promise<void>){
  return this.transaction(async db=>{
   await this.assertPaperPreparationMutationAllowed(db,campaignId);
   const campaign=(await db.query<{mode:string;chain_id:number;current_revision:number;allocation:unknown;
    strategy_id:string;profile:unknown;profile_hash:string}>(`SELECT c.mode,c.chain_id,c.current_revision,
    c.allocation,r.strategy_id,p.profile,p.profile_hash FROM deployment_campaigns c
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id WHERE c.id=$1 FOR UPDATE OF c`,
    [campaignId])).rows[0];
   const profile=marketProfileSchema.safeParse(campaign?.profile);
   if(!campaign||campaign.mode!=='paper'||campaign.strategy_id!=='rangekeeper_v1'||!profile.success||
    contentHash(profile.data)!==campaign.profile_hash)
    throw new DeploymentConflict('rangekeeper_paper_accounting_campaign_unavailable');
   const invalidated=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM
    deployment_paper_accounting_invalidations WHERE campaign_id=$1) AS found`,[campaignId])).rows[0]?.found;
   if(invalidated)throw new DeploymentConflict('rangekeeper_paper_accounting_history_invalidated');
   const mark=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`SELECT m.id::text,m.revision,
    m.source_block::text,m.source_hash,m.inventory,m.provenance FROM deployment_marks m
    LEFT JOIN deployment_paper_accounting a ON a.campaign_id=m.campaign_id AND a.source_mark_id=m.id
     AND a.policy_version=$2 WHERE m.campaign_id=$1 AND a.id IS NULL AND
     (m.provenance->>'classification' IN ('rangekeeper_paper_open_v1','rangekeeper_paper_recenter_v1',
      'rangekeeper_paper_close_retain_v1','rangekeeper_paper_close_convert_v1') OR m.id=(
       SELECT max(latest.id) FROM deployment_marks latest WHERE latest.campaign_id=$1) OR EXISTS(
       SELECT 1 FROM deployment_paper_fee_evidence f WHERE f.campaign_id=$1 AND f.to_mark_id=m.id))
     ORDER BY m.id LIMIT 1`,
    [campaignId,RANGEKEEPER_PAPER_ACCOUNTING_POLICY])).rows[0];
   if(!mark)return null;
   if(mark.revision!==campaign.current_revision||!mark.source_block||!mark.source_hash)
    throw new DeploymentConflict('rangekeeper_paper_accounting_mark_unavailable');
   const classification=String(mark.provenance.classification),kind:
    RangeKeeperPaperAccounting['markKind']=classification==='rangekeeper_paper_open_v1'?'open':
    classification==='rangekeeper_paper_mark_v1'?'valuation':classification==='rangekeeper_paper_recenter_v1'?'recenter':
    classification==='rangekeeper_paper_close_retain_v1'?'close_retain':
    classification==='rangekeeper_paper_close_convert_v1'?'close_convert':null as never;
   if(!kind)throw new DeploymentConflict('rangekeeper_paper_accounting_mark_unsupported');
   const src=paperFeeMarkSourceSchema.safeParse(mark.provenance.source),
    referenceUnavailable=Array.isArray(mark.provenance.referenceUnavailable)?mark.provenance.referenceUnavailable:[],
    rawRef=mark.provenance.reference,
    ref=rawRef as
    {price0?:unknown;price1?:unknown;nativePrice?:unknown;eligible?:unknown;proofHash?:unknown;proof?:unknown}|undefined,
    referenceProof=ref?.proof&&typeof ref.proof==='object'&&!Array.isArray(ref.proof)?ref.proof as Record<string,unknown>:null;
   if(!src.success||src.data.block!==mark.source_block||src.data.hash.toLowerCase()!==mark.source_hash.toLowerCase()||
    !ref||typeof ref.proofHash!=='string'||!referenceProof||
    referenceProofHash(referenceProof)!==ref.proofHash||
    (ref.price0!==null&&typeof ref.price0!=='string')||(ref.price1!==null&&typeof ref.price1!=='string')||
    (ref.nativePrice!==null&&typeof ref.nativePrice!=='string'))
    throw new DeploymentConflict('rangekeeper_paper_accounting_mark_reference_integrity');
   const proofFresh=rangeKeeperPaperReferenceProofFresh(referenceProof,referenceUnavailable),
    eligible=(ref.eligible===true||(ref.eligible===undefined&&referenceUnavailable.length===0&&
     (kind==='valuation'||kind==='recenter'||kind==='close_retain'||kind==='close_convert')))&&proofFresh,
    sourceRef={price0:ref.price0 as string|null,price1:ref.price1 as string|null,
    nativePrice:ref.nativePrice as string|null,proofHash:ref.proofHash,
    eligible:eligible&&Boolean(ref.price0&&ref.price1&&ref.nativePrice)&&
     [ref.price0,ref.price1,ref.nativePrice].every(value=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value)),
    proof:referenceProof};
   const priorMark=(await db.query<{id:string;classification:string}>(`SELECT m.id::text,
    m.provenance->>'classification' AS classification FROM deployment_paper_accounting a
    JOIN deployment_marks m ON m.id=a.source_mark_id WHERE a.campaign_id=$1
     AND a.policy_version=$3 AND m.id<$2 ORDER BY m.id DESC LIMIT 1`,
    [campaignId,mark.id,RANGEKEEPER_PAPER_ACCOUNTING_POLICY])).rows[0];
   const prior=priorMark?(await db.query<{snapshot:unknown;snapshot_hash:string}>(`SELECT snapshot,snapshot_hash
    FROM deployment_paper_accounting WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
    [campaignId,priorMark.id,RANGEKEEPER_PAPER_ACCOUNTING_POLICY])).rows[0]:null;
   let priorData:RangeKeeperPaperAccounting|null=null;
   if(prior){const parsed=rangeKeeperPaperAccountingSchema.safeParse(prior.snapshot);
    if(!parsed.success||contentHash(parsed.data)!==prior.snapshot_hash||parsed.data.sourceMarkId!==priorMark!.id||
     parsed.data.campaignId!==campaignId)throw new DeploymentConflict('rangekeeper_paper_accounting_prior_integrity');
    priorData=parsed.data;}
   if(kind==='open'?Boolean(priorMark):!priorData)
    throw new DeploymentConflict('rangekeeper_paper_accounting_prior_missing');
   let fee:{id:string;from_mark_id:string;proof:CanonicalPaperFeeInterval;proof_hash:string;
    carry:PaperFeeCarry;carry_hash:string}|undefined;
   if(kind!=='open'){
    fee=(await db.query<typeof fee extends infer _T?{id:string;from_mark_id:string;proof:CanonicalPaperFeeInterval;
     proof_hash:string;carry:PaperFeeCarry;carry_hash:string}:never>(`SELECT id::text,from_mark_id::text,proof,
     proof_hash,carry,carry_hash FROM deployment_paper_fee_evidence WHERE campaign_id=$1 AND to_mark_id=$2`,
     [campaignId,mark.id])).rows[0];
    if(!fee){await db.query('COMMIT');return null;}
    if(fee.from_mark_id!==priorMark?.id||contentHash(fee.proof)!==fee.proof_hash||
     contentHash(fee.carry)!==fee.carry_hash)
     throw new DeploymentConflict('rangekeeper_paper_accounting_fee_evidence_missing');
   }
   const open=(await db.query<{inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`
    SELECT inventory,provenance FROM deployment_marks WHERE campaign_id=$1
     AND provenance->>'classification'='rangekeeper_paper_open_v1' ORDER BY id LIMIT 1`,[campaignId])).rows[0];
   const openModel=(open?.provenance.confirmedOpen as {model?:Record<string,any>}|undefined)?.model,
    allocation=campaign.allocation as {token0Raw?:string;token1Raw?:string;nativeWei?:string};
   if(!open||!openModel||!allocation.token0Raw||!allocation.token1Raw||!allocation.nativeWei||
    !openModel.costs?.open||!openModel.poolState)
    throw new DeploymentConflict('rangekeeper_paper_accounting_open_baseline_missing');
   if(open.provenance.modelHash!==contentHash(openModel)||!openModel.reference?.proof||
    referenceProofHash(openModel.reference.proof)!==openModel.reference.proofHash||
    openModel.reference.eligible!==true)
    throw new DeploymentConflict('rangekeeper_paper_accounting_open_baseline_integrity');
   const epoch=Number(mark.provenance.epoch??
    (mark.provenance.currentEpoch as {epoch?:unknown}|undefined)?.epoch??0),inv=mark.inventory as Record<string,any>,
    position=inv.position as {tickLower:number;tickUpper:number;liquidity:string}|null,
    idle=inv.idle as {token0?:string;token1?:string}|undefined;
   let principal0=0n,principal1=0n;
   if(position){const pool=(mark.provenance.poolState??(kind==='open'?openModel.poolState:null)) as
     {sqrtPriceX96?:string}|undefined;
    if(!pool?.sqrtPriceX96)throw new DeploymentConflict('rangekeeper_paper_accounting_pool_state_missing');
    const amounts=principalAmounts({liquidity:BigInt(position.liquidity),sqrtPriceX96:BigInt(pool.sqrtPriceX96),
     tickLower:position.tickLower,tickUpper:position.tickUpper});principal0=amounts.amount0;principal1=amounts.amount1;}
   const retained=inv.retainedPrincipalLowerBound as {token0Raw?:string;token1Raw?:string}|undefined,
    idle0=BigInt(idle?.token0??(position===null?(inv.token0Raw??retained?.token0Raw??'0'):'0')),
    idle1=BigInt(idle?.token1??(position===null?(inv.token1Raw??retained?.token1Raw??'0'):'0'));
   let fee0=BigInt(priorData?.inventory.fee0Raw??'0'),fee1=BigInt(priorData?.inventory.fee1Raw??'0'),
    accruedFee0=0n,accruedFee1=0n;
   if(fee){
    const current0=BigInt(fee.carry.token0.lowerAmountRaw),current1=BigInt(fee.carry.token1.lowerAmountRaw),
     previous0=priorData?.feeEvidence?BigInt((await db.query<{carry:PaperFeeCarry}>(`SELECT carry
      FROM deployment_paper_fee_evidence WHERE id=$1`,[priorData.feeEvidence.id])).rows[0]?.carry.token0.lowerAmountRaw??'0'):0n,
     previous1=priorData?.feeEvidence?BigInt((await db.query<{carry:PaperFeeCarry}>(`SELECT carry
      FROM deployment_paper_fee_evidence WHERE id=$1`,[priorData.feeEvidence.id])).rows[0]?.carry.token1.lowerAmountRaw??'0'):0n;
    const delta0=current0-previous0;
    // A recenter closes the prior epoch: its whole carry is new retained fee
    // cash; within an epoch only the adjacent carry delta is added.
    const sameFeeEpoch=priorMark?.classification!=='rangekeeper_paper_recenter_v1'&&
     (kind==='recenter'?priorData?.epoch===epoch-1:priorData?.epoch===epoch);
    accruedFee0=sameFeeEpoch?delta0:current0;
    accruedFee1=sameFeeEpoch?current1-previous1:current1;
    if(accruedFee0<0n||accruedFee1<0n)throw new DeploymentConflict('rangekeeper_paper_fee_carry_regressed');
    fee0+=accruedFee0;fee1+=accruedFee1;
   }
   const ref0=sourceRef.price0&&/^(0|[1-9][0-9]*)$/.test(sourceRef.price0)?BigInt(sourceRef.price0):null,
    ref1=sourceRef.price1&&/^(0|[1-9][0-9]*)$/.test(sourceRef.price1)?BigInt(sourceRef.price1):null,
    refNative=sourceRef.nativePrice&&/^(0|[1-9][0-9]*)$/.test(sourceRef.nativePrice)?BigInt(sourceRef.nativePrice):null,
    p=profile.data.pool,WAD=10n**18n,token0Raw=principal0+idle0+fee0,token1Raw=principal1+idle1+fee1,
    nativeWei=BigInt((inv.nativeWei as string|undefined)??
     (kind==='close_retain'||kind==='close_convert'?String(BigInt(priorData?.inventory.nativeWei??'0')-
      BigInt((mark.provenance.modeledCosts as {boundWei?:string}|undefined)?.boundWei??'0')):
      (mark.provenance.kernelSnapshot as {nativeWei?:string}|undefined)?.nativeWei??
       priorData?.inventory.nativeWei??'0')),
    value=(a:bigint,price:bigint,decimals:number)=>a*price/10n**BigInt(decimals),
    openingRef=openModel.reference as {price0?:string|null;price1?:string|null;nativePrice?:string|null},
    openingEligible=Boolean(openingRef.price0&&openingRef.price1&&openingRef.nativePrice&&openModel.reference.eligible),
    pricesValid=sourceRef.eligible&&ref0!==null&&ref1!==null&&refNative!==null&&openingEligible,
    initialCapital=openingEligible?value(BigInt(allocation.token0Raw),BigInt(openingRef.price0!),p.decimals0)+
     value(BigInt(allocation.token1Raw),BigInt(openingRef.price1!),p.decimals1)+
     value(BigInt(allocation.nativeWei),BigInt(openingRef.nativePrice!),18):null,
    nav=pricesValid?value(token0Raw,ref0!,p.decimals0)+value(token1Raw,ref1!,p.decimals1)+
     value(nativeWei,refNative!,18):null,
    passive=pricesValid?value(BigInt(allocation.token0Raw),ref0!,p.decimals0)+
     value(BigInt(allocation.token1Raw),ref1!,p.decimals1)+value(BigInt(allocation.nativeWei),refNative!,18):null,
    cumulativeFee=pricesValid?value(fee0,ref0!,p.decimals0)+value(fee1,ref1!,p.decimals1):null,
    intervalFee=pricesValid?String(value(accruedFee0,ref0!,p.decimals0)+
     value(accruedFee1,ref1!,p.decimals1)):null;
   const initialBound=String(openModel.costs.open.boundValue),initialWei=String(openModel.costs.open.boundWei),
    operationCosts=mark.provenance.modeledCosts as {boundValue?:string;boundWei?:string}|undefined,
    recenterBound=classification==='rangekeeper_paper_recenter_v1'?String(operationCosts?.boundValue??''):'0',
    recenterWei=classification==='rangekeeper_paper_recenter_v1'?String(operationCosts?.boundWei??''):'0',
    exitBound=kind==='close_retain'||kind==='close_convert'?String(operationCosts?.boundValue??''):'0',
    exitWei=kind==='close_retain'||kind==='close_convert'?String(operationCosts?.boundWei??''):'0';
   if([initialBound,initialWei,recenterBound,recenterWei,exitBound,exitWei].some(v=>
    !/^(0|[1-9][0-9]*)$/.test(v)))throw new DeploymentConflict('rangekeeper_paper_accounting_cost_missing');
   const
    cumulativeBoundValue=String(BigInt(priorData?.modeledCosts.cumulativeBoundValue??initialBound)+
     (kind==='recenter'?BigInt(recenterBound):kind==='close_retain'||kind==='close_convert'?BigInt(exitBound):0n)),
    cumulativeBoundWei=String(BigInt(priorData?.modeledCosts.cumulativeBoundWei??initialWei)+
     (kind==='recenter'?BigInt(recenterWei):kind==='close_retain'||kind==='close_convert'?BigInt(exitWei):0n)),
    snapshot=rangeKeeperPaperAccountingSchema.parse({policyVersion:RANGEKEEPER_PAPER_ACCOUNTING_POLICY,
     classification:'provisional_paper_scenario',campaignId,sourceMarkId:mark.id,markKind:kind,source:src.data,
     profileHash:campaign.profile_hash,epoch,reference:sourceRef,
     feeEvidence:fee?{id:(await db.query<{id:string}>(`SELECT id::text FROM deployment_paper_fee_evidence
      WHERE campaign_id=$1 AND to_mark_id=$2`,[campaignId,mark.id])).rows[0]!.id,
      proofHash:fee.proof_hash,carryHash:fee.carry_hash,upper0Raw:fee.carry.token0.upperAmountRaw,
      upper1Raw:fee.carry.token1.upperAmountRaw}:null,
     modeledCosts:{initialOpenBoundValue:initialBound,initialOpenBoundWei:initialWei,
      cumulativeBoundValue,cumulativeBoundWei,paidCostsAvailable:false},
     inventory:{token0Raw:String(token0Raw),token1Raw:String(token1Raw),nativeWei:String(nativeWei),
      principal0Raw:String(principal0),principal1Raw:String(principal1),fee0Raw:String(fee0),fee1Raw:String(fee1),
      cumulativeGasWei:null,hasLiquidity:position!==null},
     economics:{initialCapitalQuote:initialCapital===null?null:String(initialCapital),
      netNavQuote:nav===null?null:String(nav),passiveQuote:passive===null?null:String(passive),
      absolutePnlQuote:initialCapital!==null&&nav!==null?String(nav-initialCapital):null,
      alphaQuote:nav!==null&&passive!==null?String(nav-passive):null,
      cumulativeFeeValueQuote:cumulativeFee===null?null:String(cumulativeFee),
      cumulativeGasExpenseQuote:null,intervalFeeAccrualQuote:intervalFee===null?null:String(intervalFee),
      markGasExpenseQuote:null},limitations:['modeled_hypothetical_fee_share','modeled_costs_not_paid',
      'retained_fees_not_reinvested','lower_integer_allocation_point',
      ...(pricesValid?[]:['independent_reference_unavailable']),
      ...(!fee&&kind!=='open'?['fee_coverage_unavailable' as const]:[]),
      ...(!pricesValid?['passive_comparator_unavailable' as const]:[]),
      ...(kind==='close_retain'||kind==='close_convert'?['terminal_custody_unobserved' as const]:[])]});
   const sources=[src.data];
   if(priorData)sources.push(priorData.source);
   const openSource=paperFeeMarkSourceSchema.parse(openModel.source);sources.push(openSource);
   await verifyAnchors(campaign.chain_id,sources);
   const snapshotHash=contentHash(snapshot),insert=(await db.query<{id:string}>(`INSERT INTO deployment_paper_accounting
    (campaign_id,source_mark_id,policy_version,snapshot,snapshot_hash)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(campaign_id,source_mark_id,policy_version) DO NOTHING RETURNING id::text`,
    [campaignId,mark.id,RANGEKEEPER_PAPER_ACCOUNTING_POLICY,JSON.stringify(snapshot),snapshotHash])).rows[0];
   if(!insert){const prior=(await db.query<{id:string;snapshot:RangeKeeperPaperAccounting;snapshot_hash:string}>(`
    SELECT id::text,snapshot,snapshot_hash FROM deployment_paper_accounting
    WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
    [campaignId,mark.id,RANGEKEEPER_PAPER_ACCOUNTING_POLICY])).rows[0];
    if(!prior||prior.snapshot_hash!==snapshotHash||contentHash(prior.snapshot)!==snapshotHash)
     throw new DeploymentConflict('rangekeeper_paper_accounting_conflict');
    return {accountingId:prior.id,markId:mark.id,snapshotHash,replayed:true,snapshot};}
   return {accountingId:insert.id,markId:mark.id,snapshotHash,replayed:false,snapshot};
  });
 }

 async rangeKeeperPaperAccountingBacklog(campaignId:string){
  const row=(await this.readPool.query<{count:string}>(`SELECT count(*)::text AS count
   FROM deployment_marks m LEFT JOIN deployment_paper_accounting a
    ON a.campaign_id=m.campaign_id AND a.source_mark_id=m.id AND a.policy_version=$2
   WHERE m.campaign_id=$1 AND
    (m.provenance->>'classification' IN ('rangekeeper_paper_open_v1','rangekeeper_paper_recenter_v1',
     'rangekeeper_paper_close_retain_v1','rangekeeper_paper_close_convert_v1') OR m.id=(
      SELECT max(latest.id) FROM deployment_marks latest WHERE latest.campaign_id=$1) OR EXISTS(
      SELECT 1 FROM deployment_paper_fee_evidence f WHERE f.campaign_id=$1 AND f.to_mark_id=m.id))
    AND a.id IS NULL`,[campaignId,RANGEKEEPER_PAPER_ACCOUNTING_POLICY])).rows[0];
  return Number(row?.count??0);
 }

 async auditPaperAccounting(campaignId:string,
  verifyAnchors:(chainId:number,sources:readonly PaperAccountingAnchor[])=>Promise<PaperAccountingAnchorMismatch|null>,
  policyVersion:string=PAPER_ACCOUNTING_POLICY){
  if(![PAPER_ACCOUNTING_POLICY,PAPER_CONVERSION_ACCOUNTING_POLICY,
   PAPER_CONVERSION_ACCOUNTING_POLICY_V2,PAPER_CONVERSION_ACCOUNTING_POLICY_V3,
   RANGEKEEPER_PAPER_ACCOUNTING_POLICY].includes(policyVersion))
   throw new DeploymentConflict('paper_accounting_policy_unsupported');
  const conversionPolicy=policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY;
  const conversionPolicyV2=policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY_V2;
  const conversionPolicyV3=policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY_V3;
  const rangeKeeperPolicy=policyVersion===RANGEKEEPER_PAPER_ACCOUNTING_POLICY;
  return this.transaction(async db=>{
   const campaign=(await db.query<{mode:string;chain_id:number}>(`
    SELECT mode,chain_id FROM deployment_campaigns WHERE id=$1 FOR UPDATE`,
    [campaignId])).rows[0];
   if(!campaign||campaign.mode!=='paper')
    throw new DeploymentConflict('paper_accounting_campaign_unavailable');
   const existing=(await db.query<{accounting_id:string;detected_accounting_id:string}>(`
    SELECT accounting_id::text,detected_accounting_id::text
    FROM deployment_paper_accounting_invalidations WHERE campaign_id=$1
    ORDER BY deployment_paper_accounting_invalidations.accounting_id LIMIT 1`,[campaignId])).rows[0];
   if(existing)return {checked:0,invalidated:[] as string[],
    alreadyInvalidated:true,detectedAccountingId:existing.detected_accounting_id};
   const rows=(await db.query<{id:string;source_mark_id:string;snapshot:unknown;snapshot_hash:string}>(`
    SELECT id::text,source_mark_id::text,snapshot,snapshot_hash
    FROM deployment_paper_accounting WHERE campaign_id=$1 AND policy_version=$2
    ORDER BY deployment_paper_accounting.source_mark_id LIMIT 10001`,
    [campaignId,policyVersion])).rows;
   if(rows.length>10000)throw new DeploymentConflict('paper_accounting_audit_bound');
   const sources:PaperAccountingAnchor[]=rows.map(row=>{
    const parsed=conversionPolicy?paperConversionAccountingSchema.safeParse(row.snapshot):
     conversionPolicyV2?paperConversionAccountingV2Schema.safeParse(row.snapshot):
     conversionPolicyV3?paperConversionAccountingV3Schema.safeParse(row.snapshot):
     rangeKeeperPolicy?rangeKeeperPaperAccountingSchema.safeParse(row.snapshot):
     paperAccountingSchema.safeParse(row.snapshot);
    if(!parsed.success||contentHash(parsed.data)!==row.snapshot_hash||
     parsed.data.campaignId!==campaignId||parsed.data.sourceMarkId!==row.source_mark_id)
     throw new DeploymentConflict('paper_accounting_audit_integrity');
    return {accountingId:row.id,markId:row.source_mark_id,...parsed.data.source};
   });
   if(!sources.length)return {checked:0,invalidated:[] as string[],
    alreadyInvalidated:false,detectedAccountingId:null};
   const mismatch=await verifyAnchors(campaign.chain_id,sources);
   if(!mismatch)return {checked:sources.length,invalidated:[] as string[],
    alreadyInvalidated:false,detectedAccountingId:null};
   const detected=sources.find(source=>source.accountingId===mismatch.accountingId);
   if(!detected||!/^0x[0-9a-fA-F]{64}$/.test(mismatch.actual.hash)||
    !Number.isSafeInteger(mismatch.actual.timestamp)||mismatch.actual.timestamp<0||
    (mismatch.actual.hash.toLowerCase()===detected.hash.toLowerCase()&&
     mismatch.actual.timestamp===detected.timestamp))
    throw new DeploymentConflict('paper_accounting_audit_result_invalid');
   const evidence={verificationClass:'canonical_anchor_recheck_v1',
    detectedAt:new Date().toISOString(),savedSource:{block:detected.block,
     hash:detected.hash,timestamp:detected.timestamp},
    actualSource:{block:detected.block,hash:mismatch.actual.hash,
     timestamp:mismatch.actual.timestamp}};
   const invalidated=(await db.query<{accounting_id:string}>(`
    INSERT INTO deployment_paper_accounting_invalidations
     (campaign_id,accounting_id,detected_accounting_id,reason,evidence)
    SELECT $1,a.id,$2,'canonical_anchor_changed',$3
    FROM deployment_paper_accounting a
     WHERE a.campaign_id=$1 AND a.source_mark_id >= $4
    ORDER BY a.source_mark_id
    ON CONFLICT(accounting_id) DO NOTHING RETURNING accounting_id::text`,
    [campaignId,detected.accountingId,JSON.stringify(evidence),
     detected.markId])).rows.map(row=>row.accounting_id);
   if(!invalidated.length)throw new DeploymentConflict('paper_accounting_invalidation_failed');
   return {checked:sources.length,invalidated,alreadyInvalidated:false,
    detectedAccountingId:detected.accountingId};
  });
 }

 /** A retain-close records a modeled principal lower bound and an explicit
  * unknown capital release. It never turns missing fee or paid-gas evidence
  * into a zero or an exact final balance. */
 async prepareTrustedPaperCloseConvert(operationId:string,workerId:string,
  verifyAnchors:(chainId:number,sources:readonly {block:string;hash:string;timestamp:number}[])=>Promise<void>){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  return this.transaction(async db=>{
   const row=(await db.query<{campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_until:Date|null;claim_valid:boolean|null;
    mode:string;lifecycle:string;current_revision:number;
    open_mark_id:string;profile:unknown;profile_hash:string;profile_evidence:unknown;
    config:unknown;config_hash:string;
    strategy_id:string;proposal:Record<string,unknown>;request:Record<string,unknown>;
    evidence:Record<string,unknown>;content_digest:string;expected_revision:number;expires_at:Date}>(`
    SELECT o.campaign_id,o.preview_id,o.kind,o.status,o.claimed_by,o.claim_until,
     (o.claim_until>=clock_timestamp()) AS claim_valid,c.mode,c.lifecycle,
     c.current_revision,open_mark.id::text AS open_mark_id,p.profile,p.profile_hash,
     p.evidence AS profile_evidence,
     r.config,r.config_hash,r.strategy_id,
     v.proposal,v.request,v.evidence,v.content_digest,v.expected_revision,v.expires_at
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN LATERAL (SELECT (array_agg(id ORDER BY id))[1] AS id FROM deployment_marks
     WHERE campaign_id=c.id AND provenance->>'classification'='paper_model_provisional'
     HAVING count(*)=1) open_mark ON TRUE
    JOIN deployment_previews v ON v.id=o.preview_id WHERE o.id=$1 FOR UPDATE OF o,c`,
    [operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='close_convert')
    throw new DeploymentConflict('paper_close_convert_operation_unavailable');
   const priorMarks=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;calibration_profile_ids:string[];provenance:Record<string,unknown>}>(`
    SELECT id::text,source_block::text,source_hash,inventory,calibration_profile_ids,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND provenance->>'operationId'=$2 LIMIT 2`,
    [row.campaign_id,operationId])).rows;
   if(row.status==='succeeded'){
    if(priorMarks.length!==1)throw new DeploymentConflict('paper_close_convert_replay_integrity');
    return {markId:priorMarks[0]!.id,replayed:true,pending:false};
   }
   const now=Date.now(),pendingMark=priorMarks[0];
   if(row.lifecycle!=='closing'||row.status!=='reconciling'||row.claimed_by!==workerId||
    !row.claim_valid)
    throw new DeploymentConflict('paper_close_convert_claim_lost');
   if(priorMarks.length>1)throw new DeploymentConflict('paper_close_convert_replay_integrity');
   if(row.current_revision!==row.expected_revision||(!pendingMark&&row.expires_at.getTime()<=now))
    throw new DeploymentConflict('paper_close_convert_preview_stale');
   if(previewDigest({campaignId:row.campaign_id,expectedRevision:row.expected_revision,
    kind:'close_convert',request:row.request,proposal:row.proposal,evidence:row.evidence,
    expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('paper_close_convert_preview_integrity');
   const parsed=paperCloseConvertModelSchema.safeParse(row.proposal.paperCloseConvertModel),
    profile=marketProfileSchema.safeParse(row.profile),
    profileEvidence=marketProfileEvidenceSchema.safeParse(row.profile_evidence);
   if(!parsed.success||!profile.success||!profileEvidence.success||
    contentHash(row.profile)!==row.profile_hash||
    referenceProofHash(profileEvidence.data.referenceProof)!==profileEvidence.data.references.proofHash||
    (['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
     .some(key=>profile.data.pool[key].toLowerCase()!==
      profileEvidence.data.contractHashes[key].toLowerCase())||
    !row.config||typeof row.config!=='object'||contentHash(row.config)!==row.config_hash||
    row.strategy_id!=='static_manual_v1')
    throw new DeploymentConflict('paper_close_convert_model_integrity');
   const model=parsed.data,config=row.config as Record<string,unknown>;
   if(model.campaignId!==row.campaign_id||model.revision!==row.current_revision||
    referenceProofHash(model.referenceProof)!==model.referenceProofHash||
    config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||
    config.stateSchemaVersion!==1)
    throw new DeploymentConflict('paper_close_convert_config_integrity');
   const {strategyId:_strategyId,strategyVersion:_strategyVersion,
    stateSchemaVersion:_stateSchemaVersion,...parameters}=config;
   const openMark=(await db.query<{id:string;revision:number;source_block:string|null;
    source_hash:string|null;inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,source_block::text,source_hash,inventory,provenance
    FROM deployment_marks WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [model.openMarkId,row.campaign_id])).rows[0];
   if(!openMark||openMark.revision!==row.current_revision||
    openMark.provenance.classification!=='paper_model_provisional'||
    !openMark.provenance.operationId||!openMark.provenance.previewId||
    !openMark.source_block||!openMark.source_hash)
    throw new DeploymentConflict('paper_close_convert_open_mark_unavailable');
   const openPreview=(await db.query<{proposal:Record<string,unknown>}>(`
    SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
    [openMark.provenance.previewId,row.campaign_id])).rows[0];
   const openParsed=paperOpenModelSchema.safeParse(openPreview?.proposal.paperOpenModel);
   if(!openParsed.success||openParsed.data.campaignId!==row.campaign_id||
    openParsed.data.revision!==row.current_revision||openParsed.data.profileHash!==row.profile_hash||
    openParsed.data.configHash!==row.config_hash||contentHash(openParsed.data)!==openMark.provenance.modelHash||
    contentHash(openParsed.data)!==model.openModelHash||model.openMarkId!==openMark.id)
    throw new DeploymentConflict('paper_close_convert_open_model_integrity');
   const latest=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND ($2::bigint IS NULL OR id<$2::bigint)
    ORDER BY deployment_marks.id DESC LIMIT 1`,[row.campaign_id,pendingMark?.id??null])).rows[0];
   if(!latest||latest.id!==model.previousMarkId||latest.source_block===null||latest.source_hash===null||
    latest.source_block!==model.previousSource.block||
    latest.source_hash.toLowerCase()!==model.previousSource.hash.toLowerCase()||
    BigInt(model.source.block)<=BigInt(latest.source_block)||
    !['paper_model_provisional','paper_model_principal_valuation'].includes(
     String(latest.provenance.classification)))
    throw new DeploymentConflict('paper_close_convert_prior_mark_changed');
   const priorTimestamp=(latest.provenance.source as {timestamp?:unknown}|undefined)?.timestamp;
   if(!Number.isSafeInteger(priorTimestamp)||model.source.timestamp<(priorTimestamp as number))
    throw new DeploymentConflict('paper_close_convert_source_time_regressed');
   if(!pendingMark&&(model.source.timestamp*1000>now||now-model.source.timestamp*1000>180_000||
    Date.parse(model.costs.gasPriceObservedAt)>now||now-Date.parse(model.costs.gasPriceObservedAt)>120_000))
    throw new DeploymentConflict('paper_close_convert_source_stale');
   const {costs}=await replayPaperCloseConvert(db,model,openParsed.data,profile.data,parameters,
    pendingMark?Date.parse(model.costs.gasPriceObservedAt):now);
   const modelHash=contentHash(model),profileIds=costs.stages.map(stage=>stage.profileId);
   if(pendingMark){
    if(pendingMark.source_block!==model.source.block||
     pendingMark.source_hash?.toLowerCase()!==model.source.hash.toLowerCase()||
     pendingMark.provenance.closeConvertModelHash!==modelHash||
     contentHash(pendingMark.inventory.retainedPrincipalLowerBound)!==contentHash(model.principal)||
     contentHash(pendingMark.inventory.idleLowerBound)!==contentHash(model.idle)||
     contentHash(pendingMark.provenance.modeledCosts)!==contentHash(model.costs)||
     contentHash(pendingMark.provenance.conversionRoute)!==contentHash(model.conversionRoute)||
     contentHash(pendingMark.calibration_profile_ids)!==contentHash(profileIds))
     throw new DeploymentConflict('paper_close_convert_pending_mark_conflict');
   }
   const sources=[openParsed.data.source,
    {block:latest.source_block,hash:latest.source_hash,
     timestamp:latest.provenance.source&&typeof latest.provenance.source==='object'?
      Number((latest.provenance.source as Record<string,unknown>).timestamp):-1},model.source];
   if(sources.some(source=>!Number.isSafeInteger(source.timestamp)||source.timestamp<0))
    throw new DeploymentConflict('paper_close_convert_source_invalid');
   await verifyAnchors(profile.data.pool.chainId,sources);
   if(pendingMark)return {markId:pendingMark.id,replayed:true,pending:true};
   const source={classification:'paper_model_converted_close',operationId,previewId:row.preview_id,
    openMarkId:openMark.id,openModelHash:model.openModelHash,
    closeConvertModelHash:modelHash,referenceProofHash:model.referenceProofHash,
    source:model.source,poolState:model.poolState,reference:model.reference,
    modeledCosts:model.costs,conversionRoute:model.conversionRoute,
    quoteAvailable:false,paidCostsAvailable:false,
    unavailable:['fee_capture_pending','canonical_quote_pending','paid_gas','final_custody']};
   const inventory={classification:'paper_model_converted_close',position:null,
    token0Raw:null,token1Raw:null,nativeWei:null,
    retainedPrincipalLowerBound:model.principal,idleLowerBound:model.idle,
    unobserved:['lower_fee_carry','conversion_quote','paid_gas','final_custody']};
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,NULL,$6,$7) RETURNING id::text`,
    [row.campaign_id,row.current_revision,model.source.block,model.source.hash,
     JSON.stringify(inventory),profileIds,JSON.stringify(source)])).rows[0]!;
   await db.query(`UPDATE deployment_operations SET stage='paper_close_convert_mark_pending',
    updated_at=clock_timestamp() WHERE id=$1`,[operationId]);
   return {markId:mark.id,replayed:false,pending:true};
  });
 }

 /** Completes a conversion close only after the adjacent fee carry and a
  * canonical v2 quote/cost snapshot have been persisted. The paid ledger stays
  * unknown; this operation only records provisional modeled capital-out
  * references and the campaign's reconciled paper lifecycle. */
 /** Atomically completes a source-exact static/manual V3 conversion. The V2
  * completion method below remains unchanged and continues to read only V2
  * terminal models/profiles. */
 async completeTrustedStaticPaperCloseConvertV3(input:{operationId:string;workerId:string;
  verification:{status:'verified';modelHash:string;feeReplayHash:string;previousFeeEvidenceId:string;
   intervalHash:string;feeCarryHash:string;gasReportHash:string;quoteHash:string;
   source:PaperCanonicalAnchor;
   actionAvailable:false;bookingAvailable:false};
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}){
  const {verification}=input;
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(input.workerId)||
   verification.status!=='verified'||verification.actionAvailable!==false||
   verification.bookingAvailable!==false)
   throw new DeploymentConflict('paper_close_convert_v3_replay_provenance_unavailable');
  const currentRuntime=loadRuntimeIdentity();
  if(!currentRuntime)throw new DeploymentConflict('paper_close_convert_v3_runtime_unavailable');
  return this.transaction(async db=>{
   const row=(await db.query<{campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_valid:boolean|null;mode:string;lifecycle:string;
    current_revision:number;chain_id:number;open_mark_id:string|null;runtime_identity:unknown;
    profile:unknown;profile_hash:string;profile_evidence:unknown;config:unknown;config_hash:string;
    strategy_id:string;proposal:Record<string,unknown>;request:Record<string,unknown>;
    evidence:Record<string,unknown>;content_digest:string;expected_revision:number;expires_at:Date}>(`
    SELECT o.campaign_id,o.preview_id,o.kind,o.status,o.claimed_by,
     (o.claim_until>=clock_timestamp()) AS claim_valid,c.mode,c.lifecycle,c.current_revision,
     c.chain_id,open_mark.id::text AS open_mark_id,c.runtime_identity,p.profile,p.profile_hash,
     p.evidence AS profile_evidence,r.config,r.config_hash,r.strategy_id,
     v.proposal,v.request,v.evidence,v.content_digest,v.expected_revision,v.expires_at
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN LATERAL (SELECT (array_agg(id ORDER BY id))[1] AS id FROM deployment_marks
     WHERE campaign_id=c.id AND provenance->>'classification'='paper_model_provisional'
     HAVING count(*)=1) open_mark ON TRUE
    JOIN deployment_previews v ON v.id=o.preview_id WHERE o.id=$1 FOR UPDATE OF o,c`,
    [input.operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='close_convert')
    throw new DeploymentConflict('paper_close_convert_v3_operation_unavailable');
   const runtime=sealedRuntimeIdentitySchema.safeParse(row.runtime_identity);
   if(!runtime.success||contentHash(runtime.data)!==contentHash(currentRuntime))
    throw new DeploymentConflict('paper_close_convert_v3_runtime_mismatch');
   const replayed=row.status==='succeeded';
   if(replayed){
    if(row.lifecycle!=='closed')throw new DeploymentConflict('paper_close_convert_v3_replay_integrity');
   }else if(row.lifecycle!=='closing'||row.status!=='reconciling'||row.claimed_by!==input.workerId||
    !row.claim_valid)
    throw new DeploymentConflict('paper_close_convert_v3_claim_lost');
   if(row.current_revision!==row.expected_revision||
    previewDigest({campaignId:row.campaign_id,expectedRevision:row.expected_revision,
     kind:'close_convert',request:row.request,proposal:row.proposal,evidence:row.evidence,
     expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('paper_close_convert_v3_preview_integrity');
   let model:PaperStaticCloseConvertTerminalModel;
   try{model=parsePaperStaticCloseConvertTerminalV3(row.proposal.paperCloseConvertTerminalV3);}
   catch{throw new DeploymentConflict('paper_close_convert_v3_model_invalid');}
   if(model.campaignId!==row.campaign_id||model.revision!==row.current_revision||
    model.modelHash!==verification.modelHash||model.feeReplay.replayHash!==verification.feeReplayHash||
    model.feeReplay.previousFeeEvidenceId!==verification.previousFeeEvidenceId||
    model.feeReplay.intervalHash!==verification.intervalHash||
    model.feeReplay.feeCarryHash!==verification.feeCarryHash||
    model.gasReport.reportHash!==verification.gasReportHash||
    model.quote.quoteHash!==verification.quoteHash||
    contentHash(model.source)!==contentHash(verification.source))
    throw new DeploymentConflict('paper_close_convert_v3_verified_binding_changed');
   const profile=marketProfileSchema.safeParse(row.profile),
    profileEvidence=marketProfileEvidenceSchema.safeParse(row.profile_evidence),
    config=row.config&&typeof row.config==='object'&&!Array.isArray(row.config)?
     row.config as Record<string,unknown>:null;
   if(!profile.success||!profileEvidence.success||contentHash(profile.data)!==row.profile_hash||
    referenceProofHash(profileEvidence.data.referenceProof)!==profileEvidence.data.references.proofHash||
    !config||contentHash(config)!==row.config_hash||row.strategy_id!=='static_manual_v1'||
    model.scope.profileHash!==row.profile_hash||model.openModelHash!==model.prestateReport.openModelHash||
    model.prestateReport.openModel.campaignId!==row.campaign_id||
    model.prestateReport.openModel.revision!==row.current_revision||
    model.prestateReport.openModel.profileHash!==row.profile_hash||
    model.prestateReport.openModel.configHash!==row.config_hash||
    profileEvidence.data.streamKey!==model.feeReplay.stream||
    profileEvidence.data.indexerTargetSetHash!==model.feeReplay.targetSetHash)
    throw new DeploymentConflict('paper_close_convert_v3_profile_or_config_changed');
   for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash',
    'quoterCodeHash'] as const)
    if(profile.data.pool[key].toLowerCase()!==profileEvidence.data.contractHashes[key].toLowerCase())
     throw new DeploymentConflict('paper_close_convert_v3_profile_integrity');
   const openMark=(await db.query<{id:string;revision:number;source_block:string|null;
    source_hash:string|null;provenance:Record<string,unknown>}>(`SELECT id::text,revision,
    source_block::text,source_hash,provenance FROM deployment_marks
    WHERE id=$1 AND campaign_id=$2 FOR SHARE`,[model.openMarkId,row.campaign_id])).rows[0],
    openPreview=(await db.query<{proposal:Record<string,unknown>}>(`SELECT proposal
    FROM deployment_previews WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [openMark?.provenance.previewId,row.campaign_id])).rows[0],
    open=paperOpenModelSchema.safeParse(openPreview?.proposal.paperOpenModel);
   if(!openMark||!open.success||row.open_mark_id!==model.openMarkId||
    openMark.revision!==row.current_revision||openMark.provenance.classification!==
     'paper_model_provisional'||openMark.source_block!==open.data.source.block||
    openMark.source_hash?.toLowerCase()!==open.data.source.hash.toLowerCase()||
    contentHash(open.data)!==model.openModelHash||contentHash(open.data)!==
     contentHash(model.prestateReport.openModel))
    throw new DeploymentConflict('paper_close_convert_v3_open_model_changed');
   const priorMark=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND id=$2 FOR SHARE`,
    [row.campaign_id,model.previousMarkId])).rows[0];
   if(!priorMark||priorMark.source_block!==model.feeReplay.from.block||
    priorMark.source_hash?.toLowerCase()!==model.feeReplay.from.hash.toLowerCase()||
    !['paper_model_provisional','paper_model_principal_valuation'].includes(
     String(priorMark.provenance.classification)))
    throw new DeploymentConflict('paper_close_convert_v3_prior_mark_changed');
   const existingMarks=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`
    SELECT id::text,source_block::text,source_hash,provenance FROM deployment_marks
    WHERE campaign_id=$1 AND provenance->>'operationId'=$2 LIMIT 2`,
    [row.campaign_id,input.operationId])).rows;
   if(replayed){
    if(existingMarks.length!==1||existingMarks[0]!.source_block!==model.source.block||
     existingMarks[0]!.source_hash?.toLowerCase()!==model.source.hash.toLowerCase()||
     existingMarks[0]!.provenance.classification!==
     'paper_model_converted_close'||existingMarks[0]!.provenance.terminalModelHash!==model.modelHash)
     throw new DeploymentConflict('paper_close_convert_v3_replay_integrity');
    const markId=existingMarks[0]!.id,
     feeRow=(await db.query<{id:string;from_mark_id:string;to_mark_id:string;
      proof_hash:string;carry_hash:string}>(`
      SELECT id::text,from_mark_id::text,to_mark_id::text,proof_hash,carry_hash
      FROM deployment_paper_fee_evidence
      WHERE campaign_id=$1 AND to_mark_id=$2`,[row.campaign_id,markId])).rows[0],
     accounting=(await db.query<{id:string;snapshot:unknown;snapshot_hash:string}>(`
      SELECT id::text,snapshot,snapshot_hash FROM deployment_paper_accounting
      WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
      [row.campaign_id,markId,PAPER_CONVERSION_ACCOUNTING_POLICY_V3])).rows[0],
     ledger=(await db.query<{entry_key:string;kind:string;token_address:string|null;
      amount_raw:string|null;value_raw:string|null;source:Record<string,unknown>}>(`
      SELECT entry_key,kind,token_address,amount_raw::text,value_raw::text,source
      FROM deployment_ledger WHERE campaign_id=$1 AND operation_id=$2
      ORDER BY entry_key`,[row.campaign_id,input.operationId])).rows;
    const snapshot=paperConversionAccountingV3Schema.safeParse(accounting?.snapshot);
    const capitalOut=snapshot.success?snapshot.data.flows.filter(flow=>
     flow.kind==='modeled_capital_out') as
      {kind:'modeled_capital_out';asset:'token0'|'token1'|'native';amountRaw:string;valueQuote:string}[]:[],
     expectedLedger=capitalOut.map(flow=>({
      entryKey:`paper_close_convert:${input.operationId}:${flow.asset}`,
      tokenAddress:flow.asset==='token0'?profile.data.pool.token0:
       flow.asset==='token1'?profile.data.pool.token1:null,
      amount:flow.amountRaw,value:flow.valueQuote,asset:flow.asset,
     })).sort((a,b)=>a.entryKey.localeCompare(b.entryKey));
    if(!feeRow||feeRow.from_mark_id!==model.previousMarkId||feeRow.to_mark_id!==markId||
     !accounting||!snapshot.success||contentHash(snapshot.data)!==accounting.snapshot_hash||
     snapshot.data.closeModelHash!==model.modelHash||feeRow.proof_hash!==model.feeReplay.intervalHash||
     feeRow.carry_hash!==model.feeReplay.feeCarryHash||capitalOut.length!==3||ledger.length!==3||
     !ledger.every((item,index)=>{
      const expected=expectedLedger[index];
      return !!expected&&item.entry_key===expected.entryKey&&item.kind==='capital_out'&&
       (item.token_address?.toLowerCase()??null)===(expected.tokenAddress?.toLowerCase()??null)&&
       item.amount_raw===null&&item.value_raw===null&&
       item.source.classification==='paper_modeled_conversion_capital_out_v3'&&
       item.source.operationId===input.operationId&&item.source.accountingId===accounting.id&&
       item.source.policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY_V3&&
       item.source.terminalModelHash===model.modelHash&&
       item.source.snapshotHash===accounting.snapshot_hash&&item.source.asset===expected.asset&&
       item.source.modeledAmountRaw===expected.amount&&item.source.modeledValueQuote===expected.value;
     }))
     throw new DeploymentConflict('paper_close_convert_v3_replay_integrity');
    const rawPriorTimestamp=priorMark.provenance.source&&typeof priorMark.provenance.source==='object'?
     (priorMark.provenance.source as Record<string,unknown>).timestamp:null,
     priorTimestamp=typeof rawPriorTimestamp==='number'?rawPriorTimestamp:Number.NaN;
    if(!Number.isSafeInteger(priorTimestamp)||priorTimestamp<0)
     throw new DeploymentConflict('paper_close_convert_v3_replay_source_invalid');
    try{await input.verifyAnchors(row.chain_id,[open.data.source,{block:priorMark.source_block!,
     hash:priorMark.source_hash!,timestamp:priorTimestamp},model.source]);}
    catch(error){if(error instanceof AssertionError)
      throw new DeploymentConflict('paper_close_convert_v3_replay_source_not_canonical');throw error;}
    return {markId,accountingId:accounting.id,replayed:true};
   }
   if(existingMarks.length!==0)
    throw new DeploymentConflict('paper_close_convert_v3_orphaned_operation_mark');
   if(row.lifecycle!=='closing'||priorMark.id!==model.previousMarkId)
    throw new DeploymentConflict('paper_close_convert_v3_lifecycle_changed');
   const latest=(await db.query<{id:string}>(`SELECT id::text FROM deployment_marks
    WHERE campaign_id=$1 ORDER BY deployment_marks.id DESC LIMIT 1 FOR UPDATE`,[row.campaign_id])).rows[0];
   if(latest?.id!==model.previousMarkId)
    throw new DeploymentConflict('paper_close_convert_v3_latest_mark_changed');
   const priorFee=(await db.query<{id:string;to_mark_id:string;from_mark_id:string;
    proof:unknown;proof_hash:string;carry:PaperFeeCarry;carry_hash:string}>(`
    SELECT id::text,to_mark_id::text,from_mark_id::text,proof,proof_hash,carry,carry_hash
    FROM deployment_paper_fee_evidence WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [model.feeReplay.previousFeeEvidenceId,row.campaign_id])).rows[0];
   if(!priorFee||priorFee.to_mark_id!==model.previousMarkId||
    contentHash(priorFee.proof)!==priorFee.proof_hash||
    contentHash(priorFee.carry)!==priorFee.carry_hash||
    priorFee.carry_hash!==model.feeReplay.previousFeeCarryHash)
    throw new DeploymentConflict('paper_close_convert_v3_prior_fee_invalid');
   const profileIds=model.costs.stages.map(stage=>stage.profileId);
   const gasRows=(await db.query<PaperCloseConvertPrestateGasProfileRow>(`
    SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
     allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
     evidence_class AS "evidenceClass",model,validation,source_hash AS "sourceHash",
     observed_until AS "observedUntil"
    FROM deployment_calibration_profiles WHERE chain_id=$1 AND lower(pool_address)=lower($2)
     AND path_version=$3 AND component='gas_units' AND size_band=$4
     AND validation->>'reportHash'=$5 AND id=ANY($6::uuid[])
     ORDER BY stage,version DESC`,
    [row.chain_id,profile.data.pool.pool,PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1,
     model.costs.sizeBand,model.costs.reportHash,profileIds])).rows;
   let terminalCosts;
   try{terminalCosts=selectPaperCloseConvertPrestateCostsV1({report:model.prestateReport,
    rows:gasRows.filter(item=>item.validation?.reportHash===model.prestateReport.reportHash),
    gasPriceWei:BigInt(model.costs.gasPriceWei),gasPriceObservedAt:model.costs.gasPriceObservedAt});}
   catch{throw new DeploymentConflict('paper_close_convert_v3_gas_profiles_changed');}
   if(contentHash(terminalCosts)!==contentHash(model.costs))
    throw new DeploymentConflict('paper_close_convert_v3_gas_costs_changed');
   const interval=canonicalPaperFeeIntervalSchema.safeParse(model.feeReplay.interval);
   if(!interval.success||contentHash(interval.data)!==model.feeReplay.intervalHash||
    interval.data.coverage.stream!==profileEvidence.data.streamKey||
    interval.data.coverage.targetSetHash!==profileEvidence.data.indexerTargetSetHash||
    interval.data.from.block!==priorMark.source_block||
    interval.data.from.hash.toLowerCase()!==priorMark.source_hash?.toLowerCase()||
    interval.data.to.block!==model.source.block||
    interval.data.to.hash.toLowerCase()!==model.source.hash.toLowerCase())
    throw new DeploymentConflict('paper_close_convert_v3_fee_interval_invalid');
   let advanced:PaperFeeCarry;
   try{advanced=advancePaperFeeCarry(priorFee.carry,interval.data,open.data.source);}
   catch{throw new DeploymentConflict('paper_close_convert_v3_fee_replay_invalid');}
   if(contentHash(advanced)!==model.feeReplay.feeCarryHash||
    contentHash(advanced)!==contentHash(model.feeReplay.feeCarry))
    throw new DeploymentConflict('paper_close_convert_v3_fee_replay_changed');
   const priorSnapshotRow=(await db.query<{snapshot:unknown;snapshot_hash:string;
    fee_evidence_id:string|null}>(`SELECT snapshot,snapshot_hash,fee_evidence_id::text
    FROM deployment_paper_accounting WHERE campaign_id=$1 AND source_mark_id=$2
     AND policy_version=$3`,[row.campaign_id,model.previousMarkId,
      PAPER_CONVERSION_ACCOUNTING_POLICY_V2])).rows[0],
    previousSnapshot=paperConversionAccountingV2Schema.safeParse(priorSnapshotRow?.snapshot);
   if(!priorSnapshotRow||!previousSnapshot.success||
    contentHash(previousSnapshot.data)!==priorSnapshotRow.snapshot_hash||
    previousSnapshot.data.sourceMarkId!==model.previousMarkId||
    previousSnapshot.data.markKind==='close_convert'||
    contentHash(previousSnapshot.data.runtimeIdentity)!==contentHash(currentRuntime))
    throw new DeploymentConflict('paper_close_convert_v3_prior_accounting_unavailable');
   if(priorSnapshotRow.fee_evidence_id!==priorFee.id)
    throw new DeploymentConflict('paper_close_convert_v3_prior_accounting_fee_changed');
   const invalidated=(await db.query<{found:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM deployment_paper_accounting_invalidations WHERE campaign_id=$1) AS found`,
    [row.campaign_id])).rows[0]?.found;
   if(invalidated)throw new DeploymentConflict('paper_close_convert_v3_history_invalidated');
   const now=Date.now();
   if(now-model.source.timestamp*1000>180_000||model.source.timestamp*1000>now)
    throw new DeploymentConflict('paper_close_convert_v3_source_stale');
   const anchors=[open.data.source,model.prestateReport.previousSource,model.source];
   try{await input.verifyAnchors(row.chain_id,anchors);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('paper_close_convert_v3_source_not_canonical');throw error;}
   const principalAndIdle={token0Raw:String(BigInt(model.inventory.principal0Raw)+
    BigInt(model.inventory.idle0Raw)),token1Raw:String(BigInt(model.inventory.principal1Raw)+
    BigInt(model.inventory.idle1Raw))};
   const inventory={classification:'paper_model_converted_close',position:null,
    retainedPrincipalLowerBound:{amount0Raw:model.inventory.principal0Raw,
     amount1Raw:model.inventory.principal1Raw},
    idleLowerBound:{amount0Raw:model.inventory.idle0Raw,amount1Raw:model.inventory.idle1Raw},
    simulatedPostWithdraw:{token0Raw:model.inventory.token0Raw,token1Raw:model.inventory.token1Raw,
     fee0Raw:model.inventory.fee0Raw,fee1Raw:model.inventory.fee1Raw},
    nativeWei:null,actualCustodyAvailable:false};
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`,
    [row.campaign_id,row.current_revision,model.source.block,model.source.hash,JSON.stringify(inventory),
     JSON.stringify({netNav:null,alpha:null,feeIncome:null,paidCosts:null,actualCustody:null}),
     model.costs.stages.map(stage=>stage.profileId),JSON.stringify({
      classification:'paper_model_converted_close',operationId:input.operationId,
      previewId:row.preview_id,openMarkId:model.openMarkId,previousMarkId:model.previousMarkId,
      openModelHash:model.openModelHash,terminalModelHash:model.modelHash,
      source:model.source,poolState:model.poolState,reference:model.reference,
      referenceProofHash:model.referenceProofHash,conversionRoute:model.conversionRoute,
      quoteHash:model.quote.quoteHash,modeledCosts:model.costs,
      prestateReportHash:model.prestateReport.reportHash,feeReplayHash:model.feeReplay.replayHash,
      feeEvidenceId:priorFee.id,feeEvidenceHash:priorFee.proof_hash,
      feeIntervalHash:model.feeReplay.intervalHash,feeCarryHash:model.feeReplay.feeCarryHash,
      paidCostsAvailable:false,feeAccrualAvailable:false,actualCustodyAvailable:false})])).rows[0]!;
   const feeRow=(await db.query<{id:string}>(`INSERT INTO deployment_paper_fee_evidence
    (campaign_id,from_mark_id,to_mark_id,proof,proof_hash,carry,carry_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
    [row.campaign_id,model.previousMarkId,mark.id,JSON.stringify(interval.data),
     model.feeReplay.intervalHash,JSON.stringify(advanced),contentHash(advanced)])).rows[0]!;
   const accountingMark={id:mark.id,kind:'close_convert' as const,source:model.source,
    reference:model.reference,principal0Raw:principalAndIdle.token0Raw,
    principal1Raw:principalAndIdle.token1Raw};
   let accounting;
   try{accounting=buildPaperConversionAccountingV3(open.data,profile.data,accountingMark,
    previousSnapshot.data,{id:feeRow.id,proofHash:model.feeReplay.intervalHash,
     carryHash:contentHash(advanced),carry:advanced},null,model,model.quote,model.costs,{
     reportHash:model.costs.reportHash,scopeHash:model.costs.scopeHash,
     sequenceHash:model.costs.sequenceHash,sizeBand:model.costs.sizeBand,
     profileIds:model.costs.stages.map(stage=>stage.profileId)},currentRuntime);}
   catch{throw new DeploymentConflict('paper_close_convert_v3_accounting_replay_invalid');}
   const saved=(await db.query<{id:string}>(`INSERT INTO deployment_paper_accounting
    (campaign_id,source_mark_id,policy_version,fee_evidence_id,snapshot,snapshot_hash)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,
    [row.campaign_id,mark.id,PAPER_CONVERSION_ACCOUNTING_POLICY_V3,feeRow.id,
     JSON.stringify(accounting),contentHash(accounting)])).rows[0]!;
   const conversion=accounting.conversion;
   if(!conversion)throw new DeploymentConflict('paper_close_convert_v3_capital_out_unavailable');
   const capitalOut=accounting.flows.filter(flow=>flow.kind==='modeled_capital_out') as
    {kind:'modeled_capital_out';asset:'token0'|'token1'|'native';amountRaw:string;valueQuote:string}[];
   if(capitalOut.length!==3||new Set(capitalOut.map(flow=>flow.asset)).size!==3)
    throw new DeploymentConflict('paper_close_convert_v3_capital_out_unavailable');
   for(const flow of capitalOut){
    const token=flow.asset==='token0'?profile.data.pool.token0:
     flow.asset==='token1'?profile.data.pool.token1:null;
    await db.query(`INSERT INTO deployment_ledger
     (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
     VALUES($1,$2,$3,'capital_out',$4,NULL,NULL,$5)`,
     [row.campaign_id,input.operationId,`paper_close_convert:${input.operationId}:${flow.asset}`,token,
      JSON.stringify({classification:'paper_modeled_conversion_capital_out_v3',operationId:input.operationId,
       previewId:row.preview_id,accountingId:saved.id,policyVersion:PAPER_CONVERSION_ACCOUNTING_POLICY_V3,
       snapshotHash:contentHash(accounting),terminalModelHash:model.modelHash,asset:flow.asset,
       modeledAmountRaw:flow.amountRaw,modeledValueQuote:flow.valueQuote,
       quoteHash:conversion.quoteHash,paidCostsAvailable:false,actualCustodyAvailable:false})]);
   }
   try{await input.verifyAnchors(row.chain_id,anchors);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('paper_close_convert_v3_source_changed_during_completion');throw error;}
   await db.query(`UPDATE deployment_campaigns SET lifecycle='closed',range_state='no_liquidity',
    closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[row.campaign_id]);
   await db.query(`UPDATE deployment_operations SET status='succeeded',
    stage='paper_close_convert_v3_reconciled',claimed_by=NULL,claim_until=NULL,
    updated_at=clock_timestamp() WHERE id=$1`,[input.operationId]);
   return {markId:mark.id,accountingId:saved.id,replayed:false};
  });
 }

 async completeTrustedPaperCloseConvert(operationId:string,workerId:string,
  verifyAnchors:(chainId:number,sources:readonly {block:string;hash:string;timestamp:number}[])=>Promise<void>,
  verifyCloseConvert:(chainId:number,model:PaperCloseConvertModel,
   inputAmountRaw:string)=>Promise<PaperCloseConvertQuote>){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  const currentRuntime=loadRuntimeIdentity();
  if(!currentRuntime)throw new DeploymentConflict('paper_close_convert_runtime_unavailable');
  return this.transaction(async db=>{
   const row=(await db.query<{campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_until:Date|null;claim_valid:boolean|null;
    mode:string;lifecycle:string;current_revision:number;
    open_mark_id:string;runtime_identity:unknown;chain_id:number;profile:unknown;profile_hash:string;
    profile_evidence:unknown;config:unknown;
    config_hash:string;strategy_id:string;proposal:Record<string,unknown>;
    request:Record<string,unknown>;evidence:Record<string,unknown>;content_digest:string;
    expected_revision:number;expires_at:Date}>(`
    SELECT o.campaign_id,o.preview_id,o.kind,o.status,o.claimed_by,o.claim_until,
     (o.claim_until>=clock_timestamp()) AS claim_valid,
     c.mode,c.lifecycle,c.current_revision,open_mark.id::text AS open_mark_id,
     c.runtime_identity,c.chain_id,p.profile,p.profile_hash,
     p.evidence AS profile_evidence,
     r.config,r.config_hash,r.strategy_id,v.proposal,v.request,v.evidence,v.content_digest,
     v.expected_revision,v.expires_at
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN LATERAL (SELECT id FROM deployment_marks WHERE campaign_id=c.id
     AND provenance->>'classification'='paper_model_provisional' ORDER BY id LIMIT 1) open_mark ON TRUE
    JOIN deployment_previews v ON v.id=o.preview_id WHERE o.id=$1 FOR UPDATE OF o,c`,
    [operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='close_convert')
    throw new DeploymentConflict('paper_close_convert_operation_unavailable');
   const persistedRuntime=sealedRuntimeIdentitySchema.safeParse(row.runtime_identity);
   if(!persistedRuntime.success||contentHash(persistedRuntime.data)!==contentHash(currentRuntime))
    throw new DeploymentConflict('paper_close_convert_runtime_mismatch');
   const replayed=row.status==='succeeded',now=Date.now();
   if(replayed){
    if(row.lifecycle!=='closed')throw new DeploymentConflict('paper_close_convert_replay_integrity');
   }else if(row.lifecycle!=='closing'||row.status!=='reconciling'||row.claimed_by!==workerId||
    !row.claim_valid)
    throw new DeploymentConflict('paper_close_convert_claim_lost');
   if(row.current_revision!==row.expected_revision)
    throw new DeploymentConflict('paper_close_convert_preview_stale');
   if(previewDigest({campaignId:row.campaign_id,expectedRevision:row.expected_revision,
    kind:'close_convert',request:row.request,proposal:row.proposal,evidence:row.evidence,
    expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('paper_close_convert_preview_integrity');
   const profile=marketProfileSchema.safeParse(row.profile),
    profileEvidence=marketProfileEvidenceSchema.safeParse(row.profile_evidence),
    config=row.config&&typeof row.config==='object'?row.config as Record<string,unknown>:null,
    modelResult=paperCloseConvertModelSchema.safeParse(row.proposal.paperCloseConvertModel);
   if(!profile.success||!profileEvidence.success||contentHash(row.profile)!==row.profile_hash||
    referenceProofHash(profileEvidence.data.referenceProof)!==profileEvidence.data.references.proofHash||
    (['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
     .some(key=>profile.data.pool[key].toLowerCase()!==
      profileEvidence.data.contractHashes[key].toLowerCase())||!config||
    contentHash(config)!==row.config_hash||row.strategy_id!=='static_manual_v1'||
    config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||
    config.stateSchemaVersion!==1||!modelResult.success)
    throw new DeploymentConflict('paper_close_convert_model_integrity');
   const model=modelResult.data,{strategyId:_strategyId,strategyVersion:_strategyVersion,
    stateSchemaVersion:_stateSchemaVersion,...parameters}=config;
   if(model.campaignId!==row.campaign_id||model.revision!==row.current_revision||
    referenceProofHash(model.referenceProof)!==model.referenceProofHash)
    throw new DeploymentConflict('paper_close_convert_model_integrity');
   const marks=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;calibration_profile_ids:string[];provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,source_block::text,source_hash,inventory,calibration_profile_ids,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND provenance->>'operationId'=$2 LIMIT 2`,
    [row.campaign_id,operationId])).rows;
   if(marks.length!==1)throw new DeploymentConflict('paper_close_convert_mark_unavailable');
   const mark=marks[0]!;
   const laterMark=(await db.query<{found:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM deployment_marks WHERE campaign_id=$1 AND id>$2) AS found`,
    [row.campaign_id,mark.id])).rows[0]?.found;
   if(mark.revision!==row.current_revision||
    laterMark||
    mark.provenance.classification!=='paper_model_converted_close'||
    mark.provenance.closeConvertModelHash!==contentHash(model)||
    mark.provenance.previewId!==row.preview_id||mark.provenance.openMarkId!==row.open_mark_id||
    mark.provenance.openModelHash!==model.openModelHash||mark.inventory.position!==null||
    mark.source_block!==model.source.block||mark.source_hash?.toLowerCase()!==model.source.hash.toLowerCase()||
    contentHash(mark.inventory.retainedPrincipalLowerBound)!==contentHash(model.principal)||
    contentHash(mark.inventory.idleLowerBound)!==contentHash(model.idle)||
    contentHash(mark.provenance.modeledCosts)!==contentHash(model.costs)||
    contentHash(mark.provenance.conversionRoute)!==contentHash(model.conversionRoute)||
    contentHash(mark.calibration_profile_ids)!==contentHash(model.costs.stages.map(stage=>stage.profileId)))
    throw new DeploymentConflict('paper_close_convert_mark_integrity');
   const openMark=(await db.query<{id:string;revision:number;source_block:string|null;
    source_hash:string|null;provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [model.openMarkId,row.campaign_id])).rows[0];
   const openPreview=(await db.query<{proposal:Record<string,unknown>}>(`
    SELECT v.proposal FROM deployment_marks m JOIN deployment_previews v
     ON v.id=(m.provenance->>'previewId')::uuid WHERE m.id=$1 AND m.campaign_id=$2`,
    [model.openMarkId,row.campaign_id])).rows[0];
   const open=paperOpenModelSchema.safeParse(openPreview?.proposal.paperOpenModel);
   if(!openMark||!open.success||openMark.revision!==row.current_revision||
    openMark.provenance.classification!=='paper_model_provisional'||
    openMark.source_block!==open.data.source.block||
    openMark.source_hash?.toLowerCase()!==open.data.source.hash.toLowerCase()||
    contentHash(open.data)!==model.openModelHash||model.openMarkId!==row.open_mark_id||
    open.data.profileHash!==row.profile_hash||open.data.configHash!==row.config_hash)
    throw new DeploymentConflict('paper_close_convert_open_model_integrity');
   const priorMark=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND id=$2`,
    [row.campaign_id,model.previousMarkId])).rows[0];
   if(!priorMark||priorMark.source_block!==model.previousSource.block||
    priorMark.source_hash?.toLowerCase()!==model.previousSource.hash.toLowerCase()||
    !['paper_model_provisional','paper_model_principal_valuation'].includes(
     String(priorMark.provenance.classification)))
    throw new DeploymentConflict('paper_close_convert_prior_mark_unavailable');
   const {profileIds}=await replayPaperCloseConvert(db,model,open.data,profile.data,parameters,
    Date.parse(model.costs.gasPriceObservedAt));
   if(contentHash(profileIds)!==contentHash(mark.calibration_profile_ids))
    throw new DeploymentConflict('paper_close_convert_gas_profiles_changed');
   const feeRow=(await db.query<{id:string;from_mark_id:string;proof:unknown;proof_hash:string;
    carry:PaperFeeCarry;carry_hash:string}>(`
    SELECT id::text,from_mark_id::text,proof,proof_hash,carry,carry_hash
    FROM deployment_paper_fee_evidence WHERE campaign_id=$1 AND to_mark_id=$2`,
    [row.campaign_id,mark.id])).rows[0];
   if(!feeRow||feeRow.from_mark_id!==model.previousMarkId||
    contentHash(feeRow.proof)!==feeRow.proof_hash||contentHash(feeRow.carry)!==feeRow.carry_hash)
    throw new DeploymentConflict('paper_close_convert_fee_evidence_unavailable');
   const proof=feeRow.proof as CanonicalPaperFeeInterval;
   if(proof.coverage.stream!==profileEvidence.data.streamKey||
    proof.coverage.targetSetHash!==profileEvidence.data.indexerTargetSetHash)
    throw new DeploymentConflict('paper_close_convert_fee_coverage_changed');
   const priorFee=(await db.query<{id:string;proof:unknown;proof_hash:string;
    carry:PaperFeeCarry;carry_hash:string}>(`
    SELECT id::text,proof,proof_hash,carry,carry_hash FROM deployment_paper_fee_evidence
    WHERE campaign_id=$1 AND to_mark_id=$2`,[row.campaign_id,model.previousMarkId])).rows[0];
   if(priorMark.provenance.classification==='paper_model_provisional'&&priorFee||
    priorMark.provenance.classification!=='paper_model_provisional'&&(!priorFee||
     contentHash(priorFee.proof)!==priorFee.proof_hash||contentHash(priorFee.carry)!==priorFee.carry_hash))
    throw new DeploymentConflict('paper_close_convert_prior_fee_unavailable');
   let carry:PaperFeeCarry;
   try{carry=advancePaperFeeCarry(priorFee?.carry??null,proof,open.data.source);}
   catch{throw new DeploymentConflict('paper_close_convert_fee_replay_invalid');}
   if(contentHash(carry)!==feeRow.carry_hash)
    throw new DeploymentConflict('paper_close_convert_fee_replay_invalid');
   const feeEvidence={id:feeRow.id,proofHash:feeRow.proof_hash,
    carryHash:feeRow.carry_hash,carry:feeRow.carry};
   const snapshotRow=(await db.query<{id:string;snapshot:unknown;snapshot_hash:string;
    fee_evidence_id:string|null}>(`SELECT id::text,snapshot,snapshot_hash,fee_evidence_id::text
    FROM deployment_paper_accounting WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
    [row.campaign_id,mark.id,PAPER_CONVERSION_ACCOUNTING_POLICY_V2])).rows;
   if(snapshotRow.length!==1||snapshotRow[0]!.fee_evidence_id!==feeRow.id)
    throw new DeploymentConflict('paper_close_convert_accounting_unavailable');
   const saved=snapshotRow[0]!,snapshot=paperConversionAccountingV2Schema.safeParse(saved.snapshot);
   if(!snapshot.success||contentHash(snapshot.data)!==saved.snapshot_hash||
    snapshot.data.policyVersion!==PAPER_CONVERSION_ACCOUNTING_POLICY_V2||
    snapshot.data.campaignId!==row.campaign_id||snapshot.data.sourceMarkId!==mark.id||
    snapshot.data.markKind!=='close_convert'||snapshot.data.closeModelHash!==contentHash(model)||
    snapshot.data.feeEvidence?.id!==feeRow.id||snapshot.data.feeEvidence.proofHash!==feeRow.proof_hash||
    snapshot.data.feeEvidence.carryHash!==feeRow.carry_hash||snapshot.data.conversion===null||
    snapshot.data.inventory.hasLiquidity!==false||
    contentHash(snapshot.data.runtimeIdentity)!==contentHash(currentRuntime)||
    snapshot.data.conversion.gasEvidence.pathVersion!==PAPER_STATIC_CONVERT_GAS_PATH_V2)
    throw new DeploymentConflict('paper_close_convert_accounting_integrity');
   const previousSnapshotRow=(await db.query<{snapshot:unknown;snapshot_hash:string}>(`
    SELECT snapshot,snapshot_hash FROM deployment_paper_accounting
    WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
    [row.campaign_id,model.previousMarkId,PAPER_CONVERSION_ACCOUNTING_POLICY_V2])).rows[0];
   const previousSnapshot=previousSnapshotRow?
    paperConversionAccountingV2Schema.safeParse(previousSnapshotRow.snapshot):null;
   if(!previousSnapshot?.success||contentHash(previousSnapshot.data)!==previousSnapshotRow!.snapshot_hash||
    previousSnapshot.data.sourceMarkId!==model.previousMarkId||
    previousSnapshot.data.markKind==='close_convert'||
    contentHash(previousSnapshot.data.runtimeIdentity)!==contentHash(currentRuntime))
    throw new DeploymentConflict('paper_close_convert_prior_accounting_unavailable');
   const invalidated=(await db.query<{found:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM deployment_paper_accounting_invalidations WHERE campaign_id=$1) AS found`,
    [row.campaign_id])).rows[0]?.found;
   if(invalidated)throw new DeploymentConflict('paper_close_convert_history_invalidated');
   const principalAndIdle={
    token0Raw:String(BigInt(model.principal.amount0Raw)+BigInt(model.idle.amount0Raw)),
    token1Raw:String(BigInt(model.principal.amount1Raw)+BigInt(model.idle.amount1Raw))};
   const accountingMark={id:mark.id,kind:'close_convert' as const,source:model.source,
    reference:model.reference,principal0Raw:principalAndIdle.token0Raw,
    principal1Raw:principalAndIdle.token1Raw};
   const priorStandard=paperAccountingFromConversionV2Snapshot(previousSnapshot.data),
    baseMark={...accountingMark,kind:'valuation' as const};
   let base;
   try{base=buildPaperAccounting(open.data,profile.data,baseMark,priorStandard,feeEvidence,null);}
   catch{throw new DeploymentConflict('paper_close_convert_input_replay_invalid');}
   const conversion=snapshot.data.conversion!,route=model.conversionRoute,
    savedQuote=paperCloseConvertQuoteSchema.parse({schemaVersion:1,kind:'paper_exact_input_quote_v1',
     source:conversion.source,router:route.router,quoter:route.quoter,path:route.path,fee:route.fee,
     inputAsset:conversion.fromAsset,inputAmountRaw:conversion.inputAmountRaw,
     expectedOutputRaw:conversion.expectedOutputRaw,minimumOutputRaw:conversion.minimumOutputRaw,
     slippageBps:conversion.slippageBps,pathVersion:conversion.pathVersion,
     quoteHash:conversion.quoteHash});
   if(savedQuote.inputAmountRaw!==(savedQuote.inputAsset==='token0'?
    base.inventory.token0Raw:base.inventory.token1Raw))
    throw new DeploymentConflict('paper_close_convert_input_mismatch');
   const selectedGas=await this.selectRegisteredPaperCloseConvertGasV2(db,{campaignId:row.campaign_id,
    revision:row.current_revision,terminalMarkId:mark.id,previousMarkId:model.previousMarkId,
    runtimeIdentity:currentRuntime,profile:profile.data,open:open.data,model,
    inventory:base.inventory,feeEvidence:{id:feeRow.id,proofHash:feeRow.proof_hash,
     carryHash:feeRow.carry_hash}});
   let rebuilt;
   try{rebuilt=buildPaperConversionAccountingV2(open.data,profile.data,accountingMark,
    previousSnapshot.data,feeEvidence,null,model,savedQuote,selectedGas.costs,
    selectedGas.binding,currentRuntime);}
   catch{throw new DeploymentConflict('paper_close_convert_accounting_replay_invalid');}
   if(contentHash(rebuilt)!==saved.snapshot_hash)
    throw new DeploymentConflict('paper_close_convert_accounting_replay_changed');
   const anchors=[open.data.source,previousSnapshot.data.source,model.source];
   await verifyAnchors(profile.data.pool.chainId,anchors);
   let canonicalQuote:PaperCloseConvertQuote;
   try{canonicalQuote=paperCloseConvertQuoteSchema.parse(await verifyCloseConvert(
    profile.data.pool.chainId,model,savedQuote.inputAmountRaw));}
   catch{throw new DeploymentConflict('paper_close_convert_canonical_quote_invalid');}
   if(contentHash(canonicalQuote)!==contentHash(savedQuote))
    throw new DeploymentConflict('paper_close_convert_canonical_quote_changed');
   await verifyAnchors(profile.data.pool.chainId,anchors);
   const capitalOut=snapshot.data.flows.filter(flow=>flow.kind==='modeled_capital_out') as
    {kind:'modeled_capital_out';asset:'token0'|'token1'|'native';
     amountRaw:string;valueQuote:string}[];
   const byAsset=new Map(capitalOut.map(flow=>[flow.asset,flow]));
   if(capitalOut.length!==3||byAsset.size!==3||
    !(['token0','token1','native'] as const).every(asset=>byAsset.has(asset)))
    throw new DeploymentConflict('paper_close_convert_capital_out_unreconciled');
   const expectedLedger=['token0','token1','native'] as const;
   if(replayed){
    const ledger=(await db.query<{entry_key:string;kind:string;token_address:string|null;
     amount_raw:string|null;value_raw:string|null;source:Record<string,unknown>}>(`
     SELECT entry_key,kind,token_address,amount_raw::text,value_raw::text,source
     FROM deployment_ledger WHERE campaign_id=$1 AND operation_id=$2 ORDER BY entry_key`,
     [row.campaign_id,operationId])).rows;
    if(ledger.length!==3||!expectedLedger.every(asset=>{
     const flow=byAsset.get(asset)!,item=ledger.find(entry=>entry.entry_key===
      `paper_close_convert:${operationId}:${asset}`);
     return item?.kind==='capital_out'&&item.amount_raw===null&&item.value_raw===null&&
      item.source.snapshotHash===saved.snapshot_hash&&item.source.accountingId===saved.id&&
      item.source.modeledAmountRaw===flow.amountRaw&&item.source.modeledValueQuote===flow.valueQuote;
    }))throw new DeploymentConflict('paper_close_convert_replay_ledger_integrity');
    return {markId:mark.id,accountingId:saved.id,replayed:true};
   }
   for(const asset of expectedLedger){
    const flow=byAsset.get(asset)!,token=asset==='token0'?profile.data.pool.token0:
     asset==='token1'?profile.data.pool.token1:null;
    await db.query(`INSERT INTO deployment_ledger
     (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
     VALUES($1,$2,$3,'capital_out',$4,NULL,NULL,$5)`,
     [row.campaign_id,operationId,`paper_close_convert:${operationId}:${asset}`,token,
      JSON.stringify({classification:'paper_modeled_conversion_capital_out',operationId,
       previewId:row.preview_id,accountingId:saved.id,policyVersion:PAPER_CONVERSION_ACCOUNTING_POLICY_V2,
       snapshotHash:saved.snapshot_hash,asset,modeledAmountRaw:flow.amountRaw,
       modeledValueQuote:flow.valueQuote,quoteHash:conversion.quoteHash,
       paidCostsAvailable:false,actualCustodyAvailable:false})]);
   }
   await db.query(`UPDATE deployment_campaigns SET lifecycle='closed',range_state='no_liquidity',
    closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[row.campaign_id]);
   await db.query(`UPDATE deployment_operations SET status='succeeded',
    stage='paper_close_convert_reconciled',claimed_by=NULL,claim_until=NULL,
    updated_at=clock_timestamp() WHERE id=$1`,[operationId]);
   return {markId:mark.id,accountingId:saved.id,replayed:false};
  });
 }

 async completeTrustedPaperCloseRetain(operationId:string,workerId:string,
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  return this.transaction(async db=>{
   const row=(await db.query<{campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_until:Date|null;claim_valid:boolean|null;
    mode:string;lifecycle:string;current_revision:number;
    profile:unknown;profile_hash:string;config:unknown;config_hash:string;strategy_id:string;
    proposal:Record<string,unknown>;request:Record<string,unknown>;evidence:Record<string,unknown>;
    content_digest:string;expected_revision:number;preview_created_at:Date;accepted_at:Date;
    expires_at:Date}>(`
    SELECT o.campaign_id,o.preview_id,o.kind,o.status,o.claimed_by,o.claim_until,
     (o.claim_until>=clock_timestamp()) AS claim_valid,c.mode,c.lifecycle,
     c.current_revision,p.profile,p.profile_hash,r.config,r.config_hash,r.strategy_id,
     v.proposal,v.request,v.evidence,v.content_digest,v.expected_revision,v.created_at AS preview_created_at,
     o.created_at AS accepted_at,v.expires_at
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_previews v ON v.id=o.preview_id WHERE o.id=$1 FOR UPDATE OF o,c`,
    [operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='close_retain')
    throw new DeploymentConflict('paper_close_operation_unavailable');
   if(row.status==='succeeded'){
    const prior=(await db.query<{id:string}>(`SELECT id::text FROM deployment_marks
     WHERE campaign_id=$1 AND provenance->>'operationId'=$2 LIMIT 2`,
     [row.campaign_id,operationId])).rows;
    if(prior.length!==1)throw new DeploymentConflict('paper_close_replay_integrity');
    return {markId:prior[0]!.id,replayed:true};
   }
   if(row.lifecycle!=='closing'||row.status!=='reconciling'||row.claimed_by!==workerId||
    !row.claim_valid)throw new DeploymentConflict('paper_close_claim_lost');
   if(row.current_revision!==row.expected_revision||row.accepted_at.getTime()>row.expires_at.getTime()||
    row.accepted_at.getTime()<row.preview_created_at.getTime())
    throw new DeploymentConflict('paper_close_preview_stale');
   if(previewDigest({campaignId:row.campaign_id,expectedRevision:row.expected_revision,
    kind:'close_retain',request:row.request,proposal:row.proposal,evidence:row.evidence,
    expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('paper_close_preview_integrity');
   const parsed=paperCloseRetainModelSchema.safeParse(row.proposal.paperCloseRetainModel),
    profile=marketProfileSchema.safeParse(row.profile);
   if(!parsed.success||!profile.success||contentHash(row.profile)!==row.profile_hash||
    !row.config||typeof row.config!=='object'||contentHash(row.config)!==row.config_hash||
    row.strategy_id!=='static_manual_v1')throw new DeploymentConflict('paper_close_model_integrity');
   const model=parsed.data;
   if(model.campaignId!==row.campaign_id||model.revision!==row.current_revision||
    referenceProofHash(model.referenceProof)!==model.referenceProofHash)
    throw new DeploymentConflict('paper_close_model_integrity');
   const config=row.config as Record<string,unknown>;
   if(config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||
    config.stateSchemaVersion!==1)throw new DeploymentConflict('paper_close_config_integrity');
   const {strategyId:_id,strategyVersion:_version,stateSchemaVersion:_schema,...parameters}=config;
   const openMark=(await db.query<{id:string;campaign_id:string;revision:number;source_block:string|null;
    source_hash:string|null;inventory:unknown;
    provenance:Record<string,unknown>}>(`SELECT id::text,campaign_id,revision,inventory,provenance
    ,source_block::text,source_hash
    FROM deployment_marks WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [model.openMarkId,row.campaign_id])).rows[0];
   if(!openMark||openMark.revision!==row.current_revision||
    openMark.provenance.classification!=='paper_model_provisional'||
    openMark.provenance.operationId===undefined||openMark.provenance.previewId===undefined||
    openMark.source_block===null||openMark.source_hash===null)
    throw new DeploymentConflict('paper_close_open_mark_unavailable');
   const openPreview=(await db.query<{proposal:Record<string,unknown>}>(`
    SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
    [openMark.provenance.previewId,row.campaign_id])).rows[0];
   const openParsed=paperOpenModelSchema.safeParse(openPreview?.proposal.paperOpenModel);
   if(!openParsed.success||openParsed.data.campaignId!==row.campaign_id||
    openParsed.data.revision!==row.current_revision||
    openParsed.data.profileHash!==row.profile_hash||openParsed.data.configHash!==row.config_hash||
    openParsed.data.source.block!==openMark.source_block||
    openParsed.data.source.hash.toLowerCase()!==openMark.source_hash.toLowerCase()||
    contentHash(openParsed.data)!==openMark.provenance.modelHash||
    contentHash(openParsed.data)!==model.openModelHash)
    throw new DeploymentConflict('paper_close_open_model_integrity');
   const latest=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`
    SELECT id::text,source_block::text,source_hash,provenance FROM deployment_marks
    WHERE campaign_id=$1 ORDER BY deployment_marks.id DESC LIMIT 1`,[row.campaign_id])).rows[0];
   if(!latest||latest.id!==model.previousMarkId||latest.source_block===null||
    latest.source_hash===null||
    BigInt(model.source.block)<=BigInt(latest.source_block)||
    !['paper_model_provisional','paper_model_principal_valuation'].includes(
     String(latest.provenance.classification)))
    throw new DeploymentConflict('paper_close_prior_mark_changed');
   const priorSource=paperFeeMarkSourceSchema.safeParse(latest.provenance.source);
   if(!priorSource.success||priorSource.data.block!==latest.source_block||
    priorSource.data.hash.toLowerCase()!==latest.source_hash.toLowerCase()||
    model.source.timestamp<priorSource.data.timestamp)
    throw new DeploymentConflict('paper_close_source_time_regressed');
   const acceptedAt=row.accepted_at.getTime(),sourceAt=model.source.timestamp*1000,
    gasObservedAt=Date.parse(model.costs.gasPriceObservedAt);
   if(sourceAt>acceptedAt||acceptedAt-sourceAt>180_000||gasObservedAt>acceptedAt||
    acceptedAt-gasObservedAt>120_000)
    throw new DeploymentConflict('paper_close_source_stale');
   const frame={source:model.source,tick:model.poolState.tick,
    sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),
    poolLiquidity:BigInt(model.poolState.poolLiquidity),price0:BigInt(model.reference.price0),
    price1:BigInt(model.reference.price1),nativePrice:BigInt(model.reference.nativePrice),
    referenceEligible:true,referenceReasons:[],referenceProofHash:model.referenceProofHash,
    referenceProof:model.referenceProof};
   // Scoped to the open model's exact tick range: costIndicativePaperOpenPreview's
   // valid() rejects any other range regardless, so excluding it here only keeps the
   // 201-row bound reachable as unrelated ranges accumulate rows.
   const gasRows=(await db.query<PaperGasProfileRow>(`
    SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
     allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
     evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
     observed_until AS "observedUntil" FROM deployment_calibration_profiles
    WHERE chain_id=4663 AND lower(pool_address)=lower($1) AND path_version=$2
     AND component='gas_units' AND allowance_state='zero'
     AND model->'tickLower'=to_jsonb($3::int) AND model->'tickUpper'=to_jsonb($4::int)
    ORDER BY size_band,stage,version DESC LIMIT 201`,
    [profile.data.pool.pool,PAPER_STATIC_GAS_PATH,
     openParsed.data.candidate.range.tickLower,openParsed.data.candidate.range.tickUpper])).rows;
   const costed=costIndicativePaperOpenPreview({status:'indicative',candidate:openParsed.data.candidate},
    gasRows,profile.data.pool.pool,frame.nativePrice,BigInt(model.costs.gasPriceWei),
    Date.parse(model.costs.gasPriceObservedAt));
   if(costed.costs.status!=='provisional'||contentHash(costed.costs)!==contentHash(model.costs))
    throw new DeploymentConflict('paper_close_cost_profile_changed');
   let replayed;
   try{replayed=buildPaperCloseRetainModel(openParsed.data,openMark.id,
    {markId:latest.id,sourceBlock:latest.source_block,sourceHash:latest.source_hash},
    frame,profile.data,
    parameters,costed,model.source.timestamp*1000);}
   catch{throw new DeploymentConflict('paper_close_model_rejected');}
   if(contentHash(replayed)!==contentHash(model))throw new DeploymentConflict('paper_close_model_changed');
   try{await verifyAnchors(profile.data.pool.chainId,[openParsed.data.source,priorSource.data,model.source]);}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('paper_close_source_not_canonical');throw error;}
   const source={classification:'paper_model_partial_close',operationId,previewId:row.preview_id,
    openMarkId:openMark.id,openModelHash:model.openModelHash,
    referenceProofHash:model.referenceProofHash,source:model.source,
    poolState:model.poolState,reference:model.reference,
    unavailable:['fee_capture','paid_gas','net_economics']};
   const p=profile.data.pool;
   for(const [asset,token,lowerBound] of [
    ['token0',p.token0,model.retainedLowerBound.token0Raw],
    ['token1',p.token1,model.retainedLowerBound.token1Raw],
    ['native',null,null],
   ] as const){
    await db.query(`INSERT INTO deployment_ledger
     (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
     VALUES($1,$2,$3,'capital_out',$4,NULL,NULL,$5)`,
     [row.campaign_id,operationId,`paper_close_retain:${operationId}:${asset}`,token,
      JSON.stringify({...source,asset,principalLowerBoundRaw:lowerBound})]);
   }
   const inventory={classification:'paper_model_partial_close',position:null,
    token0Raw:null,token1Raw:null,nativeWei:null,
    retainedPrincipalLowerBound:model.retainedLowerBound,
    unobserved:model.unobserved};
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,NULL,$6,$7) RETURNING id::text`,
    [row.campaign_id,row.current_revision,model.source.block,model.source.hash,
     JSON.stringify(inventory),model.costs.stages.map(stage=>stage.profileId),
     JSON.stringify({...source,modeledCosts:model.costs,paidCostsAvailable:false})])).rows[0]!;
   await db.query(`UPDATE deployment_campaigns SET lifecycle='closed',range_state='no_liquidity',
    closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[row.campaign_id]);
   await db.query(`UPDATE deployment_operations SET status='succeeded',stage='paper_close_retain_recorded',
    claimed_by=NULL,claim_until=NULL,updated_at=clock_timestamp() WHERE id=$1`,[operationId]);
   return {markId:mark.id,replayed:false};
  });
 }

 /** Atomically persist one worker-replayed RangeKeeper epoch transition. */
 async completeRangeKeeperPaperConfirmedRecenter(operationId:string,workerId:string,
  capability:unknown,verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  return this.transaction(async db=>{
   const row=(await db.query<{campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_valid:boolean|null;mode:string;lifecycle:string;chain_id:number;
    revision:number;runtime_identity:unknown;profile:unknown;profile_hash:string;config:unknown;
    config_hash:string;strategy_id:string;strategy_version:string;state_schema_version:number;
    proposal:Record<string,unknown>;request:Record<string,unknown>;evidence:Record<string,unknown>;
    content_digest:string;expected_revision:number;preview_kind:string;accepted_at:Date;expires_at:Date}>(`
    SELECT o.campaign_id,o.preview_id::text,o.kind,o.status,o.claimed_by,
     (o.claim_until>=clock_timestamp()) AS claim_valid,c.mode,c.lifecycle,c.chain_id,
     c.current_revision AS revision,c.runtime_identity,p.profile,p.profile_hash,r.config,r.config_hash,
     r.strategy_id,r.strategy_version,r.state_schema_version,v.proposal,v.request,v.evidence,
     v.content_digest,v.expected_revision,v.kind AS preview_kind,o.created_at AS accepted_at,v.expires_at
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_previews v ON v.id=o.preview_id WHERE o.id=$1 FOR UPDATE OF o,c`,
    [operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='change_range'||row.strategy_id!=='rangekeeper_v1')
    throw new DeploymentConflict('rangekeeper_paper_recenter_operation_unavailable');
   if(row.status==='succeeded'){
    const marks=(await db.query<{id:string}>(`SELECT id::text FROM deployment_marks
     WHERE campaign_id=$1 AND provenance->>'operationId'=$2 AND
      provenance->>'classification'='rangekeeper_paper_recenter_v1' LIMIT 2`,
     [row.campaign_id,operationId])).rows;
    if(marks.length!==1||!['active','paused'].includes(row.lifecycle))
     throw new DeploymentConflict('rangekeeper_paper_recenter_replay_integrity');
    return {markId:marks[0]!.id,replayed:true};
   }
   if(row.lifecycle!=='active'||row.status!=='reconciling'||row.claimed_by!==workerId||!row.claim_valid)
    throw new DeploymentConflict('rangekeeper_paper_recenter_claim_lost');
   if(row.revision!==row.expected_revision||row.accepted_at.getTime()>row.expires_at.getTime()||
    row.preview_kind!=='change_range'||previewDigest({campaignId:row.campaign_id,
     expectedRevision:row.expected_revision,kind:'change_range',request:row.request,
     proposal:row.proposal,evidence:row.evidence,expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('rangekeeper_paper_recenter_preview_integrity');
   const booking=validateRangeKeeperPaperRecenterBooking(row.proposal.rangekeeperPaperRecenterModel),
    modelHash=row.proposal.rangekeeperPaperRecenterModelHash;
   if(modelHash!==booking.modelHash||booking.campaignId!==row.campaign_id||
    booking.revision!==row.revision||row.request.kind!=='automatic_paper_recenter_v1'||
    row.request.epoch!==booking.epoch||row.request.priorMarkId!==booking.priorMark.id||
    row.request.priorMarkHash!==booking.priorMark.markHash)
    throw new DeploymentConflict('rangekeeper_paper_recenter_model_binding_invalid');
   const runtime=sealedRuntimeIdentitySchema.safeParse(row.runtime_identity),current=loadRuntimeIdentity(),
    profile=marketProfileSchema.safeParse(row.profile);
   if(!runtime.success||!await campaignRuntimeMatches(db,row.campaign_id,runtime.data,current)||
    !profile.success||contentHash(profile.data)!==row.profile_hash||!row.config||
    typeof row.config!=='object'||Array.isArray(row.config)||contentHash(row.config)!==row.config_hash||
    row.strategy_version!=='1.0.0'||row.state_schema_version!==1)
    throw new DeploymentConflict('rangekeeper_paper_recenter_campaign_integrity');
   const operationSnapshot=(await this.rangeKeeperPaperRecenterOperationSnapshot(row.campaign_id,
    operationId,workerId)) as {snapshotHash:string};
   try{assertRangeKeeperPaperRecenterReplayCapability(capability,{operationId,previewId:row.preview_id,
    campaignId:row.campaign_id,revision:row.revision,operationSnapshotHash:operationSnapshot.snapshotHash,
    modelHash:booking.modelHash,candidateHash:booking.candidateHash,
    sourceBlock:booking.source.block,sourceHash:booking.source.hash});}
   catch{throw new DeploymentConflict('rangekeeper_paper_recenter_replay_capability_invalid');}
   const latest=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;economics:unknown;provenance:Record<string,unknown>}>(`
    SELECT m.id::text,revision,source_block::text,source_hash,inventory,economics,provenance
    FROM deployment_marks m WHERE m.campaign_id=$1 ORDER BY m.id DESC LIMIT 1 FOR UPDATE`,
    [row.campaign_id])).rows[0],
    latestHash=latest?contentHash({revision:latest.revision,source_block:latest.source_block,
     source_hash:latest.source_hash,inventory:latest.inventory,economics:latest.economics,
     provenance:latest.provenance}):null,
    latestSource=paperFeeMarkSourceSchema.safeParse(latest?.provenance.source);
   if(!latest||!latestSource.success||latest.id!==booking.priorMark.id||
    latestHash!==booking.priorMark.markHash||latest.source_block!==booking.priorMark.source.block||
    latest.source_hash?.toLowerCase()!==booking.priorMark.source.hash.toLowerCase()||
    latest.revision!==row.revision||booking.previousEpoch!==Number(latest.provenance.epoch??0)||
    booking.epoch!==booking.previousEpoch+1)
    throw new DeploymentConflict('rangekeeper_paper_recenter_prior_mark_changed');
   const candidate=latest.provenance.candidate??
    (latest.provenance.positionEpoch as Record<string,unknown>|undefined)?.candidate??
    ((latest.provenance.confirmedOpen as Record<string,unknown>|undefined)?.model as
     Record<string,unknown>|undefined)?.candidate;
   if(!candidate)throw new DeploymentConflict('rangekeeper_paper_recenter_prior_candidate_unavailable');
   const previousClassification=latest.provenance.classification as
    'rangekeeper_paper_open_v1'|'rangekeeper_paper_mark_v1'|'rangekeeper_paper_recenter_v1';
   const previousMark={id:latest.id,markHash:latestHash,source:latestSource.data,
    epoch:Number(latest.provenance.epoch??0),classification:previousClassification,
    candidate,candidateHash:typeof latest.provenance.candidateHash==='string'?
     latest.provenance.candidateHash:typeof
      (latest.provenance.confirmedOpen as Record<string,unknown>|undefined)?.candidateHash==='string'?
       String((latest.provenance.confirmedOpen as Record<string,unknown>).candidateHash):undefined,
    inventory:latest.inventory,kernelSnapshot:latest.provenance.kernelSnapshot,
    provenance:latest.provenance};
   let booked;
   try{booked=buildRangeKeeperPaperRecenterBooking({draft:{id:row.campaign_id,revision:row.revision,
    configHash:row.config_hash,profileHash:row.profile_hash,profile:{pool:{
     decimals0:profile.data.pool.decimals0,decimals1:profile.data.pool.decimals1}}},previousMark,
    booking,frame:{source:booking.source,sqrtPriceX96:BigInt(booking.poolState.sqrtPriceX96)}});}
   catch{throw new DeploymentConflict('rangekeeper_paper_recenter_booking_replay_mismatch');}
   const anchors=[latestSource.data,booking.source],open=(await db.query<{source:unknown}>(`
    SELECT provenance->'source' AS source FROM deployment_marks WHERE campaign_id=$1 AND
     provenance->>'classification'='rangekeeper_paper_open_v1' ORDER BY id LIMIT 1`,
    [row.campaign_id])).rows[0],openSource=paperFeeMarkSourceSchema.safeParse(open?.source);
   if(openSource.success)anchors.unshift(openSource.data);
   try{await verifyAnchors(row.chain_id,anchors);}
   catch(error){if(error instanceof AssertionError)
    throw new DeploymentConflict('rangekeeper_paper_recenter_source_not_canonical');throw error;}
   const provenance={...booked.provenance,operationId,previewId:row.preview_id,
    candidateReferenceProofHash:booking.candidateReferenceProofHash,
    paidCostsAvailable:false,actionAvailable:false};
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,NULL,'{}'::uuid[],$6) RETURNING id::text`,
    [row.campaign_id,row.revision,booking.source.block,booking.source.hash,
     JSON.stringify(booked.inventory),JSON.stringify(provenance)])).rows[0]!;
   const entryKey=`rangekeeper_paper_recenter:${operationId}`;
   await db.query(`INSERT INTO deployment_ledger
    (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
    VALUES($1,$2,$3,'attribution_boundary',NULL,NULL,NULL,$4)`,
    [row.campaign_id,operationId,entryKey,JSON.stringify({...booked.ledger,markId:mark.id,
     modelHash:booking.modelHash,candidateHash:booking.candidateHash,paidCostsAvailable:false})]);
   await db.query(`UPDATE deployment_operations SET status='succeeded',stage='paper_recenter_recorded',
    claimed_by=NULL,claim_until=NULL,updated_at=clock_timestamp() WHERE id=$1`,[operationId]);
   return {markId:mark.id,replayed:false,epoch:booking.epoch};
  });
 }

 /** Atomically persist one worker-replayed RangeKeeper convert exit. The
  * process-local replay capability proves quote/owned-fork execution; this
  * transaction rechecks the frozen operation, latest epoch and canonical
  * anchors before appending a closed mark and non-economic ledger boundary. */
 async completeRangeKeeperPaperConfirmedConvert(operationId:string,workerId:string,
  capability:unknown,verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  return this.transaction(async db=>{
   const row=(await db.query<{campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_valid:boolean|null;mode:string;lifecycle:string;chain_id:number;
    current_revision:number;runtime_identity:unknown;profile:unknown;profile_hash:string;
    config:unknown;config_hash:string;strategy_id:string;strategy_version:string;
    state_schema_version:number;proposal:Record<string,unknown>;request:Record<string,unknown>;
    evidence:Record<string,unknown>;content_digest:string;expected_revision:number;
    preview_kind:string;preview_created_at:Date;accepted_at:Date;expires_at:Date}>(`
    SELECT o.campaign_id,o.preview_id::text,o.kind,o.status,o.claimed_by,
     (o.claim_until>=clock_timestamp()) AS claim_valid,c.mode,c.lifecycle,c.chain_id,
     c.current_revision,c.runtime_identity,p.profile,p.profile_hash,r.config,r.config_hash,
     r.strategy_id,r.strategy_version,r.state_schema_version,v.proposal,v.request,v.evidence,
     v.content_digest,v.expected_revision,v.kind AS preview_kind,v.created_at AS preview_created_at,
     o.created_at AS accepted_at,v.expires_at
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_previews v ON v.id=o.preview_id WHERE o.id=$1 FOR UPDATE OF o,c`,
    [operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='close_convert'||row.strategy_id!=='rangekeeper_v1')
    throw new DeploymentConflict('rangekeeper_paper_convert_operation_unavailable');
   if(row.status==='succeeded'){
    const mark=(await db.query<{id:string}>(`SELECT id::text FROM deployment_marks
     WHERE campaign_id=$1 AND provenance->>'operationId'=$2 AND
      provenance->>'classification'='rangekeeper_paper_close_convert_v1' LIMIT 2`,
     [row.campaign_id,operationId])).rows;
    if(mark.length!==1||row.lifecycle!=='closed')
     throw new DeploymentConflict('rangekeeper_paper_convert_replay_integrity');
    return {markId:mark[0]!.id,replayed:true};
   }
   if(row.lifecycle!=='closing'||row.status!=='reconciling'||row.claimed_by!==workerId||!row.claim_valid)
    throw new DeploymentConflict('rangekeeper_paper_convert_claim_lost');
   if(row.current_revision!==row.expected_revision||row.accepted_at.getTime()<row.preview_created_at.getTime()||
    row.accepted_at.getTime()>row.expires_at.getTime())
    throw new DeploymentConflict('rangekeeper_paper_convert_preview_stale');
   if(row.preview_kind!=='close_convert'||previewDigest({campaignId:row.campaign_id,
    expectedRevision:row.expected_revision,kind:'close_convert',request:row.request,
    proposal:row.proposal,evidence:row.evidence,expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('rangekeeper_paper_convert_preview_integrity');
   const model=row.proposal.rangekeeperPaperExitModel,modelHash=row.proposal.rangekeeperPaperExitModelHash;
   if(!model||typeof model!=='object'||Array.isArray(model)||contentHash(model)!==modelHash)
    throw new DeploymentConflict('rangekeeper_paper_convert_model_integrity');
   const m=model as Record<string,any>,source=paperFeeMarkSourceSchema.safeParse(m.source),
    runtime=sealedRuntimeIdentitySchema.safeParse(row.runtime_identity),current=loadRuntimeIdentity(),
    profile=marketProfileSchema.safeParse(row.profile);
   if(!source.success||!runtime.success||!await campaignRuntimeMatches(db,row.campaign_id,runtime.data,current)||
    !profile.success||contentHash(profile.data)!==row.profile_hash||!row.config||
    typeof row.config!=='object'||Array.isArray(row.config)||contentHash(row.config)!==row.config_hash||
    row.strategy_version!=='1.0.0'||row.state_schema_version!==1||m.campaignId!==row.campaign_id||
    m.revision!==row.current_revision||m.exitKind!=='convert'||m.status!=='indicative'||
    m.profileHash!==row.profile_hash||m.draftConfigHash!==row.config_hash||
    row.request.exitKind!=='convert'||row.request.strategyId!=='rangekeeper_v1'||
    row.request.openMarkId!==m.openMarkId||row.request.candidateHash!==m.candidateHash)
    throw new DeploymentConflict('rangekeeper_paper_convert_model_binding_invalid');
   const convert=m.conversion as Record<string,unknown>|null;
   if(!convert||typeof convert.quoteHash!=='string'||!/^([0-9a-f]{64})$/.test(convert.quoteHash))
    throw new DeploymentConflict('rangekeeper_paper_convert_quote_missing');
   const operationSnapshot=(await this.rangeKeeperPaperExitOperationSnapshot(row.campaign_id,operationId,workerId)) as
    {snapshotHash:string;exitContext:Record<string,any>};
   const savedEpoch=operationSnapshot.exitContext.currentEpoch as Record<string,any>|undefined,
    modelEpoch=m.currentEpoch as Record<string,any>|undefined;
   if(!savedEpoch||!modelEpoch||modelEpoch.epoch!==savedEpoch.epoch||
    modelEpoch.markId!==savedEpoch.markId||modelEpoch.markHash!==savedEpoch.markHash||
    contentHash(modelEpoch.source)!==contentHash(savedEpoch.source)||
    modelEpoch.candidateHash!==savedEpoch.candidateHash||
    modelEpoch.candidateReferenceProofHash!==savedEpoch.candidateReferenceProofHash||
    modelEpoch.allowancesCleared!==savedEpoch.allowancesCleared||
    contentHash(modelEpoch.position)!==contentHash(savedEpoch.inventory?.position))
    throw new DeploymentConflict('rangekeeper_paper_convert_epoch_snapshot_mismatch');
   const binding={operationId,previewId:row.preview_id,campaignId:row.campaign_id,
    revision:row.current_revision,operationSnapshotHash:
     operationSnapshot.snapshotHash,
    modelHash:String(modelHash),quoteHash:convert.quoteHash,sourceBlock:source.data.block,
    sourceHash:source.data.hash};
   try{assertRangeKeeperPaperConvertReplayCapability(capability,binding);}
   catch{throw new DeploymentConflict('rangekeeper_paper_convert_replay_capability_invalid');}
   const open=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE id=$1 AND campaign_id=$2 FOR SHARE`,[m.openMarkId,row.campaign_id])).rows[0],
    latest=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
     inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`
     SELECT m.id::text,source_block::text,source_hash,inventory,provenance
     FROM deployment_marks m WHERE m.campaign_id=$1 ORDER BY m.id DESC LIMIT 1 FOR UPDATE`,[row.campaign_id])).rows[0];
   if(!open||open.provenance.classification!=='rangekeeper_paper_open_v1'||
    open.provenance.modelHash!==m.openModelHash||!latest||latest.id!==m.previousMark.id||
    latest.source_block!==m.previousMark.source.block||
    latest.source_hash?.toLowerCase()!==m.previousMark.source.hash.toLowerCase()||
    latest.provenance.candidateHash!==m.candidateHash)
    throw new DeploymentConflict('rangekeeper_paper_convert_latest_position_changed');
   const previousSource=paperFeeMarkSourceSchema.safeParse(latest.provenance.source);
   if(!previousSource.success||contentHash(previousSource.data)!==contentHash(m.previousMark.source))
    throw new DeploymentConflict('rangekeeper_paper_convert_previous_source_invalid');
   try{await verifyAnchors(row.chain_id,[source.data,previousSource.data,
    ...((open.provenance.source&&typeof open.provenance.source==='object')?
     [paperFeeMarkSourceSchema.parse(open.provenance.source)]:[])]);}
   catch(error){if(error instanceof AssertionError)
    throw new DeploymentConflict('rangekeeper_paper_convert_source_not_canonical');throw error;}
   const position=m.position as Record<string,unknown>,inputToken=convert.inputToken;
   const inputRaw=String(convert.inputAmount),outputRaw=String(convert.expectedOutput),
    token0Raw=inputToken===0?0n:BigInt(position.principal0 as string)+BigInt(position.idle0 as string)+BigInt(outputRaw),
    token1Raw=inputToken===1?0n:BigInt(position.principal1 as string)+BigInt(position.idle1 as string)+BigInt(outputRaw);
   if(BigInt(inputRaw)!==(inputToken===0?BigInt(position.principal0 as string)+BigInt(position.idle0 as string):
    BigInt(position.principal1 as string)+BigInt(position.idle1 as string)))
    throw new DeploymentConflict('rangekeeper_paper_convert_input_inventory_mismatch');
   const inventory={classification:'rangekeeper_paper_close_convert_v1',position:null,
    token0Raw:String(token0Raw),token1Raw:String(token1Raw),nativeWei:null,
    conversion:{quoteHash:convert.quoteHash,inputToken,outputToken:convert.outputToken,
     inputAmount:inputRaw,expectedOutput:outputRaw,minimumOutput:convert.minimumOutput},
    unavailable:['final_custody','paid_gas','net_economics']};
   const provenance={classification:'rangekeeper_paper_close_convert_v1',schemaVersion:1,
    operationId,previewId:row.preview_id,modelHash,quoteHash:convert.quoteHash,
    openMarkId:m.openMarkId,openModelHash:m.openModelHash,
    previousMark:m.previousMark,source:source.data,candidateHash:m.candidateHash,
    currentEpoch:{epoch:modelEpoch!.epoch,markId:modelEpoch!.markId,markHash:modelEpoch!.markHash,
     source:modelEpoch!.source,candidateHash:modelEpoch!.candidateHash,
     candidateReferenceProofHash:modelEpoch!.candidateReferenceProofHash,
     allowancesCleared:modelEpoch!.allowancesCleared,position:modelEpoch!.position},
    poolState:m.poolState,reference:m.reference,
    modeledCosts:m.costs,paidCostsAvailable:false,economicsAvailable:false,
    simulationHash:(capability as {simulationHash:string}).simulationHash,
    unavailable:['fees','paid_costs','net_economics','final_custody']};
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,NULL,'{}'::uuid[],$6) RETURNING id::text`,
    [row.campaign_id,row.current_revision,source.data.block,source.data.hash,
     JSON.stringify(inventory),JSON.stringify(provenance)])).rows[0]!;
   const entryKey=`rangekeeper_paper_close_convert:${operationId}`;
   await db.query(`INSERT INTO deployment_ledger
    (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
    VALUES($1,$2,$3,'attribution_boundary',NULL,NULL,NULL,$4)`,
    [row.campaign_id,operationId,entryKey,JSON.stringify({classification:provenance.classification,
     operationId,markId:mark.id,modelHash,quoteHash:convert.quoteHash,
     convertedInventory:inventory,paidCostsAvailable:false})]);
   await db.query(`UPDATE deployment_campaigns SET lifecycle='closed',range_state='no_liquidity',
    closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[row.campaign_id]);
   await db.query(`UPDATE deployment_operations SET status='succeeded',stage='paper_close_convert_recorded',
    claimed_by=NULL,claim_until=NULL,updated_at=clock_timestamp() WHERE id=$1`,[operationId]);
   return {markId:mark.id,replayed:false};
  });
 }

 // ---------------------------------------------------------------------
 // NEW METHOD — added for the RangeKeeper paper EXIT (gap E of
 // docs/plans/rangekeeper-paper-operation-path-2026-10-01.md). Another track
 // may also be editing this file concurrently; this method is self-contained
 // — it only reads/writes deployment_operations/deployment_campaigns/
 // deployment_marks/deployment_ledger rows scoped to its own operationId —
 // and does not modify any other method in this class.
 //
 // Scope: `close_retain` only. It cannot re-derive the exit model's live
 // parts (kernel evaluation, convert quote) since those require RPC calls
 // owned by rangekeeper-paper-exit-model.ts, which this method does not
 // import from and must not edit. What it DOES independently re-derive, from
 // two already-trusted deployment_marks rows (the open mark and the latest
 // prior mark) plus the model's own pinned pool state, is the retained-
 // principal arithmetic that is actually written to the ledger — see
 // rangekeeper-paper-exit-completion.ts's buildRangeKeeperPaperCloseRetainBooking.
 // close_convert is refused by the worker before this method is ever called.
 // ---------------------------------------------------------------------
 async completeRangeKeeperPaperConfirmedExit(operationId:string,workerId:string,
  verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  return this.transaction(async db=>{
   const row=(await db.query<{campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_valid:boolean|null;mode:string;lifecycle:string;chain_id:number;
    current_revision:number;profile:unknown;profile_hash:string;config:unknown;config_hash:string;
    strategy_id:string;strategy_version:string;state_schema_version:number;
    proposal:Record<string,unknown>;request:Record<string,unknown>;evidence:Record<string,unknown>;
    content_digest:string;expected_revision:number;preview_kind:string;preview_created_at:Date;
    accepted_at:Date;expires_at:Date;runtime_identity:unknown}>(`
    SELECT o.campaign_id,o.preview_id,o.kind,o.status,o.claimed_by,
     (o.claim_until>=clock_timestamp()) AS claim_valid,c.mode,c.lifecycle,c.chain_id,
     c.current_revision,p.profile,p.profile_hash,r.config,r.config_hash,r.strategy_id,
     r.strategy_version,r.state_schema_version,
     v.proposal,v.request,v.evidence,v.content_digest,v.expected_revision,v.kind AS preview_kind,
     v.created_at AS preview_created_at,o.created_at AS accepted_at,v.expires_at,c.runtime_identity
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_previews v ON v.id=o.preview_id WHERE o.id=$1 FOR UPDATE OF o,c`,
    [operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='close_retain'||row.strategy_id!=='rangekeeper_v1')
    throw new DeploymentConflict('rangekeeper_paper_exit_operation_unavailable');
   if(row.status==='succeeded'){
    const prior=(await db.query<{id:string}>(`SELECT id::text FROM deployment_marks
     WHERE campaign_id=$1 AND provenance->>'operationId'=$2 LIMIT 2`,
     [row.campaign_id,operationId])).rows;
    if(prior.length!==1)throw new DeploymentConflict('rangekeeper_paper_exit_replay_integrity');
    return {markId:prior[0]!.id,replayed:true};
   }
   if(row.lifecycle!=='closing'||row.status!=='reconciling'||row.claimed_by!==workerId||
    !row.claim_valid)throw new DeploymentConflict('rangekeeper_paper_exit_claim_lost');
   const runtime=sealedRuntimeIdentitySchema.safeParse(row.runtime_identity),currentRuntime=loadRuntimeIdentity();
   if(!runtime.success||!currentRuntime||!await campaignRuntimeMatches(db,row.campaign_id,
    runtime.data,currentRuntime))
    throw new DeploymentConflict('rangekeeper_paper_exit_runtime_mismatch');
   if(row.strategy_version!=='1.0.0'||row.state_schema_version!==1)
    throw new DeploymentConflict('rangekeeper_paper_exit_config_integrity');
   if(row.current_revision!==row.expected_revision||row.accepted_at.getTime()>row.expires_at.getTime()||
    row.accepted_at.getTime()<row.preview_created_at.getTime())
    throw new DeploymentConflict('rangekeeper_paper_exit_preview_stale');
   if(row.preview_kind!=='close_retain'||previewDigest({campaignId:row.campaign_id,
    expectedRevision:row.expected_revision,kind:row.preview_kind,request:row.request,
    proposal:row.proposal,evidence:row.evidence,expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('rangekeeper_paper_exit_preview_integrity');
   const modelHashField=row.proposal.rangekeeperPaperExitModelHash;
   if(typeof modelHashField!=='string'||row.proposal.rangekeeperPaperExitModel===undefined||
    contentHash(row.proposal.rangekeeperPaperExitModel)!==modelHashField)
    throw new DeploymentConflict('rangekeeper_paper_exit_model_hash_mismatch');
   const parsedModel=rangeKeeperPaperCloseRetainModelBookingSchema.safeParse(
    row.proposal.rangekeeperPaperExitModel);
   if(!parsedModel.success)throw new DeploymentConflict('rangekeeper_paper_exit_model_unavailable');
   const model=parsedModel.data;
   // The persisted economic model remains read-only. HTTP actionability is a
   // separate wrapper over its trusted preview and the ready operation worker.
   if(model.status!=='indicative')
    throw new DeploymentConflict('rangekeeper_paper_exit_model_not_indicative');
   const profile=marketProfileSchema.safeParse(row.profile);
   if(!profile.success||contentHash(row.profile)!==row.profile_hash||
    !row.config||typeof row.config!=='object'||Array.isArray(row.config)||
    contentHash(row.config)!==row.config_hash)
    throw new DeploymentConflict('rangekeeper_paper_exit_campaign_integrity');
   const config=row.config as Record<string,unknown>;
   if(config.strategyId!=='rangekeeper_v1'||config.strategyVersion!=='1.0.0'||
    config.stateSchemaVersion!==1)
    throw new DeploymentConflict('rangekeeper_paper_exit_config_integrity');
   if(model.campaignId!==row.campaign_id||model.revision!==row.current_revision||
    model.profileHash!==row.profile_hash||model.draftConfigHash!==row.config_hash||
    model.currentEpoch?.candidateHash!==model.candidateHash||
    referenceProofHash(model.reference.proof)!==model.reference.proofHash)
    throw new DeploymentConflict('rangekeeper_paper_exit_model_integrity');
   const req=row.request;
   if(req.kind!=='close_retain'||req.strategyId!=='rangekeeper_v1'||req.exitKind!=='retain'||
    req.profileHash!==model.profileHash||req.configHash!==model.draftConfigHash||
    req.openMarkId!==model.openMarkId||req.candidateHash!==model.candidateHash)
    throw new DeploymentConflict('rangekeeper_paper_exit_request_mismatch');
   const openMark=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;provenance:Record<string,unknown>;open_model:Record<string,unknown>|null}>(`
    SELECT m.id::text,m.source_block::text,m.source_hash,m.inventory,m.provenance,
     COALESCE(m.provenance->'confirmedOpen'->'model',m.provenance->'model',
      v.proposal->'rangekeeperPaperOpenModel') AS open_model
    FROM deployment_marks m LEFT JOIN deployment_previews v ON
     v.id::text=m.provenance->>'previewId' AND v.campaign_id=m.campaign_id
    WHERE m.id=$1 AND m.campaign_id=$2 FOR SHARE OF m`,[model.openMarkId,row.campaign_id])).rows[0];
   const confirmedOpen=openMark?.provenance.confirmedOpen as Record<string,unknown>|undefined,
    openModel=openMark?.open_model,
    openCandidateHash=openModel?.candidateHash;
   if(!openMark||openMark.source_block===null||openMark.source_hash===null||
    openMark.provenance.classification!=='rangekeeper_paper_open_v1'||
    openMark.provenance.modelHash!==model.openModelHash||
    !openModel||contentHash(openModel)!==model.openModelHash||
    typeof openCandidateHash!=='string'||openMark.provenance.candidateHash!==openCandidateHash||
    (confirmedOpen!==undefined&&(confirmedOpen.campaignId!==row.campaign_id||
     confirmedOpen.revision!==row.current_revision||confirmedOpen.modelHash!==model.openModelHash||
     confirmedOpen.model===undefined||contentHash(confirmedOpen.model)!==model.openModelHash))||
    (model.currentEpoch.epoch===0&&model.candidateHash!==openCandidateHash))
    throw new DeploymentConflict('rangekeeper_paper_exit_open_mark_unavailable');
   const openMarkSource=z.object({block:z.string().regex(/^(0|[1-9][0-9]*)$/),
    hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),timestamp:z.number().int().nonnegative()}).strict()
    .safeParse((openMark.provenance as {source?:unknown}).source);
   if(!openMarkSource.success||openMarkSource.data.block!==openMark.source_block||
    openMarkSource.data.hash.toLowerCase()!==openMark.source_hash.toLowerCase())
    throw new DeploymentConflict('rangekeeper_paper_exit_open_mark_unavailable');
   const previousMarkRow=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`
    SELECT m.id::text,source_block::text,source_hash,inventory,provenance FROM deployment_marks m
    WHERE m.campaign_id=$1 ORDER BY m.id DESC LIMIT 1 FOR SHARE`,[row.campaign_id])).rows[0];
   if(!previousMarkRow||previousMarkRow.id!==model.previousMark.id||
    previousMarkRow.source_block===null||previousMarkRow.source_hash===null||
    BigInt(previousMarkRow.id)<=BigInt(openMark.id)||
    !['rangekeeper_paper_mark_v1','rangekeeper_paper_recenter_v1']
     .includes(String(previousMarkRow.provenance.classification))||
    Number(previousMarkRow.provenance.epoch??0)!==model.currentEpoch.epoch||
    previousMarkRow.provenance.candidateHash!==model.currentEpoch.candidateHash||
    (previousMarkRow.provenance.classification==='rangekeeper_paper_recenter_v1'&&
     previousMarkRow.id!==model.currentEpoch.markId))
    throw new DeploymentConflict('rangekeeper_paper_exit_previous_mark_unavailable');
   const positionSchema=z.object({tickLower:z.number().int(),tickUpper:z.number().int(),
    liquidity:z.string().regex(/^[1-9][0-9]*$/)}),
    currentEpoch=model.currentEpoch as {epoch?:unknown;markId?:unknown;markHash?:unknown;
    source?:unknown;position?:unknown}|undefined;
   if(!currentEpoch||!Number.isInteger(currentEpoch.epoch)||typeof currentEpoch.markId!=='string'||
    typeof currentEpoch.markHash!=='string')
    throw new DeploymentConflict('rangekeeper_paper_exit_epoch_unavailable');
   const epochCreator=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;economics:unknown;provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,source_block::text,source_hash,inventory,economics,provenance FROM deployment_marks
    WHERE campaign_id=$1 AND id=$2 FOR SHARE`,[row.campaign_id,currentEpoch.markId])).rows[0];
   if(!epochCreator||epochCreator.revision!==row.current_revision||
    (Number(currentEpoch.epoch)===0?epochCreator.id!==openMark.id:
     epochCreator.provenance.classification!=='rangekeeper_paper_recenter_v1'||
      Number(epochCreator.provenance.epoch)!==Number(currentEpoch.epoch)))
    throw new DeploymentConflict('rangekeeper_paper_exit_epoch_creator_unavailable');
   const epochCreatorSource=paperFeeMarkSourceSchema.safeParse(epochCreator.provenance.source),
    epochCreatorHash=contentHash({revision:epochCreator.revision,source_block:epochCreator.source_block,
     source_hash:epochCreator.source_hash,inventory:epochCreator.inventory,economics:epochCreator.economics,
     provenance:epochCreator.provenance}),
    currentEpochPosition=positionSchema.safeParse((epochCreator.inventory as {position?:unknown}).position);
   if(!epochCreatorSource.success||epochCreator.source_block!==epochCreatorSource.data.block||
    epochCreator.source_hash?.toLowerCase()!==epochCreatorSource.data.hash.toLowerCase()||
    epochCreator.provenance.candidateHash!==model.currentEpoch.candidateHash||
    epochCreatorHash!==currentEpoch.markHash||contentHash(epochCreatorSource.data)!==contentHash(currentEpoch.source)||
    !currentEpochPosition.success||contentHash(currentEpochPosition.data)!==contentHash(currentEpoch.position))
    throw new DeploymentConflict('rangekeeper_paper_exit_epoch_creator_integrity');
   const previousMarkSource=z.object({block:z.string().regex(/^(0|[1-9][0-9]*)$/),
    hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),timestamp:z.number().int().nonnegative()}).strict()
    .safeParse((previousMarkRow.provenance as {source?:unknown}).source);
   if(!previousMarkSource.success||previousMarkSource.data.block!==previousMarkRow.source_block||
    previousMarkSource.data.hash.toLowerCase()!==previousMarkRow.source_hash.toLowerCase()||
    contentHash(previousMarkSource.data)!==contentHash(model.previousMark.source))
    throw new DeploymentConflict('rangekeeper_paper_exit_previous_mark_unavailable');
   const idleSchema=z.object({token0:z.string().regex(/^(0|[1-9][0-9]*)$/),
     token1:z.string().regex(/^(0|[1-9][0-9]*)$/)}).strict();
   // A booked opening also records amount0Minted/amount1Minted. Those entry
   // quantities are not the principal at the exit frame, and must not make a
   // valid persisted position fail a strict three-field parse.
   const openPositionParsed=positionSchema.strip().safeParse((openMark.inventory as {position?:unknown}).position),
    previousPositionParsed=positionSchema.safeParse(
     (previousMarkRow.inventory as {position?:unknown}).position),
    previousIdleParsed=idleSchema.safeParse((previousMarkRow.inventory as {idle?:unknown}).idle);
   if(!openPositionParsed.success||!previousPositionParsed.success||!previousIdleParsed.success)
    throw new DeploymentConflict('rangekeeper_paper_exit_inventory_unavailable');
   let booking;
   try{booking=buildRangeKeeperPaperCloseRetainBooking({operationId,previewId:row.preview_id,
    modelHash:modelHashField,model,openMarkPosition:openPositionParsed.data,
    currentEpochPosition:currentEpochPosition.data,
    previousMark:{id:previousMarkRow.id,position:previousPositionParsed.data,idle:previousIdleParsed.data},
    pool:{token0:profile.data.pool.token0,token1:profile.data.pool.token1}});}
   catch{throw new DeploymentConflict('rangekeeper_paper_exit_model_replay_mismatch');}
   const acceptedAt=row.accepted_at.getTime(),sourceAt=model.source.timestamp*1000;
   if(sourceAt>acceptedAt||acceptedAt-sourceAt>180_000||
    model.previousMark.source.timestamp>sourceAt||
    BigInt(model.source.block)<=BigInt(model.previousMark.source.block))
    throw new DeploymentConflict('rangekeeper_paper_exit_source_stale_or_ordered_wrong');
   const exitAnchors=[openMarkSource.data,previousMarkSource.data,epochCreatorSource.data,model.source];
   for(const anchor of exitAnchors)if(exitAnchors.some(other=>other.block===anchor.block&&
    other.hash.toLowerCase()!==anchor.hash.toLowerCase()))
    throw new DeploymentConflict('rangekeeper_paper_exit_source_conflict');
   try{await verifyAnchors(row.chain_id,exitAnchors.filter((anchor,index,array)=>
    array.findIndex(other=>other.block===anchor.block)===index));}
   catch(error){if(error instanceof AssertionError)
     throw new DeploymentConflict('rangekeeper_paper_exit_source_not_canonical');throw error;}
   for(const entry of booking.ledger){
    await db.query(`INSERT INTO deployment_ledger
     (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
     VALUES($1,$2,$3,'capital_out',$4,NULL,NULL,$5)`,
     [row.campaign_id,operationId,entry.entryKey,entry.token,JSON.stringify(entry.source)]);
   }
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,NULL,$6,$7) RETURNING id::text`,
    [row.campaign_id,row.current_revision,model.source.block,model.source.hash,
     JSON.stringify(booking.mark.inventory),booking.mark.calibrationProfileIds,
     JSON.stringify(booking.mark.provenance)])).rows[0]!;
   await db.query(`UPDATE deployment_campaigns SET lifecycle='closed',range_state='no_liquidity',
    closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[row.campaign_id]);
   await db.query(`UPDATE deployment_operations SET status='succeeded',
    stage='rangekeeper_paper_close_retain_recorded',claimed_by=NULL,claim_until=NULL,
    updated_at=clock_timestamp() WHERE id=$1`,[operationId]);
   return {markId:mark.id,replayed:false};
  });
 }

 private async reserveLiveWallet(db:PoolClient,campaignId:string,chainId:number,wallet:string){
  const key=`conc-liq-live:${chainId}:${wallet}`;
  const locked=(await db.query<{locked:boolean}>(
   'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[key])).rows[0]?.locked;
  if(!locked)throw new DeploymentConflict('predecessor_wallet_locked');
  for(const schema of ['rangekeeper_v1','live_pilot_v1']){
   const exists=(await db.query<{present:string|null}>('SELECT to_regclass($1) AS present',[`${schema}.campaigns`])).rows[0]?.present;
   if(!exists)continue;
   const current=(await db.query<{active:boolean}>(`SELECT EXISTS (
    SELECT 1 FROM ${schema}.campaigns WHERE lower(operator)=$1 AND coalesce(state->>'phase','unknown')<>'closed'
   ) AS active`,[wallet])).rows[0]?.active;
   if(current)throw new DeploymentConflict('predecessor_custody_unresolved');
   const unresolved=(await db.query<{active:boolean}>(`SELECT EXISTS (
    SELECT 1 FROM ${schema}.actions a JOIN ${schema}.campaigns c ON c.id=a.campaign_id
    WHERE lower(c.operator)=$1 AND a.status IN ('prepared','signed')
   ) AS active`,[wallet])).rows[0]?.active;
   if(unresolved)throw new DeploymentConflict('predecessor_intent_unresolved');
  }
  try{await db.query(`INSERT INTO deployment_wallet_reservations(chain_id,wallet,campaign_id) VALUES($1,$2,$3)`,
   [chainId,wallet,campaignId]);}
  catch(error){if((error as {code?:string}).code==='23505')throw new DeploymentConflict('wallet_reserved');throw error;}
 }
}
