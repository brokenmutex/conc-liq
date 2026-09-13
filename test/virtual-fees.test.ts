import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sqrtRatioAtTick as sqrt} from '../src/backtest/principal.js';
import {virtualFeeCredit} from '../src/research/virtual-fees.js';
import {modeledFeeGrowth} from '../src/research/portfolio-math.js';
import {ExperimentMarket} from '../src/experiment/market.js';
import type {FeeSegment} from '../src/research/swap.js';

test('virtual whole segments reproduce existing diluted accounting in both directions',()=>{
 for(const token of [0,1] as const)for(const protocol of [0,4,10]){
  const s:FeeSegment={from:sqrt(token===0?20:-20),to:sqrt(token===0?-20:20),tickBefore:token===0?20:-20,liquidity:1000000n,fee:12345n,token,crossed:null};
  const range={tickLower:-20,tickUpper:20},ours=30000n,c=virtualFeeCredit(s,range,ours,protocol);
  assert.equal(c.lower,modeledFeeGrowth(s,range,ours,protocol)*ours);assert.equal(c.upper,c.lower);assert(!c.partial);
 }
});
test('virtual partitions conserve the observed fee within one raw unit per cut',()=>{
 for(const token of [0,1] as const)for(const fee of [1n,29n,1000000000000000000n]){
  const s:FeeSegment={from:sqrt(token===0?100:-100),to:sqrt(token===0?-100:100),tickBefore:token===0?100:-100,liquidity:1000000n,fee,token,crossed:null};
  const ranges=[[-100,-20],[-20,30],[30,100]],cuts=ranges.map(([a,b])=>virtualFeeCredit(s,{tickLower:a!,tickUpper:b!},1000n,4));
  const net=fee-fee/4n,low=cuts.reduce((n,c)=>n+c.allocatedLower,0n),high=cuts.reduce((n,c)=>n+c.allocatedUpper,0n);
  assert(low<=net&&net<=high);assert(high-low<=3n);assert(cuts.every(c=>c.partial&&c.upper>=c.lower));
 }
});
test('virtual fee allocation survives another LP deleting the boundaries without altering the canonical book',()=>{
 const book=new ExperimentMarket({price:String(sqrt(0)),tick:0,liquidity:'1100000',global0:'0',global1:'0',protocol0:0,protocol1:0,
  ticks:[{tick:-100,gross:'1000000',net:'1000000'},{tick:-20,gross:'100000',net:'100000'},{tick:20,gross:'100000',net:'-100000'},{tick:100,gross:'1000000',net:'-1000000'}]});
 book.apply({block:'1',hash:'0x1',tx:0,log:0,name:'Burn',args:{tickLower:-20,tickUpper:20,amount:'100000'}});
 const before=book.seed();assert(!book.sorted.includes(-20));
 const c=virtualFeeCredit({from:sqrt(-40),to:sqrt(40),tickBefore:-40,liquidity:book.liquidity,fee:5000n,token:1,crossed:null},{tickLower:-20,tickUpper:20},1000n,0);
 assert(c.lower>0n&&c.partial);assert.deepEqual(book.seed(),before);
});
test('stationary fees obey the lower-inclusive, upper-exclusive tick convention',()=>{
 for(const tick of [-21,-20,19,20]){
  const c=virtualFeeCredit({from:sqrt(tick),to:sqrt(tick),tickBefore:tick,liquidity:1000n,fee:50n,token:0,crossed:null},{tickLower:-20,tickUpper:20},10n,0);
  assert.equal(c.lower>0n,tick>=-20&&tick<20);
 }
});
