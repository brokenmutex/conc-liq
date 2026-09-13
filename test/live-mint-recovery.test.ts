import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {encodeErrorResult} from 'viem';
import {proveMintSlippageTrace} from '../src/live-pilot/mint-recovery.js';
import {PilotController} from '../src/live-pilot/controller.js';
import {PilotChain,authorizePilotPlan} from '../src/live-pilot/chain.js';
import {livePilotConfig} from '../src/live-pilot/config.js';
import {policyHash} from '../src/paper/engine.js';
import {reconcilePilotAction} from '../src/live-pilot/reconcile.js';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
const source=JSON.parse(readFileSync(new URL('./fixtures/live-mint-slippage-2026-09-13.json',import.meta.url),'utf8'));
function fixture(){
 const f=structuredClone(source);for(const k of ['blockNumber','gasUsed','effectiveGasPrice'])f.receipt[k]=BigInt(f.receipt[k]);
 const config=livePilotConfig(JSON.parse(readFileSync(new URL('../config/live-pilot-nvda-250.json',import.meta.url),'utf8')));
 config.operator=f.state.operator;f.state.policyHash=policyHash(config.strategy);
 const current={...structuredClone(f.state.last),block:String(BigInt(f.state.last.block)+10n),timestamp:String(BigInt(f.state.last.timestamp)+1n)};
 const saved:any[]=[],marks:any[]=[],queries:string[]=[],plans:any[]=[];
 const store={locked:async(_a:any,fn:any)=>fn({query:async(q:string)=>queries.push(q)}),current:async()=>({state:f.state}),pending:async()=>null,
  action:async()=>f.action,save:async(_db:any,s:any,reason:string)=>{saved.push({state:structuredClone(s),reason});f.state=structuredClone(s);},mark:async(...args:any[])=>marks.push(args),monitor:async()=>{}};
 const client={getTransactionReceipt:async()=>f.receipt,getBlock:async()=>({hash:f.state.last.hash}),getTransactionCount:async()=>current.nonce,
  request:async()=>f.trace};
 const chain=new PilotChain(client as never,config);chain.snapshot=async()=>current;chain.verify=async()=>{};
 chain.quote=async()=>{throw Error('Must not repeat swap');};
 chain.envelope=async(s,p,plan)=>{authorizePilotPlan(plan,s,p);plans.push(plan);return {} as never;};
 const guard={source:current,entryAllowed:true,reasons:[],referencePriceX18:'218308719020719623549',holding:undefined};
 const controller=new PilotController(store as never,chain,config,{address:f.state.operator} as never,async()=>guard);
 return {f,current,config,store,chain,client,guard,controller,saved,marks,queries,plans};
}
test('actual live trace proves the failed token minimum, rather than guessing from receipt status',()=>{
 const p=proveMintSlippageTrace(source.action,source.trace);assert.equal(p.amount0,'81237381');assert.equal(p.min0,'104411675');assert.equal(p.hash,source.action.hash);
});
for(const fault of ['swap','successful','different_input','different_sender','different_manager','different_error','nested_error','missing_pool'] as const)
 test(`mint classification rejects ${fault}`,()=>{
  const f=structuredClone(source);
  if(fault==='swap')f.action.plan.kind='swap';
  if(fault==='successful')delete f.trace.error;
  if(fault==='different_input')f.trace.input='0x00';
  if(fault==='different_sender')f.trace.from=f.trace.to;
  if(fault==='different_manager')f.trace.to=f.trace.from;
  if(fault==='different_error')f.trace.output=encodeErrorResult({abi:[{type:'error',name:'Error',inputs:[{name:'message',type:'string'}]}],errorName:'Error',args:['Transaction too old']});
  if(fault==='nested_error')f.trace.calls[0].error='execution reverted';
  if(fault==='missing_pool')f.trace.calls=[];
  assert.throws(()=>proveMintSlippageTrace(f.action,f.trace));
 });
test('recovery preserves cash, gas, swap completion and campaign; journals proof atomically',async()=>{
 const x=fixture(),before=structuredClone(x.f.state),next=await x.controller.recoverMint();
 assert.equal(next.phase,'recenter');assert.equal(next.haltReason,undefined);assert.equal(next.swapDone,true);assert.equal(next.mintRecovery?.attempts,1);
 for(const k of ['id','reserveUsdg','initialCapitalQuote','gasSpentWei','gasSpentQuote','collectedFee0','collectedFee1','externalNativeCreditsWei'])assert.deepEqual(next[k as keyof typeof next],before[k]);
 assert.equal(x.plans.length,1);assert.equal(x.plans[0].kind,'mint');assert.notEqual(x.plans[0].min0,x.f.action.plan.min0);
 assert.deepEqual(x.queries,['BEGIN','COMMIT']);assert.equal(x.marks[0][3],'mint_recovery');
 await assert.rejects(()=>x.controller.recoverMint(),/halt/);assert.equal(x.saved.length,1);
});
test('automatic tick recovers once and yields to normal fresh planning/signing',async()=>{
 const x=fixture();assert.deepEqual(await x.controller.tick(),{phase:'mint_requote',attempt:1});assert.equal(x.saved.length,1);
});
for(const fault of ['pending','nonce','tokens','native','nft','allowance','reorg','receipt','admission','reference','stopped','policy','limit','advanced_state'] as const)
 test(`mint recovery retains halt for ${fault}`,async()=>{
  const x=fixture();
  if(fault==='pending')x.store.pending=async()=>({}) as never;
  if(fault==='nonce')x.client.getTransactionCount=async()=>x.current.nonce+1;
  if(fault==='tokens')x.current.nvda=String(BigInt(x.current.nvda)+1n);
  if(fault==='native')x.current.native=String(BigInt(x.current.native)+1n);
  if(fault==='nft')x.current.nftCount='10';
  if(fault==='allowance')x.current.allowances[0].amount='0';
  if(fault==='reorg')x.client.getBlock=async()=>({hash:'0x00'});
  if(fault==='receipt')x.f.receipt.status='success';
  if(fault==='admission')x.guard.entryAllowed=false;
  if(fault==='reference')x.guard.referencePriceX18='1000000000000000000';
  if(fault==='stopped')x.f.state.desired='stopped';
  if(fault==='policy')x.f.state.policyHash='changed';
  if(fault==='limit')x.f.state.mintRecovery={attempts:3,lastActionId:'previous',phase:'recenter'};
  if(fault==='advanced_state')x.f.state.last={...x.f.state.last,block:x.current.block};
  await assert.rejects(()=>x.controller.recoverMint());assert.equal(x.saved.length,0);assert.equal(x.f.state.phase,'halted');
 });
test('a crossed retry range is recentered using retained inventory without another swap',async()=>{
 const x=fixture();x.current.tick=x.f.state.range.tickUpper+5;x.current.sqrtPriceX96=String(sqrtRatioAtTick(x.current.tick));
 const next=await x.controller.recoverMint();assert.equal(next.swapDone,true);assert(next.range&&next.range.tickUpper>x.current.tick);
 assert.equal(x.plans[0].kind,'mint');assert.equal(x.plans[0].tickUpper-x.plans[0].tickLower,40);
});
test('retry may not authorize a second swap even if a plan is accidentally supplied',()=>{
 const f=JSON.parse(readFileSync(new URL('./fixtures/live-pilot-reconciliation.json',import.meta.url),'utf8')).fixtures.find((x:any)=>x.action.plan.kind==='swap');
 f.state.mintRecovery={attempts:1,lastActionId:'failed',phase:'recenter'};
 assert.throws(()=>authorizePilotPlan(f.action.plan,f.state,f.action.before),/repeat/);
});
test('only successful mint reconciliation clears the retry counter',()=>{
 const f=JSON.parse(readFileSync(new URL('./fixtures/live-pilot-reconciliation.json',import.meta.url),'utf8')).fixtures.find((x:any)=>x.action.plan.kind==='mint');
 for(const k of ['blockNumber','gasUsed','effectiveGasPrice'])f.receipt[k]=BigInt(f.receipt[k]);
 f.state.mintRecovery={attempts:2,lastActionId:'failed',phase:'recenter'};
 assert.equal(reconcilePilotAction(f.state,f.action,f.receipt,f.after).state.mintRecovery,undefined);
});
