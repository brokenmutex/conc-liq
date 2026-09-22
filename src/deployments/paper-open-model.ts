import {z} from 'zod';
import {contentHash,staticParameters} from './contracts.js';
import {referenceProofHash} from './market-profile.js';
import type {PaperPreviewDraft,PaperOpenFrame,buildIndicativePaperOpenPreview} from './paper-preview.js';
import type {costIndicativePaperOpenPreview} from './paper-cost.js';
type CostedOpenPreview=ReturnType<typeof costIndicativePaperOpenPreview<
 ReturnType<typeof buildIndicativePaperOpenPreview>>>;

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const candidate=z.object({
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int(),
  fullWidthTicks:z.number().int()}).passthrough(),
 liquidity:raw,amount0Desired:raw,amount1Desired:raw,amount0Minted:raw,amount1Minted:raw,
 idle0:raw,idle1:raw,deployedValue:raw,exposurePpm:raw,feeEarningAtEntry:z.boolean(),
 oneSided:z.boolean(),dilutedSharePpm:raw,
}).strict();
const cost=z.object({status:z.literal('provisional'),scope:z.literal('open_and_close_retain_gas_only'),
 pathVersion:z.literal('paper_static_manual_no_swap_v1'),sizeBand:z.string(),gasPriceWei:raw,
 boundGasPriceWei:raw,gasPriceObservedAt:z.iso.datetime({offset:true}),nativeReferencePrice:raw,
 stages:z.array(z.object({stage:z.string(),profileId:z.uuid(),version:z.number().int().positive(),
  evidenceClass:z.literal('fork_estimated'),expectedGasUnits:raw,boundGasUnits:raw,
  source:z.object({block:raw,hash,estimatedAt:z.iso.datetime({offset:true}),callHash:hash,
   method:z.literal('owned_fork_nitro_exact_call_v1')}).strict()}).strict()).length(6),
 open:z.object({expectedGasUnits:raw,boundGasUnits:raw,expectedWei:raw,boundWei:raw,
  expectedValue:raw,boundValue:raw}).strict(),
 closeRetain:z.object({expectedGasUnits:raw,boundGasUnits:raw,expectedWei:raw,boundWei:raw,
  expectedValue:raw,boundValue:raw}).strict(),missing:z.array(z.string()),
}).strict();
export const paperOpenModelSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('paper_open_model'),
 campaignId:z.uuid(),revision:z.number().int().positive(),strategyId:z.literal('static_manual_v1'),
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),configHash:z.string().regex(/^[0-9a-f]{64}$/),
 candidateHash:z.string().regex(/^[0-9a-f]{64}$/),source:z.object({block:raw,hash,
  timestamp:z.number().int().nonnegative()}).strict(),
 poolState:z.object({tick:z.number().int(),sqrtPriceX96:raw,poolLiquidity:raw}).strict(),
 referenceProof:z.record(z.string(),z.unknown()),referenceProofHash:z.string().regex(/^[0-9a-f]{64}$/),
 reference:z.object({price0:raw,price1:raw,nativePrice:raw}).strict(),
 allocation:z.object({token0Raw:raw,token1Raw:raw,nativeWei:raw}).strict(),
 candidate,costs:cost,
}).strict();
export type PaperOpenModel=z.infer<typeof paperOpenModelSchema>;

/** This is a hypothetical no-swap fill. The fork gas is an estimate and no
 * chain transaction or paid-cost entry is implied by this record. */
export function buildPaperOpenModel(draft:PaperPreviewDraft,frame:PaperOpenFrame,
 preview:CostedOpenPreview):PaperOpenModel{
 if(draft.strategyId!=='static_manual_v1'||preview.status!=='indicative'||
  preview.costs.status!=='provisional'||!preview.candidate||!frame.referenceProof||
  !frame.referenceEligible||frame.price0===null||frame.price1===null||frame.nativePrice===null)
  throw Error('paper_open_model_unavailable');
 if(referenceProofHash(frame.referenceProof)!==frame.referenceProofHash||
  preview.referenceProofHash!==frame.referenceProofHash||
  preview.campaignId!==draft.id||preview.revision!==draft.revision||
  preview.profileHash!==draft.profileHash||preview.configHash!==draft.configHash||
  preview.source.block!==frame.source.block||preview.source.hash.toLowerCase()!==frame.source.hash.toLowerCase())
  throw Error('paper_open_source_mismatch');
 const limits=staticParameters.parse(draft.parameters).limits;
 if(!limits)throw Error('paper_open_limits_unavailable');
 const c=preview.candidate,costs=preview.costs;
 if(BigInt(c.amount0Minted)+BigInt(c.idle0)!==BigInt(c.amount0Desired)||
  BigInt(c.amount1Minted)+BigInt(c.idle1)!==BigInt(c.amount1Desired)||
  BigInt(c.amount0Desired)>BigInt(draft.allocation.token0Raw)||
  BigInt(c.amount1Desired)>BigInt(draft.allocation.token1Raw))
  throw Error('paper_open_inventory_mismatch');
 const max=(a:bigint,b:bigint)=>a>b?a:b;
 if(BigInt(costs.open.boundValue)>BigInt(limits.maxActionCost)||
  BigInt(costs.open.boundValue)>BigInt(limits.maxRollingCost)||
  BigInt(costs.open.boundValue)+BigInt(costs.closeRetain.boundValue)>BigInt(limits.maxCampaignCost)||
  BigInt(draft.allocation.nativeWei)<BigInt(costs.open.boundWei)+
   max(BigInt(limits.exitReserveWei),BigInt(costs.closeRetain.boundWei)))
  throw Error('paper_open_cost_or_reserve_limit');
 const model=paperOpenModelSchema.parse({schemaVersion:1,kind:'paper_open_model',
  campaignId:draft.id,revision:draft.revision,strategyId:'static_manual_v1',
  profileHash:draft.profileHash,configHash:draft.configHash,candidateHash:preview.candidateHash,
  source:frame.source,poolState:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),
   poolLiquidity:String(frame.poolLiquidity)},referenceProof:frame.referenceProof,
  referenceProofHash:frame.referenceProofHash,
  reference:{price0:String(frame.price0),price1:String(frame.price1),nativePrice:String(frame.nativePrice)},
  allocation:draft.allocation,candidate:c,costs});
 if(model.candidateHash!==contentHash({campaignId:model.campaignId,revision:model.revision,
  profileHash:model.profileHash,configHash:model.configHash,source:model.source,
  referenceProofHash:model.referenceProofHash,candidate:model.candidate}))
  throw Error('paper_open_candidate_hash_mismatch');
 return model;
}
