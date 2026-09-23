import assert from 'node:assert/strict';
import {z} from 'zod';
import {principalAmounts} from '../backtest/principal.js';
import {contentHash,staticParameters} from './contracts.js';
import {paperGasModelSchema,type PaperGasProfileRow} from './paper-cost.js';
import {referenceProofHash,type MarketProfile} from './market-profile.js';
import type {PaperOpenModel} from './paper-open-model.js';
import type {PaperOpenFrame} from './paper-preview.js';
import {paperQuoterAbi} from '../paper/execution-abi.js';
import type {RobinhoodClient} from '../client.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const source=z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict();
export const PAPER_STATIC_CONVERT_GAS_PATH='paper_static_manual_close_convert_v1';
export const PAPER_STATIC_CONVERT_GAS_STAGES=[
 'withdraw_collect','swap','cleanup_token0','cleanup_token1',
] as const;

const quoteFields=z.object({
 schemaVersion:z.literal(1),kind:z.literal('paper_exact_input_quote_v1'),
 source,router:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
 quoter:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
 path:z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).length(2),
 fee:z.number().int().positive(),inputAsset:z.enum(['token0','token1']),
 inputAmountRaw:raw,expectedOutputRaw:raw,minimumOutputRaw:raw,
 slippageBps:z.number().int().positive().max(500),
 pathVersion:z.literal(PAPER_STATIC_CONVERT_GAS_PATH),
}).strict();
export const paperCloseConvertQuoteSchema=quoteFields.extend({
 quoteHash:z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type PaperCloseConvertQuote=z.infer<typeof paperCloseConvertQuoteSchema>;
const routeFields=z.object({router:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
 quoter:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
 path:z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).length(2),
 fee:z.number().int().positive(),inputAsset:z.enum(['token0','token1']),
 slippageBps:z.number().int().positive().max(500),
 pathVersion:z.literal(PAPER_STATIC_CONVERT_GAS_PATH)}).strict();
export const paperCloseConvertRouteSchema=routeFields.extend({
 routeHash:z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type PaperCloseConvertRoute=z.infer<typeof paperCloseConvertRouteSchema>;

const costStage=z.object({stage:z.enum(PAPER_STATIC_CONVERT_GAS_STAGES),
 profileId:z.uuid(),version:z.number().int().positive(),evidenceClass:z.literal('fork_estimated'),
 expectedGasUnits:raw,boundGasUnits:raw,
 source:z.object({block:raw,hash,estimatedAt:z.iso.datetime({offset:true}),
  callHash:hash,method:z.literal('owned_fork_nitro_exact_call_v1')}).strict(),
}).strict();
export const paperCloseConvertCostsSchema=z.object({
 status:z.literal('provisional'),scope:z.literal('convert_close_gas_only'),
 pathVersion:z.literal(PAPER_STATIC_CONVERT_GAS_PATH),sizeBand:z.string().min(1),
 gasPriceWei:raw,boundGasPriceWei:raw,gasPriceObservedAt:z.iso.datetime({offset:true}),
 nativeReferencePrice:raw,stages:z.array(costStage).length(4),
 expectedGasUnits:raw,boundGasUnits:raw,expectedWei:raw,boundWei:raw,
 expectedValue:raw,boundValue:raw,
}).strict().superRefine((costs,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 const stages=new Map(costs.stages.map(stage=>[stage.stage,stage]));
 if(stages.size!==PAPER_STATIC_CONVERT_GAS_STAGES.length||
  PAPER_STATIC_CONVERT_GAS_STAGES.some(stage=>!stages.has(stage)))fail('incomplete_conversion_gas_stages');
 if(new Set(costs.stages.map(stage=>stage.profileId)).size!==costs.stages.length)
  fail('duplicate_conversion_gas_profile');
 const expected=costs.stages.reduce((sum,stage)=>sum+BigInt(stage.expectedGasUnits),0n),
  bound=costs.stages.reduce((sum,stage)=>sum+BigInt(stage.boundGasUnits),0n),
  price=BigInt(costs.gasPriceWei),boundPrice=ceil(price*5n,4n),
  expectedWei=expected*price,boundWei=bound*boundPrice,
  expectedValue=ceil(expectedWei*BigInt(costs.nativeReferencePrice),10n**18n),
  boundValue=ceil(boundWei*BigInt(costs.nativeReferencePrice),10n**18n);
 if(BigInt(costs.boundGasPriceWei)!==boundPrice||BigInt(costs.expectedGasUnits)!==expected||
  BigInt(costs.boundGasUnits)!==bound||BigInt(costs.expectedWei)!==expectedWei||
  BigInt(costs.boundWei)!==boundWei||BigInt(costs.expectedValue)!==expectedValue||
  BigInt(costs.boundValue)!==boundValue)fail('conversion_gas_totals_invalid');
});
export type PaperCloseConvertCosts=z.infer<typeof paperCloseConvertCostsSchema>;

export const paperCloseConvertModelSchema=z.object({
 schemaVersion:z.literal(1),kind:z.literal('paper_close_convert_model'),campaignId:z.uuid(),
 revision:z.number().int().positive(),openMarkId:raw,previousMarkId:raw,
 previousSource:z.object({block:raw,hash}).strict(),
 openModelHash:z.string().regex(/^[0-9a-f]{64}$/),source,
 poolState:z.object({tick:z.number().int(),sqrtPriceX96:raw,poolLiquidity:raw}).strict(),
 referenceProof:z.record(z.string(),z.unknown()),
 referenceProofHash:z.string().regex(/^[0-9a-f]{64}$/),
 reference:z.object({price0:raw,price1:raw,nativePrice:raw}).strict(),
 principal:z.object({amount0Raw:raw,amount1Raw:raw}).strict(),
 idle:z.object({amount0Raw:raw,amount1Raw:raw}).strict(),
 conversionRoute:paperCloseConvertRouteSchema,
 costs:paperCloseConvertCostsSchema,
 unmodeled:z.tuple([z.literal('execution_delay'),z.literal('execution_failure'),
  z.literal('quote_to_execution_deviation'),z.literal('paid_gas'),
  z.literal('canonical_final_custody')]),
}).strict();
export type PaperCloseConvertModel=z.infer<typeof paperCloseConvertModelSchema>;

const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;

function validGasProfile(row:PaperGasProfileRow,candidate:PaperOpenModel['candidate'],
 now:number){
 if(row.pathVersion!==PAPER_STATIC_CONVERT_GAS_PATH||row.allowanceState!=='zero'||
  row.component!=='gas_units'||!PAPER_STATIC_CONVERT_GAS_STAGES.some(stage=>stage===row.stage)||
  !['provisional','validated'].includes(row.status)||row.evidenceClass!=='fork_estimated'||
  !row.observedUntil)return null;
 const parsed=paperGasModelSchema.safeParse(row.model);
 if(!parsed.success||row.sourceHash!==contentHash(parsed.data.source))return null;
 const model=parsed.data,min=BigInt(model.sizeMinValue),max=BigInt(model.sizeMaxValue),
  shareMin=BigInt(model.shareMinPpm),shareMax=BigInt(model.shareMaxPpm),
  size=BigInt(candidate.deployedValue),share=BigInt(candidate.dilutedSharePpm);
 if(min>size||size>max||min>max||shareMin>share||share>shareMax||shareMin>shareMax||
  shareMax>1_000_000n||model.tickLower!==candidate.range.tickLower||
  model.tickUpper!==candidate.range.tickUpper||BigInt(model.gasUnitsExpected)<=0n||
  BigInt(model.gasUnitsBound)<BigInt(model.gasUnitsExpected))return null;
 const sampled=Date.parse(model.source.estimatedAt),observed=row.observedUntil.getTime();
 if(Math.abs(observed-sampled)>1000||now-sampled<0||now-sampled>86_400_000||
  now-observed<0||now-observed>86_400_000)return null;
 return model;
}

/** Selects exactly one complete, current, candidate-scoped set of fork gas
 * profiles. No retain-close allowance or unrelated path can satisfy it. */
export function costPaperCloseConvert(rows:readonly PaperGasProfileRow[],
 poolAddress:string,candidate:PaperOpenModel['candidate'],nativePrice:bigint,
 gasPriceWei:bigint,now=Date.now()):PaperCloseConvertCosts{
 if(rows.length>200)throw Error('paper_close_convert_gas_query_bound');
 const groups=new Map<string,Map<string,PaperGasProfileRow>>();
 for(const row of rows){
  if(row.poolAddress.toLowerCase()!==poolAddress.toLowerCase()||
   row.pathVersion!==PAPER_STATIC_CONVERT_GAS_PATH||row.allowanceState!=='zero'||
   row.component!=='gas_units'||!PAPER_STATIC_CONVERT_GAS_STAGES.some(stage=>stage===row.stage))continue;
  const group=groups.get(row.sizeBand)??new Map<string,PaperGasProfileRow>();
  const prior=group.get(row.stage);
  if(!prior||row.version>prior.version)group.set(row.stage,row);
  groups.set(row.sizeBand,group);
 }
 const complete=[...groups].filter(([,group])=>PAPER_STATIC_CONVERT_GAS_STAGES.every(stage=>{
  const row=group.get(stage);return row!==undefined&&validGasProfile(row,candidate,now)!==null;
 }));
 if(complete.length!==1)throw Error(complete.length?'paper_close_convert_gas_scope_ambiguous':
  'paper_close_convert_gas_profiles_unavailable');
 if(nativePrice<=0n||gasPriceWei<=0n)throw Error('paper_close_convert_gas_price_unavailable');
 const [sizeBand,group]=complete[0]!;
 const stages=PAPER_STATIC_CONVERT_GAS_STAGES.map(stage=>{
  const row=group.get(stage)!,model=validGasProfile(row,candidate,now)!;
  return {stage,profileId:row.id,version:row.version,evidenceClass:row.evidenceClass,
   expectedGasUnits:model.gasUnitsExpected,boundGasUnits:model.gasUnitsBound,
   source:model.source};
 });
 const expectedGas=stages.reduce((sum,item)=>sum+BigInt(item.expectedGasUnits),0n),
  boundGas=stages.reduce((sum,item)=>sum+BigInt(item.boundGasUnits),0n),
  boundGasPrice=ceil(gasPriceWei*5n,4n),
  expectedWei=expectedGas*gasPriceWei,boundWei=boundGas*boundGasPrice,
  expectedValue=ceil(expectedWei*nativePrice,10n**18n),
  boundValue=ceil(boundWei*nativePrice,10n**18n);
 return paperCloseConvertCostsSchema.parse({status:'provisional',scope:'convert_close_gas_only',
  pathVersion:PAPER_STATIC_CONVERT_GAS_PATH,sizeBand,gasPriceWei:String(gasPriceWei),
  boundGasPriceWei:String(boundGasPrice),gasPriceObservedAt:new Date(now).toISOString(),
  nativeReferencePrice:String(nativePrice),stages,expectedGasUnits:String(expectedGas),
  boundGasUnits:String(boundGas),expectedWei:String(expectedWei),boundWei:String(boundWei),
  expectedValue:String(expectedValue),boundValue:String(boundValue)});
}

/** A source-pinned, explicit quote and separately scoped cost model are
 * required. Principal uses the configured position's exact V3 math; fees are
 * the saved lower integer carry, never inferred from pool spot. */
export function buildPaperCloseConvertModel(open:PaperOpenModel,openMarkId:string,
 previous:{markId:string;sourceBlock:string;sourceHash:string},frame:PaperOpenFrame,
 profile:MarketProfile,parameters:Record<string,unknown>,
 routeInput:unknown,
 costsInput:unknown,now=Date.now()):PaperCloseConvertModel{
 const route=paperCloseConvertRouteSchema.parse(routeInput),
  costs=paperCloseConvertCostsSchema.parse(costsInput),
  limits=staticParameters.parse(parameters).limits;
 if(!limits)throw Error('paper_close_convert_limits_unavailable');
 if(!frame.referenceEligible||!frame.referenceProof||!frame.price0||!frame.price1||
  !frame.nativePrice||frame.sqrtPriceX96<=0n||frame.poolLiquidity<=0n)
  throw Error('paper_close_convert_source_unavailable');
 if(referenceProofHash(frame.referenceProof)!==frame.referenceProofHash||
  BigInt(frame.source.block)<=BigInt(previous.sourceBlock)||
  BigInt(previous.sourceBlock)<BigInt(open.source.block)||
  frame.source.timestamp<open.source.timestamp||
  now-frame.source.timestamp*1000<0||now-frame.source.timestamp*1000>180_000)
  throw Error('paper_close_convert_source_mismatch');
 const p=profile.pool,expectedPath=route.inputAsset==='token0'?
  [p.token0.toLowerCase(),p.token1.toLowerCase()]:[p.token1.toLowerCase(),p.token0.toLowerCase()];
 const quoteAsset=p.quoteToken===0?'token0':'token1';
 if(route.router.toLowerCase()!==p.router.toLowerCase()||
  route.quoter.toLowerCase()!==p.quoter.toLowerCase()||
  route.path.some((address,index)=>address.toLowerCase()!==expectedPath[index])||
  route.fee!==p.fee||route.slippageBps!==limits.maxSlippageBps||
  route.inputAsset===quoteAsset)
  throw Error('paper_close_convert_quote_route_or_slippage_mismatch');
 const {routeHash,...routeContent}=route;
 if(routeHash!==contentHash(routeContent))throw Error('paper_close_convert_route_hash_mismatch');
 const poolPrice1=((1n<<192n)*10n**BigInt(p.decimals1)*frame.price0)/
  (frame.sqrtPriceX96*frame.sqrtPriceX96*10n**BigInt(p.decimals0));
 const deviation=poolPrice1>frame.price1?poolPrice1-frame.price1:frame.price1-poolPrice1;
 if(deviation*1_000_000n>frame.price1*BigInt(profile.referencePolicy.maxPoolDeviationPpm))
  throw Error('paper_close_convert_independent_price_band');
 if(costs.nativeReferencePrice!==String(frame.nativePrice)||
  Date.parse(costs.gasPriceObservedAt)>now||now-Date.parse(costs.gasPriceObservedAt)>120_000)
  throw Error('paper_close_convert_cost_stale');
 const stages=new Set(costs.stages.map(stage=>stage.stage));
 if(stages.size!==PAPER_STATIC_CONVERT_GAS_STAGES.length||
  PAPER_STATIC_CONVERT_GAS_STAGES.some(stage=>!stages.has(stage)))
  throw Error('paper_close_convert_cost_stages_invalid');
 if(BigInt(costs.expectedValue)>BigInt(limits.maxActionCost)||
  BigInt(costs.expectedValue)>BigInt(limits.maxRollingCost)||
  BigInt(open.costs.open.expectedValue)+BigInt(costs.expectedValue)>BigInt(limits.maxCampaignCost)||
  BigInt(open.allocation.nativeWei)<BigInt(open.costs.open.expectedWei)+
   (BigInt(limits.exitReserveWei)>BigInt(costs.boundWei)?
    BigInt(limits.exitReserveWei):BigInt(costs.boundWei)))
  throw Error('paper_close_convert_cost_or_reserve_limit');
 const principal=principalAmounts({liquidity:BigInt(open.candidate.liquidity),
  tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
  sqrtPriceX96:frame.sqrtPriceX96});
 const idle0=BigInt(open.allocation.token0Raw)-BigInt(open.candidate.amount0Minted),
  idle1=BigInt(open.allocation.token1Raw)-BigInt(open.candidate.amount1Minted);
 if(idle0<0n||idle1<0n)throw Error('paper_close_convert_inventory_invalid');
 return paperCloseConvertModelSchema.parse({schemaVersion:1,kind:'paper_close_convert_model',
  campaignId:open.campaignId,revision:open.revision,openMarkId,previousMarkId:previous.markId,
  previousSource:{block:previous.sourceBlock,hash:previous.sourceHash},
  openModelHash:contentHash(open),source:frame.source,
  poolState:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),
   poolLiquidity:String(frame.poolLiquidity)},referenceProof:frame.referenceProof,
  referenceProofHash:frame.referenceProofHash,
  reference:{price0:String(frame.price0),price1:String(frame.price1),nativePrice:String(frame.nativePrice)},
  principal:{amount0Raw:String(principal.amount0),amount1Raw:String(principal.amount1)},
  idle:{amount0Raw:String(idle0),amount1Raw:String(idle1)},
  conversionRoute:route,costs,
  unmodeled:['execution_delay','execution_failure','quote_to_execution_deviation',
   'paid_gas','canonical_final_custody']});
}

/** Replays the configured Quoter at the exact canonical block. A self-hash is
 * only integrity evidence; this check establishes the quoted output. Call at
 * close acceptance and again before appending v2 accounting. */
export async function verifyCanonicalPaperCloseConvertQuote(client:RobinhoodClient,
 model:PaperCloseConvertModel,inputAmountRaw:string):Promise<PaperCloseConvertQuote>{
 const route=model.conversionRoute;
 if(!/^[1-9][0-9]*$/.test(inputAmountRaw))throw Error('paper_convert_quote_input_invalid');
 assert.equal(await client.getChainId(),4663,'Paper conversion quote chain changed');
 const read=()=>client.getBlock({blockNumber:BigInt(model.source.block)});
 const before=await read();
 assert.equal(before.hash.toLowerCase(),model.source.hash.toLowerCase(),
  'Paper conversion quote source reorged');
 assert.equal(Number(before.timestamp),model.source.timestamp,
  'Paper conversion quote timestamp changed');
 const result=await client.simulateContract({address:route.quoter as `0x${string}`,
  abi:paperQuoterAbi,functionName:'quoteExactInputSingle',
  blockNumber:BigInt(model.source.block),args:[{tokenIn:route.path[0] as `0x${string}`,
   tokenOut:route.path[1] as `0x${string}`,amountIn:BigInt(inputAmountRaw),
   fee:route.fee,sqrtPriceLimitX96:0n}]});
 const after=await read();
 assert.equal(`${after.hash.toLowerCase()}:${Number(after.timestamp)}`,
  `${before.hash.toLowerCase()}:${Number(before.timestamp)}`,
  'Paper conversion quote source changed during verification');
 const expectedOutputRaw=String(result.result[0]),slippageBps=route.slippageBps,
  minimumOutputRaw=String(BigInt(expectedOutputRaw)*BigInt(10_000-slippageBps)/10_000n),
  content={schemaVersion:1 as const,kind:'paper_exact_input_quote_v1' as const,
   source:model.source,router:route.router,quoter:route.quoter,path:route.path,fee:route.fee,
   inputAsset:route.inputAsset,inputAmountRaw,expectedOutputRaw,minimumOutputRaw,
   slippageBps,pathVersion:route.pathVersion};
 return paperCloseConvertQuoteSchema.parse({...content,quoteHash:contentHash(content)});
}
