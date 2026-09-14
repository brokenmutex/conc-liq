import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {getAddress} from 'viem';
import {USDG,NONFUNGIBLE_POSITION_MANAGER} from '../src/constants.js';
import {PAPER_NVDA} from '../src/paper/engine.js';
import {PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {livePilotConfig} from '../src/live-pilot/config.js';
import {PilotChain,authorizePilotPlan} from '../src/live-pilot/chain.js';
import {reconcilePilotAction} from '../src/live-pilot/reconcile.js';
import type {AllowancePolicy} from '../src/execution/allowance-policy.js';
const raw=JSON.parse(readFileSync('config/live-pilot-nvda-250.json','utf8'));
const source=JSON.parse(readFileSync('test/fixtures/live-pilot-reconciliation.json','utf8'));
const policy:Extract<AllowancePolicy,{kind:'persistent_finite_v1'}>={kind:'persistent_finite_v1',grants:[USDG,getAddress(PAPER_NVDA)].flatMap(token=>[PAPER_ROUTER,NONFUNGIBLE_POSITION_MANAGER].map(spender=>({token,spender,amountRaw:token===USDG?'2500000000':'10000000000000000000'})))};
const config=()=>livePilotConfig({...raw,execution:{...raw.execution,allowancePolicy:policy}});
function fixture(kind:string){const f=structuredClone(source.fixtures.find((x:any)=>x.action.plan.kind===kind));for(const k of ['blockNumber','gasUsed','effectiveGasPrice'])f.receipt[k]=BigInt(f.receipt[k]);return f;}
test('pilot adapter accepts complete finite budgets and rejects another stock or spender',()=>{
 assert.deepEqual(config().execution.allowancePolicy,policy);
 assert.throws(()=>livePilotConfig({...raw,execution:{...raw.execution,allowancePolicy:{...policy,grants:policy.grants.slice(1)}}}),/verified/);
 assert.throws(()=>livePilotConfig({...raw,execution:{...raw.execution,allowancePolicy:{...policy,grants:policy.grants.map(g=>({...g,token:PAPER_ROUTER}))}}}));
});
test('finite grant authorization is persisted, exact-budgeted and cannot enlarge actual swap funding',()=>{
 const f=fixture('approve');f.state.allowancePolicy=policy;
 f.action.plan.amount='2500000000';authorizePilotPlan(f.action.plan,f.state,f.action.before);
 f.action.plan.amount='2500000001';assert.throws(()=>authorizePilotPlan(f.action.plan,f.state,f.action.before),/finite budget/);
 const swap=fixture('swap');swap.state.allowancePolicy=policy;swap.action.plan.amountIn=swap.action.before.usdg;
 assert.throws(()=>authorizePilotPlan(swap.action.plan,swap.state,swap.action.before));
});
for(const kind of ['swap','mint'])test(`finite allowances reconcile ${kind} receipt subtraction and reject an unexplained remainder`,()=>{
 const f=fixture(kind);f.state.allowancePolicy=policy;
 for(const old of f.action.before.allowances){const after=f.after.allowances.find((a:any)=>a.token===old.token&&a.spender===old.spender);
  old.amount=String(BigInt(old.amount)+100000000000000000000n);after.amount=String(BigInt(after.amount)+100000000000000000000n);}
 assert.equal(reconcilePilotAction(f.state,f.action,f.receipt,f.after).status,'confirmed');
 f.after.allowances[0].amount=String(BigInt(f.after.allowances[0].amount)+1n);assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after),/allowance/);
});
test('planner uses persisted budgets, skips adequate permissions, and blocks config changes',async()=>{
 const f=fixture('mint'),chain=new PilotChain({} as never,config());f.state.allowancePolicy=policy;f.state.swapDone=true;f.state.phase='recenter';f.state.range={tickLower:f.action.plan.tickLower,tickUpper:f.action.plan.tickUpper};
 const snapshot=structuredClone(f.action.before);for(const a of snapshot.allowances)a.amount='0';
 let p=await chain.plan(f.state,snapshot);assert(p?.kind==='approve');assert.equal(p.amount,'2500000000');
 for(const a of snapshot.allowances)a.amount=policy.grants.find(g=>g.token.toLowerCase()===a.token.toLowerCase()&&g.spender.toLowerCase()===a.spender.toLowerCase())!.amountRaw;
 p=await chain.plan(f.state,snapshot);assert.equal(p?.kind,'mint');
 delete f.state.allowancePolicy;await assert.rejects(()=>chain.plan(f.state,snapshot),/saved campaign/);
});
test('exit approval covers actual inventory even above a persistent budget, then clears every remainder',async()=>{
 const f=fixture('approve'),chain=new PilotChain({} as never,config());f.state.allowancePolicy=policy;f.state.phase='exit';
 const s=structuredClone(f.action.before);s.position=null;s.nvda='11000000000000000000';for(const a of s.allowances)a.amount='0';
 chain.quote=async()=>({amountOut:100n,price:1n});
 const p=await chain.plan(f.state,s);assert(p?.kind==='approve');assert.equal(p.amount,s.nvda);authorizePilotPlan(p,f.state,s);
 s.nvda='0';for(const a of s.allowances)a.amount='100';
 for(let i=0;i<4;i++){const revoke=await chain.plan(f.state,s);assert(revoke?.kind==='approve'&&revoke.amount==='0');authorizePilotPlan(revoke,f.state,s);s.allowances.find((a:any)=>a.token===revoke.token&&a.spender===revoke.spender)!.amount='0';}
 assert.equal(await chain.plan(f.state,s),null);
});

import {PilotController} from '../src/live-pilot/controller.js';
import {policyHash} from '../src/paper/engine.js';
function adoptionFixture(){
 const f=fixture('approve'),c=config();c.operator=f.state.operator;
 const state={...f.state,phase:'closed',desired:'stopped',tokenId:null,last:structuredClone(f.action.before),policyHash:policyHash(c.strategy)};
 const current=structuredClone(state.last);current.position=null;
 const queries:string[]=[],saved:any[]=[];
 const db={query:async(q:string)=>{queries.push(q);return {rowCount:1};}};
 const store={schema:'test_only',locked:async(_o:any,fn:any)=>fn(db),current:async()=>({state}),pending:async()=>null,save:async(_d:any,s:any,reason:string)=>saved.push({s,reason})};
 const chain={client:{getBlock:async()=>({hash:state.last.hash}),getTransactionCount:async()=>current.nonce},verify:async()=>{},snapshot:async()=>current};
 const controller=new PilotController(store as never,chain as never,c,{address:state.operator} as never,async()=>({source:current,entryAllowed:true,reasons:[],referencePriceX18:null}));
 return {state,current,queries,saved,store,chain,controller};
}
test('closed policy adoption journals config atomically without signing, moving custody or resetting accounting',async()=>{
 const x=adoptionFixture(),before=structuredClone(x.state),next=await x.controller.adoptAllowancePolicy();
 assert.equal(next.allowancePolicy?.kind,'persistent_finite_v1');assert.equal(x.saved.length,1);
 for(const key of ['id','gasSpentWei','gasSpentQuote','collectedFee0','collectedFee1','reserveUsdg','retiredTokenIds'])assert.deepEqual((next as any)[key],before[key]);
 assert.equal(x.queries[0],'BEGIN');assert.match(x.queries[1]!,/jsonb_set/);assert.equal(x.queries[2],'COMMIT');
});
for(const fault of ['active','running','allowance','pending','nonce','custody','position','reorg','strategy'] as const)
 test(`policy adoption rejects ${fault} without writing`,async()=>{
  const x=adoptionFixture();
  if(fault==='active')x.state.phase='holding';
  if(fault==='running')x.state.desired='running';
  if(fault==='allowance')x.state.last.allowances[0].amount='1';
  if(fault==='pending')x.store.pending=async()=>({status:'signed'}) as never;
  if(fault==='nonce')x.chain.client.getTransactionCount=async()=>x.current.nonce+1;
  if(fault==='custody')x.current.usdg=String(BigInt(x.current.usdg)+1n);
  if(fault==='position')x.current.position={liquidity:'0'};
  if(fault==='reorg')x.chain.client.getBlock=async()=>({hash:'0x00'});
  if(fault==='strategy')x.state.policyHash='changed';
  await assert.rejects(()=>x.controller.adoptAllowancePolicy());assert.equal(x.saved.length,0);assert.equal(x.queries.length,0);
 });
test('restart refuses a configuration edit before resolving or broadcasting any pending transaction',async()=>{
 const x=adoptionFixture();await assert.rejects(()=>x.controller.tick(),/Allowance policy differs/);assert.equal(x.saved.length,0);
});
