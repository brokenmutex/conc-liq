import {z} from 'zod';
import {principalAmounts} from '../backtest/principal.js';
import {contentHash} from './contracts.js';
import {referenceProofHash,type MarketProfile} from './market-profile.js';
import type {PaperOpenModel} from './paper-open-model.js';
import type {PaperOpenFrame} from './paper-preview.js';
import {readCanonicalPaperNextFrame} from './paper-preview.js';
import type {RobinhoodClient} from '../client.js';
import type {DeploymentStore} from './store.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const paperPrincipalValuationSchema=z.object({
 schemaVersion:z.literal(1),kind:z.literal('paper_principal_valuation'),
 campaignId:z.uuid(),revision:z.number().int().positive(),
 openMarkId:raw,openModelHash:z.string().regex(/^[0-9a-f]{64}$/),previousMarkId:raw,
 previousSource:z.object({block:raw,hash}).strict(),
 source:z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict(),
 poolState:z.object({tick:z.number().int(),sqrtPriceX96:raw,poolLiquidity:raw}).strict(),
 referenceProof:z.record(z.string(),z.unknown()),
 referenceProofHash:z.string().regex(/^[0-9a-f]{64}$/),
 reference:z.object({price0:raw,price1:raw,nativePrice:raw}).strict(),
 principal:z.object({amount0Raw:raw,amount1Raw:raw}).strict(),
 idle:z.object({amount0Raw:raw,amount1Raw:raw}).strict(),
 lowerBound:z.object({token0Raw:raw,token1Raw:raw,principalOnlyValue:raw}).strict(),
 passiveTokenValue:raw,
 unavailable:z.tuple([z.literal('fee_capture'),z.literal('paid_gas'),
  z.literal('native_balance'),z.literal('net_nav'),z.literal('alpha')]),
}).strict();
export type PaperPrincipalValuation=z.infer<typeof paperPrincipalValuationSchema>;

/** Reference-valued principal and idle tokens only. A hypothetical LP's fees
 * cannot be inferred from pool spot or the real pool's aggregate fee growth. */
export function buildPaperPrincipalValuation(open:PaperOpenModel,openMarkId:string,
 previous:{markId:string;sourceBlock:string;sourceHash:string},frame:PaperOpenFrame,
 profile:MarketProfile,now=Date.now()):PaperPrincipalValuation{
 if(!frame.referenceEligible||!frame.referenceProof||!frame.price0||!frame.price1||
  !frame.nativePrice||frame.sqrtPriceX96<=0n||frame.poolLiquidity<=0n)
  throw Error('paper_valuation_source_unavailable');
 if(referenceProofHash(frame.referenceProof)!==frame.referenceProofHash||
  BigInt(frame.source.block)<=BigInt(previous.sourceBlock)||
  BigInt(previous.sourceBlock)<BigInt(open.source.block)||
  frame.source.timestamp<open.source.timestamp||
  now-frame.source.timestamp*1000<0||now-frame.source.timestamp*1000>180_000)
  throw Error('paper_valuation_source_mismatch');
 const p=profile.pool;
 const poolPrice1=((1n<<192n)*10n**BigInt(p.decimals1)*frame.price0)/
  (frame.sqrtPriceX96*frame.sqrtPriceX96*10n**BigInt(p.decimals0));
 const deviation=poolPrice1>frame.price1?poolPrice1-frame.price1:frame.price1-poolPrice1;
 if(deviation*1_000_000n>frame.price1*BigInt(profile.referencePolicy.maxPoolDeviationPpm))
  throw Error('paper_valuation_independent_price_band');
 const principal=principalAmounts({liquidity:BigInt(open.candidate.liquidity),
  tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
  sqrtPriceX96:frame.sqrtPriceX96});
 const idle0=BigInt(open.allocation.token0Raw)-BigInt(open.candidate.amount0Minted);
 const idle1=BigInt(open.allocation.token1Raw)-BigInt(open.candidate.amount1Minted);
 if(idle0<0n||idle1<0n)throw Error('paper_valuation_open_inventory_invalid');
 const total0=idle0+principal.amount0,total1=idle1+principal.amount1;
 const value=(a:bigint,b:bigint)=>a*frame.price0!/10n**BigInt(p.decimals0)+
  b*frame.price1!/10n**BigInt(p.decimals1);
 return paperPrincipalValuationSchema.parse({schemaVersion:1,kind:'paper_principal_valuation',
  campaignId:open.campaignId,revision:open.revision,openMarkId,openModelHash:contentHash(open),
  previousMarkId:previous.markId,
  previousSource:{block:previous.sourceBlock,hash:previous.sourceHash},source:frame.source,
  poolState:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),
   poolLiquidity:String(frame.poolLiquidity)},
  referenceProof:frame.referenceProof,referenceProofHash:frame.referenceProofHash,
  reference:{price0:String(frame.price0),price1:String(frame.price1),nativePrice:String(frame.nativePrice)},
  principal:{amount0Raw:String(principal.amount0),amount1Raw:String(principal.amount1)},
  idle:{amount0Raw:String(idle0),amount1Raw:String(idle1)},
  lowerBound:{token0Raw:String(total0),token1Raw:String(total1),
   principalOnlyValue:String(value(total0,total1))},
  passiveTokenValue:String(value(BigInt(open.allocation.token0Raw),
   BigInt(open.allocation.token1Raw))),
  unavailable:['fee_capture','paid_gas','native_balance','net_nav','alpha']});
}

/** Read-only chain sampling followed by an optimistic, append-only commit.
 * A concurrent mark or close makes the store reject the stale snapshot. */
export async function recordCanonicalPaperPrincipalValuation(store:DeploymentStore,
 client:RobinhoodClient,campaignId:string){
 const state=await store.paperValuationState(campaignId);
 const frame=await readCanonicalPaperNextFrame(client,state.profile,state.previous);
 const model=buildPaperPrincipalValuation(state.openModel,state.openMarkId,state.previous,
  frame,state.profile);
 return store.recordTrustedPaperPrincipalValuation(model);
}
