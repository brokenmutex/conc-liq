import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import type {Pool,PoolClient} from 'pg';
import {PaperPreparationLeaseRegistry,acquirePaperPreparationSharedLease,
 paperPreparationLockName} from '../src/deployments/paper-preparation-lease.js';

class FakeClient extends EventEmitter {
 released:boolean|undefined;
 failQuery=false;
 constructor(readonly locks:Map<string,{exclusive:boolean;shared:number}>){super();}
 async query(sql:string,values:unknown[]=[]){
  if(this.failQuery)throw Error('connection_lost');
  const name=String(values[0]??'');
  if(sql.includes('pg_try_advisory_lock_shared')){
   const lock=this.locks.get(name);
   if(lock?.exclusive)return {rows:[{acquired:false}]};
   if(lock)lock.shared++;
   else this.locks.set(name,{exclusive:false,shared:1});
   return {rows:[{acquired:true}]};
  }
  if(sql.includes('pg_try_advisory_lock(')){
   const lock=this.locks.get(name);
   if(lock)return {rows:[{acquired:false}]};
   this.locks.set(name,{exclusive:true,shared:0});return {rows:[{acquired:true}]};
  }
  if(sql.includes('pg_advisory_unlock_shared')){
   const lock=this.locks.get(name);if(!lock||lock.shared===0)return {rows:[{unlocked:false}]};
   if(--lock.shared===0&&!lock.exclusive)this.locks.delete(name);
   return {rows:[{unlocked:true}]};
  }
  if(sql.includes('pg_advisory_unlock(')){
   const lock=this.locks.get(name);if(!lock?.exclusive)return {rows:[{unlocked:false}]};
   this.locks.delete(name);return {rows:[{unlocked:true}]};
  }
  return {rows:[]};
 }
 release(destroy?:boolean){this.released=destroy??false;}
}

class FakePool {
 readonly locks=new Map<string,{exclusive:boolean;shared:number}>();
 readonly clients:FakeClient[]=[];
 async connect(){const client=new FakeClient(this.locks);this.clients.push(client);return client;}
}

const id='00000001-0000-4000-8000-000000000000';

test('exclusive preparation lease blocks maintenance and releases for another process',async()=>{
 const pool=new FakePool(),registry=new PaperPreparationLeaseRegistry(pool as unknown as Pool);
 const lease=await registry.acquire(id,10_000);
 assert.equal(await acquirePaperPreparationSharedLease(pool as unknown as Pool,id),null);
 await lease.assertHealthy();
 await lease.release();
 const shared=await acquirePaperPreparationSharedLease(pool as unknown as Pool,id);
 assert.ok(shared);await shared.release();
 assert.equal(pool.locks.has(paperPreparationLockName(id)),false);
 await registry.close();
});

test('lease expiry cannot be extended beyond its hard bound and close shuts the registry',async()=>{
 const pool=new FakePool(),registry=new PaperPreparationLeaseRegistry(pool as unknown as Pool);
 const lease=await registry.acquire(id,1_000);
 assert.throws(()=>lease.retainUntil(new Date(Date.now()+2_000)),/paper_preparation_lease_expiry_invalid/);
 await registry.close();
 assert.equal(pool.clients[0]!.released,false);
 await assert.rejects(registry.acquire(id),/paper_preparation_lease_registry_closed/);
});

test('lost preparation lease destroys its session and fails health checks',async()=>{
 const pool=new FakePool(),registry=new PaperPreparationLeaseRegistry(pool as unknown as Pool);
 const lease=await registry.acquire(id,10_000),client=pool.clients[0]!;
 client.emit('error',Error('connection_lost'));
 await assert.rejects(lease.assertHealthy(),/paper_preparation_lease_lost/);
 assert.equal(client.released,true);
 await registry.close();
});

test('registry close during asynchronous acquire releases the late lease',async()=>{
 const pool=new FakePool();let finishConnect!:()=>void;
 const delayed={...pool,async connect(){await new Promise<void>(resolve=>{finishConnect=resolve;});
  return pool.connect();}};
 const registry=new PaperPreparationLeaseRegistry(delayed as unknown as Pool);
 const pending=registry.acquire(id,10_000);await Promise.resolve();
 await registry.close();finishConnect();
 await assert.rejects(pending,/paper_preparation_lease_registry_closed/);
 assert.equal(pool.locks.size,0);
});
