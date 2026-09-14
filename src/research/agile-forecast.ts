import assert from 'node:assert/strict';
import type {ForecastSample,ForecastStats} from './adaptive-forecast.js';

export interface AgileForecastSpec {
  lookbackMs:number;
  minimumSpanMs:number;
  minimumSamples:number;
  volatilityHalfLifeMs?:number;
  feeHalfLifeMs?:number;
  /** Share of the weighted fee rate; the remainder uses the trailing rate. */
  weightedFeePpm?:number;
}

/** Time-weighted causal rates on real observations. No interpolation across
 * outages and no interpretation of missing observations as a quiet market.
 * Fee-growth weights use fixed-point integers; token values never use floats. */
export function agileForecastStats(samples:readonly ForecastSample[],at:number,spec:AgileForecastSpec):ForecastStats|null {
  assert(spec.lookbackMs>=spec.minimumSpanMs&&spec.minimumSpanMs>0);
  assert(Number.isInteger(spec.minimumSamples)&&spec.minimumSamples>=2);
  for(const halfLife of [spec.volatilityHalfLifeMs,spec.feeHalfLifeMs])assert(halfLife===undefined||halfLife>0);
  const mix=spec.weightedFeePpm??1000000;
  assert(Number.isInteger(mix)&&mix>=0&&mix<=1000000);
  const last=samples.at(-1);
  if(!last||last.at>at||at-last.at>90000)return null;
  let firstIndex=0;
  // Preserve the observation immediately before the cutoff, as the baseline
  // does, rather than inventing price or fee growth at the cutoff itself.
  while(firstIndex+1<samples.length&&samples[firstIndex+1]!.at<last.at-spec.lookbackMs)firstIndex++;
  const first=samples[firstIndex]!,spanMs=last.at-first.at,count=samples.length-firstIndex;
  if(spanMs<spec.minimumSpanMs||count<spec.minimumSamples)return null;
  let varianceNumerator=0,varianceTime=0,fee0=0n,fee1=0n,feeTime=0n;
  const scale=1n<<48n;
  for(let i=firstIndex+1;i<samples.length;i++){
    const a=samples[i-1]!,b=samples[i]!,dt=b.at-a.at;
    assert(dt>0&&a.price>0n&&b.price>0n&&b.growth0>=a.growth0&&b.growth1>=a.growth1);
    if(dt>900000)return null;
    const weight=spec.volatilityHalfLifeMs===undefined?1:2**(-(last.at-b.at)/spec.volatilityHalfLifeMs);
    const change=2*Math.log(Number(b.price)/Number(a.price))/Math.log(1.0001);
    varianceNumerator+=weight*change*change;varianceTime+=weight*dt;
    const feeWeight=spec.feeHalfLifeMs===undefined?scale:BigInt(Math.round(Number(scale)*2**(-(last.at-b.at)/spec.feeHalfLifeMs)));
    fee0+=feeWeight*(b.growth0-a.growth0);fee1+=feeWeight*(b.growth1-a.growth1);feeTime+=feeWeight*BigInt(dt);
  }
  assert(varianceTime>0&&feeTime>0n);
  const growth=(weighted:bigint,trailing:bigint)=>(weighted*BigInt(spanMs)/feeTime*BigInt(mix)+trailing*BigInt(1000000-mix))/1000000n;
  return {asOf:last.at,spanMs,count,varianceTicksPerMs:varianceNumerator/varianceTime,
    growth0:growth(fee0,last.growth0-first.growth0),growth1:growth(fee1,last.growth1-first.growth1)};
}
