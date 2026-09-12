import {feeSharePolicyChange} from './policy-history.js';
import {policyHash,type PaperPolicy} from './engine.js';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {readPaperChain} from './reentry.js';
import type {PaperSessionRow} from './store.js';
import {executionRuntime} from './runtime-history.js';
import type {RuntimeIdentity} from '../runtime/identity.js';
/** Explicit maintenance operation: retain position/accounting and pin old proofs
 * to their original runtime. A stream lock excludes every in-flight preflight. */
export async function upgradePaperRuntime(db:PoolClient,stream:string,id:string,fromBuild:string,to:RuntimeIdentity,newPolicy?:PaperPolicy) {
 await db.query('BEGIN');
 try {
  const lock=(await db.query<{locked:boolean}>("SELECT pg_try_advisory_xact_lock(hashtext('conc-liq-paper'),hashtext($1)) AS locked",[stream])).rows[0];
  assert(lock?.locked,'Paper worker is busy; retry when idle');
  const row=(await db.query<PaperSessionRow>('SELECT * FROM paper_sessions WHERE stream_key=$1 ORDER BY id DESC LIMIT 1 FOR UPDATE',[stream])).rows[0];
  assert(row&&row.id===id,'Paper session advanced; recheck upgrade');
  assert(row.runtime_identity?.buildId===fromBuild,'Prior runtime changed');
  assert(row.state.status==='open'&&row.state.position&&!row.state.invalidatedAt&&!row.state.reentryStoppedAt,'Upgrade requires an active valid position');
  assert(to.configHash===row.runtime_identity.configHash&&to.nodeVersion===row.runtime_identity.nodeVersion&&to.buildId!==fromBuild,'Runtime upgrade requires identical configuration and a different build');
  await readPaperChain(db,row);
  const policyChange=newPolicy?feeSharePolicyChange(row.policy,newPolicy):undefined;
  const boundary=(await db.query<{run:string;observation:string;at:Date}>(`SELECT
    (SELECT COALESCE(MAX(id),0)::text FROM paper_execution_runs WHERE session_id=$1) AS run,
    (SELECT COALESCE(MAX(id),0)::text FROM paper_observations WHERE session_id=$1) AS observation,clock_timestamp() AS at`,[id])).rows[0]!;
  const transition={...(policyChange?{policyChange}:{}),from:row.runtime_identity,to,throughRunId:boundary.run,throughObservationId:boundary.observation,at:boundary.at.toISOString(),
    stateSha256:createHash('sha256').update(JSON.stringify(row.state)).digest('hex')};
  const state=structuredClone(row.state);state.runtimeTransitions=[...(state.runtimeTransitions??[]),transition];
  // A pre-upgrade quote is discarded. The position and all money counters remain.
  if(state.execution)state.execution.recenterIntent=null;
  executionRuntime(to,state.runtimeTransitions);
  const policy=policyChange?.to??row.policy,policy_hash=policyHash(policy);
  await db.query('UPDATE paper_sessions SET runtime_identity=$2,state=$3,policy=$4,policy_hash=$5,updated_at=clock_timestamp() WHERE id=$1',[id,JSON.stringify(to),JSON.stringify(state),JSON.stringify(policy),policy_hash]);
  await readPaperChain(db,{...row,state,policy,policy_hash,runtime_identity:to});
  await db.query('COMMIT');return {id,transition,executionEligible:false};
 }catch(error){await db.query('ROLLBACK');throw error;}
}
