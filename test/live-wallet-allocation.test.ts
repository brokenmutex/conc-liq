import assert from 'node:assert/strict';
import test from 'node:test';
import {allocateLiveWalletBalances} from '../src/deployments/live-wallet-allocation.js';

const risky='0x1111111111111111111111111111111111111111';
const usdg='0x2222222222222222222222222222222222222222';
const commitments=[
 {campaignId:'campaign-b',active:true,known:true,allocatedByTokenAddress:{[risky]:'30',[usdg]:'40'},
  pendingByTokenAddress:{[usdg]:'5'},allocatedNativeWei:'10',pendingNativeWei:'2',exitReserveWei:'3',nftTokenIds:['22']},
 {campaignId:'campaign-a',active:true,known:true,allocatedByTokenAddress:{[usdg]:'25'},
  pendingByTokenAddress:{[risky]:'4'},allocatedNativeWei:'20',pendingNativeWei:'1',exitReserveWei:'6',nftTokenIds:['11']},
];

test('conserves wallet liquid balances across concurrent campaigns sharing USDG',()=>{
 const result=allocateLiveWalletBalances({tokens:[
  {address:risky,decimals:18,symbol:'RISK',reference:'RISK/USD',balanceRaw:'100'},
  {address:usdg,decimals:6,symbol:'USDG',reference:'USDG/USD',balanceRaw:'100'},
 ],nativeBalanceWei:'100',commitments});
 assert.equal(result.status,'available');
 const riskyRow=result.tokens.find(token=>token.address.toLowerCase()===risky)!;
 const quoteRow=result.tokens.find(token=>token.address.toLowerCase()===usdg)!;
 assert.deepEqual([riskyRow.allocatedRaw,riskyRow.pendingRaw,riskyRow.availableRaw],['30','4','66']);
 assert.deepEqual([quoteRow.allocatedRaw,quoteRow.pendingRaw,quoteRow.availableRaw],['65','5','30']);
 assert.deepEqual(result.native,{balanceWei:'100',allocatedWei:'30',pendingWei:'3',exitReserveWei:'9',availableWei:'58'});
 assert.equal(result.tokens.reduce((total,token)=>total+BigInt(token.allocatedRaw!),0n),95n);
});

test('hash and token rows do not depend on input token or campaign order',()=>{
 const input={tokens:[
  {address:risky,decimals:18,symbol:'RISK',reference:'RISK/USD',balanceRaw:'100'},
  {address:usdg,decimals:6,symbol:'USDG',reference:'USDG/USD',balanceRaw:'100'},
 ],nativeBalanceWei:'100',commitments};
 const first=allocateLiveWalletBalances(input),reversed=allocateLiveWalletBalances({
  ...input,tokens:[...input.tokens].reverse(),commitments:[...commitments].reverse()});
 assert.equal(first.commitmentsHash,reversed.commitmentsHash);
 assert.deepEqual(first.tokens.map(token=>token.address),reversed.tokens.map(token=>token.address));
});

test('unknown active custody, malformed commitments, and oversubscription never report free funds',()=>{
 const unknown=allocateLiveWalletBalances({tokens:[{address:usdg,decimals:6,symbol:'USDG',balanceRaw:'100'}],
  nativeBalanceWei:'10',commitments:[{campaignId:'legacy-live',active:true,known:false}]});
 assert.equal(unknown.status,'unavailable');
 assert(unknown.blockers.includes('active_live_custody_commitment_unknown'));
 assert.equal(unknown.tokens[0]!.availableRaw,null);
 assert.equal(unknown.native.availableWei,null);
 const oversubscribed=allocateLiveWalletBalances({tokens:[{address:usdg,decimals:6,symbol:'USDG',balanceRaw:'20'}],
  nativeBalanceWei:'10',commitments:[{campaignId:'one',active:true,known:true,
   allocatedByTokenAddress:{[usdg]:'21'},pendingByTokenAddress:{},allocatedNativeWei:'0',pendingNativeWei:'0',exitReserveWei:'0'}]});
 assert.equal(oversubscribed.status,'unavailable');
 assert(oversubscribed.blockers.includes(`wallet_token_balance_oversubscribed:${usdg}`));
 assert.equal(oversubscribed.tokens[0]!.availableRaw,null);
 const duplicate=allocateLiveWalletBalances({tokens:[{address:usdg,decimals:6,symbol:'USDG',balanceRaw:'100'}],
  nativeBalanceWei:'10',commitments:[
   {campaignId:'same',active:true,known:true,allocatedByTokenAddress:{[usdg]:'20'},pendingByTokenAddress:{},
    allocatedNativeWei:'0',pendingNativeWei:'0',exitReserveWei:'0'},
   {campaignId:'same',active:true,known:true,allocatedByTokenAddress:{[usdg]:'20'},pendingByTokenAddress:{},
    allocatedNativeWei:'0',pendingNativeWei:'0',exitReserveWei:'0'},
  ]});
 assert.equal(duplicate.status,'unavailable');
 assert(duplicate.blockers.includes('active_live_commitment_duplicate_campaign:same'));
 assert.equal(duplicate.tokens[0]!.availableRaw,null);
});
