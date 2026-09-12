// Bounded accounting repair after a missing boundary read. No past orders are
// created: both the recorded decision and the whole recovery path must stay in range.
import assert from 'node:assert/strict';import pg from 'pg';import {readFileSync,writeFileSync} from 'node:fs';import {parseEnv} from 'node:util';
import {NitroPaperExecutor} from '../src/paper/executor.js';import {sourceSql} from '../src/paper/store.js';
import {PAPER_POOL,PAPER_NVDA,advancePaper,invalidatePaper} from '../src/paper/engine.js';import {boundaryContinuity} from '../src/paper/boundary-fees.js';
import {readDilutedFees} from '../src/paper/diluted-fees.js';import {readPaperChain} from '../src/paper/reentry.js';import {evidenceHash} from '../src/paper/recovery.js';
import {evaluatePaperReference,readPaperReferenceGate} from '../src/paper/reference.js';import {evaluateCanaryEntryReadiness} from '../src/canary-plan/entry-readiness.js';
const [command,envFile,output]=process.argv.slice(2);assert(['audit','apply'].includes(command)&&envFile&&output);
Object.assign(process.env,parseEnv(readFileSync(envFile,'utf8')));const db=new pg.Client({connectionString:process.env.DATABASE_URL}),executor=new NitroPaperExecutor(process.env.DATABASE_URL);await db.connect();
try{
 const session=(await db.query('SELECT * FROM paper_sessions WHERE stream_key=$1 ORDER BY id DESC LIMIT 1',[process.env.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1'])).rows[0];
 assert.equal(session.state.status,'invalid');assert.deepEqual(session.state.reasons,['paper_boundary_fee_continuity_unproven']);assert(!session.state.reentryStoppedAt);
 const [bad,prior]=(await db.query('SELECT * FROM paper_observations WHERE session_id=$1 ORDER BY id DESC LIMIT 2',[session.id])).rows;
 assert.equal(bad.action,'invalidate');assert.equal(prior.state.status,'open');assert.equal(prior.state.action,'mark');assert.deepEqual(bad.state,session.state);
 const base=structuredClone(prior.state);base.holding=bad.state.holding;
 assert.deepEqual(invalidatePaper(base,bad.state.invalidatedAt,bad.state.reasons),bad.state,'Only the audited invalidation may differ');
 const policy=session.policy;assert.equal(policy.feeAccounting,'initialized_boundaries_v1');assert(policy.recenter&&policy.tradingHours?.kind==='continuous_v1'&&policy.maxHoldingSeconds===null&&!policy.inventoryExitPpm);
 await readPaperChain(db,{...session,state:base});
 const sources=(await db.query(`${sourceSql} AND c.block_number>$4 ORDER BY c.block_number,c.id LIMIT 21`,[session.stream_key,PAPER_NVDA,PAPER_POOL,base.last.block])).rows;
 assert(sources.length>=1&&sources.length<=20);assert.equal(sources[0].checkpoint.id,bad.checkpoint_id);
 const first=sources[0],last=sources.at(-1),now=new Date().toISOString();assert(Date.parse(last.checkpoint.blockTimestamp)-Date.parse(base.last.blockTimestamp)<=policy.maxGapSeconds*1000,'Recovery gap exceeds the original policy');
 for(const s of sources){assert(s.canonical===true&&s.covered===true&&s.pool_unlocked===true);const snap=(await db.query('SELECT snapshot FROM risk_snapshot_runs WHERE id=$1',[s.risk_run_id])).rows[0].snapshot;
  const reference=evaluatePaperReference({snapshot:snap,checkpoint:s.checkpoint,policy:policy.referencePolicy});assert(reference.eligible,reference.reasons.join(','));}
 const proofs=[];for(const s of first===last?[first]:[first,last])proofs.push(await executor.boundaryFees(s.checkpoint,base.position));
 const health=(await db.query("SELECT id::text,snapshot FROM rpc_health_samples WHERE observed_at>=$1::timestamptz-interval '6 minutes' AND observed_at<=$2 ORDER BY observed_at,id",[base.last.blockTimestamp,now])).rows;
 for(const at of [bad.observed_at.toISOString(),now]){const samples=health.filter(h=>Date.parse(h.snapshot.observedAt)<=Date.parse(at));const readiness=evaluateCanaryEntryReadiness({now:at,sourceBlock:BigInt(at===now?last.checkpoint.block:first.checkpoint.block),samples});assert(readiness.chainEligible,readiness.reasons.join(','));}
 const gate=await readPaperReferenceGate(db,last.checkpoint,policy.referencePolicy,now);assert(gate.eligible,'Current reference gate failed');
 await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 await db.query("SELECT pg_advisory_xact_lock(hashtext('conc-liq-paper'),hashtext($1))",[session.stream_key]);
 const locked=(await db.query('SELECT * FROM paper_sessions WHERE stream_key=$1 ORDER BY id DESC LIMIT 1 FOR UPDATE',[session.stream_key])).rows[0];assert.equal(evidenceHash(locked),evidenceHash(session),'Session changed');
 const currentObs=(await db.query('SELECT id::text FROM paper_observations WHERE session_id=$1 ORDER BY id DESC LIMIT 1',[session.id])).rows[0];assert.equal(currentObs.id,bad.id);
 let state=base;const inputs=[],states=[];
 for(const [i,s] of (first===last?[first]:[first,last]).entries()){
  const cp=s.checkpoint,proof=proofs[i],start=state.last;
  const swaps=(await db.query("SELECT min((event_args->>'tick')::int) AS lo,max((event_args->>'tick')::int) AS hi,count(*)::text AS count FROM v3_pool_events WHERE stream_key=$1 AND lower(pool_address)=$2 AND block_number>$3 AND block_number<=$4 AND event_name='Swap'",[session.stream_key,PAPER_POOL,start.block,cp.block])).rows[0];
  const lo=Math.min(start.tick,cp.tick,swaps.lo??cp.tick),hi=Math.max(start.tick,cp.tick,swaps.hi??cp.tick);assert(lo>=state.position.tickLower&&hi<state.position.tickUpper,'Recovery path required a recenter');
  const changes=(await db.query("SELECT event_name AS \"eventName\",event_args AS args FROM v3_pool_events WHERE stream_key=$1 AND lower(pool_address)=$2 AND block_number>$3 AND block_number<=$4 AND event_name IN ('Mint','Burn') ORDER BY block_number,transaction_index,log_index",[session.stream_key,PAPER_POOL,start.block,cp.block])).rows;
  assert(boundaryContinuity(state.position.boundaryFees,proof,changes));await readDilutedFees(db,session.stream_key,start,cp,state.position,proof);
  const input={now:i===0?bad.observed_at.toISOString():now,checkpoint:cp,dataReasons:[],entryReasons:[],chainHealthy:true,holdingChainReady:true,pathMinTick:lo,pathMaxTick:hi,swapCount:swaps.count,
   reference:i===0?bad.state.holding.riskEvidence.reference:gate.reference,boundaryFees:proof,boundaryContinuity:true,execution:{available:true}};
  state=advancePaper(state,policy,input);assert.equal(state.status,'open');assert.equal(state.action,'mark');assert.deepEqual(state.reasons,[]);
  assert.deepEqual(state.execution,{...base.execution,earnedFee0:state.execution.earnedFee0,earnedFee1:state.execution.earnedFee1});
  assert.equal(state.costsPaidQuote,base.costsPaidQuote);assert.equal(state.position.liquidity,base.position.liquidity);inputs.push(input);states.push(structuredClone(state));
 }
 assert(Date.now()-Date.parse(state.last.blockTimestamp)<policy.maxSourceAgeSeconds*1000,'Fresh recovery checkpoint required');
 const audit={at:new Date().toISOString(),scope:'boundary_read_race_accounting_repair',sessionId:session.id,beforeSession:session,beforeObservation:bad,inputs,states,sourceIds:sources.map(s=>s.checkpoint.id),healthSampleIds:health.map(h=>h.id),ordersAdded:0,executionEligible:false};
 const auditSha256=evidenceHash(audit);writeFileSync(output,JSON.stringify({...audit,auditSha256},null,2)+'\n',{flag:'wx'});
 if(command==='apply'){
  const repair={at:audit.at,auditSha256,beforeObservation:bad,inputs,sourceIds:audit.sourceIds,healthSampleIds:audit.healthSampleIds};
  states[0].boundaryRepair=repair;state.boundaryRepair=repair;
  await db.query("UPDATE paper_observations SET action='mark',state=$2,entry_reasons=$3 WHERE id=$1",[bad.id,JSON.stringify(states[0]),JSON.stringify(['boundary_read_race_accounting_repaired'])]);
  if(first!==last)await db.query(`INSERT INTO paper_observations(session_id,checkpoint_id,block_number,block_hash,source_at,action,state,entry_reasons) VALUES($1,$2,$3,$4,$5,'mark',$6,$7)`,[session.id,state.last.id,state.last.block,state.last.hash,state.last.blockTimestamp,JSON.stringify(state),JSON.stringify(['boundary_read_race_accounting_repaired'])]);
  await db.query("UPDATE paper_sessions SET state=$2,status='open',updated_at=clock_timestamp(),heartbeat_at=clock_timestamp(),monitor_reasons=$3 WHERE id=$1",[session.id,JSON.stringify(state),JSON.stringify(['boundary_read_race_accounting_repaired'])]);
  await readPaperChain(db,{...session,state});await db.query('COMMIT');
 }else await db.query('ROLLBACK');
 console.log(JSON.stringify({command,session:session.id,status:state.status,sourceAt:state.last.blockTimestamp,repairedObservation:bad.id,ordersAdded:0,nav:state.navQuote,auditSha256,output}));
}catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();await executor.close();}
