import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {deriveAdaptivePassiveBenchmark,valueAdaptivePassiveBenchmark,ADAPTIVE_BENCHMARK_KIND} from '../src/paper/adaptive-benchmark.js';
import {marketValue,NVDA_PAPER_MARKET} from '../src/paper/market.js';

test('adaptive passive benchmark freezes post-entry inventory and charges entry once',()=>{
 const actions=[{kind:'entry',at:1000,block:'42',gasQuote:'125',afterSwap:{amount0:'900000000',amount1:'400000000000000000'}},
  {kind:'recenter',at:2000,block:'43',gasQuote:'250',afterSwap:{amount0:'1',amount1:'2'}}];
 const benchmark=deriveAdaptivePassiveBenchmark(actions);assert(benchmark);
 assert.deepEqual(benchmark,{kind:ADAPTIVE_BENCHMARK_KIND,amount0:'900000000',amount1:'400000000000000000',entryCostQuote:'125',entryAt:1000,entryBlock:'42'});
 const price=sqrtRatioAtTick(222600);
 assert.equal(valueAdaptivePassiveBenchmark(NVDA_PAPER_MARKET,price,benchmark),marketValue(NVDA_PAPER_MARKET,price,900000000n,400000000000000000n)-125n);
 assert.equal(valueAdaptivePassiveBenchmark(NVDA_PAPER_MARKET,price,null),null);
});

test('adaptive passive benchmark is unavailable before entry and rejects malformed evidence',()=>{
 assert.equal(deriveAdaptivePassiveBenchmark([{kind:'recenter'}]),null);
 assert.throws(()=>deriveAdaptivePassiveBenchmark([{kind:'entry',at:1,block:'x',gasQuote:'1',afterSwap:{amount0:'1',amount1:'2'}}]),/entry block/);
});
