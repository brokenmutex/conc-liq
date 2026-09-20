import assert from 'node:assert/strict';
import type {AdaptivePassiveBenchmark} from './adaptive-benchmark.js';
import {namedBalances,type PaperMarket} from './market.js';
import type {PaperReferenceDecision} from './reference.js';

export interface AdaptiveReferenceValuation {
 readonly eligible:boolean;
 readonly basis:PaperReferenceDecision['basis'];
 readonly priceX18:string|null;
 readonly updatedAt:string|null;
 readonly sourceBlock:string;
 readonly ageSeconds:number|null;
 readonly reasons:readonly string[];
 readonly navQuote:string|null;
 readonly holdQuote:string|null;
 readonly alphaQuote:string|null;
}

/** Value raw RWA and quote balances with a quote-per-RWA X18 mark. Output is
 * raw six-decimal USDG. Pool spot is not consulted. */
export function valueAtIndependentReference(market:PaperMarket,priceX18:bigint,amount0:bigint,amount1:bigint):bigint {
 assert(priceX18>0n,'Independent reference price must be positive');
 const balances=namedBalances(market,amount0,amount1);
 return balances.quote+balances.rwa*priceX18/10n**BigInt(market.rwaDecimals+12);
}

export function adaptiveReferenceValuation(input:{
 readonly market:PaperMarket;
 readonly decision:PaperReferenceDecision|null;
 readonly amount0:bigint;
 readonly amount1:bigint;
 readonly costsPaidQuote:bigint;
 readonly benchmark?:AdaptivePassiveBenchmark;
}):AdaptiveReferenceValuation|null {
 const {decision}=input;if(!decision)return null;
 const base={eligible:decision.eligible,basis:decision.basis,priceX18:decision.referencePriceX18,
  updatedAt:decision.referenceUpdatedAt,sourceBlock:decision.sourceBlock,ageSeconds:decision.ageSeconds,reasons:decision.reasons};
 if(!decision.eligible)return {...base,navQuote:null,holdQuote:null,alphaQuote:null};
 assert(decision.referencePriceX18!==null,'Eligible independent reference has no price');
 const price=BigInt(decision.referencePriceX18);
 const nav=valueAtIndependentReference(input.market,price,input.amount0,input.amount1)-input.costsPaidQuote;
 let hold:null|bigint=null;
 if(input.benchmark)hold=valueAtIndependentReference(input.market,price,BigInt(input.benchmark.amount0),BigInt(input.benchmark.amount1))-BigInt(input.benchmark.entryCostQuote);
 return {...base,navQuote:String(nav),holdQuote:hold===null?null:String(hold),alphaQuote:hold===null?null:String(nav-hold)};
}
