import assert from 'node:assert/strict';
import pg,{type PoolClient} from 'pg';
import type {Hex} from 'viem';
import {verifyPilotSignature,type PilotIntent} from '../../live-pilot/journal.js';
import {rangeKeeperJson,parseRangeKeeperJson,type RangeKeeperLiveAction,type RangeKeeperLiveState,type RangeKeeperSnapshot} from './live-domain.js';
import type {RangeKeeperTxPlan} from './calldata.js';

/** Separate v1 ledger with the old pilot's wallet-level advisory lock key. */
export class RangeKeeperLiveStore {
 readonly pool:pg.Pool;readonly schema='rangekeeper_v1';
 constructor(connectionString:string){this.pool=new pg.Pool({connectionString,max:3,statement_timeout:15000});}
 async initialize(){
  await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema};
   CREATE TABLE IF NOT EXISTS ${this.schema}.campaigns(id uuid PRIMARY KEY,operator text UNIQUE NOT NULL,
    state jsonb NOT NULL,config jsonb NOT NULL,heartbeat_at timestamptz,monitor jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
   ALTER TABLE ${this.schema}.campaigns ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT clock_timestamp();
   ALTER TABLE ${this.schema}.campaigns DROP CONSTRAINT IF EXISTS campaigns_operator_key;
   CREATE TABLE IF NOT EXISTS ${this.schema}.actions(id uuid PRIMARY KEY,campaign_id uuid NOT NULL REFERENCES ${this.schema}.campaigns(id),
    nonce bigint NOT NULL,intent jsonb NOT NULL,plan jsonb NOT NULL,before_state jsonb NOT NULL,
    status text NOT NULL CHECK(status IN('prepared','signed','confirmed','reverted','cancelled')),
    raw text,hash text UNIQUE,receipt jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    broadcast_at timestamptz,error text,
    CHECK((status IN('prepared','cancelled') AND raw IS NULL AND hash IS NULL)
       OR (status IN('signed','confirmed','reverted') AND raw IS NOT NULL AND hash IS NOT NULL)));
   CREATE UNIQUE INDEX IF NOT EXISTS one_pending ON ${this.schema}.actions(campaign_id) WHERE status IN('prepared','signed');
   CREATE UNIQUE INDEX IF NOT EXISTS one_consumed_nonce ON ${this.schema}.actions(campaign_id,nonce) WHERE status<>'cancelled';
   CREATE TABLE IF NOT EXISTS ${this.schema}.transitions(id bigserial PRIMARY KEY,campaign_id uuid NOT NULL REFERENCES ${this.schema}.campaigns(id),
    at timestamptz NOT NULL DEFAULT clock_timestamp(),reason text NOT NULL,state jsonb NOT NULL);
   CREATE TABLE IF NOT EXISTS ${this.schema}.marks(id bigserial PRIMARY KEY,campaign_id uuid NOT NULL REFERENCES ${this.schema}.campaigns(id),
    at timestamptz NOT NULL DEFAULT clock_timestamp(),block bigint NOT NULL,kind text NOT NULL,snapshot jsonb NOT NULL)`);
 }
 async locked<T>(operator:string,work:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect(),key=`conc-liq-live:4663:${operator.toLowerCase()}`;
  try{
   const got=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0]?.locked;
   assert(got,'Another live controller holds this wallet');
   try{return await work(db);}finally{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
  }finally{db.release();}
 }
 async create(db:PoolClient,state:RangeKeeperLiveState,config:unknown){
  await db.query(`INSERT INTO ${this.schema}.campaigns(id,operator,state,config) VALUES($1,$2,$3,$4)`,
   [state.id,state.operator.toLowerCase(),rangeKeeperJson(state),rangeKeeperJson(config)]);
 }
 async current(db:PoolClient,operator:string){
  const row=(await db.query(`SELECT state,config,monitor,heartbeat_at FROM ${this.schema}.campaigns
   WHERE operator=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[operator.toLowerCase()])).rows[0];
  return row?{state:parseRangeKeeperJson<RangeKeeperLiveState>(row.state),config:row.config,
   monitor:row.monitor as string[],heartbeatAt:row.heartbeat_at as string|null}:null;
 }
 async save(db:PoolClient,state:RangeKeeperLiveState,reason:string){
  const r=await db.query(`WITH updated AS (UPDATE ${this.schema}.campaigns SET state=$2,heartbeat_at=clock_timestamp(),monitor='[]'
   WHERE id=$1 RETURNING id,state) INSERT INTO ${this.schema}.transitions(campaign_id,reason,state)
   SELECT id,$3,state FROM updated`,[state.id,rangeKeeperJson(state),reason]);
  assert.equal(r.rowCount,1,'Campaign save lost its row');
 }
 async monitor(db:PoolClient,id:string,reasons:string[]){
  await db.query(`UPDATE ${this.schema}.campaigns SET monitor=$2,heartbeat_at=clock_timestamp() WHERE id=$1`,[id,rangeKeeperJson(reasons)]);
 }
 async mark(db:PoolClient,id:string,block:bigint,kind:string,snapshot:unknown){
  await db.query(`INSERT INTO ${this.schema}.marks(campaign_id,block,kind,snapshot) VALUES($1,$2,$3,$4)`,
   [id,String(block),kind,rangeKeeperJson(snapshot)]);
 }
 async pending(db:PoolClient,id:string):Promise<RangeKeeperLiveAction|null>{
  const row=(await db.query(`SELECT id,campaign_id AS "campaignId",intent,plan,before_state AS before,status,raw,hash,receipt,
   created_at AS "createdAt",broadcast_at AS "broadcastAt",error FROM ${this.schema}.actions
   WHERE campaign_id=$1 AND status IN('prepared','signed')`,[id])).rows[0];
  return row?{...row,plan:parseRangeKeeperJson<RangeKeeperTxPlan>(row.plan),
   before:parseRangeKeeperJson<RangeKeeperSnapshot>(row.before)} as RangeKeeperLiveAction:null;
 }
 async action(db:PoolClient,id:string):Promise<RangeKeeperLiveAction>{
  const row=(await db.query(`SELECT id,campaign_id AS "campaignId",intent,plan,before_state AS before,status,raw,hash,receipt,
   created_at AS "createdAt",broadcast_at AS "broadcastAt",error FROM ${this.schema}.actions WHERE id=$1`,[id])).rows[0];
  assert(row,'Unknown RangeKeeper action');
  return {...row,plan:parseRangeKeeperJson<RangeKeeperTxPlan>(row.plan),
   before:parseRangeKeeperJson<RangeKeeperSnapshot>(row.before)} as RangeKeeperLiveAction;
 }
 async prepare(db:PoolClient,state:RangeKeeperLiveState,intent:PilotIntent,plan:RangeKeeperTxPlan,before:RangeKeeperSnapshot){
  assert.equal(intent.operator.toLowerCase(),state.operator.toLowerCase());assert.equal(intent.nonce,before.nonce);
  await db.query(`INSERT INTO ${this.schema}.actions(id,campaign_id,nonce,intent,plan,before_state,status)
   VALUES($1,$2,$3,$4,$5,$6,'prepared')`,[intent.id,state.id,intent.nonce,rangeKeeperJson(intent),rangeKeeperJson(plan),rangeKeeperJson(before)]);
  const pending=await this.pending(db,state.id);assert(pending);return pending;
 }
 async signed(db:PoolClient,action:RangeKeeperLiveAction,raw:Hex){
  const hash=await verifyPilotSignature(action.intent,raw);
  const r=await db.query(`UPDATE ${this.schema}.actions SET raw=$2,hash=$3,status='signed' WHERE id=$1 AND status='prepared'`,[action.id,raw,hash]);
  assert.equal(r.rowCount,1);return {raw,hash};
 }
 async attempted(db:PoolClient,id:string,error:string|null){
  await db.query(`UPDATE ${this.schema}.actions SET broadcast_at=clock_timestamp(),error=$2 WHERE id=$1 AND status='signed'`,[id,error]);
 }
 async cancel(db:PoolClient,id:string,reason:string){
  const r=await db.query(`UPDATE ${this.schema}.actions SET status='cancelled',error=$2 WHERE id=$1 AND status='prepared'`,[id,reason]);
  assert.equal(r.rowCount,1,'Cannot cancel a signed transaction');
 }
 async finish(db:PoolClient,action:RangeKeeperLiveAction,state:RangeKeeperLiveState,receipt:unknown,status:'confirmed'|'reverted'){
  await db.query('BEGIN');try{
   const r=await db.query(`UPDATE ${this.schema}.actions SET status=$2,receipt=$3 WHERE id=$1 AND status='signed'`,
    [action.id,status,rangeKeeperJson(receipt)]);assert.equal(r.rowCount,1);
   await this.save(db,state,`${status}:${action.id}`);await this.mark(db,state.id,state.last.source.block,'receipt',receipt);
   await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}
 }
 async close(){await this.pool.end();}
}
