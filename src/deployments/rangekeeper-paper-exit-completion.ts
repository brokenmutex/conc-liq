import {z} from 'zod';
import {principalAmounts} from '../backtest/principal.js';
import {contentHash} from './contracts.js';

/** RangeKeeper paper EXIT completion/booking — gap E of
 * docs/plans/rangekeeper-paper-operation-path-2026-10-01.md.
 *
 * This module is intentionally narrow. It covers `close_retain` only; it does
 * not know how to book `close_convert`, and callers must not call the booking
 * builder below for an `exitKind!=='retain'` model. The scope note appended to
 * the plan document explains why convert is out of scope for this pass.
 *
 * It also does not, and cannot, re-derive `RangeKeeperPaperExitModel`'s live
 * parts (the kernel's `planRangeKeeper` evaluation, or a convert quote) —
 * those require live RPC `quote`/`simulate` calls that live inside
 * `rangekeeper-paper-exit-model.ts`, a file this module must not edit, whose
 * helpers (`idleInventory`, `validateIdentity`, `terminalQuote`, etc.) are not
 * exported. What this module DOES re-derive, from data already recorded on
 * two trusted `deployment_marks` rows (the open mark and the latest prior
 * mark) plus the model's own pinned pool state, is the pure principal/
 * retained-lower-bound arithmetic — the numbers that are actually written to
 * the ledger. Anything it cannot independently re-derive (modeled costs,
 * `kernelEvaluation`) is carried through unverified and labeled as such in
 * the booked mark's provenance, never used to decide whether to book. */

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const positiveRaw=z.string().regex(/^[1-9][0-9]*$/);
const hash64=z.string().regex(/^[0-9a-f]{64}$/);
const hash0x=z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const rangeKeeperPaperExitSourceSchema=z.object({block:raw,hash:hash0x,
 timestamp:z.number().int().nonnegative()}).strict();
export type RangeKeeperPaperExitSource=z.infer<typeof rangeKeeperPaperExitSourceSchema>;

/** The loosest possible read of a saved `RangeKeeperPaperExitModel`: just
 * enough to recover its canonical anchor source for a preliminary anchor
 * check. Deliberately passthrough/non-strict so it does not reject a model
 * shape this module does not otherwise care about (it does not gate booking
 * — `rangeKeeperPaperCloseRetainModelBookingSchema` below does that). Used by
 * both `close_retain` and `close_convert`, since both need a source for the
 * worker's preliminary canonical check before the kind is actually decided. */
export const rangeKeeperPaperExitModelSourceSchema=z.object({
 source:rangeKeeperPaperExitSourceSchema}).passthrough();

/** Deliberately narrow mirror of `RangeKeeperPaperExitModel` (owned by
 * `rangekeeper-paper-exit-model.ts`, which this module must not edit) scoped
 * to exactly the fields the retain-exit booking path reads. Non-strict at
 * every level whose shape this module does not otherwise depend on, so a
 * field renamed/added upstream does not by itself break parsing here; fields
 * this module DOES depend on are still required and will fail closed if
 * missing or malformed. This is not a substitute for the canonical type and
 * must not be read as one. */
export const rangeKeeperPaperCloseRetainModelBookingSchema=z.object({
 schemaVersion:z.literal(1),kind:z.literal('rangekeeper_paper_exit_model'),
 status:z.enum(['blocked','indicative']),exitKind:z.literal('retain'),
 actionAvailable:z.boolean(),
 campaignId:z.uuid(),revision:z.number().int().positive(),
 strategyId:z.literal('rangekeeper_v1'),strategyVersion:z.literal('1.0.0'),
 draftConfigHash:hash64,profileHash:hash64,
 openMarkId:raw,openModelHash:hash64,candidateHash:hash64,
 currentEpoch:z.object({epoch:z.number().int().nonnegative(),markId:raw,markHash:hash64,
  source:rangeKeeperPaperExitSourceSchema,candidateHash:hash64,candidateReferenceProofHash:hash64,
  allowancesCleared:z.boolean(),position:z.object({tickLower:z.number().int(),tickUpper:z.number().int(),
   liquidity:positiveRaw}).strict()}).strict(),
 previousMark:z.object({id:raw,source:rangeKeeperPaperExitSourceSchema,candidateHash:hash64}).strict(),
 source:rangeKeeperPaperExitSourceSchema,
 poolState:z.object({tick:z.number().int(),sqrtPriceX96:raw,poolLiquidity:raw}).strict(),
 reference:z.object({price0:raw,price1:raw,nativePrice:raw,proofHash:hash64,
  proof:z.record(z.string(),z.unknown())}).strict(),
 position:z.object({paperPositionKey:z.string().min(1),tickLower:z.number().int(),
  tickUpper:z.number().int(),liquidity:positiveRaw,sharePpm:raw,idle0:raw,idle1:raw,
  principal0:raw,principal1:raw,retainedLowerBound0:raw,retainedLowerBound1:raw}).strict(),
 conversion:z.null(),
 costs:z.object({status:z.literal('provisional'),
  profileIds:z.array(z.object({stage:z.string().min(1),id:z.uuid(),
   version:z.number().int().positive()}).strict())}).passthrough(),
 kernelEvaluation:z.unknown(),unmodeled:z.array(z.string()),unavailable:z.array(z.string()),
}).passthrough();
export type RangeKeeperPaperCloseRetainModelForBooking=
 z.infer<typeof rangeKeeperPaperCloseRetainModelBookingSchema>;

export interface RangeKeeperPaperCloseRetainBookingInput {
 operationId:string;previewId:string;modelHash:string;
 model:RangeKeeperPaperCloseRetainModelForBooking;
 openMarkPosition:{tickLower:number;tickUpper:number;liquidity:string};
 currentEpochPosition:{tickLower:number;tickUpper:number;liquidity:string};
 previousMark:{id:string;position:{tickLower:number;tickUpper:number;liquidity:string};
  idle:{token0:string;token1:string}};
 pool:{token0:string;token1:string};
}
export interface RangeKeeperPaperCloseRetainLedgerEntry {
 asset:'token0'|'token1'|'native';token:string|null;entryKey:string;source:Record<string,unknown>;
}
export interface RangeKeeperPaperCloseRetainBooking {
 ledger:readonly RangeKeeperPaperCloseRetainLedgerEntry[];
 mark:{inventory:Record<string,unknown>;provenance:Record<string,unknown>;calibrationProfileIds:string[]};
}

/** Pure, DB/RPC-free. Re-derives the retained-principal lower bound from the
 * open mark's position, the latest prior mark's idle wallet balances, and the
 * exit model's own pinned pool state, and requires it to match exactly what
 * the saved model declares before producing anything bookable. Throws on any
 * mismatch; never silently substitutes a recomputed value for the model's. */
export function buildRangeKeeperPaperCloseRetainBooking(
 input:RangeKeeperPaperCloseRetainBookingInput):RangeKeeperPaperCloseRetainBooking{
 const {model,openMarkPosition,currentEpochPosition,previousMark,pool}=input;
 if(model.exitKind!=='retain'||model.conversion!==null)
  throw new Error('rangekeeper_paper_exit_retain_model_kind_mismatch');
 if(previousMark.id!==model.previousMark.id)
  throw new Error('rangekeeper_paper_exit_previous_mark_mismatch');
 if((model.currentEpoch.epoch===0&&(openMarkPosition.tickLower!==model.position.tickLower||
  openMarkPosition.tickUpper!==model.position.tickUpper||
  openMarkPosition.liquidity!==model.position.liquidity))||
  currentEpochPosition.tickLower!==model.position.tickLower||
  currentEpochPosition.tickUpper!==model.position.tickUpper||
  currentEpochPosition.liquidity!==model.position.liquidity||
  previousMark.position.tickLower!==model.position.tickLower||
  previousMark.position.tickUpper!==model.position.tickUpper||
  previousMark.position.liquidity!==model.position.liquidity)
  throw new Error('rangekeeper_paper_exit_position_mismatch');
 if(previousMark.idle.token0!==model.position.idle0||previousMark.idle.token1!==model.position.idle1)
  throw new Error('rangekeeper_paper_exit_idle_mismatch');
 const principal=principalAmounts({liquidity:BigInt(model.position.liquidity),
  sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),tickLower:model.position.tickLower,
  tickUpper:model.position.tickUpper});
 if(String(principal.amount0)!==model.position.principal0||
  String(principal.amount1)!==model.position.principal1)
  throw new Error('rangekeeper_paper_exit_principal_mismatch');
 const retained0=BigInt(previousMark.idle.token0)+principal.amount0,
  retained1=BigInt(previousMark.idle.token1)+principal.amount1;
 if(String(retained0)!==model.position.retainedLowerBound0||
  String(retained1)!==model.position.retainedLowerBound1)
  throw new Error('rangekeeper_paper_exit_retained_lower_bound_mismatch');
 const baseSource={classification:'rangekeeper_paper_close_retain_v1' as const,
  operationId:input.operationId,previewId:input.previewId,openMarkId:model.openMarkId,
  previousMarkId:previousMark.id,modelHash:input.modelHash,candidateHash:model.candidateHash,
  currentEpoch:model.currentEpoch,
  referenceProofHash:model.reference.proofHash,source:model.source,poolState:model.poolState,
  reference:model.reference,unavailable:['fee_capture','paid_gas','net_economics']};
 const ledger:RangeKeeperPaperCloseRetainLedgerEntry[]=[
  {asset:'token0',token:pool.token0,entryKey:`rangekeeper_close_retain:${input.operationId}:token0`,
   source:{...baseSource,asset:'token0',principalLowerBoundRaw:model.position.retainedLowerBound0}},
  {asset:'token1',token:pool.token1,entryKey:`rangekeeper_close_retain:${input.operationId}:token1`,
   source:{...baseSource,asset:'token1',principalLowerBoundRaw:model.position.retainedLowerBound1}},
  {asset:'native',token:null,entryKey:`rangekeeper_close_retain:${input.operationId}:native`,
   source:{...baseSource,asset:'native',principalLowerBoundRaw:null}},
 ];
 const mark={inventory:{classification:'rangekeeper_paper_close_retain_v1',position:null,
   retainedPrincipalLowerBound:{token0Raw:model.position.retainedLowerBound0,
    token1Raw:model.position.retainedLowerBound1},unmodeled:model.unmodeled},
  provenance:{...baseSource,modeledCosts:model.costs,kernelEvaluation:model.kernelEvaluation,
   paidCostsAvailable:false},
  calibrationProfileIds:model.costs.profileIds.map(entry=>entry.id)};
 return {ledger,mark};
}

/** Recovers the exit model's canonical anchor source from a claimed
 * operation's saved proposal, for both `close_retain` and `close_convert`.
 * Requires the contract-guaranteed `rangekeeperPaperExitModelHash` to bind the
 * model before trusting any field inside it — the same posture `sourceFor`
 * already takes for the static open/retain/convert shapes it parses. Returns
 * `null` rather than throwing so callers can choose their own error code. */
export function recoverRangeKeeperPaperExitModelSource(proposal:unknown):RangeKeeperPaperExitSource|null{
 if(!proposal||typeof proposal!=='object'||Array.isArray(proposal))return null;
 const record=proposal as Record<string,unknown>,modelHash=record.rangekeeperPaperExitModelHash;
 if(typeof modelHash!=='string'||!/^[0-9a-f]{64}$/.test(modelHash))return null;
 if(record.rangekeeperPaperExitModel===undefined||contentHash(record.rangekeeperPaperExitModel)!==modelHash)
  return null;
 const parsed=rangeKeeperPaperExitModelSourceSchema.safeParse(record.rangekeeperPaperExitModel);
 if(!parsed.success)return null;
 return parsed.data.source;
}
