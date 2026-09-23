import assert from 'node:assert/strict';
import {z} from 'zod';
import {contentHash} from './contracts.js';
import type {MarketProfile} from './market-profile.js';
import type {PaperOpenModel} from './paper-open-model.js';
import type {PaperCloseRetainModel} from './paper-close-model.js';
import {paperCloseConvertQuoteSchema,verifyCanonicalPaperCloseConvertQuote,
 type PaperCloseConvertQuote,
 type PaperCloseConvertModel} from './paper-close-convert-model.js';
import type {PaperFeeCarry} from './paper-fee-replay.js';
import type {RobinhoodClient} from '../client.js';
import type {DeploymentStore,PaperAccountingAnchor} from './store.js';

export const PAPER_ACCOUNTING_POLICY='paper_fixed_flow_lower_v1';
export const PAPER_CONVERSION_ACCOUNTING_POLICY='paper_fixed_flow_convert_v1';
const Q128=1n<<128n;
const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const signed=z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const source=z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict();
const reference=z.object({price0:raw,price1:raw,nativePrice:raw}).strict();
const flow=z.object({kind:z.enum(['modeled_fee','modeled_gas','modeled_capital_out']),
 asset:z.enum(['token0','token1','native']),amountRaw:raw,valueQuote:raw}).strict();
const conversionFlow=z.object({kind:z.literal('modeled_conversion'),
 fromAsset:z.enum(['token0','token1']),fromAmountRaw:raw,
 toAsset:z.enum(['token0','token1']),expectedToAmountRaw:raw,minimumToAmountRaw:raw,
 expectedValueQuote:raw,minimumValueQuote:raw,quoteHash:z.string().regex(/^[0-9a-f]{64}$/),
 pathVersion:z.string()}).strict();
export const paperAccountingSchema=z.object({
 policyVersion:z.literal(PAPER_ACCOUNTING_POLICY),classification:z.literal('provisional_paper_scenario'),
 campaignId:z.uuid(),sourceMarkId:raw,markKind:z.enum(['open','valuation','close_retain']),
 source,reference,profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 openModelHash:z.string().regex(/^[0-9a-f]{64}$/),
 closeModelHash:z.string().regex(/^[0-9a-f]{64}$/).nullable(),
 feeEvidence:z.object({id:raw,proofHash:z.string().regex(/^[0-9a-f]{64}$/),
  carryHash:z.string().regex(/^[0-9a-f]{64}$/),upper0Raw:raw,upper1Raw:raw}).strict().nullable(),
 gasProfiles:z.array(z.object({stage:z.string(),id:z.uuid(),version:z.number().int().positive(),
  sourceHash:hash}).strict()),
 inventory:z.object({token0Raw:raw,token1Raw:raw,nativeWei:raw,
  principal0Raw:raw,principal1Raw:raw,fee0Raw:raw,fee1Raw:raw,
  cumulativeGasWei:raw,hasLiquidity:z.boolean()}).strict(),
 economics:z.object({initialCapitalQuote:raw,netNavQuote:raw,passiveQuote:raw,
  absolutePnlQuote:signed,alphaQuote:signed,cumulativeFeeValueQuote:raw,
  cumulativeGasExpenseQuote:raw,intervalFeeAccrualQuote:raw,markGasExpenseQuote:raw}).strict(),
 flows:z.array(flow),
 limitations:z.tuple([z.literal('fixed_observed_flow_counterfactual'),
  z.literal('lower_integer_allocation_point'),z.literal('execution_delay_unmodeled'),
  z.literal('failure_expense_unmodeled'),z.literal('close_convert_unavailable')]),
}).strict();
export type PaperAccounting=z.infer<typeof paperAccountingSchema>;

/** A separately versioned replay policy for campaigns closed through an
 * explicitly quoted token conversion. The v1 schema and policy remain frozen. */
export const paperConversionAccountingSchema=z.object({
 policyVersion:z.literal(PAPER_CONVERSION_ACCOUNTING_POLICY),
 classification:z.literal('provisional_paper_scenario'),campaignId:z.uuid(),
 sourceMarkId:raw,markKind:z.enum(['open','valuation','close_retain','close_convert']),
 source,reference,profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 openModelHash:z.string().regex(/^[0-9a-f]{64}$/),closeModelHash:z.string().regex(/^[0-9a-f]{64}$/).nullable(),
 feeEvidence:z.object({id:raw,proofHash:z.string().regex(/^[0-9a-f]{64}$/),
  carryHash:z.string().regex(/^[0-9a-f]{64}$/),upper0Raw:raw,upper1Raw:raw}).strict().nullable(),
 gasProfiles:z.array(z.object({stage:z.string(),id:z.uuid(),version:z.number().int().positive(),
  sourceHash:hash}).strict()),
 inventory:z.object({token0Raw:raw,token1Raw:raw,nativeWei:raw,
  principal0Raw:raw,principal1Raw:raw,fee0Raw:raw,fee1Raw:raw,
  cumulativeGasWei:raw,hasLiquidity:z.boolean()}).strict(),
 economics:z.object({initialCapitalQuote:raw,netNavQuote:raw,passiveQuote:raw,
  absolutePnlQuote:signed,alphaQuote:signed,cumulativeFeeValueQuote:raw,
  cumulativeGasExpenseQuote:raw,intervalFeeAccrualQuote:raw,markGasExpenseQuote:raw,
  cumulativeConversionCostQuote:raw,cumulativeSwapCostQuote:signed,
  modeledSwapExpectedProceedsQuote:raw,modeledSwapProceedsQuote:raw,
  modeledSwapCostQuote:signed}).strict(),
 conversion:z.object({quoteHash:z.string().regex(/^[0-9a-f]{64}$/),
  pathVersion:z.string(),source,fromAsset:z.enum(['token0','token1']),
  toAsset:z.enum(['token0','token1']),inputAmountRaw:raw,
  expectedOutputRaw:raw,minimumOutputRaw:raw,slippageBps:z.number().int().positive().max(500),
  expectedProceedsQuote:raw,minimumProceedsQuote:raw,
  modeledSwapCostQuote:signed,
  expectedGasWei:raw,boundGasWei:raw,expectedGasCostQuote:raw,boundGasCostQuote:raw}).strict().nullable(),
 flows:z.array(z.union([flow,conversionFlow])),
 limitations:z.tuple([z.literal('fixed_observed_flow_counterfactual'),
  z.literal('lower_integer_allocation_point'),z.literal('execution_delay_unmodeled'),
  z.literal('failure_expense_unmodeled'),z.literal('quote_to_execution_deviation_unmodeled'),
  z.literal('final_custody_unobserved')]),
}).strict();
export type PaperConversionAccounting=z.infer<typeof paperConversionAccountingSchema>;

export interface AccountingMark {
 id:string;kind:'open'|'valuation'|'close_retain';
 source:z.infer<typeof source>;reference:z.infer<typeof reference>;
 principal0Raw:string;principal1Raw:string;
}
interface FeeEvidence {id:string;proofHash:string;carryHash:string;carry:PaperFeeCarry}
const same=(a:{block:string;hash:string},b:{block:string;hash:string})=>
 a.block===b.block&&a.hash.toLowerCase()===b.hash.toLowerCase();
const value=(amount:bigint,price:bigint,decimals:number)=>amount*price/10n**BigInt(decimals);
const signedText=(amount:bigint)=>String(amount);

/** A deterministic scenario, never a claim of earned fees or paid gas.
 * Choose the lower Q128 integer allocation under the verified fixed flow;
 * that bound does not cover flow changes caused by the hypothetical LP. */
export function buildPaperAccounting(open:PaperOpenModel,profile:MarketProfile,
 mark:AccountingMark,previous:PaperAccounting|null,fee:FeeEvidence|null,
 close:PaperCloseRetainModel|null):PaperAccounting{
 assert(mark.id.match(/^[1-9][0-9]*$/),'Paper accounting mark ID invalid');
 assert(open.profileHash===contentHash(profile),'Paper accounting profile changed');
 assert(mark.source.block===open.source.block&&mark.kind==='open'||
  BigInt(mark.source.block)>BigInt(open.source.block),'Paper accounting source order invalid');
 if(mark.kind==='open')assert(!previous&&!fee&&!close&&same(mark.source,open.source),
  'Paper accounting opening inputs invalid');
 else assert(previous&&fee&&BigInt(mark.id)>BigInt(previous.sourceMarkId)&&
  BigInt(mark.source.block)>BigInt(previous.source.block)&&
  previous.campaignId===open.campaignId&&previous.openModelHash===contentHash(open),
  'Paper accounting prior snapshot or fee evidence unavailable');
 if(mark.kind==='close_retain')assert(close&&close.openModelHash===contentHash(open)&&
  close.campaignId===open.campaignId&&same(close.source,mark.source),
  'Paper accounting close model unavailable');
 else assert(!close,'Paper accounting unexpected close model');
 const p=profile.pool,allocation=open.allocation;
 const price0=BigInt(mark.reference.price0),price1=BigInt(mark.reference.price1),
  nativePrice=BigInt(mark.reference.nativePrice);
 assert(price0>0n&&price1>0n&&nativePrice>0n,'Paper accounting reference unavailable');
 const feeAmount=(token:'token0'|'token1')=>{
  if(!fee)return {lower:0n,upper:0n};
  const carried=fee.carry[token],lower=BigInt(carried.lowerRawQ128),
   upper=BigInt(carried.upperRawQ128);
  assert(lower>=0n&&upper>=lower&&carried.lowerAmountRaw===String(lower/Q128)&&
   carried.upperAmountRaw===String(upper/Q128),'Paper accounting fee carry invalid');
  return {lower:lower/Q128,upper:upper/Q128};
 };
 if(fee){
  assert(fee.carry.kind==='paper_fee_carry_v1'&&
   same(fee.carry.from,open.source)&&same(fee.carry.through,mark.source)&&
   fee.carry.pool===p.pool.toLowerCase()&&
   fee.carry.token0Address===p.token0.toLowerCase()&&
   fee.carry.token1Address===p.token1.toLowerCase()&&
   fee.carry.fee===p.fee&&fee.carry.tickSpacing===p.tickSpacing&&
   fee.carry.liquidity===open.candidate.liquidity&&
   fee.carry.range.tickLower===open.candidate.range.tickLower&&
   fee.carry.range.tickUpper===open.candidate.range.tickUpper,
   'Paper accounting fee identity mismatch');
 }
 const fees0=feeAmount('token0'),fees1=feeAmount('token1');
 const prior0=BigInt(previous?.inventory.fee0Raw??'0'),
  prior1=BigInt(previous?.inventory.fee1Raw??'0');
 assert(fees0.lower>=prior0&&fees1.lower>=prior1,'Paper accounting fee carry regressed');
 const delta0=fees0.lower-prior0,delta1=fees1.lower-prior1;
 const openGas=BigInt(open.costs.open.expectedWei),
  closeGas=close?BigInt(close.costs.closeRetain.expectedWei):0n,
  cumulativeGas=openGas+closeGas;
 assert(cumulativeGas<=BigInt(allocation.nativeWei)&&
  (!previous||BigInt(previous.inventory.cumulativeGasWei)===openGas),
  'Paper accounting native reserve insufficient or changed');
 const principal0=BigInt(mark.principal0Raw),principal1=BigInt(mark.principal1Raw);
 const token0=principal0+fees0.lower,token1=principal1+fees1.lower,
  native=BigInt(allocation.nativeWei)-cumulativeGas;
 const quote=(a0:bigint,a1:bigint,n:bigint,r:{price0:string;price1:string;nativePrice:string})=>
  value(a0,BigInt(r.price0),p.decimals0)+value(a1,BigInt(r.price1),p.decimals1)+
  value(n,BigInt(r.nativePrice),18);
 const initial=quote(BigInt(allocation.token0Raw),BigInt(allocation.token1Raw),
  BigInt(allocation.nativeWei),open.reference);
 if(previous)assert(previous.economics.initialCapitalQuote===String(initial),
  'Paper accounting initial capital changed');
 const nav=quote(token0,token1,native,mark.reference),
  passive=quote(BigInt(allocation.token0Raw),BigInt(allocation.token1Raw),
   BigInt(allocation.nativeWei),mark.reference);
 const feeValue=value(fees0.lower,price0,p.decimals0)+
  value(fees1.lower,price1,p.decimals1);
 const intervalFeeValue=value(delta0,price0,p.decimals0)+
  value(delta1,price1,p.decimals1);
 const markGas=mark.kind==='open'?BigInt(open.costs.open.expectedValue):
  close?BigInt(close.costs.closeRetain.expectedValue):0n;
 const gasExpense=BigInt(previous?.economics.cumulativeGasExpenseQuote??'0')+markGas;
 const flows:PaperAccounting['flows']=[];
 if(mark.kind==='open')flows.push({kind:'modeled_gas',asset:'native',
  amountRaw:String(openGas),valueQuote:String(markGas)});
 else{
  flows.push({kind:'modeled_fee',asset:'token0',amountRaw:String(delta0),
   valueQuote:String(value(delta0,price0,p.decimals0))},
  {kind:'modeled_fee',asset:'token1',amountRaw:String(delta1),
   valueQuote:String(value(delta1,price1,p.decimals1))});
 }
 if(close){
  flows.push({kind:'modeled_gas',asset:'native',amountRaw:String(closeGas),
   valueQuote:String(markGas)});
  for(const [asset,amount,price,decimals] of [
   ['token0',token0,price0,p.decimals0],['token1',token1,price1,p.decimals1],
   ['native',native,nativePrice,18],
  ] as const)flows.push({kind:'modeled_capital_out',asset,amountRaw:String(amount),
   valueQuote:String(value(amount,price,decimals))});
 }
 const gasStages=[...open.costs.stages,...(close?.costs.stages??[])];
 return paperAccountingSchema.parse({policyVersion:PAPER_ACCOUNTING_POLICY,
  classification:'provisional_paper_scenario',campaignId:open.campaignId,
  sourceMarkId:mark.id,markKind:mark.kind,source:mark.source,reference:mark.reference,
  profileHash:open.profileHash,openModelHash:contentHash(open),
  closeModelHash:close?contentHash(close):null,
  feeEvidence:fee?{id:fee.id,proofHash:fee.proofHash,carryHash:fee.carryHash,
   upper0Raw:String(fees0.upper),upper1Raw:String(fees1.upper)}:null,
  gasProfiles:gasStages.map(stage=>({stage:stage.stage,id:stage.profileId,
   version:stage.version,sourceHash:stage.source.hash})),
  inventory:{token0Raw:String(token0),token1Raw:String(token1),nativeWei:String(native),
   principal0Raw:String(principal0),principal1Raw:String(principal1),
   fee0Raw:String(fees0.lower),fee1Raw:String(fees1.lower),
   cumulativeGasWei:String(cumulativeGas),hasLiquidity:mark.kind!=='close_retain'},
  economics:{initialCapitalQuote:String(initial),netNavQuote:String(nav),
   passiveQuote:String(passive),absolutePnlQuote:signedText(nav-initial),
   alphaQuote:signedText(nav-passive),cumulativeFeeValueQuote:String(feeValue),
   cumulativeGasExpenseQuote:String(gasExpense),intervalFeeAccrualQuote:String(intervalFeeValue),
   markGasExpenseQuote:String(markGas)},flows,
  limitations:['fixed_observed_flow_counterfactual','lower_integer_allocation_point',
   'execution_delay_unmodeled','failure_expense_unmodeled','close_convert_unavailable']});
}

export type ConversionAccountingMark={id:string;kind:'open'|'valuation'|'close_retain'|'close_convert';
 source:z.infer<typeof source>;reference:z.infer<typeof reference>;
 principal0Raw:string;principal1Raw:string};
const v1Limitations:PaperAccounting['limitations']=[
 'fixed_observed_flow_counterfactual','lower_integer_allocation_point',
 'execution_delay_unmodeled','failure_expense_unmodeled','close_convert_unavailable'];
const v2Limitations:PaperConversionAccounting['limitations']=[
 'fixed_observed_flow_counterfactual','lower_integer_allocation_point',
 'execution_delay_unmodeled','failure_expense_unmodeled',
 'quote_to_execution_deviation_unmodeled','final_custody_unobserved'];
const v1Economics=(economics:PaperConversionAccounting['economics'])=>({
 initialCapitalQuote:economics.initialCapitalQuote,netNavQuote:economics.netNavQuote,
 passiveQuote:economics.passiveQuote,absolutePnlQuote:economics.absolutePnlQuote,
 alphaQuote:economics.alphaQuote,cumulativeFeeValueQuote:economics.cumulativeFeeValueQuote,
 cumulativeGasExpenseQuote:economics.cumulativeGasExpenseQuote,
 intervalFeeAccrualQuote:economics.intervalFeeAccrualQuote,
 markGasExpenseQuote:economics.markGasExpenseQuote,
});
export const paperAccountingFromConversionSnapshot=(snapshot:PaperConversionAccounting|null):PaperAccounting|null=>{
 if(!snapshot)return null;
 assert(snapshot.markKind!=='close_convert','Paper conversion already terminal');
 const base={...snapshot};
 delete (base as Partial<PaperConversionAccounting>).conversion;
 return paperAccountingSchema.parse({...base,policyVersion:PAPER_ACCOUNTING_POLICY,
  economics:v1Economics(snapshot.economics),
  flows:snapshot.flows.filter((item)=>item.kind!=='modeled_conversion'),
  limitations:v1Limitations});
};

/** Replays the frozen fixed-flow calculation under a distinct policy key. Its
 * terminal conversion uses an exact block-pinned quote and the quote's
 * explicit slippage floor. No output is treated as an executed fill. */
export function buildPaperConversionAccounting(open:PaperOpenModel,profile:MarketProfile,
 mark:ConversionAccountingMark,previous:PaperConversionAccounting|null,fee:FeeEvidence|null,
 closeRetain:PaperCloseRetainModel|null,closeConvert:PaperCloseConvertModel|null,
 closeQuoteInput:PaperCloseConvertQuote|null):PaperConversionAccounting{
 assert(mark.id.match(/^[1-9][0-9]*$/),'Paper conversion accounting mark ID invalid');
 if(mark.kind==='close_convert')assert(closeConvert&&closeQuoteInput&&
  closeConvert.openModelHash===contentHash(open)&&
  closeConvert.campaignId===open.campaignId&&same(closeConvert.source,mark.source)&&
  contentHash(closeConvert.reference)===contentHash(mark.reference),
  'Paper conversion close model unavailable');
 else assert(!closeConvert&&!closeQuoteInput,'Paper conversion close model unexpected');
 assert(mark.kind!=='close_retain'||closeRetain,'Paper conversion retain model unavailable');
 assert(mark.kind==='close_retain'||!closeRetain,'Paper conversion retain model unexpected');
 const baseKind=mark.kind==='close_convert'?'valuation':mark.kind;
 const baseMark:AccountingMark={...mark,kind:baseKind as AccountingMark['kind']};
 const base=buildPaperAccounting(open,profile,baseMark,paperAccountingFromConversionSnapshot(previous),fee,
  mark.kind==='close_retain'?closeRetain:null);
 const initialEconomics={...base.economics,cumulativeConversionCostQuote:'0',
  cumulativeSwapCostQuote:'0',modeledSwapExpectedProceedsQuote:'0',
  modeledSwapProceedsQuote:'0',modeledSwapCostQuote:'0'};
 if(mark.kind!=='close_convert')return paperConversionAccountingSchema.parse({
  ...base,policyVersion:PAPER_CONVERSION_ACCOUNTING_POLICY,
  economics:initialEconomics,conversion:null,limitations:v2Limitations});

 const model=closeConvert!,q=paperCloseConvertQuoteSchema.parse(closeQuoteInput),
  route=model.conversionRoute,p=profile.pool;
 assert(model.principal.amount0Raw===mark.principal0Raw&&
  model.principal.amount1Raw===mark.principal1Raw,
  'Paper conversion principal changed');
 const fromAsset=q.inputAsset,toAsset=fromAsset==='token0'?'token1':'token0',
  input=BigInt(q.inputAmountRaw),expected=BigInt(q.expectedOutputRaw),
  minimum=BigInt(q.minimumOutputRaw),
  token0Before=BigInt(base.inventory.token0Raw),token1Before=BigInt(base.inventory.token1Raw);
 const quoteAsset=p.quoteToken===0?'token0':'token1';
 assert(route.router.toLowerCase()===q.router.toLowerCase()&&
  route.quoter.toLowerCase()===q.quoter.toLowerCase()&&route.fee===q.fee&&
  route.pathVersion===q.pathVersion&&route.slippageBps===q.slippageBps&&
  contentHash(route.path)===contentHash(q.path)&&fromAsset===route.inputAsset&&
  fromAsset!==quoteAsset&&same(q.source,model.source)&&
  q.minimumOutputRaw===String(expected*BigInt(10_000-q.slippageBps)/10_000n),
  'Paper conversion quote differs from pinned route');
 assert(input===(fromAsset==='token0'?token0Before:token1Before),
  'Paper conversion quote does not cover full input inventory');
 const token0=fromAsset==='token0'?0n:token0Before+minimum,
  token1=fromAsset==='token1'?0n:token1Before+minimum,
  nativePrice=BigInt(mark.reference.nativePrice),price0=BigInt(mark.reference.price0),
  price1=BigInt(mark.reference.price1),
  nativeGas=BigInt(model.costs.expectedWei),gasQuote=BigInt(model.costs.expectedValue),
  cumulativeGas=BigInt(base.inventory.cumulativeGasWei)+nativeGas;
 assert(cumulativeGas<=BigInt(open.allocation.nativeWei),
  'Paper conversion native reserve insufficient');
 const native=BigInt(open.allocation.nativeWei)-cumulativeGas;
 const valueRaw=(amount:bigint,price:bigint,decimals:number)=>amount*price/10n**BigInt(decimals);
 const proceedsExpected=valueRaw(expected,toAsset==='token0'?price0:price1,
  toAsset==='token0'?p.decimals0:p.decimals1),
  proceedsMinimum=valueRaw(minimum,toAsset==='token0'?price0:price1,
   toAsset==='token0'?p.decimals0:p.decimals1),
  inputValue=valueRaw(input,fromAsset==='token0'?price0:price1,
   fromAsset==='token0'?p.decimals0:p.decimals1),
  modeledSwapCost=inputValue-proceedsMinimum,
  nav=valueRaw(token0,price0,p.decimals0)+valueRaw(token1,price1,p.decimals1)+
   valueRaw(native,nativePrice,18),
  markGas=gasQuote,
  conversionFlows:PaperConversionAccounting['flows'][number][]=[
   {kind:'modeled_gas',asset:'native',amountRaw:String(nativeGas),valueQuote:String(gasQuote)},
   {kind:'modeled_conversion',fromAsset,fromAmountRaw:String(input),toAsset,
    expectedToAmountRaw:String(expected),minimumToAmountRaw:String(minimum),
    expectedValueQuote:String(proceedsExpected),minimumValueQuote:String(proceedsMinimum),
    quoteHash:q.quoteHash,pathVersion:q.pathVersion},
  ];
 const addCapitalOut=(asset:'token0'|'token1'|'native',amount:bigint,price:bigint,decimals:number)=>
  conversionFlows.push({kind:'modeled_capital_out',asset,amountRaw:String(amount),
   valueQuote:String(valueRaw(amount,price,decimals))});
 addCapitalOut('token0',token0,price0,p.decimals0);
 addCapitalOut('token1',token1,price1,p.decimals1);
 addCapitalOut('native',native,nativePrice,18);
 const gasProfiles=[...base.gasProfiles,...model.costs.stages.map(stage=>({stage:stage.stage,
  id:stage.profileId,version:stage.version,
  sourceHash:stage.source.hash}))];
 const closeConvertHash=contentHash(model);
 const economics={...base.economics,netNavQuote:String(nav),
  absolutePnlQuote:String(nav-BigInt(base.economics.initialCapitalQuote)),
  alphaQuote:String(nav-BigInt(base.economics.passiveQuote)),
  cumulativeGasExpenseQuote:String(BigInt(base.economics.cumulativeGasExpenseQuote)+gasQuote),
  markGasExpenseQuote:String(markGas),cumulativeConversionCostQuote:String(gasQuote),
  cumulativeSwapCostQuote:signedText(modeledSwapCost),
  modeledSwapExpectedProceedsQuote:String(proceedsExpected),
  modeledSwapProceedsQuote:String(proceedsMinimum),
  modeledSwapCostQuote:signedText(modeledSwapCost)};
 return paperConversionAccountingSchema.parse({...base,
  policyVersion:PAPER_CONVERSION_ACCOUNTING_POLICY,markKind:'close_convert',
  closeModelHash:closeConvertHash,gasProfiles,
  inventory:{...base.inventory,token0Raw:String(token0),token1Raw:String(token1),
   nativeWei:String(native),cumulativeGasWei:String(cumulativeGas),hasLiquidity:false},
  economics,conversion:{quoteHash:q.quoteHash,pathVersion:q.pathVersion,source:q.source,
   fromAsset,toAsset,inputAmountRaw:String(input),expectedOutputRaw:String(expected),
   minimumOutputRaw:String(minimum),slippageBps:q.slippageBps,
   expectedProceedsQuote:String(proceedsExpected),minimumProceedsQuote:String(proceedsMinimum),
   modeledSwapCostQuote:signedText(modeledSwapCost),expectedGasWei:model.costs.expectedWei,
   boundGasWei:model.costs.boundWei,expectedGasCostQuote:model.costs.expectedValue,
   boundGasCostQuote:model.costs.boundValue},
  flows:[...base.flows,...conversionFlows],limitations:v2Limitations});
}

/** Projects one saved mark only while its source anchors still resolve on the
 * configured chain. The store performs these reads inside the append
 * transaction, after replaying persisted evidence and before inserting. */
export async function recordCanonicalNextPaperAccounting(store:DeploymentStore,
 client:RobinhoodClient,campaignId:string){
 return store.recordNextPaperAccounting(campaignId,async(chainId,sources)=>{
  assert.equal(await client.getChainId(),chainId,'Paper accounting chain changed');
  const checked=new Map<string,string>();
  for(const source of sources){
   const prior=checked.get(source.block);
   if(prior!==undefined){
    assert.equal(prior,`${source.hash.toLowerCase()}:${source.timestamp}`,
     'Paper accounting same-block source conflict');
    continue;
   }
   const block=await client.getBlock({blockNumber:BigInt(source.block)});
   assert.equal(block.hash.toLowerCase(),source.hash.toLowerCase(),
    'Paper accounting source reorged');
   assert.equal(Number(block.timestamp),source.timestamp,
    'Paper accounting source timestamp changed');
   checked.set(source.block,`${source.hash.toLowerCase()}:${source.timestamp}`);
  }
  // Bracket the full set of reads; a reorg while checking later marks also
  // invalidates the earlier anchor before the transaction can commit.
  for(const [number,identity] of checked){
   const block=await client.getBlock({blockNumber:BigInt(number)});
   assert.equal(`${block.hash.toLowerCase()}:${Number(block.timestamp)}`,identity,
    'Paper accounting source changed during verification');
  }
 });
}

/** V2 is intentionally opt-in. Its terminal close quote is derived from the
 * persisted lower-fee carry inside the store transaction, then replayed at
 * the exact saved block before the versioned scenario can be appended. */
export async function recordCanonicalNextPaperConversionAccounting(store:DeploymentStore,
 client:RobinhoodClient,campaignId:string){
 return store.recordNextPaperAccounting(campaignId,async(chainId,sources)=>{
  assert.equal(await client.getChainId(),chainId,'Paper conversion accounting chain changed');
  const checked=new Map<string,string>();
  for(const source of sources){
   const prior=checked.get(source.block);
   if(prior!==undefined){
    assert.equal(prior,`${source.hash.toLowerCase()}:${source.timestamp}`,
     'Paper conversion accounting same-block conflict');
    continue;
   }
   const block=await client.getBlock({blockNumber:BigInt(source.block)});
   assert.equal(block.hash.toLowerCase(),source.hash.toLowerCase(),
    'Paper conversion accounting source reorged');
   assert.equal(Number(block.timestamp),source.timestamp,
    'Paper conversion accounting timestamp changed');
   checked.set(source.block,`${source.hash.toLowerCase()}:${source.timestamp}`);
  }
  for(const [number,identity] of checked){
   const block=await client.getBlock({blockNumber:BigInt(number)});
   assert.equal(`${block.hash.toLowerCase()}:${Number(block.timestamp)}`,identity,
    'Paper conversion accounting source changed during verification');
  }
 },PAPER_CONVERSION_ACCOUNTING_POLICY,async(chainId,model,inputAmountRaw)=>{
  assert.equal(await client.getChainId(),chainId,'Paper conversion quote chain changed');
  const quote=await verifyCanonicalPaperCloseConvertQuote(client,model,inputAmountRaw);
  assert.deepEqual(quote.source,model.source,'Paper conversion quote anchor changed');
  return quote;
 });
}

/** Audits already-projected history against a stable pair of canonical reads.
 * A provider failure or a chain change during the audit rejects the run and
 * cannot create a permanent revocation. */
export async function auditCanonicalPaperAccounting(store:DeploymentStore,
 client:RobinhoodClient,campaignId:string){
 return store.auditPaperAccounting(campaignId,async(chainId,sources)=>{
  assert.equal(await client.getChainId(),chainId,'Paper accounting audit chain changed');
  const read=async(source:PaperAccountingAnchor)=>{
   const block=await client.getBlock({blockNumber:BigInt(source.block)});
   return {hash:block.hash.toLowerCase(),timestamp:Number(block.timestamp)};
  };
  const first=new Map<string,{hash:string;timestamp:number}>();
  for(const source of sources)first.set(source.accountingId,await read(source));
  const second=new Map<string,{hash:string;timestamp:number}>();
  for(const source of sources){
   const actual=await read(source),prior=first.get(source.accountingId)!;
   assert.deepEqual(actual,prior,'Paper accounting source changed during audit');
   second.set(source.accountingId,actual);
  }
  for(const source of sources){
   const actual=second.get(source.accountingId)!;
   if(actual.hash!==source.hash.toLowerCase()||actual.timestamp!==source.timestamp)
    return {accountingId:source.accountingId,actual};
  }
  return null;
 });
}

/** Audits the independent v2 projection. Its append-only invalidation is
 * campaign-wide, so either policy's detected reorg fails both views closed. */
export async function auditCanonicalPaperConversionAccounting(store:DeploymentStore,
 client:RobinhoodClient,campaignId:string){
 return store.auditPaperAccounting(campaignId,async(chainId,sources)=>{
  assert.equal(await client.getChainId(),chainId,'Paper conversion audit chain changed');
  const read=async(source:PaperAccountingAnchor)=>{
   const block=await client.getBlock({blockNumber:BigInt(source.block)});
   return {hash:block.hash.toLowerCase(),timestamp:Number(block.timestamp)};
  };
  const first=new Map<string,{hash:string;timestamp:number}>();
  for(const source of sources)first.set(source.accountingId,await read(source));
  for(const source of sources){
   const actual=await read(source),prior=first.get(source.accountingId)!;
   assert.deepEqual(actual,prior,'Paper conversion audit source changed during verification');
   if(actual.hash!==source.hash.toLowerCase()||actual.timestamp!==source.timestamp)
    return {accountingId:source.accountingId,actual};
  }
  return null;
 },PAPER_CONVERSION_ACCOUNTING_POLICY);
}

/** Bounded, restart-safe journal pass for one campaign. A later run picks up
 * the first unprojected mark; missing fee evidence or revoked sources stop
 * the pass without changing prior snapshots. */
export async function projectCanonicalPaperAccounting(store:DeploymentStore,
 client:RobinhoodClient,campaignId:string,maxMarks=100){
 assert(Number.isSafeInteger(maxMarks)&&maxMarks>=1&&maxMarks<=100,
  'Paper accounting projection budget invalid');
 const projected:string[]=[];
 for(let n=0;n<maxMarks;n++){
  const next=await recordCanonicalNextPaperAccounting(store,client,campaignId);
  if(!next)return {projected,caughtUp:true};
  projected.push(next.markId);
 }
 return {projected,caughtUp:false};
}

/** Bounded v2 replay; unlike v1, the close-convert terminal requires its exact
 * fee-aware quote and scoped conversion gas profiles before it can catch up. */
export async function projectCanonicalPaperConversionAccounting(store:DeploymentStore,
 client:RobinhoodClient,campaignId:string,maxMarks=100){
 assert(Number.isSafeInteger(maxMarks)&&maxMarks>=1&&maxMarks<=100,
  'Paper conversion accounting projection budget invalid');
 const projected:string[]=[];
 for(let n=0;n<maxMarks;n++){
  const next=await recordCanonicalNextPaperConversionAccounting(store,client,campaignId);
  if(!next)return {projected,caughtUp:true};
  projected.push(next.markId);
 }
 return {projected,caughtUp:false};
}
