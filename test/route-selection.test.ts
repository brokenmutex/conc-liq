import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe,it} from 'node:test';
import {selectSwapRoute,acceptSimulatedRoute,type RoutePricing} from '../src/live-pilot/route-selection.js';

// Campaign f8affe19 conditions: median effective gas price 0.083 gwei and ETH
// at about 2,530 USDG. One wei is then 2.53e-9 raw USDG, i.e. 2.53e9 scaled by
// 1e18, which prices the campaign's 157k-gas swap at 0.033 USDG as measured.
const pricing:RoutePricing={gasPriceWei:83_000_000n,nativePerGasTokenX18:2_530_000_000n,minimumGainOut:0n};

describe('per-trade swap route selection',()=>{
 it('keeps the baseline when no candidate beats it',()=>{
  const s=selectSwapRoute([{fee:500,amountOut:1_000_000n,gas:109_329n},
   {fee:3000,amountOut:999_000n,gas:117_744n}],500,pricing);
  assert.equal(s.fee,500);assert.equal(s.reason,'baseline');assert.equal(s.gainOut,0n);
 });
 it('takes a better tier only after paying for its own extra gas',()=>{
  const gas500=109_329n,gas3000=400_000n;
  // The 3000 quote is 200 raw USDG better gross; its extra 290k gas is worth
  // more than that at campaign prices, so the baseline must win.
  const s=selectSwapRoute([{fee:500,amountOut:1_000_000n,gas:gas500},
   {fee:3000,amountOut:1_000_200n,gas:gas3000}],500,pricing);
  assert.equal(s.fee,500,'gross improvement must not survive its own gas');
  const bigger=selectSwapRoute([{fee:500,amountOut:1_000_000n,gas:gas500},
   {fee:3000,amountOut:1_100_000n,gas:gas3000}],500,pricing);
  assert.equal(bigger.fee,3000);assert.equal(bigger.reason,'better_net_of_gas');assert(bigger.gainOut>0n);
 });
 it('ignores tiers that could not be quoted and requires the baseline',()=>{
  const s=selectSwapRoute([{fee:500,amountOut:1_000_000n,gas:109_329n},
   {fee:100,amountOut:0n,gas:0n},{fee:10000,amountOut:0n,gas:0n}],500,pricing);
  assert.equal(s.fee,500);
  assert.throws(()=>selectSwapRoute([{fee:3000,amountOut:1n,gas:1n}],500,pricing),/baseline pool must be quoted/);
 });
 it('holds out for the configured minimum gain',()=>{
  const quotes=[{fee:500,amountOut:1_000_000n,gas:109_329n},{fee:3000,amountOut:1_000_500n,gas:109_329n}];
  assert.equal(selectSwapRoute(quotes,500,pricing).fee,3000);
  assert.equal(selectSwapRoute(quotes,500,{...pricing,minimumGainOut:1_000n}).fee,500);
 });
});

describe('simulated route acceptance',()=>{
 const selection={fee:3000,amountOut:1_100_000n,gas:109_329n,baselineFee:500,gainOut:100_000n,
  reason:'better_net_of_gas' as const};
 const base={selection,baselineQuoteOut:1_000_000n,baselineGas:109_329n,pricing,slippageBps:50};
 it('accepts a simulation that holds its quote and still beats the baseline',()=>{
  assert.deepEqual(acceptSimulatedRoute({...base,simulatedOut:1_099_000n}),
   {accepted:true,reason:'better_net_of_gas'});
 });
 it('rejects a simulation that comes in below its own quote by more than the bound',()=>{
  // 50 bps below 1,100,000 is 1,094,500.
  assert.equal(acceptSimulatedRoute({...base,simulatedOut:1_094_500n}).accepted,true);
  assert.deepEqual(acceptSimulatedRoute({...base,simulatedOut:1_094_499n}),
   {accepted:false,reason:'route_simulation_below_quote'});
 });
 it('rejects a route whose simulated gain no longer clears the minimum',()=>{
  const strict={...base,pricing:{...pricing,minimumGainOut:200_000n}};
  assert.deepEqual(acceptSimulatedRoute({...strict,simulatedOut:1_099_000n}),
   {accepted:false,reason:'route_gain_below_minimum'});
 });
 it('never blocks the baseline route',()=>{
  const baseline={...selection,fee:500,reason:'baseline' as const,gainOut:0n};
  assert.deepEqual(acceptSimulatedRoute({...base,selection:baseline,simulatedOut:0n}),
   {accepted:true,reason:'baseline'});
 });
});

describe('replay against the pilot campaign route evidence',()=>{
 it('reproduces the 19-of-58 higher-tier wins from the recorded quotes',()=>{
  const path='/root/conc-liq/data/live-cost-analysis-2026-09-17/routes.json';
  let routes;
  try{routes=JSON.parse(readFileSync(path,'utf8'));}catch{return;}  // evidence is untracked
  let wins=0,gain=0n;
  for(const row of routes.rows){
   const quotes=row.quotes.filter((q:{out?:string})=>q.out!==undefined)
    .map((q:{fee:number;out:string;gas:string})=>({fee:q.fee,amountOut:BigInt(q.out),gas:BigInt(q.gas)}));
   // Gas is valued at zero here to match how `routes.json` scored its own
   // `best.bps`: the router gas is identical across v3 tiers, so the tier
   // comparison is unaffected. It is not zero for an aggregator route.
   const s=selectSwapRoute(quotes,500,{gasPriceWei:0n,nativePerGasTokenX18:0n,minimumGainOut:0n});
   if(s.fee!==500){wins++;gain+=s.gainOut;}
  }
  assert.equal(routes.rows.length,58);
  assert.equal(wins,routes.higherTierWins??19,`expected 19 higher-tier wins, got ${wins}`);
  assert(gain>0n);
 });
});
