import assert from 'node:assert/strict';
import {MIN_TICK,MAX_TICK} from '../backtest/principal.js';
import {replayPaperMint} from './management-audit.js';

export interface InventoryRange {tickLower:number;tickUpper:number}

/** Full spans, not half-widths. Include the single grid cell and asymmetric
 * placements; exact token balances determine mintable liquidity and idle cash.
 * No swap, hidden 50/50 reset or directional price forecast is introduced. */
export function inventoryRanges(tick:number,spacing:number,spanSpacings:readonly number[]):InventoryRange[]{
 assert(Number.isSafeInteger(tick)&&Number.isSafeInteger(spacing)&&spacing>0);
 assert(spanSpacings.length>0&&spanSpacings.every(n=>Number.isSafeInteger(n)&&n>0&&n<=64));
 const base=Math.floor(tick/spacing)*spacing,ranges=new Map<string,InventoryRange>();
 for(const cells of spanSpacings)for(const fraction of [0,0.25,0.5,0.75,1]){
  const lower=base-Math.floor((cells-1)*fraction)*spacing,upper=lower+cells*spacing;
  if(lower<MIN_TICK||upper>MAX_TICK)continue;
  ranges.set(`${lower}:${upper}`,{tickLower:lower,tickUpper:upper});
 }
 return [...ranges.values()];
}

export function inventoryMintPlan(price:bigint,range:InventoryRange,amount0:bigint,amount1:bigint){
 assert(amount0>=0n&&amount1>=0n);
 const mint=replayPaperMint(price,range,amount0,amount1,0n);
 assert(mint.liquidity>0n,'inventory_empty_mint');
 return {...range,token:null,amount:0n,amountOut:0n,price,mint};
}
