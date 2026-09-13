import assert from 'node:assert/strict';
import {principalAmounts,sqrtRatioAtTick,MIN_TICK,MAX_TICK,MIN_SQRT_RATIO,MAX_SQRT_RATIO} from '../backtest/principal.js';
import {marketTokens,marketValue,type PaperMarket} from '../paper/market.js';
import {historicalSwapQuote} from './portfolio-math.js';
import {tickAtPrice,type SwapSource} from './swap.js';

export interface ForecastPosition {tickLower:number;tickUpper:number;liquidity:bigint}
export interface ForecastPortfolio {amount0:bigint;amount1:bigint;position:ForecastPosition|null}
export interface ForecastSample {at:number;price:bigint;growth0:bigint;growth1:bigint}
export interface ForecastStats {asOf:number;spanMs:number;count:number;varianceTicksPerMs:number;growth0:bigint;growth1:bigint}
const LOG_TICK=Math.log(1.0001),Q128=1n<<128n;

/** Causal trailing estimates. Missing timestamps cannot be invented as quiet
 * market observations. Growth values are cumulative reconstructed fee growth. */
export class TrailingForecast {
  samples:ForecastSample[]=[];
  constructor(readonly lookbackMs=6*3600000,readonly minimumSpanMs=2*3600000,readonly maximumGapMs=900000){}
  observe(s:ForecastSample){
    const last=this.samples.at(-1);assert(s.price>0n);
    if(last){assert(s.at>last.at,'Forecast sources must advance');assert(s.growth0>=last.growth0&&s.growth1>=last.growth1);}
    this.samples.push(s);
    while(this.samples.length>1&&this.samples[1]!.at<s.at-this.lookbackMs)this.samples.shift();
  }
  stats(at:number):ForecastStats|null {
    const first=this.samples[0],last=this.samples.at(-1);
    if(!first||!last||last.at>at||at-last.at>90000||last.at-first.at<this.minimumSpanMs||this.samples.length<60)return null;
    let squares=0;
    for(let i=1;i<this.samples.length;i++){
      const a=this.samples[i-1]!,b=this.samples[i]!;
      if(b.at-a.at>this.maximumGapMs)return null;
      const change=2*Math.log(Number(b.price)/Number(a.price))/LOG_TICK;
      squares+=change*change;
    }
    return {asOf:last.at,spanMs:last.at-first.at,count:this.samples.length,varianceTicksPerMs:squares/(last.at-first.at),growth0:last.growth0-first.growth0,growth1:last.growth1-first.growth1};
  }
}

/** Three moment-matched diffusion scenarios, zero predictive drift. This is a
 * forecasting hypothesis, not the paper's continuous-time optimum. Fee income
 * uses lagged fee growth, current-depth dilution and sampled range occupancy. */
export function forecastPortfolio(market:PaperMarket,m:SwapSource,portfolio:ForecastPortfolio,stats:ForecastStats,horizonMs:number,exitCost:bigint,feePpm=1000000) {
  assert(horizonMs>0&&stats.spanMs>0&&feePpm>=0&&feePpm<=1000000);
  const center=2*Math.log(Number(m.price)/(2**96))/LOG_TICK;
  const variance=stats.varianceTicksPerMs*horizonMs;
  const points=[{z:-Math.sqrt(3),weight:1n},{z:0,weight:4n},{z:Math.sqrt(3),weight:1n}];
  const p=portfolio.position;
  let weighted=0n,weightedFees=0n,unadjustedFees=0n;
  const shiftedSource=(shift:number)=>{
    const offset=Math.max(MIN_TICK+1,Math.min(MAX_TICK-1,Math.round(shift)));
    if(offset===0)return m;
    const raw=m.price*sqrtRatioAtTick(offset)/(1n<<96n);
    const price=raw<=MIN_SQRT_RATIO?MIN_SQRT_RATIO+1n:raw>=MAX_SQRT_RATIO?MAX_SQRT_RATIO-1n:raw;
    const tick=tickAtPrice(price);
    const liquidity=m.ticks.filter(t=>t<=tick).reduce((n,t)=>n+m.net(t),0n);
    return {...m,tick,price,liquidity};
  };
  const fee=(token:0|1,occupancy:bigint)=>{
    if(!p||m.liquidity===0n)return 0n;
    const growth=token===0?stats.growth0:stats.growth1;
    return growth*BigInt(horizonMs)*p.liquidity*m.liquidity*occupancy*BigInt(feePpm)/
      (BigInt(stats.spanMs)*Q128*(m.liquidity+p.liquidity)*10n*1000000n);
  };
  if(p)unadjustedFees=marketValue(market,m.price,fee(0,10n),fee(1,10n));
  for(const point of points){
    const target=shiftedSource(point.z*Math.sqrt(variance)-variance*LOG_TICK/2);
    let occupied=0n;
    if(p)for(let i=1;i<=10;i++){
      const fraction=(i-.5)/10,tick=center+point.z*Math.sqrt(variance*fraction)-variance*fraction*LOG_TICK/2;
      if(tick>=p.tickLower&&tick<p.tickUpper)occupied++;
    }
    const f0=fee(0,occupied),f1=fee(1,occupied);
    const principal=p?principalAmounts({...p,sqrtPriceX96:target.price}):{amount0:0n,amount1:0n};
    const a=portfolio.amount0+principal.amount0+f0,b=portfolio.amount1+principal.amount1+f1;
    const q0=marketTokens(market).quoteIsToken0,risky=q0?b:a,cash=q0?a:b;
    try{
      const out=risky===0n?0n:historicalSwapQuote(target,risky,q0?1:0);
      if(typeof out!=='bigint'&&(!out.fullyFilled||!out.passesSlippage))return null;
      const value=cash+(typeof out==='bigint'?out:out.amountOut)-(p||risky>0n?exitCost:0n);
      weighted+=point.weight*value;weightedFees+=point.weight*marketValue(market,target.price,f0,f1);
    }catch{return null;}
  }
  return {terminalQuote:weighted/6n,feesQuote:weightedFees/6n,trailingAlwaysActiveFeesQuote:unadjustedFees,
    asOf:stats.asOf,horizonMs,sampleCount:stats.count,varianceTicks:variance};
}
