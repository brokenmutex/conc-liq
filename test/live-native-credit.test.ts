import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {proveNativeCredit} from '../src/live-pilot/native-credit.js';
import {PilotController} from '../src/live-pilot/controller.js';
import {PilotChain} from '../src/live-pilot/chain.js';
import {livePilotConfig} from '../src/live-pilot/config.js';
import {policyHash} from '../src/paper/engine.js';
import {reconcilePilotAction} from '../src/live-pilot/reconcile.js';
import {liveSummary} from '../src/dashboard/positions.js';
const source=JSON.parse(readFileSync(new URL('./fixtures/live-native-credit-2026-09-12.json',import.meta.url),'utf8'));
function fixture(){
 const f=structuredClone(source);f.tx.value=BigInt(f.tx.value);f.tx.blockNumber=BigInt(f.tx.blockNumber);f.receipt.blockNumber=BigInt(f.receipt.blockNumber);
 const client={getChainId:async()=>4663,getBytecode:async()=>undefined,
  getBlock:async({blockNumber}:any)=>({hash:blockNumber===BigInt(f.before.block)?f.before.hash:blockNumber===BigInt(f.after.block)?f.after.hash:f.receipt.blockHash,
   transactions:blockNumber===f.tx.blockNumber?[f.tx]:[]}),getTransaction:async()=>f.tx,getTransactionReceipt:async()=>f.receipt,getTransactionCount:async()=>f.after.nonce};
 return {...f,client};
}
test('actual overnight deposit is discovered and exactly explains the native increase',async()=>{
 const f=fixture(),p=await proveNativeCredit(f.client as never,f.before,f.after);
 assert.equal(p?.totalWei,'8505303167004');assert.equal(p?.transfers[0]?.hash,f.tx.hash);
});
test('unchanged native balance needs no RPC or external funding record',async()=>{
 const f=fixture();assert.equal(await proveNativeCredit({} as never,f.before,{...f.after,native:f.before.native}),null);
});
test('long halt requires explicit hashes; duplicate or old deposits cannot be replayed',async()=>{
 const f=fixture();f.after.block=String(BigInt(f.before.block)+10000n);
 await assert.rejects(()=>proveNativeCredit(f.client as never,f.before,f.after),/512 blocks/);
 assert.equal((await proveNativeCredit(f.client as never,f.before,f.after,0n,[f.tx.hash]))?.totalWei,'8505303167004');
 await assert.rejects(()=>proveNativeCredit(f.client as never,f.before,f.after,0n,[f.tx.hash,f.tx.hash]),/Duplicate/);
 f.before.block=String(f.tx.blockNumber);await assert.rejects(()=>proveNativeCredit(f.client as never,f.before,f.after,0n,[f.tx.hash]),/outside snapshot/);
});
for(const fault of ['recipient','revert','receipt_hash','canonical_hash','value','input','debit','chain','delegation'] as const)
 test(`native credit rejects ${fault}`,async()=>{
  const f=fixture();
  if(fault==='recipient')f.tx.to=f.tx.from;
  if(fault==='revert')f.receipt.status='reverted';
  if(fault==='receipt_hash')f.receipt.transactionHash='0x00';
  if(fault==='canonical_hash')f.tx.blockHash='0x00';
  if(fault==='value')f.tx.value+=1n;
  if(fault==='input')f.tx.input='0x1234';
  if(fault==='debit')f.after.native=String(BigInt(f.before.native)-1n);
  if(fault==='chain')f.client.getChainId=async()=>1;
  if(fault==='delegation')f.client.getBytecode=async()=>'0xef01' as never;
  await assert.rejects(()=>proveNativeCredit(f.client as never,f.before,f.after,0n,[f.tx.hash]));
 });
function controllerFixture(){
 const f=fixture(),config=livePilotConfig(JSON.parse(readFileSync(new URL('../config/live-pilot-nvda-250.json',import.meta.url),'utf8')));
 config.operator=f.state.operator;f.state.policyHash=policyHash(config.strategy);
 const saved:any[]=[],marks:any[]=[],queries:string[]=[];
 const store={locked:async(_a:any,fn:any)=>fn({query:async(q:string)=>queries.push(q)}),current:async()=>({state:f.state}),pending:async()=>null,
  save:async(_db:any,s:any,reason:string)=>saved.push({state:structuredClone(s),reason}),mark:async(...args:any[])=>marks.push(args),monitor:async()=>{}};
 const chain=new PilotChain(f.client as never,config);chain.snapshot=async()=>f.after;
 const guard=async()=>({source:f.after,entryAllowed:true,reasons:[],holding:undefined,referencePriceX18:null});
 const controller=new PilotController(store as never,chain,config,{address:f.state.operator} as never,guard as never);
 return {...f,controller,saved,marks,queries};
}
test('explicit recovery retains capital, gas and desired mode; atomically records funding then finishes exit',async()=>{
 const f=controllerFixture(),s=await f.controller.recoverNativeCredit([f.tx.hash]);
 assert.equal(s.phase,'exit');assert.equal(s.desired,'running');assert.equal(s.haltReason,undefined);
 assert.equal(s.externalNativeCreditsWei,'8505303167004');assert.equal(s.gasSpentWei,source.state.gasSpentWei);
 assert.equal(s.gasSpentQuote,source.state.gasSpentQuote);assert.equal(s.initialCapitalQuote,'250000000');assert.equal(s.reserveUsdg,source.state.reserveUsdg);
 assert.deepEqual(f.queries,['BEGIN','COMMIT']);assert.equal(f.marks[0][3],'native_credit');
});
for(const field of ['usdg','nvda','nonce','nftCount','allowances'] as const)test(`recovery cannot conceal simultaneous ${field} changes`,async()=>{
 const f=controllerFixture();if(field==='nonce')f.after.nonce++;else if(field==='allowances')f.after.allowances[0].amount='1';else f.after[field]=String(BigInt(f.after[field])+1n);
 await assert.rejects(()=>f.controller.recoverNativeCredit([f.tx.hash]));assert.equal(f.saved.length,0);
});
test('normal closed tick records a verified credit once without changing NAV inputs',async()=>{
 const f=controllerFixture();f.state.phase='closed';f.state.desired='stopped';
 await f.controller.tick();assert.equal(f.saved.length,1);assert.equal(f.saved[0].reason,'reconciled_native_credit');
 assert.equal(f.state.externalNativeCreditsWei,'8505303167004');await f.controller.tick();assert.equal(f.saved.length,1);
});
test('deposit during a pending receipt leaves gas cost and capital accounting exact',async()=>{
 const all=JSON.parse(readFileSync(new URL('./fixtures/live-pilot-reconciliation.json',import.meta.url),'utf8'));
 const f=all.fixtures.find((x:any)=>x.action.plan.kind==='approve');
 for(const k of ['blockNumber','gasUsed','effectiveGasPrice'])f.receipt[k]=BigInt(f.receipt[k]);
 const old=reconcilePilotAction(f.state,f.action,f.receipt,f.after);const credit=8505303167004n;
 f.after.native=String(BigInt(f.after.native)+credit);
 const p={kind:'canonical_direct_native_credit_v1' as const,fromBlock:f.action.before.block,toBlock:f.after.block,totalWei:String(credit),
  transfers:[{hash:source.tx.hash,block:f.after.block,blockHash:f.after.hash,from:source.tx.from,valueWei:String(credit)}]};
 assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after),/receipt gas/);
 const result=reconcilePilotAction(f.state,f.action,f.receipt,f.after,p);
 assert.equal(result.state.gasSpentWei,old.state.gasSpentWei);assert.equal(result.state.externalNativeCreditsWei,String(credit));assert.equal(result.state.initialCapitalQuote,old.state.initialCapitalQuote);
});
test('dashboard exposes a halted strategy independently of a fresh heartbeat',()=>{
 const r=liveSummary({id:source.state.id,state:source.state,heartbeat_at:new Date(),monitor:['unexplained_wallet_or_nft_change'],strategy:{}});
 assert.equal(r.status,'halted');assert.equal(r.hasLiquidity,false);assert.match(r.nextAction!,/Reconciliation/);assert.equal(r.reasons.filter(x=>x==='unexplained_wallet_or_nft_change').length,1);
});
