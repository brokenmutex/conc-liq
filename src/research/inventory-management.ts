import assert from 'node:assert/strict';
import {sqrtRatioAtTick} from '../backtest/principal.js';
import {paperEntryRange} from '../paper/engine.js';
import {historicalSwapQuote,nvdaValueQuote,positionAmounts,type TickRange} from './portfolio-math.js';
import {replayPaperMint} from './management-audit.js';
import type {SwapSource} from './swap.js';

export const poolReference=(price:bigint)=>(1n<<192n)*10n**30n/price**2n;
export interface InventoryPosition extends TickRange {liquidity:bigint;fee0:bigint;fee1:bigint}
export interface InventoryBook {cash:bigint;rwa:bigint;position:InventoryPosition|null;gas:bigint}
export function inventoryBalances(book:InventoryBook,market:SwapSource){
 const p=book.position,a=p?positionAmounts(market.price,p,p.liquidity,false):{amount0:0n,amount1:0n};
 return {amount0:book.cash+a.amount0+(p?.fee0??0n)/(1n<<128n),amount1:book.rwa+a.amount1+(p?.fee1??0n)/(1n<<128n)};
}
export function balancedRecenterPlan(m:SwapSource,cash:bigint,rwa:bigint,halfWidthTicks=20,allocationPpm=800000,preserve=false){
 assert(cash>=0n&&rwa>=0n&&[10,20,30,40,50].includes(halfWidthTicks));
 assert(Number.isInteger(allocationPpm)&&allocationPpm>0&&allocationPpm<=800000);
 const range=paperEntryRange({tick:m.tick,sqrtPriceX96:String(m.price)},{halfWidthSpacings:halfWidthTicks/10,feeAccounting:'initialized_boundaries_v1'});
 assert(m.ticks.includes(range.tickLower)&&m.ticks.includes(range.tickUpper),'Recenter boundaries are not initialized');
 const gross=cash+nvdaValueQuote(rwa,poolReference(m.price));
 const reserve=(gross*BigInt(1000000-allocationPpm)+999999n)/1000000n;
 const ratio=(price:bigint,q:bigint,r:bigint)=>{
  const a=positionAmounts(price,range,10n**24n,true);
  return (q-reserve)*a.amount1-r*a.amount0;
 };
 let token:0|1|null=null,amount=0n;
 if(!preserve){
  const sign=ratio(m.price,cash,rwa);
  if(sign!==0n){
   token=sign<0n?1:0;
   let lo=0n,hi=token===1?rwa:cash>reserve?cash-reserve:0n;
   const crossed=(n:bigint)=>{const q=historicalSwapQuote(m,n,token!);return token===1?
    ratio(q.sqrtPriceAfter,cash+q.amountOut,rwa-n)>=0n:ratio(q.sqrtPriceAfter,cash-n,rwa+q.amountOut)<=0n;};
   assert(hi>0n&&crossed(hi),'Recenter inventory cannot fund the cash reserve');
   while(lo<hi){const mid=(lo+hi)/2n;if(crossed(mid))hi=mid;else lo=mid+1n;}amount=lo;
  }
 }
 const swap=token!==null&&amount>0n?historicalSwapQuote(m,amount,token):null;
 assert(!swap||(swap.fullyFilled&&swap.passesSlippage),'Recenter swap slippage failed');
 const price=swap?.sqrtPriceAfter??m.price,tick=swap?.tickAfter??m.tick;
 assert(tick>=range.tickLower&&tick<range.tickUpper,'Recenter swap left its range');
 const q=cash+(token===1?swap!.amountOut:token===0?-amount:0n),r=rwa+(token===0?swap!.amountOut:token===1?-amount:0n);
 assert(q>=reserve,'Recenter cash reserve unavailable');
 const mint=replayPaperMint(price,range,q,r,reserve);
 assert(mint.liquidity>0n&&mint.liquidity*1000000n<=(swap?.liquidityAfter??m.liquidity)*10000n,'Recenter liquidity share failed');
 return {range,reserve,token,amount,swap,mint,price,tick};
}

/** Pure delayed fill: failures leave the input portfolio unchanged. */
export function filledRecenter(b:InventoryBook,m:SwapSource,plan:ReturnType<typeof balancedRecenterPlan>,cost:{remove:bigint;mint:bigint;buy:bigint;sell:bigint}){
 const a=inventoryBalances(b,m);let q=a.amount0,r=a.amount1,price=m.price,liquidity=m.liquidity,trade=null;
 if(plan.swap&&plan.token!==null){assert((plan.token===1?r:q)>=plan.amount,'Frozen swap funding unavailable');trade=historicalSwapQuote(m,plan.amount,plan.token);assert(trade.fullyFilled&&trade.passesSlippage&&trade.amountOut*10000n>=plan.swap.amountOut*9950n,'Frozen swap minimum unavailable');q+=plan.token===1?trade.amountOut:-plan.amount;r+=plan.token===0?trade.amountOut:-plan.amount;price=trade.sqrtPriceAfter;liquidity=trade.liquidityAfter;}
 assert(price>=sqrtRatioAtTick(plan.range.tickLower)&&price<sqrtRatioAtTick(plan.range.tickUpper),'Frozen range no longer active');
 const mint=replayPaperMint(price,plan.range,q,r,plan.reserve);assert(mint.liquidity>0n&&mint.liquidity*1000000n<=liquidity*10000n,'Liquidity share unavailable');
 assert(mint.amount0*10000n>=plan.mint.amount0*9950n&&mint.amount1*10000n>=plan.mint.amount1*9950n,'Frozen mint minimum unavailable');
 return {book:{cash:mint.idle0,rwa:mint.idle1,position:{...plan.range,liquidity:mint.liquidity,fee0:0n,fee1:0n},gas:b.gas+cost.remove+cost.mint+(plan.token===0?cost.buy:plan.token===1?cost.sell:0n)},token:plan.token,price};
}

export function trimPlan(book:InventoryBook,m:SwapSource){
 const p=book.position;assert(p,'Trim requires an open LP');const burned=p.liquidity/4n;assert(burned>0n);
 const released=positionAmounts(m.price,p,burned,false),amount=book.rwa+released.amount1+p.fee1/(1n<<128n);
 const remaining=p.liquidity-burned;
 const augmented={...m,liquidity:m.liquidity+(m.tick>=p.tickLower&&m.tick<p.tickUpper?remaining:0n),net:(t:number)=>m.net(t)+(t===p.tickLower?remaining:t===p.tickUpper?-remaining:0n)};
 const quote=historicalSwapQuote(augmented,amount,1);assert(quote.fullyFilled&&quote.passesSlippage);
 return {burned,amount,minimum:quote.amountOut*9950n/10000n};
}
export function filledTrim(book:InventoryBook,m:SwapSource,plan:ReturnType<typeof trimPlan>,cost:bigint){
 const p=book.position;assert(p&&p.liquidity>plan.burned&&plan.burned>0n);
 const released=positionAmounts(m.price,p,plan.burned,false),remaining=p.liquidity-plan.burned;
 const q=book.cash+released.amount0+p.fee0/(1n<<128n),r=book.rwa+released.amount1+p.fee1/(1n<<128n);
 assert(r>=plan.amount,'Frozen trim funding unavailable');
 const augmented={...m,liquidity:m.liquidity+(m.tick>=p.tickLower&&m.tick<p.tickUpper?remaining:0n),net:(t:number)=>m.net(t)+(t===p.tickLower?remaining:t===p.tickUpper?-remaining:0n)};
 const quote=historicalSwapQuote(augmented,plan.amount,1);assert(quote.fullyFilled&&quote.passesSlippage&&quote.amountOut>=plan.minimum,'Frozen trim minimum unavailable');
 return {book:{cash:q+quote.amountOut,rwa:r-plan.amount,gas:book.gas+cost,position:{tickLower:p.tickLower,tickUpper:p.tickUpper,liquidity:remaining,fee0:0n,fee1:0n}},price:quote.sqrtPriceAfter,quote};
}
