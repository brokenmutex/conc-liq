import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {decodeEventLog,encodeAbiParameters,encodeEventTopics,parseAbi,type Hex} from 'viem';
import {NONFUNGIBLE_POSITION_MANAGER} from '../src/constants.js';
import {PAPER_POOL} from '../src/paper/engine.js';
import {reconcilePilotAction} from '../src/live-pilot/reconcile.js';
import type {PilotAction,PilotSnapshot,PilotState} from '../src/live-pilot/domain.js';
import type {PilotReceipt} from '../src/live-pilot/receipt.js';
const source=JSON.parse(readFileSync(new URL('./fixtures/live-withdraw-rounding-2026-09-14.json',import.meta.url),'utf8'));
type Fixture={state:PilotState;action:PilotAction;receipt:PilotReceipt;after:PilotSnapshot};
function fixture():Fixture {
 const f=structuredClone(source);
 for(const key of ['blockNumber','gasUsed','effectiveGasPrice'])f.receipt[key]=BigInt(f.receipt[key]);return f;
}
const poolAbi=parseAbi(['event Collect(address indexed owner,address recipient,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount0,uint128 amount1)']);
function collection(f:Fixture){
 return f.receipt.logs.find(l=>l.address.toLowerCase()===PAPER_POOL&&l.topics[0]===encodeEventTopics({abi:poolAbi,eventName:'Collect'})[0])!;
}
function changeCollection(f:Fixture,changes:Record<string,unknown>){
 const log=collection(f),{args}=decodeEventLog({abi:poolAbi,data:log.data,topics:log.topics as [Hex,...Hex[]]});
 const a={...args,...changes};
 log.topics=encodeEventTopics({abi:poolAbi,eventName:'Collect',args:{owner:a.owner,tickLower:a.tickLower,tickUpper:a.tickUpper}}) as Hex[];
 log.data=encodeAbiParameters([{type:'address'},{type:'uint128'},{type:'uint128'}],[a.recipient,a.amount0,a.amount1]);
}
test('canonical stalled withdrawal reconciles actual proceeds and records manager rounding separately',()=>{
 const f=fixture(),original=structuredClone(f),result=reconcilePilotAction(f.state,f.action,f.receipt,f.after);
 assert.equal(result.status,'confirmed');assert.deepEqual(f,original,'Reconciliation must not mutate its inputs');
 assert.deepEqual(result.facts.collectionProof,{
  requested:{amount0:'201704356',amount1:'423276323724852'},actual:{amount0:'201704354',amount1:'423276323724852'},
  roundingDifference:{amount0:'2',amount1:'0'},fees:{amount0:'145718',amount1:'423276323724852'}});
 assert.equal(BigInt(result.state.collectedFee0)-BigInt(f.state.collectedFee0),145718n);
 assert.equal(BigInt(result.state.collectedFee1)-BigInt(f.state.collectedFee1),423276323724852n);
 assert.equal(BigInt(result.state.gasSpentWei)-BigInt(f.state.gasSpentWei),13738601980000n);
 assert.equal(result.state.tokenId,null);assert.equal(result.state.last.nonce,250);
 assert.deepEqual(result.state.retiredTokenIds,[...f.state.retiredTokenIds,'1164733']);
 assert.equal(result.state.phase,f.state.phase);assert.equal(result.state.desired,f.state.desired);
});
for(const [name,change] of Object.entries({
 owner:{owner:source.state.operator},recipient:{recipient:NONFUNGIBLE_POSITION_MANAGER},
 lower:{tickLower:222790},upper:{tickUpper:222850},amount0:{amount0:201704355n},amount1:{amount1:423276323724853n}
}))test(`withdrawal rejects mismatched canonical pool ${name}`,()=>{
 const f=fixture();changeCollection(f,change);assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after));
});
for(const mode of ['missing','duplicate','wrong_pool'])test(`withdrawal rejects ${mode} pool collection evidence`,()=>{
 const f=fixture(),log=collection(f);
 if(mode==='missing')f.receipt.logs=f.receipt.logs.filter(l=>l!==log);
 else if(mode==='duplicate')f.receipt.logs=[...f.receipt.logs,log];else log.address=f.state.operator;
 assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after),/canonical pool collection/);
});
test('withdrawal rejects actual proceeds above the manager request',()=>{
 const f=fixture(),abi=parseAbi(['event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)']);
 const log=f.receipt.logs.find(l=>l.address.toLowerCase()===NONFUNGIBLE_POSITION_MANAGER.toLowerCase()&&l.topics[0]===encodeEventTopics({abi,eventName:'Collect'})[0])!;
 log.data=encodeAbiParameters([{type:'address'},{type:'uint256'},{type:'uint256'}],[f.state.operator,201704353n,423276323724852n]);
 assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after),/exceeds manager request/);
});
for(const key of ['usdg','nvda','native','nonce','nftCount'] as const)test(`rounding does not tolerate unexplained wallet ${key}`,()=>{
 const f=fixture();if(key==='nonce')f.after.nonce++;else f.after[key]=String(BigInt(f.after[key])+1n);
 assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after));
});
test('withdrawal still requires zero remaining liquidity and fees, unchanged custody and allowances',()=>{
 for(const key of ['liquidity','tokensOwed0','tokensOwed1','owner','tickLower','tickUpper','tokenId'] as const){
  const f=fixture();assert(f.after.position);
  if(key==='owner')f.after.position.owner=NONFUNGIBLE_POSITION_MANAGER;
  else if(key==='tickLower'||key==='tickUpper')f.after.position[key]++;
  else f.after.position[key]='1';
  assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after),key);
 }
 const f=fixture();f.after.allowances[0]!.amount=String(BigInt(f.after.allowances[0]!.amount)+1n);
 assert.throws(()=>reconcilePilotAction(f.state,f.action,f.receipt,f.after),/allowance/);
});
