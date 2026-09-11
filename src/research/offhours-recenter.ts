import assert from 'node:assert/strict';
import {OffHoursCap,type CapCosts,type CapFrame} from './offhours-cap.js';
import {balancedRecenterPlan,filledRecenter,inventoryBalances,poolReference} from './inventory-management.js';
import {nvdaValueQuote,positionAmounts} from './portfolio-math.js';
import {referenceExposure} from './management-audit.js';
import {sqrtRatioAtTick} from '../backtest/principal.js';
import {paperTradingWindow} from '../paper/trading-hours.js';
import {CAP_HOURS} from './offhours-cap.js';
import type {SwapSource} from './swap.js';
import type {RpcHealthEvaluation} from '../rpc-health/domain.js';

export type RangePolicy='hold_range'|'preserve_tokens'|'net_swap';
export interface RecenterCosts {remove:bigint;mint:bigint;buy:bigint;sell:bigint}
export const RECENTER_RULES={displacementTicks:10,confirmations:2,persistenceSeconds:60,cooldownSeconds:600,quoteMaxAgeSeconds:90,maxFillDriftTicks:5} as const;
type Intent={at:number;tick:number;oldRange:{tickLower:number;tickUpper:number};plan:ReturnType<typeof balancedRecenterPlan>};
/** Independent range management layered over the frozen inventory-cap baseline.
 * Hard exits have priority. All decisions and frozen fills use past/present data.
 * No production paper policy is modified by this research model.
 */
export class OffHoursRecenter extends OffHoursCap {
 rangeIntent:Intent|null=null;
 lastMoveAt:number|null=null;
 displacement:{direction:number;first:number;lastBlock:bigint;count:number}|null=null;
 recenters=0;recenterSwaps=0;recenterGas=0n;recenterTurnover=0n;signals=0;
 deploymentPpmSeconds=0;minDeploymentPpm=1000000n;
 private utilizationLast:{sourceAt:number;deployment:bigint}|null=null;
 constructor(budget:bigint,cap:number,costs:CapCosts,readonly rangePolicy:RangePolicy,readonly recenterCosts:RecenterCosts){super(budget,cap,costs);}
 private cancel(reason:string){if(this.rangeIntent){this.reject('recenter_cancelled_'+reason);this.rangeIntent=null;}this.displacement=null;}
 private rangeBand(plan:Intent['plan'],f:CapFrame){
  if(!f.referenceEligible||!f.referencePrice)return false;
  const ref=BigInt(f.referencePrice);
  return [plan.range.tickLower,plan.range.tickUpper].every(t=>{const p=poolReference(sqrtRatioAtTick(t));return p*1000000n>=ref*950000n&&p*1000000n<=ref*1050000n;});
 }
 override decision(f:CapFrame,m:SwapSource,health:{id:string;snapshot:RpcHealthEvaluation}[]){
  const hadPosition=!!this.book.position,previousEntries=this.entries,now=Date.parse(f.observedAt);
  if(hadPosition&&this.utilizationLast&&!this.invalid){const seconds=(Date.parse(f.sourceAt)-this.utilizationLast.sourceAt)/1000;this.deploymentPpmSeconds+=Number(this.utilizationLast.deployment)*seconds;}
  super.decision(f,m,health);
  if(this.entries>previousEntries){this.lastMoveAt=this.enteredAt;this.cancel('new_entry');}
  if(this.invalid||!this.book.position||this.pending?.kind==='exit'){this.cancel('exit_or_unavailable');this.recordUtilization(f,m);return;}
  if(this.rangePolicy==='hold_range'){this.recordUtilization(f,m);return;}
  const eligible=!this.holding?.paused&&f.chainHealthy&&f.referenceEligible&&paperTradingWindow(f.observedAt,CAP_HOURS).entryAllowed&&paperTradingWindow(f.sourceAt,CAP_HOURS).entryAllowed;
  if(!eligible){this.cancel('guard_or_entry_cutoff');this.recordUtilization(f,m);return;}
  if(this.rangeIntent){
   const intent=this.rangeIntent;
   if(Date.parse(f.sourceAt)>intent.at){
    this.rangeIntent=null;this.displacement=null;
    try{
     assert(now-intent.at<=RECENTER_RULES.quoteMaxAgeSeconds*1000,'quote_expired');
     assert(Math.abs(m.tick-intent.tick)<=RECENTER_RULES.maxFillDriftTicks,'fill_tick_drift');
     assert(this.rangeBand(intent.plan,f),'reference_band');
     // All component transactions are simulated as an atomic research action.
     // A rejected fill leaves the old position and its accrued fees untouched.
     const fill=filledRecenter(this.book,m,intent.plan,this.recenterCosts);
     const afterMarket={...m,price:fill.price},balances=inventoryBalances(fill.book,afterMarket);
     const exposure=referenceExposure(balances.amount0,balances.amount1,BigInt(f.referencePrice!),fill.book.gas+this.costs.exit);
     assert(exposure<BigInt(this.cap),'post_move_inventory_cap');
     const net=balances.amount0+nvdaValueQuote(balances.amount1,poolReference(fill.price))-fill.book.gas;
     assert(net>this.costs.exit,'post_move_cash_insufficient');
     const gas=fill.book.gas-this.book.gas;
     this.book=fill.book;this.gas+=gas;this.recenterGas+=gas;this.recenters++;
     if(intent.plan.swap){this.recenterSwaps++;this.recenterTurnover+=intent.plan.token===0?intent.plan.amount:nvdaValueQuote(intent.plan.amount,poolReference(m.price));}
     if(exposure>this.maxExposure)this.maxExposure=exposure;
     this.lastMoveAt=now;this.mark(afterMarket);this.mark(m);
     this.actions.push({kind:'recenter',at:f.observedAt,sourceAt:f.sourceAt,checkpoint:f.id,quotedAt:new Date(intent.at).toISOString(),oldRange:intent.oldRange,newRange:intent.plan.range,
      tokenIn:intent.plan.token===null?null:intent.plan.token===0?'USDG':'NVDA',amountIn:String(intent.plan.amount),gas:String(gas),exposurePpm:String(exposure),idleUSDG:String(this.book.cash),idleNVDA:String(this.book.rwa),liquidity:String(this.book.position!.liquidity)});
    }catch(error){this.reject('recenter_fill_'+(error instanceof Error?error.message:'unavailable'));}
   }
   this.recordUtilization(f,m);return;
  }
  const p=this.book.position,center=(p.tickLower+p.tickUpper)/2,displacement=m.tick-center,direction=Math.sign(displacement);
  if(Math.abs(displacement)<RECENTER_RULES.displacementTicks){this.displacement=null;this.recordUtilization(f,m);return;}
  const block=BigInt(f.block);
  if(!this.displacement||this.displacement.direction!==direction)this.displacement={direction,first:now,lastBlock:block,count:1};
  else if(block>this.displacement.lastBlock){this.displacement.count++;this.displacement.lastBlock=block;}
  if(this.displacement.count>=RECENTER_RULES.confirmations&&now-this.displacement.first>=RECENTER_RULES.persistenceSeconds*1000&&now-this.lastMoveAt!>=RECENTER_RULES.cooldownSeconds*1000){
   this.signals++;
   try{
    const balances=inventoryBalances(this.book,m),plan=balancedRecenterPlan(m,balances.amount0,balances.amount1,20,800000,this.rangePolicy==='preserve_tokens');
    assert(plan.range.tickLower!==p.tickLower||plan.range.tickUpper!==p.tickUpper,'same_range');
    assert(this.rangeBand(plan,f),'reference_band');
    this.rangeIntent={at:now,tick:m.tick,oldRange:{tickLower:p.tickLower,tickUpper:p.tickUpper},plan};
    this.actions.push({kind:'recenter_quote',at:f.observedAt,checkpoint:f.id,displacementTicks:displacement,range:plan.range,tokenIn:plan.token,amountIn:String(plan.amount)});
   }catch(error){this.reject('recenter_quote_'+(error instanceof Error?error.message:'unavailable'));this.displacement=null;}
  }
  this.recordUtilization(f,m);
 }
 private recordUtilization(f:CapFrame,m:SwapSource){
  if(!this.book.position||this.invalid){this.utilizationLast=null;return;}
  const a=positionAmounts(m.price,this.book.position,this.book.position.liquidity,false),nav=this.nav(m);
  const deployed=a.amount0+nvdaValueQuote(a.amount1,poolReference(m.price));
  const ppm=nav>0n?deployed*1000000n/nav:0n;
  if(ppm<this.minDeploymentPpm)this.minDeploymentPpm=ppm;
  this.utilizationLast={sourceAt:Date.parse(f.sourceAt),deployment:ppm};
 }
 override summary(m:SwapSource){return {...super.summary(m),rangePolicy:this.rangePolicy,recenters:this.recenters,recenterSwaps:this.recenterSwaps,recenterGas:this.recenterGas,recenterTurnover:this.recenterTurnover,recenterSignals:this.signals,
  deploymentPpmSeconds:this.deploymentPpmSeconds,meanDeployedPpm:this.holdingSeconds?this.deploymentPpmSeconds/this.holdingSeconds:null,minDeployedPpm:this.entries?this.minDeploymentPpm:null};}
}
