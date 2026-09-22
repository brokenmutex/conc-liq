import assert from 'node:assert/strict';
import {z} from 'zod';
import {contentHash} from './contracts.js';
import type {MarketProfile} from './market-profile.js';
import type {PaperOpenModel} from './paper-open-model.js';
import type {PaperCloseRetainModel} from './paper-close-model.js';
import type {PaperFeeCarry} from './paper-fee-replay.js';
import type {RobinhoodClient} from '../client.js';
import type {DeploymentStore} from './store.js';

export const PAPER_ACCOUNTING_POLICY='paper_fixed_flow_lower_v1';
const Q128=1n<<128n;
const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const signed=z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const source=z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict();
const reference=z.object({price0:raw,price1:raw,nativePrice:raw}).strict();
const flow=z.object({kind:z.enum(['modeled_fee','modeled_gas','modeled_capital_out']),
 asset:z.enum(['token0','token1','native']),amountRaw:raw,valueQuote:raw}).strict();
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

interface AccountingMark {
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
