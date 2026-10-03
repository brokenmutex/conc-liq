import assert from 'node:assert/strict';
import {it} from 'node:test';
import type {PoolClient} from 'pg';
import {assertNoSharedRangeKeeperWalletOwnership} from '../src/strategy/rangekeeper/live-store.js';

it('legacy whole-wallet execution is rejected when the shared executor reserves any campaign',async()=>{
 const calls:Array<{sql:string;args?:unknown[]}>=[];
 const db={query:async(sql:string,args?:unknown[])=>{calls.push({sql,args});
  return {rows:sql.includes('to_regclass')?[{present:'deployment_live_allocations'}]:[{owned:true}]};
 }} as unknown as Pick<PoolClient,'query'>;
 await assert.rejects(()=>assertNoSharedRangeKeeperWalletOwnership(db,'0x'+'A'.repeat(40)),/Shared wallet executor owns/);
 assert.deepEqual(calls[1]!.args,['0x'+'a'.repeat(40)]);
 assert.match(calls[1]!.sql,/state<>'released'/);assert.match(calls[1]!.sql,/prepared','signed','blocked/);
});

it('the predecessor guard remains read-only and supports v11 or fully released shared ownership',async()=>{
 for(const present of [null,'deployment_live_allocations']){
  const sql:string[]=[];
  const db={query:async(query:string)=>{sql.push(query);
   return {rows:query.includes('to_regclass')?[{present}]:[{owned:false}]};
  }} as unknown as Pick<PoolClient,'query'>;
  await assertNoSharedRangeKeeperWalletOwnership(db,'0x'+'a'.repeat(40));
  assert.equal(sql.length,present?2:1);assert(sql.every(query=>query.startsWith('SELECT')));
 }
});
