import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {ExperimentMarket} from '../src/experiment/market.js';
import {balancedRecenterPlan,filledRecenter,inventoryBalances,trimPlan,filledTrim,type InventoryBook} from '../src/research/inventory-management.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/inventory-recenter-fork.json',import.meta.url),'utf8'));
const market=new ExperimentMarket(fixture.seed).source();
const stringify=(v:unknown)=>JSON.parse(JSON.stringify(v,(_,v)=>typeof v==='bigint'?String(v):v));
const cost={remove:491842n,mint:1065129n,sell:475109n,buy:475109n};
test('balanced and inventory-preserving plans match separately executed fork swaps, mint amounts and idle balances',()=>{
 for(const c of fixture.cases){
  const b=c.balances.afterCollect,plan=balancedRecenterPlan(market,BigInt(b.quote),BigInt(b.rwa),20,800000,c.action==='preserve');
  assert.deepEqual(stringify(plan),c.plan);
  assert.equal(String(plan.mint.liquidity),c.position.liquidity);
  assert.equal(String(plan.mint.idle0),c.balances.after.quote);
  assert.equal(String(plan.mint.idle1),c.balances.after.rwa);
 }
});
test('no-swap relocation retains total NVDA; surplus idle NVDA still counts',()=>{
 const c=fixture.cases.find((c:{action:string})=>c.action==='preserve'),p=c.plan;
 const after:InventoryBook={cash:BigInt(p.mint.idle0),rwa:BigInt(p.mint.idle1),gas:0n,position:{...p.range,liquidity:BigInt(p.mint.liquidity),fee0:0n,fee1:0n}};
 const balances=inventoryBalances(after,market);
 assert(BigInt(c.balances.afterCollect.rwa)-balances.amount1<=1n);
 assert(after.rwa>10n**18n);
});
test('delayed recenter failure is atomic and cannot silently relax frozen mint minimums',()=>{
 const c=fixture.cases[0],b=c.balances.afterCollect,plan=balancedRecenterPlan(market,BigInt(b.quote),BigInt(b.rwa));
 const before:InventoryBook={cash:BigInt(b.quote),rwa:BigInt(b.rwa),gas:260684n,position:null},saved=structuredClone(before);
 const filled=filledRecenter(before,market,plan,cost);
 assert.equal(filled.book.gas-before.gas,cost.remove+cost.mint+cost.sell);
 assert.deepEqual(before,saved);
 assert.throws(()=>filledRecenter(before,market,{...plan,mint:{...plan.mint,amount0:plan.mint.amount0*2n}},cost),/Frozen mint minimum/);
 assert.deepEqual(before,saved);
 assert.throws(()=>filledRecenter({...before,rwa:0n},market,plan,cost),/Frozen swap funding/);
});
test('buy and sell plans conserve exact token inputs and protect reserve; absent boundaries fail',()=>{
 for(const [cash,rwa,token] of [[900000000n,1n*10n**17n,0],[300000000n,3n*10n**18n,1]] as const){
  const p=balancedRecenterPlan(market,cash,rwa);assert.equal(p.token,token);assert(p.swap);
  assert.equal(p.mint.amount0+p.mint.idle0,cash+(token===1?p.swap.amountOut:-p.amount));
  assert.equal(p.mint.amount1+p.mint.idle1,rwa+(token===0?p.swap.amountOut:-p.amount));
  assert(p.mint.idle0>=p.reserve);
 }
 assert.throws(()=>balancedRecenterPlan({...market,ticks:[]},500000000n,2n*10n**18n),/boundaries/);
 assert.throws(()=>balancedRecenterPlan(market,0n,2n*10n**18n,20,800000,true),/reserve/);
});

test('partial trim matches the separately executed fork including retained LP depth',()=>{
 const c=fixture.trim,i=c.inventory;
 const before:InventoryBook={cash:BigInt(i.idle0),rwa:BigInt(i.idle1),gas:0n,position:{tickLower:i.tickLower,tickUpper:i.tickUpper,liquidity:BigInt(i.liquidity),fee0:BigInt(i.fee0)*(1n<<128n),fee1:BigInt(i.fee1)*(1n<<128n)}};
 const plan=trimPlan(before,market),fill=filledTrim(before,market,plan,BigInt(c.gasQuote));
 assert.equal(String(plan.burned),c.burnedLiquidity);
 assert.equal(String(fill.book.position.liquidity),c.remainingLiquidity);
 assert.equal(String(fill.price),c.priceAfter);
 assert.equal(String(fill.book.cash),c.balances.after.quote);
 assert.equal(String(fill.book.rwa),c.balances.after.rwa);
 assert.equal(String(fill.quote.amountOut),c.trade.actualOut);
 const saved=structuredClone(before);
 assert.throws(()=>filledTrim(before,market,{...plan,amount:plan.amount*10n},0n),/Frozen trim funding/);
 assert.deepEqual(before,saved);
});
