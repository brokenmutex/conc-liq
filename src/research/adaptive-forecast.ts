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

const SQRT2=Math.SQRT2;
/** Abramowitz and Stegun 7.1.26; absolute error below 1.5e-7. Deterministic. */
function erf(x:number){
  const sign=x<0?-1:1,a=Math.abs(x),t=1/(1+0.3275911*a);
  const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-a*a);
  return sign*y;
}
const normalCdf=(z:number)=>0.5*(1+erf(z/SQRT2));

/** Probability that driftless Brownian motion in tick space, started at x
 * strictly inside (a,b) with standard deviation s accumulated so far, has not
 * yet touched either boundary. Method of images; the number of image terms
 * grows with s relative to the band width. */
function survival(x:number,a:number,b:number,s:number){
  if(s<=0)return 1;
  const width=b-a,terms=Math.ceil(3*s/width)+1;
  let total=0;
  for(let k=-terms;k<=terms;k++){
    const shift=2*k*width;
    total+=normalCdf((b-x-shift)/s)-normalCdf((a-x-shift)/s)-normalCdf((b-2*a+x-shift)/s)+normalCdf((x-a-shift)/s);
  }
  return Math.min(1,Math.max(0,total));
}

export interface RangeOccupancy {
  /** Expected fraction of the horizon spent inside the band before first exit. */
  occupancy:number;
  /** Probability that the band is left at least once within the horizon. */
  exitProbability:number;
  inRange:boolean;
}

/** Expected in-band time until first exit for a driftless diffusion whose
 * variance over the horizon is `varianceTicks`. A position that starts outside
 * its band earns nothing here; re-entry is a separate later decision. The
 * lognormal drift correction (well below one tick at observed variances) is
 * ignored for occupancy and retained for the terminal price scenarios.
 *
 * The integral (1/T)∫₀ᵀ S(t)dt uses t=T·u², dt=2Tu·du and Simpson's rule on
 * u∈[0,1], so the early flat part of the survival curve is resolved. */
export function rangeOccupancy(centerTick:number,tickLower:number,tickUpper:number,varianceTicks:number):RangeOccupancy {
  assert(Number.isFinite(centerTick)&&Number.isFinite(varianceTicks)&&tickLower<tickUpper&&varianceTicks>=0);
  if(centerTick<tickLower||centerTick>=tickUpper)return {occupancy:0,exitProbability:1,inRange:false};
  if(varianceTicks===0)return {occupancy:1,exitProbability:0,inRange:true};
  const sigma=Math.sqrt(varianceTicks),n=64;
  let sum=0;
  for(let i=0;i<=n;i++){
    const u=i/n,weight=i===0||i===n?1:i%2?4:2;
    sum+=weight*2*u*survival(centerTick,tickLower,tickUpper,sigma*u);
  }
  const occupancy=Math.min(1,Math.max(0,sum/(3*n)));
  return {occupancy,exitProbability:1-survival(centerTick,tickLower,tickUpper,sigma),inRange:true};
}

/** Expected fraction of the horizon a driftless walk started at `x` spends
 * inside (a,b), WITHOUT stopping at first exit.
 *
 * `rangeOccupancy` above is stopped occupancy, which is right for a two-sided
 * band the strategy will manage when it is left. It returns exactly zero for a
 * position starting outside its band. A one-sided residual range always starts
 * outside its band, by construction — it is minted at the edge of the grid
 * cell the price currently occupies — and it earns every time price comes
 * back, with no action in between. Unstopped occupancy is that quantity.
 *
 * Same substitution t=T*u^2, dt=2Tu*du and Simpson's rule on u in [0,1] as
 * `rangeOccupancy`, so the two are directly comparable. */
export function bandOccupancy(centerTick:number,tickLower:number,tickUpper:number,varianceTicks:number):number {
  assert(Number.isFinite(centerTick)&&Number.isFinite(varianceTicks)&&tickLower<tickUpper&&varianceTicks>=0);
  if(varianceTicks===0)return centerTick>=tickLower&&centerTick<tickUpper?1:0;
  const sigma=Math.sqrt(varianceTicks),n=64;
  let sum=0;
  for(let i=0;i<=n;i++){
    const u=i/n,weight=i===0||i===n?1:i%2?4:2,s=sigma*u;
    const inside=s<=0?(centerTick>=tickLower&&centerTick<tickUpper?1:0)
      :normalCdf((tickUpper-centerTick)/s)-normalCdf((tickLower-centerTick)/s);
    sum+=weight*2*u*inside;
  }
  return Math.min(1,Math.max(0,sum/(3*n)));
}

/** Probability that the walk ends the horizon past the far edge of a one-sided
 * band: the state in which the inventory is fully converted and the book is
 * one-sided again, needing another placement. `heldToken` is 1 when the band
 * lies below the current tick and 0 when it lies above. */
export function bandTraverseProbability(centerTick:number,tickLower:number,tickUpper:number,
 varianceTicks:number,heldToken:0|1):number {
  if(varianceTicks<=0)return 0;
  const sigma=Math.sqrt(varianceTicks);
  return heldToken===1?normalCdf((tickLower-centerTick)/sigma):1-normalCdf((tickUpper-centerTick)/sigma);
}

/** The tick-space centre `forecastPortfolio` uses, exposed so a caller scoring
 * a band outside the portfolio path derives it identically. */
export function forecastCenterTick(price:bigint){return 2*Math.log(Number(price)/(2**96))/LOG_TICK;}

/** Three moment-matched diffusion scenarios for terminal inventory value, zero
 * predictive drift. Fee income uses lagged fee growth, current-depth dilution
 * and the analytic expected in-band time until first exit, so a band that the
 * trailing volatility is likely to cross earns proportionally less. A position
 * that starts inside its band is additionally charged `crossingCost` times the
 * probability of leaving the band within the horizon: the management a narrow
 * range is expected to need. This is a forecasting hypothesis, not the paper's
 * continuous-time optimum. */
export function forecastPortfolio(market:PaperMarket,m:SwapSource,portfolio:ForecastPortfolio,stats:ForecastStats,horizonMs:number,exitCost:bigint,feePpm=1000000,crossingCost=0n) {
  assert(horizonMs>0&&stats.spanMs>0&&feePpm>=0&&feePpm<=1000000&&crossingCost>=0n);
  const center=2*Math.log(Number(m.price)/(2**96))/LOG_TICK;
  const variance=stats.varianceTicksPerMs*horizonMs;
  const points=[{z:-Math.sqrt(3),weight:1n},{z:0,weight:4n},{z:Math.sqrt(3),weight:1n}];
  const p=portfolio.position;
  const range=p?rangeOccupancy(center,p.tickLower,p.tickUpper,variance):{occupancy:0,exitProbability:0,inRange:false};
  const occupancyPpm=BigInt(Math.round(range.occupancy*1000000)),exitPpm=BigInt(Math.round(range.exitProbability*1000000));
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
      (BigInt(stats.spanMs)*Q128*(m.liquidity+p.liquidity)*1000000n*1000000n);
  };
  if(p)unadjustedFees=marketValue(market,m.price,fee(0,1000000n),fee(1,1000000n));
  const f0=fee(0,occupancyPpm),f1=fee(1,occupancyPpm);
  const crossingChargeQuote=range.inRange?crossingCost*exitPpm/1000000n:0n;
  for(const point of points){
    const target=shiftedSource(point.z*Math.sqrt(variance)-variance*LOG_TICK/2);
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
  return {terminalQuote:weighted/6n-crossingChargeQuote,feesQuote:weightedFees/6n,trailingAlwaysActiveFeesQuote:unadjustedFees,
    occupancy:range.occupancy,exitProbability:range.exitProbability,crossingChargeQuote,
    asOf:stats.asOf,horizonMs,sampleCount:stats.count,varianceTicks:variance};
}
