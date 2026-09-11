import assert from 'node:assert/strict';
import pg from 'pg';
import {paperExecutionEvidenceValid} from '../../src/paper/evidence.ts';
const db=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});
const schema=`paper_recenter_evidence_${process.pid}_${Date.now()}`;
await db.connect();
try {
 await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path=${schema}`);
 await db.query('CREATE TABLE paper_execution_runs(id bigint,session_id bigint,policy_hash text,action text,status text,snapshot jsonb,runtime_identity jsonb,checkpoint_id bigint,source_block numeric,source_hash text)');
 await db.query('CREATE TABLE v3_strategy_checkpoint_runs(id bigint,block_number numeric,block_hash text,risk_run_id bigint)');
 await db.query('CREATE TABLE risk_snapshot_canonicality(risk_run_id bigint,block_number numeric,canonical boolean,expected_hash text,observed_hash text)');
 const identity={buildId:'a'.repeat(64),configHash:'b'.repeat(64),nodeVersion:process.version},hash='0x'+'c'.repeat(64);
 const state={status:'open',position:{},execution:{entryRunId:'1',exitRunId:null,recenterRunIds:['2','3']}};
 const session={id:'1',policy_hash:'policy',state,runtime_identity:identity};
 for(let id=1;id<=3;id++){
  const result={executionEligible:false,scope:id===1?'paper_cash_swap_mint_exit_cash':'paper_inventory_recenter',source:{block:String(id),hash}};
  await db.query('INSERT INTO v3_strategy_checkpoint_runs VALUES($1::bigint,$1::bigint,$2,$1::bigint)',[id,hash]);
  await db.query('INSERT INTO risk_snapshot_canonicality VALUES($1::bigint,$1::bigint,true,$2,$2)',[id,hash]);
  await db.query("INSERT INTO paper_execution_runs VALUES($1::bigint,1,'policy','entry','succeeded',$2,$3,$1::bigint,$1::bigint,$4)",[id,JSON.stringify({result,valuation:{sourceBlock:String(id),sourceHash:hash}}),JSON.stringify(identity),hash]);
 }
 assert.equal(await paperExecutionEvidenceValid(db,session),true);
 for(const field of ['status','runtime','scope','valuation','canonical']){
  await db.query('BEGIN');
  if(field==='status')await db.query("UPDATE paper_execution_runs SET status='failed' WHERE id=2");
  if(field==='runtime')await db.query('UPDATE paper_execution_runs SET runtime_identity=NULL WHERE id=2');
  if(field==='scope')await db.query(`UPDATE paper_execution_runs SET snapshot=jsonb_set(snapshot,'{result,scope}','"paper_cash_swap_mint_exit_cash"') WHERE id=2`);
  if(field==='valuation')await db.query(`UPDATE paper_execution_runs SET snapshot=jsonb_set(snapshot,'{valuation,sourceBlock}','"99"') WHERE id=2`);
  if(field==='canonical')await db.query('UPDATE risk_snapshot_canonicality SET canonical=false WHERE risk_run_id=2');
  assert.equal(await paperExecutionEvidenceValid(db,session),false,field);await db.query('ROLLBACK');
 }
 for(const ids of [['1'],['2','2'],['3','2']])assert.equal(await paperExecutionEvidenceValid(db,{...session,state:{...state,execution:{...state.execution,recenterRunIds:ids}}}),false);
 assert.equal(await paperExecutionEvidenceValid(db,session),true);
 console.log(JSON.stringify({passed:['all recenter proofs checked','failed move proof rejected','runtime mismatch rejected','wrong action scope rejected','valuation mismatch rejected','revoked recenter source rejected','duplicate and regressing move IDs rejected'],scope:'isolated PostgreSQL recenter evidence'}));
} finally {await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();}
