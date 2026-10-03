import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import type {PoolClient} from 'pg';
import {MIGRATION_CHECKSUMS} from '../src/storage/migration-checksums.js';
import {applyWalletSnapshotInTransaction,liveWalletSourceNotBefore,readCommitments} from '../src/deployments/live-wallet-store.js';
import {liveWalletCommitmentFingerprint} from '../src/deployments/live-wallet-commitment-projection.js';

const wallet='0x1111111111111111111111111111111111111111',token0='0x2222222222222222222222222222222222222222',
 token1='0x3333333333333333333333333333333333333333';
const id={chainId:4663 as const,address:wallet};
const hash=(c:string)=>`0x${c.repeat(64)}`;
const nowSeconds=()=>Math.floor(Date.now()/1000);

/** Minimal in-memory stand-in for the wallet tables read and written by applyWalletSnapshotInTransaction. */
function fakeWalletDb(){
 const wallets=new Map<string,any>(),tokens:{token_address:string;balance_raw:string}[]=[];
 let allocations:any[]=[],allocationTokens:any[]=[];
 const client={query:async(sql:string,params:unknown[]=[])=>{
  const q=sql.replace(/\s+/g,' ');
  if(q.includes('FROM pg_class'))return {rows:[{present:true}]};
  if(q.includes('FROM schema_migrations ORDER BY'))return {rows:MIGRATION_CHECKSUMS.slice(0,14).map((checksum,index)=>({version:index+1,checksum}))};
  if(q.includes('max(version)'))return {rows:[{version:14}]};
  if(q.includes('FROM deployment_live_stage_outbox'))return {rows:[{yes:false}]};
  if(q.startsWith('SELECT generation,source_block,source_hash,commitments_hash FROM deployment_live_wallets'))
   return {rows:wallets.has('w')?[wallets.get('w')]:[]};
  if(q.startsWith('SELECT DISTINCT token_address FROM deployment_live_allocation_tokens'))
   return {rows:[...new Set(allocationTokens.map(t=>t.token_address))].map(token_address=>({token_address}))};
  if(q.startsWith('SELECT native_balance_wei,snapshot_hash,nonce,pending_nonce FROM deployment_live_wallets'))
   return {rows:wallets.has('w')?[wallets.get('w')]:[]};
  if(q.startsWith('SELECT token_address,balance_raw FROM deployment_live_wallet_tokens'))return {rows:[...tokens]};
  if(q.includes('FROM deployment_live_allocations WHERE chain_id=$1 AND wallet=$2 AND state<>'))return {rows:allocations};
  if(q.includes('FROM deployment_live_allocation_tokens WHERE chain_id=$1 AND wallet=$2 ORDER BY allocation_id'))return {rows:allocationTokens};
  if(q.includes('FROM deployment_live_nft_custody'))return {rows:[]};
  if(q.startsWith('SELECT token_address,sum('))return {rows:[]};
  if(q.includes('coalesce(sum(native_spend_wei'))return {rows:[{amount:'0'}]};
  if(q.startsWith('INSERT INTO deployment_live_wallets')){
   const [chain_id,wallet_,generation,status,source_block,source_hash,source_timestamp,nonce,pending_nonce,native_balance_wei,snapshot_hash,commitments_hash]=params as any[];
   wallets.set('w',{chain_id,wallet:wallet_,generation,status,source_block,source_hash,source_timestamp,nonce,pending_nonce,native_balance_wei,snapshot_hash,commitments_hash});
   return {rows:[],rowCount:1};
  }
  if(q.startsWith('DELETE FROM deployment_live_wallet_tokens')){tokens.length=0;return {rows:[]};}
  if(q.startsWith('INSERT INTO deployment_live_wallet_tokens')){tokens.push({token_address:String(params[2]),balance_raw:String(params[4])});return {rows:[]};}
  throw new Error(`unexpected query: ${q.slice(0,120)}`);
 }} as unknown as PoolClient;
 return {client,row:()=>wallets.get('w'),addAllocation:()=>{
  allocations=[{id:'a1',campaign_id:'c1',revision:1,state:'active',native_spend_wei:'5',pending_native_spend_wei:'0',exit_reserve_wei:'1'}];
  allocationTokens=[{allocation_id:'a1',token_address:token0,allocated_raw:'10',pending_spend_raw:'0'}];
 }};
}
async function snapshot(db:ReturnType<typeof fakeWalletDb>,over:{block?:string;hash?:string;timestamp?:number;nonce?:string;native?:string;
 balance0?:string;effectProof?:any}={}){
 const commitmentsHash=liveWalletCommitmentFingerprint(await readCommitments(db.client,id));
 const nonce=over.nonce??'5';
 return applyWalletSnapshotInTransaction(db.client,{...id,source:{block:over.block??'1000',hash:over.hash??hash('a'),timestamp:over.timestamp??nowSeconds()},
  nonce,pendingNonce:nonce,nativeBalanceWei:over.native??'1000',tokens:[{address:token0,balanceRaw:over.balance0??'500'},{address:token1,balanceRaw:'700'}],
  commitmentsHash,...(over.effectProof?{effectProof:over.effectProof}:{})});
}

describe('wallet generation is a content version',()=>{
 it('keeps the generation through source-only refreshes and advances it only when wallet content changes',async()=>{
  const db=fakeWalletDb(),t=nowSeconds();
  const first=await snapshot(db,{timestamp:t});assert.equal(first.generation,1);
  for(let i=1;i<=5;i++){
   const next=await snapshot(db,{block:String(1000+i*30),hash:hash(String(i)),timestamp:t+i*15});
   assert.equal(next.generation,1,'a source-only advance must not invalidate pinned reviews');
   assert.equal(next.source?.block,String(1000+i*30));assert.notEqual(next.snapshotHash,first.snapshotHash);
  }
  assert.equal(db.row().generation,1);assert.equal(db.row().source_block,'1150');
  const noncePlus=await snapshot(db,{block:'1200',hash:hash('b'),timestamp:t+20,nonce:'6'});assert.equal(noncePlus.generation,2);
  const nativeChange=await snapshot(db,{block:'1210',hash:hash('c'),timestamp:t+21,nonce:'6',native:'900'});assert.equal(nativeChange.generation,3);
  const tokenChange=await snapshot(db,{block:'1220',hash:hash('d'),timestamp:t+22,nonce:'6',native:'900',balance0:'501'});assert.equal(tokenChange.generation,4);
  const sourceOnlyAgain=await snapshot(db,{block:'1230',hash:hash('e'),timestamp:t+23,nonce:'6',native:'900',balance0:'501'});
  assert.equal(sourceOnlyAgain.generation,4);
 });
 it('advances the generation when only the commitments fingerprint changes',async()=>{
  const db=fakeWalletDb(),t=nowSeconds();
  assert.equal((await snapshot(db,{timestamp:t})).generation,1);
  db.addAllocation();
  const changed=await snapshot(db,{block:'1010',hash:hash('2'),timestamp:t+1});
  assert.equal(changed.generation,2,'an allocation change is wallet content even with identical balances');
  assert.equal((await snapshot(db,{block:'1020',hash:hash('3'),timestamp:t+2})).generation,2);
 });
 it('still refuses a backwards source or a forked hash at the same height',async()=>{
  const db=fakeWalletDb(),t=nowSeconds();
  await snapshot(db,{block:'1000',timestamp:t});
  await assert.rejects(()=>snapshot(db,{block:'999',hash:hash('1'),timestamp:t}),/moved backwards/);
  await assert.rejects(()=>snapshot(db,{block:'1000',hash:hash('9'),timestamp:t}),/hash changed at same height/);
 });
});

describe('pinned review source admissibility',()=>{
 const pinned={block:'1000',hash:hash('a'),timestamp:1_800_000_000};
 it('accepts the pinned source or a strictly later canonical one only',()=>{
  assert.equal(liveWalletSourceNotBefore(pinned,pinned),true);
  assert.equal(liveWalletSourceNotBefore({block:'1001',hash:hash('b'),timestamp:1_800_000_003},pinned),true);
  assert.equal(liveWalletSourceNotBefore({block:'999',hash:hash('b'),timestamp:1_799_999_999},pinned),false);
  assert.equal(liveWalletSourceNotBefore({...pinned,hash:hash('b')},pinned),false);
  assert.equal(liveWalletSourceNotBefore({...pinned,timestamp:pinned.timestamp+1},pinned),false);
  assert.equal(liveWalletSourceNotBefore({block:'1001',hash:hash('b'),timestamp:1_799_999_999},pinned),false);
  assert.equal(liveWalletSourceNotBefore(null,pinned),false);
  assert.equal(liveWalletSourceNotBefore({block:'x',hash:hash('b'),timestamp:1},pinned),false);
 });
});
