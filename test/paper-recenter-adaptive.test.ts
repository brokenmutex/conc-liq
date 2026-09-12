import assert from 'node:assert/strict';import {test} from 'node:test';import {readFileSync} from 'node:fs';
import {executionRecenterPlan,solveRecenterSwap,assertRecenterPrice,type PaperRecenterQuote} from '../src/paper/execution-recenter.js';
import {paperEntryRange} from '../src/paper/engine.js';import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {historicalSwapQuote} from '../src/research/portfolio-math.js';import {replayPaperMint} from '../src/research/management-audit.js';
const seed=JSON.parse(readFileSync(new URL('./fixtures/inventory-recenter-fork.json',import.meta.url),'utf8')).seed;
const net=new Map<number,bigint>(seed.ticks.map((t:any)=>[t.tick,BigInt(t.net)]));
const market={fee:500,spacing:10,price:BigInt(seed.price),tick:seed.tick,liquidity:BigInt(seed.liquidity),ticks:[...net.keys()].sort((a,b)=>a-b),net:(t:number)=>net.get(t)??0n};
const quote=(m:typeof market)=>async(amount:bigint,token:0|1)=>{const q=historicalSwapQuote(m,amount,token);assert(q.fullyFilled);return {amountOut:q.amountOut,price:q.sqrtPriceAfter};};
for(const token of [0,1] as const)test(`adaptive ${token===0?'buy':'sell'} deploys inventory after a three-tick move without weakening exchange-rate limits`,async()=>{
 const cash=token===0?5000000000n:0n,rwa=token===1?20n*10n**18n:0n;
 const range=paperEntryRange({tick:seed.tick,sqrtPriceX96:seed.price},{halfWidthSpacings:2});
 const plan=await solveRecenterSwap(market.price,range,cash,rwa,quote(market));assert.equal(plan.token,token);
 const mint=replayPaperMint(plan.price,range,cash+(token===0?-plan.amount:plan.amountOut),rwa+(token===1?-plan.amount:plan.amountOut),0n);
 const min=(n:bigint)=>String(n*9950n/10000n);
 const intent:PaperRecenterQuote={kind:'outside_range_v1',sourceBlock:'1',sourceHash:'0x1',quotedAt:'2026-09-12T00:00:00Z',oldRange:{...range,liquidity:'1'},...range,
 token,amountIn:String(plan.amount),minOut:min(plan.amountOut),minMint0:min(mint.amount0),minMint1:min(mint.amount1),adaptive:{kind:'bounded_net_swap_v1',referenceSqrtPriceX96:seed.price,maxAmountIn:String(token===0?cash:rwa)}};
 const moved={...market,tick:seed.tick+3,price:sqrtRatioAtTick(seed.tick+3)};
 const fresh=await executionRecenterPlan(moved.price,cash,rwa,intent,50,quote(moved));assert.notEqual(fresh.amountIn,intent.amountIn);
 assert(BigInt(fresh.minOut)*BigInt(intent.amountIn)>=BigInt(fresh.amountIn)*BigInt(intent.minOut));
 const fill=await quote(moved)(BigInt(fresh.amountIn),token);
 const after=replayPaperMint(fill.price,range,cash+(token===0?-BigInt(fresh.amountIn):fill.amountOut),rwa+(token===1?-BigInt(fresh.amountIn):fill.amountOut),0n);
 assert(after.amount0>=BigInt(fresh.minMint0)&&after.amount1>=BigInt(fresh.minMint1));
 assert(after.idle0<=10n&&after.idle1<=10n**11n,`Only integer dust remains: ${after.idle0}, ${after.idle1}`);
 const oldFill=await quote(moved)(BigInt(intent.amountIn),token);
 const oldMint=replayPaperMint(oldFill.price,range,cash+(token===0?-BigInt(intent.amountIn):oldFill.amountOut),rwa+(token===1?-BigInt(intent.amountIn):oldFill.amountOut),0n);
 assert(oldMint.amount0<BigInt(intent.minMint0)||oldMint.amount1<BigInt(intent.minMint1),'Old frozen mint rejected the changed token ratio');
 await assert.rejects(()=>executionRecenterPlan(moved.price,cash,rwa,{...intent,adaptive:{...intent.adaptive!,maxAmountIn:'1'}},50,quote(moved)),/inventory budget/);
 await assert.rejects(()=>executionRecenterPlan(moved.price,cash,rwa,{...intent,minOut:String(BigInt(intent.minOut)*2n)},50,quote(moved)),/swap minimum/);
 const legacy={...intent};delete legacy.adaptive;assert.equal(await executionRecenterPlan(moved.price,cash,rwa,legacy,50,quote(moved)),legacy);
});
test('frozen price bounds reject excessive price moves in either direction',()=>{
 const price=sqrtRatioAtTick(222400);assertRecenterPrice(price,price,50);
 for(const t of [222349,222451])assert.throws(()=>assertRecenterPrice(sqrtRatioAtTick(t),price,50),/slippage band/);
});
