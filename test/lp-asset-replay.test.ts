import assert from 'node:assert/strict';import {test} from 'node:test';
import {AssetReplay} from '../src/research/asset-replay.js';
import {NVDA_PAPER_MARKET} from '../src/paper/market.js';
import type {SwapSource} from '../src/research/swap.js';
const depth=10n**18n,source:SwapSource={price:1n<<96n,tick:0,liquidity:depth,fee:500,spacing:10,ticks:[-1000,-20,20,1000],net:t=>t===-1000?depth:t===1000?-depth:0n};
const costs={entry:100n,recenter:200n,exit:80n,hold:30n};
test('asset replay freezes quotes, waits for a later source and reconciles terminal costs',async()=>{
 const base=new AssetReplay(NVDA_PAPER_MARKET,costs),stress=new AssetReplay(NVDA_PAPER_MARKET,costs,30,2,500000);
 for(const m of [base,stress]){await m.decision(source,0);assert.equal(m.entries,0);assert(m.intent);await m.decision(source,1000);assert.equal(m.entries,0);await m.decision(source,30000);assert.equal(m.entries,1);assert(m.hold);assert.equal(m.gas,costs.entry*BigInt(m.gasMultiplier));}
 const a=base.summary(source),b=stress.summary(source);assert(BigInt(a.terminalCashQuote!)<base.budget);assert.equal(BigInt(a.terminalCashQuote!)-BigInt(b.terminalCashQuote!),costs.entry+costs.exit);
 assert.equal(BigInt(a.netPnlQuote!),BigInt(a.terminalCashQuote!)-base.budget);assert.equal(BigInt(a.alphaQuote!),BigInt(a.terminalCashQuote!)-BigInt(a.holdQuote!));
 const segment={from:source.price,to:source.price,tickBefore:0,liquidity:depth,fee:100000000000000n,token:0 as const,crossed:null};
 base.accrue(segment,0);stress.accrue(segment,0);assert(base.fees0>0n);assert(base.fees0>=stress.fees0*2n&&base.fees0<=stress.fees0*2n+1n);
});
test('asset replay does not promote missing boundary evidence into valid income',async()=>{
 const m=new AssetReplay(NVDA_PAPER_MARKET,costs);await m.decision(source,0);await m.decision(source,30000);
 await m.decision({...source,ticks:[-1000,1000]},60000);assert.equal(m.invalid,'initialized_fee_boundary_lost');
 const empty=new AssetReplay(NVDA_PAPER_MARKET,costs);await empty.decision({...source,ticks:[-1000,1000]},0);assert.equal(empty.entries,0);assert(empty.rejected.boundaries_missing);
});
