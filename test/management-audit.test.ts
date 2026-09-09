import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {paperSegmentCredit,replayPaperMint,referenceExposure} from '../src/research/management-audit.js';
import type {FeeSegment} from '../src/research/swap.js';

test('replay mint matches recorded position-manager fills in sessions 28 and 29',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/management-replay-cycles.json',import.meta.url),'utf8'));
 for(const c of fixture.cases){
  const result=replayPaperMint(BigInt(c.price),c.range,BigInt(c.cash),BigInt(c.rwa),BigInt(c.reserve));
  assert.deepEqual(Object.fromEntries(Object.entries(result).map(([k,v])=>[k,String(v)])),c.expected);
 }
});

test('fee replay carries fractions, excludes the upper boundary, and rejects unsplit crossings',()=>{
 const range={tickLower:0,tickUpper:10},Q128=1n<<128n;
 const segment:FeeSegment={from:sqrtRatioAtTick(0),to:sqrtRatioAtTick(10),tickBefore:0,liquidity:2n,fee:5n,token:0,crossed:10};
 const credit=paperSegmentCredit(segment,range,1n,0);
 assert.equal(credit/Q128,2n);assert.equal((credit+credit)/Q128,5n);
 assert.equal(paperSegmentCredit({...segment,from:segment.to,tickBefore:10},range,1n,0),0n);
 assert.throws(()=>paperSegmentCredit({...segment,from:sqrtRatioAtTick(-10),tickBefore:-10},range,1n,0),/Partial fee segment/);
 assert.equal(paperSegmentCredit({...segment,fee:100n,liquidity:10n},range,2n,10)/Q128,18n);
});

test('inventory exposure values both idle assets and deductions; insolvency fails closed',()=>{
 const reference=200n*10n**18n,rwa=3n*10n**18n;
 assert.equal(referenceExposure(400000000n,rwa,reference,0n),600000n);
 assert(referenceExposure(400000000n,rwa,reference,1000000n)>600000n);
 assert.equal(referenceExposure(0n,0n,reference,1n),1000000n);
});
