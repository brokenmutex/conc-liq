import assert from 'node:assert/strict';
import {it} from 'node:test';
import {liveWalletInventoryMatchesState} from '../src/deployments/live-wallet-commitment-projection.js';
import type {LiveWalletState} from '../src/deployments/live-wallet-store.js';

const a='0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',b='0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const state:LiveWalletState={chainId:4663,address:a,generation:3,status:'available',
 source:{block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:1000},snapshotHash:'2'.repeat(64),
 commitmentsHash:'3'.repeat(64),nonce:'7',pendingNonce:'7',nativeBalanceWei:'100',
 tokens:[{address:a,balanceRaw:'1000'},{address:b,balanceRaw:'2000'}]};
const observed=():{nonce:string;nativeBalanceWei:string;commitmentsHash:string;
 tokens:{address:string;balanceRaw:string|null}[]}=>({nonce:'7',nativeBalanceWei:'100',commitmentsHash:'3'.repeat(64),
 tokens:[{address:b,balanceRaw:'2000'},{address:a.toUpperCase(),balanceRaw:'1000'}]});

it('a registered wallet read preserves exact attributed inventory across token order and address case',()=>{
 assert.equal(liveWalletInventoryMatchesState(state,observed()),true);
});

it('unexplained deposits, withdrawals, nonce movement or missing tokens cannot become free campaign capital',()=>{
 for(const balance of ['999','1001',null]){
  const next=observed();next.tokens[1]!.balanceRaw=balance;
  assert.equal(liveWalletInventoryMatchesState(state,next),false);
 }
 assert.equal(liveWalletInventoryMatchesState(state,{...observed(),nonce:'8'}),false);
 assert.equal(liveWalletInventoryMatchesState(state,{...observed(),nativeBalanceWei:'101'}),false);
 assert.equal(liveWalletInventoryMatchesState(state,{...observed(),tokens:observed().tokens.slice(0,1)}),false);
 assert.equal(liveWalletInventoryMatchesState(state,{...observed(),commitmentsHash:'4'.repeat(64)}),false);
});
