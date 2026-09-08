import assert from "node:assert/strict";
import { feeGrowthInside, subtractUint256 } from "../accounting/math.js";
import type { PaperCheckpoint } from "./engine.js";

export interface BoundaryTick { gross: string; outside0: string; outside1: string }
export interface BoundaryFeeProof {
  block: string; hash: string; tickLower: number; tickUpper: number;
  lower: BoundaryTick; upper: BoundaryTick;
}
export interface BoundaryChange { eventName: string; args: { tickLower: number; tickUpper: number; amount: string } }
export function boundaryInside(cp: PaperCheckpoint, proof: BoundaryFeeProof) {
  assert(proof.block===cp.block&&proof.hash.toLowerCase()===cp.hash.toLowerCase(),"Fee boundary source mismatch");
  assert(proof.tickLower<proof.tickUpper&&BigInt(proof.lower.gross)>0n&&BigInt(proof.upper.gross)>0n,"Fee boundaries must remain initialized");
  return [0,1].map(token=>feeGrowthInside({currentTick:cp.tick,tickLower:proof.tickLower,tickUpper:proof.tickUpper,
    feeGrowthGlobalX128:BigInt(token===0?cp.feeGrowth0:cp.feeGrowth1),
    lowerFeeGrowthOutsideX128:BigInt(token===0?proof.lower.outside0:proof.lower.outside1),
    upperFeeGrowthOutsideX128:BigInt(token===0?proof.upper.outside0:proof.upper.outside1)}));
}
/** Event-complete continuity proof: a cleared/reinitialized boundary cannot reuse its prior outside-growth baseline. */
export function boundaryContinuity(previous: BoundaryFeeProof, next: BoundaryFeeProof, changes: readonly BoundaryChange[]) {
  if(previous.tickLower!==next.tickLower||previous.tickUpper!==next.tickUpper)return false;
  for(const [tick,side] of [[previous.tickLower,"lower"],[previous.tickUpper,"upper"]] as const){
    let gross=BigInt(previous[side].gross);if(gross<=0n)return false;
    for(const event of changes){
      if(event.args.tickLower!==tick&&event.args.tickUpper!==tick)continue;
      assert(event.eventName==="Mint"||event.eventName==="Burn");
      const amount=BigInt(event.args.amount);assert(amount>=0n);
      gross+=event.eventName==="Mint"?amount:-amount;if(gross<=0n)return false;
    }
    if(gross!==BigInt(next[side].gross))return false;
  }
  return true;
}
export function boundaryFeeIncrement(before: PaperCheckpoint, after: PaperCheckpoint, previous: BoundaryFeeProof, next: BoundaryFeeProof,
  liquidity: bigint, remainder0=0n,remainder1=0n) {
  const a=boundaryInside(before,previous),b=boundaryInside(after,next),q=1n<<128n;
  const raw0=subtractUint256(b[0]!,a[0]!)*liquidity+remainder0,raw1=subtractUint256(b[1]!,a[1]!)*liquidity+remainder1;
  // Inside fee growth cannot exceed global growth while boundary initialization is continuous.
  assert(subtractUint256(b[0]!,a[0]!)<=subtractUint256(BigInt(after.feeGrowth0),BigInt(before.feeGrowth0)));
  assert(subtractUint256(b[1]!,a[1]!)<=subtractUint256(BigInt(after.feeGrowth1),BigInt(before.feeGrowth1)));
  return {fee0:raw0/q,fee1:raw1/q,remainder0:raw0%q,remainder1:raw1%q};
}
