import {z} from 'zod';
import {principalAmounts} from '../backtest/principal.js';
import {contentHash} from './contracts.js';
import {referenceProofHash,marketProfileSchema,type MarketProfile} from './market-profile.js';
import {costIndicativePaperOpenPreview,type PaperGasProfileRow} from './paper-cost.js';
import {paperOpenModelSchema} from './paper-open-model.js';
import type {PaperOpenFrame} from './paper-preview.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const frameSchema=z.object({source:z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict(),
 tick:z.number().int(),sqrtPriceX96:z.bigint(),poolLiquidity:z.bigint(),
 price0:z.bigint().nullable(),price1:z.bigint().nullable(),nativePrice:z.bigint().nullable(),
 referenceEligible:z.boolean(),referenceReasons:z.array(z.string()),referenceProofHash:z.string().regex(/^[0-9a-f]{64}$/),
 referenceProof:z.record(z.string(),z.unknown()).optional()}).strict();
const inputSchema=z.object({campaignId:z.uuid(),openMarkId:raw,
 previous:z.object({markId:raw,sourceBlock:raw,sourceHash:hash}).strict(),
 openModel:paperOpenModelSchema,profile:marketProfileSchema,frame:frameSchema,
 gasProfiles:z.array(z.custom<PaperGasProfileRow>()),gasPriceWei:z.bigint().nonnegative(),
 now:z.number().int().nonnegative()}).strict();

export type PaperStaticRetainTerminalPreview={
 status:'indicative'|'unavailable';kind:'close_retain';campaignId:string;revision:number|null;
 openMarkId:string|null;previousMarkId:string|null;source:PaperOpenFrame['source']|null;
 actionAvailable:false;draftCreationAvailable:false;retainedLowerBound:{token0Raw:string;token1Raw:string}|null;
 retainedPrincipalValue:string|null;costs:{scope:'saved_open_candidate_close_retain_stages_only';
  closeRetain:{expectedGasUnits:string;boundGasUnits:string;expectedWei:string;boundWei:string;
   expectedValue:string;boundValue:string};profileIds:readonly string[];gasPriceWei:string;
  boundGasPriceWei:string;gasPriceObservedAt:string;nativeReferencePrice:string}|null;
 missing:readonly string[];limitations:readonly string[];
};

function unavailable(campaignId:string,reason:string):PaperStaticRetainTerminalPreview{return {
 status:'unavailable',kind:'close_retain',campaignId,revision:null,openMarkId:null,previousMarkId:null,
 source:null,actionAvailable:false,draftCreationAvailable:false,retainedLowerBound:null,
 retainedPrincipalValue:null,costs:null,missing:[reason],limitations:[
  'read_only_terminal_estimate_no_operation_or_saved_draft',
  'fee_capture_paid_gas_and_net_economics_are_unavailable',
 ]};}

/** Builds a retain-only readout from the persisted opening position and a
 * later canonical frame. It never re-sizes an entry candidate at the exit
 * price, and always leaves action acceptance disabled. */
export function buildPaperStaticRetainTerminalPreview(rawInput:unknown):PaperStaticRetainTerminalPreview{
 const parsed=inputSchema.safeParse(rawInput),campaignId=(rawInput as {campaignId?:unknown}|null)?.campaignId;
 if(typeof campaignId!=='string')return unavailable('00000000-0000-4000-8000-000000000000','campaign_id_invalid');
 if(!parsed.success)return unavailable(campaignId,'terminal_preview_input_invalid');
 const {campaignId:id,openMarkId,previous,openModel:open,profile,frame,gasProfiles,gasPriceWei,now}=parsed.data;
 const p=profile.pool,c=open.candidate;
 if(open.campaignId!==id||open.strategyId!=='static_manual_v1'||open.profileHash!==contentHash(profile)||
  BigInt(frame.source.block)<=BigInt(previous.sourceBlock)||
  BigInt(previous.sourceBlock)<BigInt(open.source.block)||frame.source.timestamp<open.source.timestamp||
  now<frame.source.timestamp*1000||now-frame.source.timestamp*1000>180_000)
  return unavailable(id,'saved_terminal_context_mismatch');
 if(!frame.referenceEligible||!frame.referenceProof||!frame.price0||!frame.price1||!frame.nativePrice||
  frame.sqrtPriceX96<=0n||frame.poolLiquidity<=0n||
  referenceProofHash(frame.referenceProof)!==frame.referenceProofHash)
  return unavailable(id,'canonical_independent_reference_unavailable');
 const poolPrice1=((1n<<192n)*10n**BigInt(p.decimals1)*frame.price0)/
  (frame.sqrtPriceX96*frame.sqrtPriceX96*10n**BigInt(p.decimals0));
 const deviation=poolPrice1>frame.price1?poolPrice1-frame.price1:frame.price1-poolPrice1;
 if(deviation*1_000_000n>frame.price1*BigInt(profile.referencePolicy.maxPoolDeviationPpm))
  return unavailable(id,'independent_price_band');
 const idle0=BigInt(open.allocation.token0Raw)-BigInt(c.amount0Minted),
  idle1=BigInt(open.allocation.token1Raw)-BigInt(c.amount1Minted);
 if(idle0<0n||idle1<0n)return unavailable(id,'saved_open_inventory_invalid');
 const principal=principalAmounts({liquidity:BigInt(c.liquidity),tickLower:c.range.tickLower,
  tickUpper:c.range.tickUpper,sqrtPriceX96:frame.sqrtPriceX96});
 const retained0=idle0+principal.amount0,retained1=idle1+principal.amount1;
 const value0=retained0*frame.price0/10n**BigInt(p.decimals0),
  value1=retained1*frame.price1/10n**BigInt(p.decimals1);
 // Cost selection is scoped to the exact saved open candidate's range, size,
 // and diluted share. A new entry preview could silently change those inputs.
 const costed=costIndicativePaperOpenPreview({status:'indicative' as const,candidate:c},gasProfiles,
  p.pool,frame.nativePrice,gasPriceWei,now);
 if(costed.costs.status!=='provisional')return unavailable(id,
  `scoped_terminal_costs_unavailable:${costed.costs.reason}`);
 return {status:'indicative',kind:'close_retain',campaignId:id,revision:open.revision,
  openMarkId,previousMarkId:previous.markId,source:frame.source,actionAvailable:false,
  draftCreationAvailable:false,retainedLowerBound:{token0Raw:String(retained0),token1Raw:String(retained1)},
  retainedPrincipalValue:String(value0+value1),costs:{scope:'saved_open_candidate_close_retain_stages_only',
   closeRetain:costed.costs.closeRetain,profileIds:costed.costs.stages.slice(3).map(stage=>stage.profileId),
   gasPriceWei:costed.costs.gasPriceWei,boundGasPriceWei:costed.costs.boundGasPriceWei,
   gasPriceObservedAt:costed.costs.gasPriceObservedAt,nativeReferencePrice:costed.costs.nativeReferencePrice},
  missing:['stored_static_limits_unavailable','fee_capture_unavailable','paid_gas_unavailable',
   'native_balance_and_net_nav_unavailable','atomic_saved_draft_binding_unavailable'],
  limitations:['retained amounts are principal-only lower bounds',
   'costs are provisional fork-estimated models and are not paid gas',
   'no execution preview id or operation digest is created']};
}
