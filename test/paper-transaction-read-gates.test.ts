import assert from 'node:assert/strict';
import {it} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {encodeFunctionResult} from 'viem';
import {simulatePaperTransaction} from '../src/paper/execution-gas.js';
import {nodeInterfaceAbi,PAPER_ACCOUNT} from '../src/paper/execution-abi.js';
import type {PaperFork} from '../src/paper/fork.js';

function fixture(){
 const reads:{method:string;params:unknown[];resolve:(value:unknown)=>void;reject:(reason:Error)=>void}[]=[],
  localCalls:string[]=[],hash=`0x${'a'.repeat(64)}`;
 const fork={blockTag:'0xc8',source:{number:200n,hash},
  read:(method:string,params:unknown[])=>new Promise((resolve,reject)=>reads.push({method,params,resolve,reject})),
  rpc:async(method:string)=>{
   localCalls.push(method);
   if(method==='debug_traceCall')return {[PAPER_ACCOUNT]:{balance:'0x1'}};
   if(method==='eth_call')return '0x1234';
   if(method==='eth_sendTransaction')return hash;
   if(method==='eth_getTransactionReceipt')return {status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1'};
   throw Error(`Unexpected local method ${method}`);
  }} as unknown as PaperFork;
 const component=encodeFunctionResult({abi:nodeInterfaceAbi,functionName:'gasEstimateL1Component',
  result:[100n,2n,3n]});
 return {fork,reads,localCalls,component};
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
