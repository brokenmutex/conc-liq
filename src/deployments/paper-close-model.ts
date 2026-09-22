import {z} from 'zod';
import {principalAmounts} from '../backtest/principal.js';
import {staticParameters,contentHash} from './contracts.js';
import {referenceProofHash,type MarketProfile} from './market-profile.js';
import {paperOpenModelSchema,type PaperOpenModel} from './paper-open-model.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {costIndicativePaperOpenPreview} from './paper-cost.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const paperCloseRetainModelSchema=z.object({
 schemaVersion:z.literal(1),kind:z.literal('paper_close_retain_model'),campaignId:z.uuid(),
 revision:z.number().int().positive(),openMarkId:raw,openModelHash:z.string().regex(/^[0-9a-f]{64}$/),
 source:z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict(),
 poolState:z.object({tick:z.number().int(),sqrtPriceX96:raw,poolLiquidity:raw}).strict(),
 referenceProof:z.record(z.string(),z.unknown()),referenceProofHash:z.string().regex(/^[0-9a-f]{64}$/),
 reference:z.object({price0:raw,price1:raw,nativePrice:raw}).strict(),
 principal:z.object({amount0Raw:raw,amount1Raw:raw}).strict(),
 retainedLowerBound:z.object({token0Raw:raw,token1Raw:raw}).strict(),
 unobserved:z.tuple([z.literal('fee_capture'),z.literal('paid_gas'),z.literal('net_economics')]),
 costs:paperOpenModelSchema.shape.costs,
}).strict();
export type PaperCloseRetainModel=z.infer<typeof paperCloseRetainModelSchema>;

/** Computes only provable principal and idle tokens. Fee income and paid gas
 * remain unknown, so retained balances are lower bounds, not final custody. */
export function buildPaperCloseRetainModel(open:PaperOpenModel,openMarkId:string,
 frame:PaperOpenFrame,profile:MarketProfile,parameters:Record<string,unknown>,
 costed:ReturnType<typeof costIndicativePaperOpenPreview>,now=Date.now()):PaperCloseRetainModel{
 if(costed.status!=='indicative'||costed.costs.status!=='provisional'||
  !frame.referenceEligible||!frame.referenceProof||!frame.price0||!frame.price1||!frame.nativePrice||
  frame.sqrtPriceX96<=0n||frame.poolLiquidity<=0n)throw Error('paper_close_model_unavailable');
 if(referenceProofHash(frame.referenceProof)!==frame.referenceProofHash||
  BigInt(frame.source.block)<=BigInt(open.source.block)||
  frame.source.timestamp<open.source.timestamp||
  now-frame.source.timestamp*1000<0||now-frame.source.timestamp*1000>180_000||
  contentHash(costed.candidate)!==contentHash(open.candidate))
  throw Error('paper_close_source_or_position_mismatch');
 const p=profile.pool;
 const poolPrice1=((1n<<192n)*10n**BigInt(p.decimals1)*frame.price0)/
  (frame.sqrtPriceX96*frame.sqrtPriceX96*10n**BigInt(p.decimals0));
 const deviation=poolPrice1>frame.price1?poolPrice1-frame.price1:frame.price1-poolPrice1;
 if(deviation*1_000_000n>frame.price1*BigInt(profile.referencePolicy.maxPoolDeviationPpm))
  throw Error('paper_close_independent_price_band');
 const limits=staticParameters.parse(parameters).limits;
 if(!limits)throw Error('paper_close_limits_unavailable');
 const max=(a:bigint,b:bigint)=>a>b?a:b;
 if(BigInt(costed.costs.closeRetain.boundValue)>BigInt(limits.maxActionCost)||
  BigInt(costed.costs.closeRetain.boundValue)>BigInt(limits.maxRollingCost)||
  BigInt(open.costs.open.boundValue)+BigInt(costed.costs.closeRetain.boundValue)>
   BigInt(limits.maxCampaignCost)||
  BigInt(open.allocation.nativeWei)<BigInt(open.costs.open.boundWei)+
   max(BigInt(limits.exitReserveWei),BigInt(costed.costs.closeRetain.boundWei)))
  throw Error('paper_close_cost_or_reserve_limit');
 const principal=principalAmounts({liquidity:BigInt(open.candidate.liquidity),
  tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
  sqrtPriceX96:frame.sqrtPriceX96});
 const retained0=BigInt(open.allocation.token0Raw)-BigInt(open.candidate.amount0Minted)+principal.amount0;
 const retained1=BigInt(open.allocation.token1Raw)-BigInt(open.candidate.amount1Minted)+principal.amount1;
 if(retained0<0n||retained1<0n)throw Error('paper_close_inventory_invalid');
 return paperCloseRetainModelSchema.parse({schemaVersion:1,kind:'paper_close_retain_model',
  campaignId:open.campaignId,revision:open.revision,openMarkId,
  openModelHash:contentHash(open),source:frame.source,
  poolState:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),
   poolLiquidity:String(frame.poolLiquidity)},
  referenceProof:frame.referenceProof,referenceProofHash:frame.referenceProofHash,
  reference:{price0:String(frame.price0),price1:String(frame.price1),nativePrice:String(frame.nativePrice)},
  principal:{amount0Raw:String(principal.amount0),amount1Raw:String(principal.amount1)},
  retainedLowerBound:{token0Raw:String(retained0),token1Raw:String(retained1)},
  unobserved:['fee_capture','paid_gas','net_economics'],costs:costed.costs});
}
