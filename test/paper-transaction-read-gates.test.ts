import assert from 'node:assert/strict';
import {it} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {encodeFunctionResult} from 'viem';
import {simulatePaperTransaction} from '../src/paper/execution-gas.js';
import {nodeInterfaceAbi,NODE_INTERFACE,PAPER_ACCOUNT} from '../src/paper/execution-abi.js';
import type {PaperFork} from '../src/paper/fork.js';

function fixture(balance='0x1'){
  const reads:{method:string;params:unknown[];resolve:(value:unknown)=>void;reject:(reason:Error)=>void}[]=[],
  localCalls:string[]=[],sent:Record<string,unknown>[]=[],estimates:Record<string,unknown>[]=[],hash=`0x${'a'.repeat(64)}`;
 const fork={blockTag:'0xc8',source:{number:200n,hash},
  read:(method:string,params:unknown[])=>new Promise((resolve,reject)=>reads.push({method,params,resolve,reject})),
  rpc:async(method:string,params:unknown[]=[])=>{
   localCalls.push(method);
   if(method==='debug_traceCall')return {[PAPER_ACCOUNT]:{balance:'0x1'}};
   if(method==='eth_call')return '0x1234';
   if(method==='eth_getBlockByNumber')return {baseFeePerGas:'0x3b9aca00'};
   if(method==='eth_estimateGas'){estimates.push(params[0] as Record<string,unknown>);return '0x5208';}
   if(method==='eth_getBalance')return balance;
   if(method==='eth_gasPrice')return '0x77359400';
   if(method==='eth_sendTransaction'){sent.push(params[0] as Record<string,unknown>);return hash;}
   if(method==='eth_getTransactionReceipt')return {status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1'};
   throw Error(`Unexpected local method ${method}`);
  }} as unknown as PaperFork;
 const component=encodeFunctionResult({abi:nodeInterfaceAbi,functionName:'gasEstimateL1Component',
  result:[100n,2n,3n]});
 return {fork,reads,localCalls,sent,estimates,component};
}

function resolveReads(f:ReturnType<typeof fixture>){
 for(const read of f.reads){
  if(read.method==='eth_call'&&read.params[0]&&typeof read.params[0]==='object'&&
   (read.params[0] as {to?:string}).to?.toLowerCase()===NODE_INTERFACE.toLowerCase())
   read.resolve(f.component);
  else if(read.method==='eth_call')read.resolve('0x1234');
  else if(read.method==='eth_estimateGas')read.resolve('0x7530');
 }
}

it('finishes all source/prestate reads before sending the local transaction',async()=>{
 const f=fixture(),pending=simulatePaperTransaction(f.fork,{action:'gate',to:PAPER_ACCOUNT,calldata:'0x1234'});
 await setImmediate();
 assert.equal(f.reads.length,3);
 for(const read of f.reads){assert.equal(read.params[1],'0xc8');assert.deepEqual(read.params[2],
  {[PAPER_ACCOUNT]:{balance:'0x1'}});}
 f.reads[0]!.resolve('0x1234');f.reads[1]!.resolve('0x7530');
 await setImmediate();assert(!f.localCalls.includes('eth_sendTransaction'));
 f.reads[2]!.resolve(f.component);
 const result=await pending;
 assert.equal(result.estimate.gas,'30000');assert.equal(result.estimate.parentGas,'100');
 assert.equal(result.estimate.totalFeeWei,'60000');assert.equal(result.returnData,'0x1234');
 assert.equal(f.localCalls.filter(method=>method==='eth_sendTransaction').length,1);
});

it('waits for remaining reads and refuses local send when an upstream read fails',async()=>{
 const f=fixture(),pending=simulatePaperTransaction(f.fork,{action:'gate',to:PAPER_ACCOUNT,calldata:'0x1234'}),
  rejected=assert.rejects(pending,/upstream unavailable/);
 await setImmediate();f.reads[0]!.reject(Error('upstream unavailable'));
 f.reads[1]!.resolve('0x7530');
 let settled=false;void rejected.then(()=>{settled=true;});
 await setImmediate();assert.equal(settled,false);assert(!f.localCalls.includes('eth_sendTransaction'));
 f.reads[2]!.resolve(f.component);await rejected;
 assert(!f.localCalls.includes('eth_sendTransaction'));
});

it('refuses local send when canonical and local return data differ',async()=>{
 const f=fixture(),pending=simulatePaperTransaction(f.fork,{action:'gate',to:PAPER_ACCOUNT,calldata:'0x1234'}),
  rejected=assert.rejects(pending,/Local\/Nitro gate result mismatch/);
 await setImmediate();f.reads[0]!.resolve('0xabcd');f.reads[1]!.resolve('0x7530');
 f.reads[2]!.resolve(f.component);await rejected;
 assert(!f.localCalls.includes('eth_sendTransaction'));
});

it('uses a measured bounded gas envelope for explicitly funded paper-account stages',async()=>{
 const f=fixture('0xb5e620f48000'),pending=simulatePaperTransaction(f.fork,
  {action:'funded-paper',to:PAPER_ACCOUNT,calldata:'0x1234'},PAPER_ACCOUNT,{measuredGas:true});
 await setImmediate();resolveReads(f);
 const transaction=await pending;
 assert.equal(f.sent.length,1);
 assert.equal(BigInt(f.sent[0]!.gas as string),39_000n);
 assert.equal(BigInt(f.sent[0]!.gasPrice as string),1_000_000_000n);
 assert.equal(f.estimates.length,1);
 assert.equal('gas' in f.estimates[0]!,false);
 assert.equal(transaction.localEnvelope?.balanceBeforeWei,String(BigInt('0xb5e620f48000')));
});

it('preserves the legacy fixed-gas estimate for non-paper operator accounts',async()=>{
 const operator='0x0000000000000000000000000000000000000abc';
 const f=fixture('0xb5e620f48000'),pending=simulatePaperTransaction(f.fork,
  {action:'operator-default',to:operator,calldata:'0x1234'},operator);
 await setImmediate();resolveReads(f);
 await pending;
 assert.equal(f.estimates.length,1);
 assert.equal(f.estimates[0]!.gas,'0x7a1200');
});

it('fails a measured paper-account stage before send when its real reserve cannot cover the envelope',async()=>{
 const f=fixture('0x174876e800'),pending=simulatePaperTransaction(f.fork,
  {action:'underfunded-paper',to:PAPER_ACCOUNT,calldata:'0x1234'},PAPER_ACCOUNT,{measuredGas:true});
 await setImmediate();resolveReads(f);
 await assert.rejects(pending,/Operator balance cannot cover measured fork gas reserve/);
 assert(!f.localCalls.includes('eth_sendTransaction'));
});
