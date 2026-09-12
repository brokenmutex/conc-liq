import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {authorizePilotPlan,encodePilotPlan} from '../src/live-pilot/chain.js';
import {assertPilotWalletContinuity} from '../src/live-pilot/controller.js';
import {reconcilePilotAction} from '../src/live-pilot/reconcile.js';
import type {PilotAction,PilotSnapshot,PilotState} from '../src/live-pilot/domain.js';
import type {PilotReceipt} from '../src/live-pilot/receipt.js';
type Fixture={state:PilotState;action:PilotAction;receipt:PilotReceipt;after:PilotSnapshot};
const source=JSON.parse(readFileSync(new URL('./fixtures/live-pilot-reconciliation.json',import.meta.url),'utf8'));
function fixture(kind:string):Fixture {
 const f=structuredClone(source.fixtures.find((f:any)=>f.action.plan.kind===kind));assert(f);
 for(const k of ['blockNumber','gasUsed','effectiveGasPrice'])f.receipt[k]=BigInt(f.receipt[k]);return f;
}
for(const kind of ['approve','swap','mint','withdraw'])test(`pilot ${kind}: actual fork receipt and calldata reconcile`,()=>{
 const f=fixture(kind);authorizePilotPlan(f.action.plan,f.state,f.action.before);
 const encoded=encodePilotPlan(f.action.plan,f.state.operator);
 assert.equal(encoded.to.toLowerCase(),f.action.intent.to.toLowerCase());assert.equal(encoded.data,f.action.intent.data);
 assert.equal(reconcilePilotAction(f.state,f.action,f.receipt,f.after).status,'confirmed');
});
test('pilot authorization preserves reserved USDG and restricts spender',()=>{
 const f=fixture('approve'),p=f.action.plan;assert(p.kind==='approve');
 p.amount=f.action.before.usdg;assert.throws(()=>authorizePilotPlan(p,f.state,f.action.before),/managed inventory/);
 p.amount='1';p.spender=f.state.operator;assert.throws(()=>authorizePilotPlan(p,f.state,f.action.before),/spender/);
});
test('pilot authorization rejects weakened swap output, deadline and exit direction',()=>{
 const f=fixture('swap'),p=f.action.plan;assert(p.kind==='swap');
 const minimum=p.minOut;p.minOut='1';assert.throws(()=>authorizePilotPlan(p,f.state,f.action.before),/minimum/);
 p.minOut=minimum;p.deadline=f.action.before.timestamp;assert.throws(()=>authorizePilotPlan(p,f.state,f.action.before),/deadline/);
 p.deadline=String(BigInt(f.action.before.timestamp)+300n);f.state.phase='exit';assert.throws(()=>authorizePilotPlan(p,f.state,f.action.before),/outside/);
});
test('pilot authorization rejects excessive mint width and reduced liquidity withdrawal',()=>{
 const f=fixture('mint'),p=f.action.plan;assert(p.kind==='mint');p.tickUpper+=10;
 assert.throws(()=>authorizePilotPlan(p,f.state,f.action.before));
 const w=fixture('withdraw'),q=w.action.plan;assert(q.kind==='withdraw');q.liquidity=String(BigInt(q.liquidity)-1n);
 assert.throws(()=>authorizePilotPlan(q,w.state,w.action.before));
});
for(const key of ['usdg','nvda','native','nonce','nftCount'] as const)test(`pilot rejects unaccounted ${key} changes`,()=>{
 const f=fixture('swap');if(key==='nonce')f.after.nonce+=1;else f.after[key]=String(BigInt(f.after[key])+1n);
 assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after));
 assert.throws(()=>assertPilotWalletContinuity(f.action.before,f.after));
});
test('pilot rejects wrong hash, wrong NFT owner and excess gas receipt',()=>{
 let f=fixture('mint');f.receipt.transactionHash=`0x${'ab'.repeat(32)}`;assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after),/hash/);
 f=fixture('mint');assert(f.after.position);f.after.position.owner=f.action.intent.to;
 assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after));
 f=fixture('mint');f.receipt.gasUsed=BigInt(f.action.intent.gas)+1n;
 assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after),/gas envelope/);
});
test('pilot reverted receipt charges gas, preserves custody and halts',()=>{
 const f=fixture('swap');f.receipt.status='reverted';f.receipt.logs=[];
 const after={...structuredClone(f.action.before),block:f.after.block,hash:f.after.hash,timestamp:f.after.timestamp,
  nonce:f.action.before.nonce+1,native:String(BigInt(f.action.before.native)-f.receipt.gasUsed*f.receipt.effectiveGasPrice)};
 const result=reconcilePilotAction(f.state,f.action,f.receipt,after);
 assert.equal(result.status,'reverted');assert.equal(result.state.phase,'halted');assert.equal(result.state.last.nvda,f.action.before.nvda);
 assert.equal(BigInt(result.state.gasSpentWei)-BigInt(f.state.gasSpentWei),f.receipt.gasUsed*f.receipt.effectiveGasPrice);
});
test('pilot continuity permits pool movement and protects the owned NFT',()=>{
 const f=fixture('withdraw'),before=f.action.before,after=structuredClone(before);after.tick+=10;after.sqrtPriceX96=String(BigInt(after.sqrtPriceX96)+1n);
 assertPilotWalletContinuity(before,after);assert(after.position);after.position.liquidity='0';
 assert.throws(()=>assertPilotWalletContinuity(before,after),/NFT/);
});

test('pilot publisher is separate and verifies chain and source before sending',async()=>{
 const {PilotChain}=await import('../src/live-pilot/chain.js');
 const {livePilotConfig}=await import('../src/live-pilot/config.js');
 const config=livePilotConfig(JSON.parse(readFileSync(new URL('../config/live-pilot-nvda-250.json',import.meta.url),'utf8')));
 const source=fixture('approve').action.before;let chainId=4663,hash=source.hash,sends=0;
 const publisher={getChainId:async()=>chainId,getBlock:async()=>({hash}),sendRawTransaction:async()=>{sends++;return source.hash;}};
 const chain=new PilotChain({} as never,config,undefined,publisher as never);
 chainId=1;await assert.rejects(()=>chain.broadcast('0x01',source),/chain mismatch/);assert.equal(sends,0);
 chainId=4663;hash=`0x${'ab'.repeat(32)}`;await assert.rejects(()=>chain.broadcast('0x01',source),/source mismatch/);assert.equal(sends,0);
 hash=source.hash;assert.equal(await chain.broadcast('0x01',source),hash);assert.equal(sends,1);
});
