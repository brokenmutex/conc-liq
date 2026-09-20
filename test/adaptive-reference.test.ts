import assert from 'node:assert/strict';
import {test} from 'node:test';
import {adaptiveReferenceValuation,valueAtIndependentReference} from '../src/paper/adaptive-reference.js';
import {ADAPTIVE_BENCHMARK_KIND} from '../src/paper/adaptive-benchmark.js';
import {canonicalBalances,NVDA_PAPER_MARKET} from '../src/paper/market.js';
import type {PaperReferenceDecision} from '../src/paper/reference.js';

const decision=(eligible=true):PaperReferenceDecision=>({eligible,reasons:eligible?[]:['paper_reference_band_exceeded'],basis:eligible?'heartbeat_valid':'unavailable',ageSeconds:10,
 referencePriceX18:eligible?'250000000000000000000':null,poolPriceX18:'251000000000000000000',deviationPpm:eligible?'4000':null,
 referenceUpdatedAt:'2026-09-20T12:00:00.000Z',sourceBlock:'100',maxAgeSeconds:86400,maxDeviationPpm:50000});

test('independent reference values strategy and the same fixed-token comparator separately from pool spot',()=>{
 const balances=canonicalBalances(NVDA_PAPER_MARKET,500000000n,2n*10n**18n);
 assert.equal(valueAtIndependentReference(NVDA_PAPER_MARKET,250n*10n**18n,balances.amount0,balances.amount1),1000000000n);
 const result=adaptiveReferenceValuation({market:NVDA_PAPER_MARKET,decision:decision(),...balances,costsPaidQuote:2000000n,
  benchmark:{kind:ADAPTIVE_BENCHMARK_KIND,amount0:String(balances.amount0),amount1:String(balances.amount1),entryCostQuote:'1000000',entryAt:1,entryBlock:'1'}});
 assert(result);assert.equal(result.navQuote,'998000000');assert.equal(result.holdQuote,'999000000');assert.equal(result.alphaQuote,'-1000000');
});

test('unavailable independent reference preserves reasons without manufacturing values',()=>{
 const result=adaptiveReferenceValuation({market:NVDA_PAPER_MARKET,decision:decision(false),amount0:1n,amount1:2n,costsPaidQuote:0n});
 assert(result);assert.equal(result.eligible,false);assert.equal(result.navQuote,null);assert.equal(result.holdQuote,null);assert.equal(result.alphaQuote,null);
});
