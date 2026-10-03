import assert from 'node:assert/strict';
import {it} from 'node:test';
import type {Pool} from 'pg';
import {readLiveWalletCommitments} from '../src/deployments/live-wallet-commitments.js';

const operator='0x1111111111111111111111111111111111111111';
type QueryCall={sql:string;values?:readonly unknown[]};
function fakePool({deploymentRows=[],legacyRows={},failOn,failRollback=false,schemas=['rangekeeper_v1','live_pilot_v1']}:
 {deploymentRows?:Array<{id:string}>;legacyRows?:Record<string,Array<{id:string}>>;failOn?:(sql:string)=>boolean;
  failRollback?:boolean;schemas?:string[]}={}){
 const calls:QueryCall[]=[];let released=false;
 const client={
  async query(sql:string,values?:readonly unknown[]){
   calls.push({sql,values});
   if(sql==='ROLLBACK'&&failRollback)throw Error('rollback_failed');
   if(failOn?.(sql))throw Error('read_failed');
   if(sql.includes('FROM deployment_campaigns c'))return {rows:deploymentRows};
   if(sql.includes('to_regclass($1)')){
    const relation=String(values?.[0]??'');
    return {rows:[{present:schemas.includes(relation.split('.')[0]??'')?relation:null}]};
   }
   if(sql.includes('FROM rangekeeper_v1.campaigns c'))return {rows:legacyRows.rangekeeper_v1??[]};
   if(sql.includes('FROM live_pilot_v1.campaigns c'))return {rows:legacyRows.live_pilot_v1??[]};
   return {rows:[]};
  },
  release(){released=true;},
 };
 const pool={async connect(){return client;}} as unknown as Pick<Pool,'connect'>;
 return {pool,calls,get released(){return released;}};
}

it('reports available only when deployed and legacy ledgers have no active or pending ownership',async()=>{
 const fixture=fakePool();
 const result=await readLiveWalletCommitments(fixture.pool,operator);
 assert.deepEqual(result,{status:'available',rows:[]});
 assert.equal(fixture.calls[0]?.sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert(fixture.calls.some(call=>call.sql.includes('deployment_campaigns c')));
 assert(fixture.calls.some(call=>call.sql.includes('rangekeeper_v1.campaigns c')));
 assert(fixture.calls.some(call=>call.sql.includes('live_pilot_v1.campaigns c')));
 assert(fixture.calls.some(call=>call.sql==='COMMIT'));
 assert.equal(fixture.released,true);
 const deployed=fixture.calls.find(call=>call.sql.includes('FROM deployment_campaigns c'))!;
 assert.match(deployed.sql,/c\.lifecycle NOT IN \('draft','closed'\)/);
 assert.match(deployed.sql,/deployment_wallet_reservations wr/);
 assert.match(deployed.sql,/deployment_operations o/);
 for(const schema of ['rangekeeper_v1','live_pilot_v1']){
  const legacy=fixture.calls.find(call=>call.sql.includes(`FROM ${schema}.campaigns c`))!;
  assert.match(legacy.sql,/coalesce\(c\.state->>'phase','unknown'\)<>'closed'/);
  assert.match(legacy.sql,/a\.status IN \('prepared','signed'\)/);
 }
 assert(fixture.calls.every(({sql})=>sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'||
  sql==='COMMIT'||/^SELECT\b/.test(sql.trim())), 'commitment inspection must only begin, select, and commit');
 assert.equal(fixture.calls.some(({sql})=>/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql)),false);
});

it('marks every active deployment or legacy campaign unknown and unavailable',async()=>{
 const cases:Array<{name:string;options:NonNullable<Parameters<typeof fakePool>[0]>;id:string}>=[
  {name:'deployment campaign',options:{deploymentRows:[{id:'deployment-a'}]},id:'deployment:deployment-a'},
  {name:'RangeKeeper legacy campaign',options:{legacyRows:{rangekeeper_v1:[{id:'rk-a'}]}},id:'rangekeeper_v1:rk-a'},
  {name:'live pilot legacy campaign',options:{legacyRows:{live_pilot_v1:[{id:'pilot-a'}]}},id:'live_pilot_v1:pilot-a'},
 ];
 for(const scenario of cases){
  const fixture=fakePool(scenario.options),result=await readLiveWalletCommitments(fixture.pool,operator);
  assert.equal(result.status,'unavailable',scenario.name);
  if(result.status!=='unavailable')throw Error('expected unavailable commitments');
  assert.deepEqual(result.reasons,['active_live_campaign_allocation_not_yet_proven'],scenario.name);
  assert.deepEqual(result.rows,[{campaignId:scenario.id,active:true,known:false}],scenario.name);
  assert.equal(fixture.released,true,scenario.name);
 }
});

it('returns unavailable and rolls back on deployment and legacy read failures, then releases the client',async()=>{
 for(const failedRead of ['deployment_campaigns','rangekeeper_v1.campaigns']){
  const fixture=fakePool({failOn:sql=>sql.includes(failedRead)});
  const result=await readLiveWalletCommitments(fixture.pool,operator);
  assert.equal(result.status,'unavailable',failedRead);
  if(result.status!=='unavailable')throw Error('expected unavailable commitments');
  assert.deepEqual(result.reasons,['live_wallet_commitment_read_unavailable']);
  assert(fixture.calls.some(call=>call.sql==='ROLLBACK'),failedRead);
  assert.equal(fixture.calls.some(call=>call.sql==='COMMIT'),false,failedRead);
  assert.equal(fixture.released,true,failedRead);
 }
});

it('attempts rollback and releases the client even when rollback itself fails',async()=>{
 const fixture=fakePool({failOn:sql=>sql.includes('deployment_campaigns'),failRollback:true});
 const result=await readLiveWalletCommitments(fixture.pool,operator);
 assert.equal(result.status,'unavailable');
 assert(fixture.calls.some(call=>call.sql==='ROLLBACK'));
 assert.equal(fixture.released,true);
});
