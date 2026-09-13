import assert from 'node:assert/strict';
import {marketRange,marketTokens,marketValue,canonicalBalances,namedBalances,type PaperMarket} from '../paper/market.js';
import {sizeLiquidityForQuoteBudget} from '../simulator/math.js';
import {principalAmounts} from '../backtest/principal.js';
import {historicalSwapQuote,modeledFeeGrowth} from './portfolio-math.js';
import {replayPaperMint} from './management-audit.js';
import {solveRecenterSwap,assertRecenterPrice} from '../paper/execution-recenter.js';
import type {FeeSegment,SwapSource} from './swap.js';
type Range={tickLower:number;tickUpper:number};
type Position=Range&{liquidity:bigint;fee0:bigint;fee1:bigint};
type Intent=Range&{at:number;token:0|1;amount:bigint;minimum:bigint;kind:'entry'|'recenter';maxAmount:bigint;reference:bigint};
export interface AssetReplayCosts {entry:bigint;recenter:bigint;exit:bigint;hold:bigint}
/** Conditional market-path replay. Historical risk/infrastructure eligibility is
 * deliberately not inferred from present-day evidence. Forward paper supplies it. */
export class AssetReplay {
 readonly budget=5000000000n;cash0=0n;cash1=0n;position:Position|null=null;intent:Intent|null=null;
 hold:{a:bigint;b:bigint}|null=null;gas=0n;fees0=0n;fees1=0n;entries=0;recenters=0;rejected:Record<string,number>={};
 lastDecision:number|null=null;peak=5000000000n;drawdown=0n;invalid:string|null=null;actions:Record<string,unknown>[]=[];
 constructor(readonly market:PaperMarket,readonly costs:AssetReplayCosts,readonly delaySeconds=30,readonly gasMultiplier=1,readonly feePpm=1000000){
  const b=canonicalBalances(market,this.budget,0n);this.cash0=b.amount0;this.cash1=b.amount1;
 }
 balances(m:SwapSource){const p=this.position,a=p?principalAmounts({...p,sqrtPriceX96:m.price}):{amount0:0n,amount1:0n};return {a:this.cash0+a.amount0+(p?p.fee0/(1n<<128n):0n),b:this.cash1+a.amount1+(p?p.fee1/(1n<<128n):0n)};}
 accrue(s:FeeSegment,protocol:number){const p=this.position;if(!p||this.invalid)return;const credit=modeledFeeGrowth(s,p,p.liquidity,protocol)*p.liquidity*BigInt(this.feePpm)/1000000n;const key=s.token===0?'fee0':'fee1',old=p[key]/(1n<<128n);p[key]+=credit;if(s.token===0)this.fees0+=p[key]/(1n<<128n)-old;else this.fees1+=p[key]/(1n<<128n)-old;}
 reject(reason:string){this.rejected[reason]=(this.rejected[reason]??0)+1;}
 async decision(m:SwapSource,at:number){
  if(this.invalid||this.lastDecision!==null&&at-this.lastDecision<this.delaySeconds*1000)return;
  this.lastDecision=at;
  if(this.position&&(!m.ticks.includes(this.position.tickLower)||!m.ticks.includes(this.position.tickUpper))){this.invalid='initialized_fee_boundary_lost';return;}
  const b=this.balances(m),nav=marketValue(this.market,m.price,b.a,b.b)-this.gas;
  if(nav>this.peak)this.peak=nav;const dd=(this.peak-nav)*1000000n/this.peak;if(dd>this.drawdown)this.drawdown=dd;
  if(this.intent){const intent=this.intent;this.intent=null;
   try{
    assert(at-intent.at<=90000,'quote_expired');assert(m.tick>=intent.tickLower&&m.tick<intent.tickUpper,'frozen_range_left');
    assert(m.ticks.includes(intent.tickLower)&&m.ticks.includes(intent.tickUpper),'boundaries_missing');
    // Recenter amount can adapt inside the frozen inventory budget/direction.
    let amount=intent.amount;
    if(intent.kind==='recenter'){
     assertRecenterPrice(m.price,intent.reference,50);
     const plan=await solveRecenterSwap(m.price,intent,b.a,b.b,async(n,t)=>{const q=historicalSwapQuote(m,n,t);assert(q.fullyFilled,'swap_unfilled');return {amountOut:q.amountOut,price:q.sqrtPriceAfter};});
     assert(plan.token===intent.token,'swap_direction_changed');amount=plan.amount;assert(amount<=intent.maxAmount,'frozen_input_budget');assertRecenterPrice(plan.price,intent.reference,50);
    }
    const q=historicalSwapQuote(m,amount,intent.token);assert(q.fullyFilled&&q.passesSlippage&&q.amountOut*intent.amount>=intent.minimum*amount,'swap_slippage');
    assert(q.tickAfter>=intent.tickLower&&q.tickAfter<intent.tickUpper,'swap_left_range');
    const a=b.a+(intent.token===0?-amount:q.amountOut),c=b.b+(intent.token===1?-amount:q.amountOut);
    const mint=replayPaperMint(q.sqrtPriceAfter,intent,a,c,0n);assert(mint.liquidity>0n,'empty_mint');
    if(!this.hold)this.hold={a,b:c};
    this.cash0=mint.idle0;this.cash1=mint.idle1;this.position={tickLower:intent.tickLower,tickUpper:intent.tickUpper,liquidity:mint.liquidity,fee0:0n,fee1:0n};
    this.gas+=this.costs[intent.kind]*BigInt(this.gasMultiplier);if(intent.kind==='entry')this.entries++;else this.recenters++;
    this.actions.push({at,kind:intent.kind,amountIn:String(amount),token:intent.token,amountOut:String(q.amountOut),tickLower:intent.tickLower,tickUpper:intent.tickUpper});
   }catch(e){this.reject(e instanceof Error?e.message:'placement_failed');}
   return;
  }
  if(this.position&&m.tick>=this.position.tickLower&&m.tick<this.position.tickUpper)return;
  try{
   const range=marketRange(m.price,m.tick,20,10);assert(m.ticks.includes(range.tickLower)&&m.ticks.includes(range.tickUpper),'boundaries_missing');
   let token:0|1,amount:bigint;
   if(!this.position){const t=marketTokens(this.market),size=sizeLiquidityForQuoteBudget({budgetQuote:this.budget,quoteToken:t.quoteIsToken0?t.token0:t.token1,...t,sqrtPriceX96:m.price,...range});token=t.quoteIsToken0?0:1;amount=this.budget-namedBalances(this.market,size.amount0,size.amount1).quote-size.idleQuote;}
   else{const p=await solveRecenterSwap(m.price,range,b.a,b.b,async(n,t)=>{const q=historicalSwapQuote(m,n,t);assert(q.fullyFilled,'swap_unfilled');return {amountOut:q.amountOut,price:q.sqrtPriceAfter};});assert(p.token!==null,'zero_swap');token=p.token;amount=p.amount;}
   const q=historicalSwapQuote(m,amount,token);assert(q.fullyFilled&&q.passesSlippage,'quote_slippage');
   this.intent={...range,at,token,amount,minimum:q.amountOut*9950n/10000n,kind:this.position?'recenter':'entry',maxAmount:token===0?b.a:b.b,reference:m.price};
  }catch(e){this.reject(e instanceof Error?e.message:'quote_failed');}
 }
 summary(m:SwapSource){if(this.invalid)return {entries:this.entries,recenters:this.recenters,markedNavQuote:null,terminalCashQuote:null,netPnlQuote:null,holdQuote:null,alphaQuote:null,feesQuote:null,gasPaidQuote:String(this.gas),drawdownPpm:String(this.drawdown),invalid:this.invalid,rejected:this.rejected,actions:this.actions};const b=this.balances(m),t=marketTokens(this.market),rwa=t.quoteIsToken0?b.b:b.a,cash=t.quoteIsToken0?b.a:b.b,exit=historicalSwapQuote(m,rwa,t.quoteIsToken0?1:0);
  const marked=marketValue(this.market,m.price,b.a,b.b)-this.gas,terminal=exit.fullyFilled?cash+exit.amountOut-this.gas-(this.position||rwa>0n?this.costs.exit*BigInt(this.gasMultiplier):0n):null;
  const hold=this.hold?marketValue(this.market,m.price,this.hold.a,this.hold.b)-this.costs.hold*BigInt(this.gasMultiplier):null;
  return {entries:this.entries,recenters:this.recenters,markedNavQuote:String(marked),terminalCashQuote:terminal===null?null:String(terminal),netPnlQuote:terminal===null?null:String(terminal-this.budget),holdQuote:hold===null?null:String(hold),alphaQuote:hold===null||terminal===null?null:String(terminal-hold),feesQuote:String(marketValue(this.market,m.price,this.fees0,this.fees1)),gasPaidQuote:String(this.gas),drawdownPpm:String(this.drawdown),invalid:this.invalid,rejected:this.rejected,actions:this.actions};}
}
