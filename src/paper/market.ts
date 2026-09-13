import assert from 'node:assert/strict';
import {getAddress,type Address} from 'viem';
import {USDG} from '../constants.js';
import {sqrtRatioAtTick,MIN_TICK,MAX_TICK} from '../backtest/principal.js';
import {quoteValue} from '../simulator/math.js';

export interface PaperMarket {
 readonly symbol:string;readonly rwa:Address;readonly pool:Address;readonly fee:number;readonly tickSpacing:number;readonly rwaDecimals:number;
}
export const NVDA_PAPER_MARKET:PaperMarket={symbol:'NVDA',rwa:getAddress('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'),pool:getAddress('0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3'),fee:500,tickSpacing:10,rwaDecimals:18};
export function marketTokens(m:PaperMarket){
 const rwa=getAddress(m.rwa),quote=USDG;assert(rwa!==quote,'Paper RWA equals quote token');
 const quoteIsToken0=quote.toLowerCase()<rwa.toLowerCase();
 return {token0:quoteIsToken0?quote:rwa,token1:quoteIsToken0?rwa:quote,quoteIsToken0};
}
export function marketRange(sqrtPriceX96:bigint,tick:number,halfWidthTicks:number,spacing:number){
 assert(Number.isSafeInteger(halfWidthTicks)&&halfWidthTicks>0&&Number.isSafeInteger(spacing)&&spacing>0&&halfWidthTicks%spacing===0,'Requested half-width does not fit pool tick spacing');
 const base=Math.floor(tick/spacing)*spacing;
 const ranges=[base,base+spacing].map(center=>({tickLower:center-halfWidthTicks,tickUpper:center+halfWidthTicks}))
  .filter(r=>r.tickLower>=MIN_TICK&&r.tickUpper<=MAX_TICK&&tick>=r.tickLower&&tick<r.tickUpper);
 assert(ranges.length,'No valid paper range');
 const distance=(r:typeof ranges[number])=>{const middle=sqrtRatioAtTick(r.tickLower)*sqrtRatioAtTick(r.tickUpper),now=sqrtPriceX96**2n;return middle>now?middle-now:now-middle;};
 return ranges.reduce((a,b)=>distance(b)<distance(a)?b:a);
}
export function marketValue(m:PaperMarket,price:bigint,amount0:bigint,amount1:bigint){
 return quoteValue({...marketTokens(m),amount0,amount1,quoteToken:USDG,sqrtPriceX96:price});
}
export function marketPriceX18(m:PaperMarket,price:bigint){
 const {quoteIsToken0}=marketTokens(m),one=10n**BigInt(m.rwaDecimals);
 return marketValue(m,price,quoteIsToken0?0n:one,quoteIsToken0?one:0n)*10n**12n;
}
export function canonicalBalances(m:PaperMarket,quote:bigint,rwa:bigint){
 return marketTokens(m).quoteIsToken0?{amount0:quote,amount1:rwa}:{amount0:rwa,amount1:quote};
}
export function namedBalances(m:PaperMarket,amount0:bigint,amount1:bigint){
 return marketTokens(m).quoteIsToken0?{quote:amount0,rwa:amount1}:{quote:amount1,rwa:amount0};
}

export function paperMarket(policy?:{readonly market?:PaperMarket}):PaperMarket{return policy?.market??NVDA_PAPER_MARKET;}
