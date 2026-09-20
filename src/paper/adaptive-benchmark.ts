import assert from 'node:assert/strict';
import {marketValue,type PaperMarket} from './market.js';

export const ADAPTIVE_BENCHMARK_KIND='fixed_post_entry_inventory_v1' as const;

export interface AdaptivePassiveBenchmark {
 readonly kind:typeof ADAPTIVE_BENCHMARK_KIND;
 readonly amount0:string;
 readonly amount1:string;
 readonly entryCostQuote:string;
 readonly entryAt:number;
 readonly entryBlock:string;
}

interface AdaptiveAction {
 readonly kind?:unknown;
 readonly at?:unknown;
 readonly block?:unknown;
 readonly gasQuote?:unknown;
 readonly afterSwap?:{readonly amount0?:unknown;readonly amount1?:unknown};
}

const decimal=(value:unknown,label:string)=>{
 assert(typeof value==='string'&&/^\d+$/.test(value),`${label} is not an unsigned integer`);
 return value;
};

/** Freeze the strategy's exact post-entry inventory once. Later recenters may
 * change the strategy inventory, but never this passive comparator. */
export function deriveAdaptivePassiveBenchmark(actions:readonly AdaptiveAction[]):AdaptivePassiveBenchmark|null {
 const entry=actions.find(action=>action.kind==='entry');
 if(!entry)return null;
 assert(Number.isSafeInteger(entry.at)&&Number(entry.at)>=0,'Benchmark entry time is invalid');
 const block=decimal(entry.block,'Benchmark entry block');
 const amount0=decimal(entry.afterSwap?.amount0,'Benchmark token0 amount');
 const amount1=decimal(entry.afterSwap?.amount1,'Benchmark token1 amount');
 const entryCostQuote=decimal(entry.gasQuote,'Benchmark entry cost');
 return {kind:ADAPTIVE_BENCHMARK_KIND,amount0,amount1,entryCostQuote,entryAt:Number(entry.at),entryBlock:block};
}

/** Mark the fixed token inventory at the supplied price. The shared entry
 * action cost is charged once, making strategy alpha exactly zero at entry. */
export function valueAdaptivePassiveBenchmark(market:PaperMarket,price:bigint,benchmark:AdaptivePassiveBenchmark|null|undefined):bigint|null {
 if(!benchmark)return null;
 return marketValue(market,price,BigInt(benchmark.amount0),BigInt(benchmark.amount1))-BigInt(benchmark.entryCostQuote);
}
