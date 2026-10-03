import assert from 'node:assert/strict';
import {it} from 'node:test';
import type {PoolClient} from 'pg';
import {MIGRATION_CHECKSUMS} from '../src/storage/migration-checksums.js';
import {assertDeploymentSchemaReady,assertLiveWalletSchemaReady,assertLiveRuntimeSchemaReady,
 assertPositionManagerWalletTransferSchemaReady,assertSchemaReady} from '../src/storage/compatibility.js';

function database(version:number,changed=false){
 const sql:string[]=[];
 const db={query:async(query:string)=>{
  sql.push(query);
  if(query.includes('SELECT EXISTS'))return {rows:[{present:true}]};
  if(query.includes('max(version)'))return {rows:[{version}]};
  return {rows:Array.from({length:version},(_,index)=>({version:index+1,
   checksum:changed&&index===version-1?'modified':MIGRATION_CHECKSUMS[index]}))};
 }} as unknown as Pick<PoolClient,'query'>;
 return {db,sql};
}

it('paper and campaign services remain compatible through v14 while wallet transfer writes require v14',async()=>{
 const old=database(11);await assertDeploymentSchemaReady(old.db);
 await assert.rejects(()=>assertLiveWalletSchemaReady(old.db),/schema incompatible/);
 const current=database(12);await assertDeploymentSchemaReady(current.db);await assertLiveWalletSchemaReady(current.db);
 await assert.rejects(()=>assertLiveRuntimeSchemaReady(current.db),/schema incompatible/);
 const runtime=database(13);await assertDeploymentSchemaReady(runtime.db);await assertLiveWalletSchemaReady(runtime.db);await assertLiveRuntimeSchemaReady(runtime.db);
 await assert.rejects(()=>assertPositionManagerWalletTransferSchemaReady(runtime.db),/schema incompatible/);
 const walletIndex=database(14);await assertDeploymentSchemaReady(walletIndex.db);await assertLiveWalletSchemaReady(walletIndex.db);
 await assertLiveRuntimeSchemaReady(walletIndex.db);await assertPositionManagerWalletTransferSchemaReady(walletIndex.db);
 assert([...old.sql,...current.sql].every(sql=>sql.startsWith('SELECT')));
});

it('an unknown or modified migration never qualifies the shared wallet or existing services',async()=>{
 for(const fixture of [database(12,true),database(13,true),database(14,true),database(15)]){
  await assert.rejects(()=>assertSchemaReady(fixture.db),/schema incompatible/);
  await assert.rejects(()=>assertLiveWalletSchemaReady(fixture.db),/schema incompatible/);
  await assert.rejects(()=>assertLiveRuntimeSchemaReady(fixture.db),/schema incompatible/);
  await assert.rejects(()=>assertPositionManagerWalletTransferSchemaReady(fixture.db),/schema incompatible/);
 }
});
