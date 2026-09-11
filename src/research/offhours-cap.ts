import { paperTradingWindow,type PaperTradingHours } from '../paper/trading-hours.js';
import { advanceHolding,type PaperHoldingState } from '../paper/holding.js';
import { paperEntryRange,PAPER_NVDA } from '../paper/engine.js';
import { USDG } from '../constants.js';
import { sizeLiquidityForQuoteBudget } from '../simulator/math.js';
import { historicalSwapQuote,modeledFeeGrowth,nvdaValueQuote } from './portfolio-math.js';
import { replayPaperMint,referenceExposure } from './management-audit.js';
import { inventoryBalances,poolReference,type InventoryBook } from './inventory-management.js';
import type { SwapSource,FeeSegment } from './swap.js';
import type { ExperimentFrame } from '../experiment/market.js';
import type { RpcHealthEvaluation } from '../rpc-health/domain.js';
import { sqrtRatioAtTick } from '../backtest/principal.js';
export const CAP_HOURS:PaperTradingHours={kind:'us_equity_off_hours_v1',entryCutoffSeconds:1800,exitLeadSeconds:600};
export interface CapFrame extends ExperimentFrame {referenceReasons:string[];allHealthIds:string[]}
export interface CapCosts {entry:bigint;exit:bigint;buy:bigint;feePpm:number}
const ms=Date.parse,Q128=1n<<128n;
export class OffHoursCap {
 book:InventoryBook;holding?:PaperHoldingState;invalid:string|null=null;
 pending:({kind:'entry';at:number;range:{tickLower:number;tickUpper:number};amount:bigint;minimum:bigint;lp:bigint;budget:bigint}|{kind:'exit';at:number;reason:string;deadline:string|null})|null=null;last:CapFrame|null=null;enteredAt:number|null=null;lastExitAt:number|null=null;cashDeadline:string|null=null;
 benchmark:{cash:bigint;rwa:bigint;gas:bigint}|null=null;
 entries=0;exits=0;gas=0n;fees=0n;outsideSeconds=0;holdingSeconds=0;maxExposure=0n;peak:bigint;drawdown=0n;
 actions:any[]=[];rejections:Record<string,number>={};lateExitSeconds=0;
 constructor(readonly budget:bigint,readonly cap:number,readonly costs:CapCosts){this.book={cash:budget,rwa:0n,gas:0n,position:null};this.peak=budget;}
 reject(reason:string){this.rejections[reason]=(this.rejections[reason]??0)+1;}
 accrue(segments:{segment:FeeSegment;protocol:number}[],m:SwapSource){
  const p=this.book.position;if(!p||this.invalid)return;
  const old0=p.fee0/Q128,old1=p.fee1/Q128;
  for(const {segment,protocol} of segments)p[segment.token===0?'fee0':'fee1']+=modeledFeeGrowth(segment,p,p.liquidity,protocol)*p.liquidity*BigInt(this.costs.feePpm)/1000000n;
  this.fees+=p.fee0/Q128-old0+nvdaValueQuote(p.fee1/Q128-old1,poolReference(m.price));
 }
 mark(m:SwapSource){const nav=this.nav(m);if(nav>this.peak)this.peak=nav;if(this.peak-nav>this.drawdown)this.drawdown=this.peak-nav;}
 nav(m:SwapSource){const a=inventoryBalances(this.book,m);return a.amount0+nvdaValueQuote(a.amount1,poolReference(m.price))-this.book.gas;}
 decision(f:CapFrame,m:SwapSource,health:{id:string;snapshot:RpcHealthEvaluation}[]){
  if(this.invalid)return;
  const now=ms(f.observedAt),schedule=paperTradingWindow(now,CAP_HOURS),fresh=now-ms(f.sourceAt)<=180000&&now>=ms(f.sourceAt);
  if(!f.dataValid){this.invalid='canonical_data_unavailable';return;}
  if(this.last&&this.book.position){
   const seconds=(ms(f.sourceAt)-ms(this.last.sourceAt))/1000;
   this.holdingSeconds+=seconds;
   if(this.last.tick<this.book.position.tickLower||this.last.tick>=this.book.position.tickUpper)this.outsideSeconds+=seconds;
   if(seconds>900||!fresh){this.invalid='unobserved_holding_decisions';return;}
  }
  this.last=f;
  this.mark(m);
  if(this.book.position){
   const a=inventoryBalances(this.book,m);
   const exposure=f.referencePrice?referenceExposure(a.amount0,a.amount1,BigInt(f.referencePrice),this.book.gas+this.costs.exit):0n;
   if(exposure>this.maxExposure)this.maxExposure=exposure;
   this.holding=advanceHolding({now:f.observedAt,policy:{kind:'bounded_infrastructure_v1',maxLagBlocks:30,chainPauseSeconds:60,riskPauseSeconds:30},previous:this.holding,samples:health,
    risk:{eligible:f.referenceEligible,reasons:f.referenceReasons,evidence:{failedChecks:[]}} as any,riskRead:null});
   const reason=schedule.exitRequired?'scheduled_cash_exit':this.holding.exitReasons.length?'holding_guard':this.holding.paused?null:exposure>=BigInt(this.cap)?'inventory_cap':now-this.enteredAt!>=86400000?'max_holding':null;
   if(reason&&!this.pending)this.pending={kind:'exit',at:now,reason,deadline:this.cashDeadline};
   if(this.pending?.kind==='exit'&&ms(f.sourceAt)>this.pending.at&&fresh&&f.chainHealthy){
    // ETH/USD gas is a frozen cost scenario. USDG-reference failures prevent
    // liquidation in this model, as its quote valuation would be unavailable.
    if(f.referenceReasons.some(r=>r.includes('usdg'))){this.reject('exit_quote_reference_unavailable');return;}
    const q=historicalSwapQuote(m,a.amount1,1);
    if(!q.fullyFilled||!q.passesSlippage){this.reject('exit_depth');return;}
    const cash=a.amount0+q.amountOut-this.book.gas-this.costs.exit;
    this.gas+=this.costs.exit;this.exits++;
    const late=this.pending.deadline?Math.max(0,(now-ms(this.pending.deadline))/1000):0;this.lateExitSeconds+=late;
    this.actions.push({kind:'exit',at:f.observedAt,sourceAt:f.sourceAt,checkpoint:f.id,reason:this.pending.reason,cash:String(cash),lateSeconds:late});
    this.book={cash,rwa:0n,gas:0n,position:null};this.pending=null;this.holding=undefined;this.lastExitAt=now;this.mark(m);
   }
   return;
  }
  if(!schedule.entryAllowed||!paperTradingWindow(f.sourceAt,CAP_HOURS).entryAllowed||!fresh||!f.chainHealthy||!f.referenceEligible){this.pending=null;return;}
  if(this.lastExitAt!==null&&ms(f.sourceAt)<this.lastExitAt+600000)return;
  if(this.book.cash<=this.costs.entry+this.costs.exit){this.reject('cash_exhausted');return;}
  if(!this.pending){
   const range=paperEntryRange({tick:m.tick,sqrtPriceX96:String(m.price)},{halfWidthSpacings:2,feeAccounting:'initialized_boundaries_v1'});
   if(!m.ticks.includes(range.tickLower)||!m.ticks.includes(range.tickUpper)){this.reject('uninitialized_boundaries');return;}
   const ref=BigInt(f.referencePrice!);
   if([range.tickLower,range.tickUpper].some(t=>{const p=(1n<<192n)*10n**30n/sqrtRatioAtTick(t)**2n;return p*1000000n<ref*950000n||p*1000000n>ref*1050000n;})){this.reject('range_reference_band');return;}
   const lp=this.book.cash*800000n/1000000n;
   const sized=sizeLiquidityForQuoteBudget({budgetQuote:lp,quoteToken:USDG,token0:USDG,token1:PAPER_NVDA,sqrtPriceX96:m.price,...range});
   const amount=lp-sized.amount0-sized.idleQuote,q=historicalSwapQuote(m,amount,0);
   if(!q.fullyFilled||!amount){this.reject('quote_depth');return;}
   this.pending={kind:'entry',at:now,range,amount,minimum:q.amountOut*9950n/10000n,lp,budget:this.book.cash};
   this.actions.push({kind:'quote',at:f.observedAt,checkpoint:f.id,amount:String(amount)});return;
  }
  const intent=this.pending;if(intent.kind!=='entry'||ms(f.sourceAt)<=intent.at)return;
  this.pending=null;
  if(now-intent.at>900000||m.tick<intent.range.tickLower||m.tick>=intent.range.tickUpper){this.reject('entry_intent_expired_or_outside');return;}
  const q=historicalSwapQuote(m,intent.amount,0);
  if(!q.fullyFilled||q.amountOut<intent.minimum||q.tickAfter<intent.range.tickLower||q.tickAfter>=intent.range.tickUpper){this.reject('entry_fill_minimum_or_range');return;}
  const mint=replayPaperMint(q.sqrtPriceAfter,intent.range,intent.budget-intent.amount,q.amountOut,intent.budget-intent.lp);
  if(mint.liquidity<=0n||mint.liquidity*1000000n>q.liquidityAfter*10000n){this.reject('liquidity_share');return;}
  this.benchmark??={cash:intent.budget-intent.amount,rwa:q.amountOut,gas:this.costs.buy};
  this.book={cash:mint.idle0,rwa:mint.idle1,gas:this.costs.entry,position:{...intent.range,liquidity:mint.liquidity,fee0:0n,fee1:0n}};
  this.enteredAt=ms(f.sourceAt);this.cashDeadline=schedule.excludedAt;this.gas+=this.costs.entry;this.entries++;
  this.holding={checkedAt:f.observedAt,lastHealthAt:f.observedAt,chainSince:null,riskSince:null,paused:false,resumeFromPause:false,exitReasons:[],reasons:[],healthSampleId:null,riskEvidence:null};
  this.mark(m);
  this.actions.push({kind:'entry',at:f.observedAt,sourceAt:f.sourceAt,checkpoint:f.id,budget:String(intent.budget),range:intent.range,gas:String(this.costs.entry)});
 }
 summary(m:SwapSource){
  const nav=this.nav(m),hold=this.benchmark?this.benchmark.cash+nvdaValueQuote(this.benchmark.rwa,poolReference(m.price))-this.benchmark.gas:this.budget;
  return {cap:this.cap,nav,pnl:nav-this.budget,hold,alpha:nav-hold,fees:this.fees,gas:this.gas,entries:this.entries,exits:this.exits,positionOpen:!!this.book.position,
   invalid:this.invalid,maxExposurePpm:this.maxExposure,maxDrawdown:this.drawdown,holdingSeconds:this.holdingSeconds,outsideSeconds:this.outsideSeconds,lateExitSeconds:this.lateExitSeconds,
   actions:this.actions,rejections:this.rejections};
 }
}
