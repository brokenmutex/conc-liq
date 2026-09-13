import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {historicalSwapQuote} from '../src/research/portfolio-math.ts';
import {sqrtRatioAtTick} from '../src/backtest/principal.ts';
import {ExperimentMarket} from '../src/experiment/market.ts';
const original=await import(new URL('../src/research/portfolio-math.ts?unoptimized_quote=1',import.meta.url).href);
assert(!original.historicalSwapQuote.toString().includes('ticks.length'));
assert(historicalSwapQuote.toString().includes('ticks.length'));
const root=process.argv[2]??'data/adaptive-lp-universe-study-2026-09-13/memo-validation';mkdirSync(root,{recursive:true});
let state=0x94ac8372;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};let compared=0,empty=0,partial=0,diagnosticDifferences=0;const started=Date.now();
function compare(source,amount,token,slippage=50){let a,b,ea,eb;try{a=original.historicalSwapQuote(source,amount,token,slippage);}catch(e){ea=[e.constructor.name,e.code??null,e.message];}try{b=historicalSwapQuote(source,amount,token,slippage);}catch(e){eb=[e.constructor.name,e.code??null,e.message];}assert.deepEqual(eb?.slice(0,2),ea?.slice(0,2));if(ea&&eb&&ea[2]!==eb[2]){assert(amount<0n,'Unexpected diagnostic difference for valid quote input');diagnosticDifferences++;}assert.deepEqual(b,a);compared++;if(source.liquidity===0n)empty++;if(a&&!a.fullyFilled&&a.amountOut>0n)partial++;}
for(let i=0;i<10000;i++){
 const center=(random()%140000-70000)*10,net=new Map(),positions=random()%8;
 for(let j=0;j<positions;j++){const lo=center+(random()%201-100)*10,hi=lo+(random()%100+1)*10,L=(BigInt(random())+1n)*10n**BigInt(random()%12);net.set(lo,(net.get(lo)??0n)+L);net.set(hi,(net.get(hi)??0n)-L);}
 const tick=center+(random()%4001-2000),ticks=[...net.keys()].sort((a,b)=>a-b),liquidity=ticks.filter(t=>t<=tick).reduce((n,t)=>n+net.get(t),0n),source={price:sqrtRatioAtTick(tick),tick,liquidity,fee:500,spacing:10,ticks,net:t=>net.get(t)??0n};
 for(const token of [0,1])compare(source,1n<<BigInt(random()%105),token,[0,50,1000][random()%3]);
}
const meta=JSON.parse(readFileSync('data/adaptive-lp-universe-study-2026-09-13/capture.json'));
for(const asset of meta.assets){const source=new ExperimentMarket(asset.seed).source();for(const token of [0,1])for(const amount of [0n,1n,1000000n,10n**18n,10n**30n])compare(source,amount,token);}
for(const fee of [500,3000])for(const spacing of [10,60]){const source={price:sqrtRatioAtTick(0),tick:0,liquidity:0n,fee,spacing,ticks:[],net:()=>0n};for(const token of [0,1]){compare(source,1000000n,token);compare(source,-1n,token);}}
const dense={price:sqrtRatioAtTick(0),tick:0,liquidity:0n,fee:500,spacing:10,ticks:Array.from({length:10000},(_,i)=>(i-5000)*10),net:()=>0n};for(const token of [0,1])compare(dense,100n,token);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),result={compared,emptyInitialLiquidity:empty,partialQuotes:partial,randomSeed:'94ac8372',fullResultAndErrorTypeCodeEquality:true,invalidInputDiagnosticDifferences:diagnosticDifferences,diagnosticScope:'Native TypeScript loading can change Node default assertion source excerpts for invalid negative amounts; valid quote results and explicit errors are compared exactly.',sourceSha256:hash('src/research/portfolio-math.ts'),hookSha256:hash('scripts/lp-empty-quote-hook.mjs'),verifierSha256:hash('scripts/verify-lp-empty-quote.mjs'),elapsedMs:Date.now()-started,
 equivalenceArgument:'With zero liquidity and no next initialized tick, every remaining bitmap word consumes zero input and earns zero output or fees. Jumping to the same canonical price limit preserves all return fields. The shortcut is restricted to fee 500, spacing 10 and fewer than 10000 ticks, so skipping fewer than 700 empty words cannot change the original 20000-step guard outcome for a valid ordered book.'};
writeFileSync(root+'/quote-conformance.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
