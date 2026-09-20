import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const fixture=JSON.parse(readFileSync('research/fixtures/hybrid-lp-250/competitor-attribution.json','utf8'));
const sum=(values:string[])=>values.reduce((total,value)=>total+BigInt(value),0n);

test('bounded competitor fixture pins the audited population and counterexample swap',()=>{
  const source=readFileSync('data/competitor-cluster-amc-2026-09-04/analysis.json');
  assert.equal(createHash('sha256').update(source).digest('hex'),fixture.sourceAnalysisSha256);
  assert.deepEqual(fixture.aggregate,{cohortPositions:47,fullySettledPositions:35,positionsRetainingLiquidity:12,
    amcSwapTransactionsSeptember4:52,maximumConcurrentNonzeroLiquidity:13});
  assert.equal(fixture.counterexampleSwap.amount1,'1000000000');assert(BigInt(fixture.counterexampleSwap.amount0)<0n);
});

test('partial withdrawal fixture conserves liquidity and uses actual core collection payments',()=>{
  const partial=fixture.partialWithdrawal;
  assert.equal(sum(partial.addedLiquidity)-sum(partial.burnedLiquidity),BigInt(partial.remainingLiquidity));
  assert(BigInt(partial.remainingLiquidity)>0n);assert(partial.firstBurnAt<partial.lastBurnAt);
  assert.equal(partial.lastCoreCollect.actualErc20PaymentsMatched,true);
  assert(BigInt(partial.lastCoreCollect.amount0)>0n&&BigInt(partial.lastCoreCollect.amount1)>0n);
});

test('top-up and midnight fixtures cannot be collapsed into a one-mint same-day close',()=>{
  assert.equal(fixture.topUp.mintCount,fixture.topUp.mintLiquidity.length);assert.equal(fixture.topUp.mintCount,4);
  const span=fixture.midnightSpanningPosition;assert(span.mintedAt.startsWith('2026-09-04'));
  assert(span.fullyWithdrawnAt.startsWith('2026-09-05'));assert.equal(span.remainingLiquidity,'0');
  assert(BigInt(span.lifetimeCenterMarkedQuote)>BigInt(span.september4CenterMarkedQuote));
  assert(BigInt(span.lifetimeFeesRaw[0])>BigInt(span.september4FeesRaw[0]));
  assert.equal(span.finalCoreCollect.actualErc20PaymentsMatched,true);
});

test('compact competitor timeline covers all 52 AMC swap transactions with bounded attribution',()=>{
  const timeline=JSON.parse(readFileSync('research/evidence/hybrid-lp-250-competitor-timeline-2026-09-20.json','utf8'));
  assert.equal(timeline.timeline.length,52);assert.equal(timeline.counts.amcSwapEvents,56);
  assert.equal(new Set(timeline.timeline.map((item:{hash:string})=>item.hash)).size,52);
  for(const item of timeline.timeline){assert(['buy_amc_with_usdg','sell_amc_for_usdg'].includes(item.direction));
    assert(item.routeLegs>=1);assert(item.liveCohort.positions>=0);assert.equal(item.walletBalances.status,'unavailable');}
  assert.equal(timeline.behaviors.length,3);
});
