import assert from 'node:assert/strict';
import test from 'node:test';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../src/client.js';
import {runPaperMaintenancePass,type PaperCampaignRow} from
 '../src/deployments-paper-worker.js';
import {DeploymentConflict,type DeploymentStore} from '../src/deployments/store.js';

test('worker rotates its actual bounded query through active and closed history',async()=>{
 const rows:PaperCampaignRow[]=Array.from({length:45},(_,index)=>({
  id:`${String(index+1).padStart(8,'0')}-0000-4000-8000-000000000000`,
  lifecycle:index<40?'active':'closed',
 }));
 const visited:string[]=[],sampled:string[]=[];
 let cursor:string|null=null;
 const lock={release(){},async query(sql:string,params:unknown[]=[]){
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{acquired:true}]};
  if(sql.includes('pg_advisory_unlock'))return {rows:[]};
  assert.match(sql,/ORDER BY c\.id/);
  assert.doesNotMatch(sql,/ORDER BY CASE WHEN c\.lifecycle/);
  const after=params[0] as string|null,limit=params[1] as number;
  const page=sql.includes('c.id<=$1::uuid')?
   rows.filter(row=>after!==null&&row.id<=after).slice(0,limit):
   rows.filter(row=>after===null||row.id>after).slice(0,limit);
  visited.push(...page.map(row=>row.id));
  cursor=page.at(-1)?.id??cursor;
  return {rows:page};
 }};
 const indexer={connect:async()=>lock} as unknown as Pool;
 const store={
  async auditPaperAccounting(){return {alreadyInvalidated:false,invalidated:[]};},
  async paperValuationState(id:string){sampled.push(id);throw new DeploymentConflict('paper_valuation_state_unavailable');},
  async recordNextPaperAccounting(){return null;},
 } as unknown as DeploymentStore;
 // Projection reports caught up after the sampling decision.
 const chain={getChainId:async()=>4663} as unknown as RobinhoodClient;
 for(let pass=0;pass<3;pass++){
  const result=await runPaperMaintenancePass(store,chain,indexer,20,1);
  assert.equal(result.processed,20);
 }
 assert.equal(new Set(visited).size,45);
 assert.equal(new Set(sampled).size,40);
 assert.equal(sampled.some(id=>rows.find(row=>row.id===id)?.lifecycle==='closed'),false);
 assert.equal(cursor,rows[14]!.id);
});
