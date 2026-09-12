// Real PostgreSQL transactions in a disposable schema with synthetic evidence.
import assert from 'node:assert/strict';import pg from 'pg';import {readFileSync} from 'node:fs';
import {policyHash} from '../../src/paper/engine.ts';
import {paperPolicySchema} from '../../src/paper/config.ts';
import {upgradePaperRuntime} from '../../src/paper/runtime-upgrade.ts';
import {readPaperChain} from '../../src/paper/reentry.ts';
import {paperExecutionEvidenceValid} from '../../src/paper/evidence.ts';
import {assertRuntimeMatches} from '../../src/runtime/identity.ts';
const db=new pg.Client({connectionString:process.env.TEST_DATABASE_URL}),other=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});
const schema=`paper_runtime_upgrade_${process.pid}_${Date.now()}`;await db.connect();await other.connect();
try{
 await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path=${schema}`);
 await db.query('CREATE TABLE paper_sessions(id bigint PRIMARY KEY,stream_key text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),policy jsonb,policy_hash text,state jsonb,runtime_identity jsonb)');
 await db.query('CREATE TABLE paper_observations(id bigint,session_id bigint,checkpoint_id bigint,block_number numeric,block_hash text)');
 await db.query('CREATE TABLE paper_execution_runs(id bigint,session_id bigint,policy_hash text,action text,status text,snapshot jsonb,runtime_identity jsonb,checkpoint_id bigint,source_block numeric,source_hash text)');
 await db.query('CREATE TABLE v3_strategy_checkpoint_runs(id bigint,block_number numeric,block_hash text,risk_run_id bigint)');
 await db.query('CREATE TABLE risk_snapshot_canonicality(risk_run_id bigint,block_number numeric,canonical boolean,expected_hash text,observed_hash text)');
 const identity={buildId:'a'.repeat(64),configHash:'b'.repeat(64),nodeVersion:process.version},hash='0x'+'d'.repeat(64);
 const policy=paperPolicySchema.parse(JSON.parse(readFileSync(new URL('../../config/paper-nvda-5000-recenter-continuous.json',import.meta.url),'utf8'))),ph=policyHash(policy);
 const state=JSON.parse(readFileSync(new URL('../fixtures/paper-state-rejected-exit-recovery.json',import.meta.url),'utf8')).previous;
 state.status='open';state.invalidatedAt=null;state.execution.entryRunId='1';state.execution.exitRunId=null;state.execution.recenterRunIds=['2','3'];
 await db.query('INSERT INTO paper_sessions(id,stream_key,policy,policy_hash,state,runtime_identity) VALUES(59,$1,$2,$3,$4,$5)',[schema,JSON.stringify(policy),ph,JSON.stringify(state),JSON.stringify(identity)]);
 for(let id=1;id<=3;id++){
  const result={executionEligible:false,scope:id===1?'paper_cash_swap_mint_exit_cash':'paper_inventory_recenter',source:{block:String(id),hash}};
  await db.query('INSERT INTO v3_strategy_checkpoint_runs VALUES($1::bigint,$1::bigint,$2,$1::bigint)',[id,hash]);
  await db.query('INSERT INTO risk_snapshot_canonicality VALUES($1::bigint,$1::bigint,true,$2,$2)',[id,hash]);
  await db.query('INSERT INTO paper_observations VALUES($1::bigint,59,$1::bigint,$1::bigint,$2)',[id,hash]);
  await db.query("INSERT INTO paper_execution_runs VALUES($1::bigint,59,$2,'entry','succeeded',$3,$4,$1::bigint,$1::bigint,$5)",[id,ph,JSON.stringify({result,valuation:{sourceBlock:String(id),sourceHash:hash}}),JSON.stringify(identity),hash]);
 }
 const original=(await db.query('SELECT * FROM paper_sessions')).rows[0],from=original.runtime_identity,to={...from,buildId:'c'.repeat(64)};
 assert.equal(original.state.status,'open');await readPaperChain(db,original);
 await other.query("SELECT pg_advisory_lock(hashtext('conc-liq-paper'),hashtext($1))",[schema]);
 await assert.rejects(()=>upgradePaperRuntime(db,schema,'59',from.buildId,to),/busy/);
 await other.query("SELECT pg_advisory_unlock(hashtext('conc-liq-paper'),hashtext($1))",[schema]);
 await assert.rejects(()=>upgradePaperRuntime(db,schema,'59',from.buildId,{...to,configHash:'f'.repeat(64)}),/identical configuration/);
 await assert.rejects(()=>upgradePaperRuntime(db,schema,'60',from.buildId,to),/advanced/);
 const result=await upgradePaperRuntime(db,schema,'59',from.buildId,to);
 const upgraded=(await db.query('SELECT * FROM paper_sessions')).rows[0];
 assert.equal(upgraded.state.runtimeTransitions.length,1);assert.deepEqual(upgraded.policy,original.policy);assert.equal(upgraded.policy_hash,original.policy_hash);
 const stripped=structuredClone(upgraded.state);delete stripped.runtimeTransitions;if(original.state.execution)original.state.execution.recenterIntent=null;
 assert.deepEqual(stripped,original.state,'Position, mark, accounting and benchmark unchanged');assert.deepEqual(upgraded.runtime_identity,to);
 assert.equal(await paperExecutionEvidenceValid(db,upgraded),true);await readPaperChain(db,upgraded);
 assert.throws(()=>assertRuntimeMatches(upgraded.runtime_identity,from));
 await assert.rejects(()=>upgradePaperRuntime(db,schema,'59',from.buildId,to),/Prior runtime changed/);
 // An old proof cannot be relabeled with the new release, and a new proof cannot
 // borrow the old release identity merely because both appear in the history.
 const entry=upgraded.state.execution.entryRunId;
 await db.query('BEGIN');await db.query('UPDATE paper_execution_runs SET runtime_identity=$2 WHERE id=$1',[entry,JSON.stringify(to)]);
 assert.equal(await paperExecutionEvidenceValid(db,upgraded),false);await db.query('ROLLBACK');
 const newId=String(BigInt(result.transition.throughRunId)+1n),last=upgraded.state.execution.recenterRunIds.at(-1);
 await db.query('BEGIN');await db.query('UPDATE paper_execution_runs SET id=$2,runtime_identity=$3 WHERE id=$1',[last,newId,JSON.stringify(to)]);
 const forward=structuredClone(upgraded);forward.state.execution.recenterRunIds[forward.state.execution.recenterRunIds.length-1]=newId;
 assert.equal(await paperExecutionEvidenceValid(db,forward),true);
 await db.query('UPDATE paper_execution_runs SET runtime_identity=$2 WHERE id=$1',[newId,JSON.stringify(from)]);
 assert.equal(await paperExecutionEvidenceValid(db,forward),false);await db.query('ROLLBACK');
 const broken=structuredClone(upgraded);broken.state.runtimeTransitions[0].throughRunId='1';assert.equal(await paperExecutionEvidenceValid(db,broken),false);
 // The fee/share migration preserves all accepted legacy policy hashes.
 const policyNext=paperPolicySchema.parse({...policy,feeAccounting:'diluted_segments_v1',liquidityShareMode:'warn_v1'}),nextRuntime={...to,buildId:'e'.repeat(64)};
 await assert.rejects(()=>upgradePaperRuntime(db,schema,'59',to.buildId,nextRuntime,{...policyNext,maxSlippageBps:100}),/Only diluted/);
 const migration=await upgradePaperRuntime(db,schema,'59',to.buildId,nextRuntime,policyNext),migrated=(await db.query('SELECT * FROM paper_sessions')).rows[0];
 assert.equal(migrated.policy_hash,policyHash(policyNext));assert.equal(migrated.state.runtimeTransitions.length,2);
 const unchanged=structuredClone(migrated.state);delete unchanged.runtimeTransitions;assert.deepEqual(unchanged,original.state);
 assert.equal(await paperExecutionEvidenceValid(db,migrated),true);await readPaperChain(db,migrated);
 await db.query('BEGIN');await db.query('UPDATE paper_execution_runs SET policy_hash=$1',[policyHash(policyNext)]);
 assert.equal(await paperExecutionEvidenceValid(db,migrated),false);await db.query('ROLLBACK');
 await db.query('BEGIN');const futureId=String(BigInt(migration.transition.throughRunId)+1n);
 await db.query('UPDATE paper_execution_runs SET id=$2,runtime_identity=$3,policy_hash=$4 WHERE id=$1',[last,futureId,JSON.stringify(nextRuntime),policyHash(policyNext)]);
 const future=structuredClone(migrated);future.state.execution.recenterRunIds[future.state.execution.recenterRunIds.length-1]=futureId;
 assert.equal(await paperExecutionEvidenceValid(db,future),true);
 await db.query('UPDATE paper_execution_runs SET policy_hash=$2 WHERE id=$1',[futureId,ph]);assert.equal(await paperExecutionEvidenceValid(db,future),false);await db.query('ROLLBACK');
 console.log(JSON.stringify({passed:['advisory lock excludes in-flight worker','config and latest session enforced','state and policy preserved','old proofs keep original identity','new proofs require new identity','old worker rejected','tampered boundary rejected','fee/share migration preserves balances and legacy policy proofs','new fills require the new policy hash','unrelated policy retuning rejected'],session:'59',scope:'disposable schema'}));
}finally{await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();await other.end();}
