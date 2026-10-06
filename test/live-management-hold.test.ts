import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {LiveManagementHoldUnavailable,liveManagementHoldKey,tryAcquireLiveWalletObservationLease,withLiveManagementPreviewHold}
 from '../src/deployments/live-management-hold.js';

const wallet={chainId:4663 as const,address:'0xAbCdef0000000000000000000000000000000001'};
/** A scripted pooled client: records every statement and how it was released. */
function fakePool(script:(sql:string)=>unknown){
 const sql:string[]=[],released:Array<boolean|Error|undefined>=[];
 const client=Object.assign(new EventEmitter(),{
  query:async(text:string)=>{sql.push(text);const r=script(text);if(r instanceof Error)throw r;return {rows:[r]};},
  release:(arg?:boolean|Error)=>{released.push(arg);}});
 return {pool:{connect:async()=>client as never},sql,released,client};
}

test('the hold key is wallet scoped, lowercase and distinct from the wallet transaction lock',()=>{
 assert.equal(liveManagementHoldKey(wallet),'conc-liq-live-management-hold:4663:0xabcdef0000000000000000000000000000000001');
 assert.notEqual(liveManagementHoldKey(wallet),`conc-liq-live:4663:${wallet.address.toLowerCase()}`);
});

test('a preview hold is unlocked and its connection returned only after a confirmed unlock',async()=>{
 const f=fakePool(s=>s.includes('pg_advisory_unlock')?{unlocked:true}:{});
 assert.equal(await withLiveManagementPreviewHold(f.pool,wallet,async()=>'ok'),'ok');
 assert(f.sql.some(s=>s.includes('pg_advisory_lock(')));
 assert(f.sql.some(s=>s.includes('pg_advisory_unlock')));
 assert.deepEqual(f.released,[undefined],'clean release back to the pool');
});

test('an unconfirmed unlock destroys the connection instead of pooling a locked session',async()=>{
 const f=fakePool(s=>s.includes('pg_advisory_unlock')?{unlocked:false}:{});
 await withLiveManagementPreviewHold(f.pool,wallet,async()=>1);
 assert.deepEqual(f.released,[true]);
 const g=fakePool(s=>s.includes('pg_advisory_unlock')?new Error('connection lost'):{});
 await assert.rejects(withLiveManagementPreviewHold(g.pool,wallet,async()=>{throw Error('preview failed');}),/preview failed/);
 assert.deepEqual(g.released,[true]);
});

test('a lock wait timeout fails closed as busy and destroys the connection',async()=>{
 const f=fakePool(s=>s.includes('pg_advisory_lock(')?Object.assign(new Error('lock timeout'),{code:'55P03'}):{});
 await assert.rejects(withLiveManagementPreviewHold(f.pool,wallet,async()=>'never'),
  (e:unknown)=>e instanceof LiveManagementHoldUnavailable&&e.reason==='live_management_hold_busy');
 assert.deepEqual(f.released,[true]);
});

test('a preview that outlives its bound has its connection destroyed once',async()=>{
 const f=fakePool(s=>s.includes('pg_advisory_unlock')?{unlocked:true}:{});
 await withLiveManagementPreviewHold(f.pool,wallet,()=>new Promise(r=>setTimeout(r,60)),{maxHoldMs:10});
 assert.deepEqual(f.released,[true]);
});

test('the observer lease never waits and returns its connection after unlock',async()=>{
 const busy=fakePool(s=>s.includes('pg_try_advisory_lock')?{locked:false}:{});
 assert.equal(await tryAcquireLiveWalletObservationLease(busy.pool,wallet),null);
 assert.deepEqual(busy.released,[false]);
 const free=fakePool(s=>s.includes('pg_try_advisory_lock')?{locked:true}:{unlocked:true});
 const lease=await tryAcquireLiveWalletObservationLease(free.pool,wallet);assert(lease);
 assert.equal(free.released.length,0,'held while the lease is open');
 await lease.release();await lease.release();
 assert.deepEqual(free.released,[false]);
});
