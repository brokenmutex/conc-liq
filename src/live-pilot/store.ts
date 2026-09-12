import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg,{type PoolClient} from 'pg';
import type {Hex} from 'viem';
import {json,type PilotState,type PilotAction,type PilotPlan,type PilotSnapshot} from './domain.js';
import {verifyPilotSignature,type PilotIntent} from './journal.js';

/** Live ledger v1. Independent of paper schema/runtime migrations. */
export class PilotStore {
 readonly pool:pg.Pool;readonly schema:string;
 constructor(connectionString:string,schema='live_pilot_v1') {
  assert(/^[a-z][a-z0-9_]{0,62}$/.test(schema));this.schema=schema;
  this.pool=new pg.Pool({connectionString,max:3,statement_timeout:15000});
 }
 async initialize(){
  await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema};
   CREATE TABLE IF NOT EXISTS ${this.schema}.version(version integer PRIMARY KEY CHECK(version=1));
   INSERT INTO ${this.schema}.version VALUES(1) ON CONFLICT DO NOTHING;
   CREATE TABLE IF NOT EXISTS ${this.schema}.campaigns(id uuid PRIMARY KEY,operator text UNIQUE NOT NULL,state jsonb NOT NULL,config jsonb NOT NULL,heartbeat_at timestamptz,monitor jsonb NOT NULL DEFAULT '[]');
   CREATE TABLE IF NOT EXISTS ${this.schema}.actions(id uuid PRIMARY KEY,campaign_id uuid NOT NULL REFERENCES ${this.schema}.campaigns(id),nonce bigint NOT NULL,
    intent jsonb NOT NULL,plan jsonb NOT NULL,before_state jsonb NOT NULL,status text NOT NULL CHECK(status IN('prepared','signed','confirmed','reverted','cancelled')),
    raw text,hash text UNIQUE,receipt jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),broadcast_at timestamptz,error text,
    CHECK((status IN('prepared','cancelled') AND raw IS NULL AND hash IS NULL) OR (status IN('signed','confirmed','reverted') AND raw IS NOT NULL AND hash IS NOT NULL)));
   CREATE UNIQUE INDEX IF NOT EXISTS one_pending ON ${this.schema}.actions(campaign_id) WHERE status IN('prepared','signed');
   CREATE UNIQUE INDEX IF NOT EXISTS one_consumed_nonce ON ${this.schema}.actions(campaign_id,nonce) WHERE status<>'cancelled';
   CREATE TABLE IF NOT EXISTS ${this.schema}.marks(id bigserial PRIMARY KEY,campaign_id uuid NOT NULL REFERENCES ${this.schema}.campaigns(id),at timestamptz NOT NULL DEFAULT clock_timestamp(),block bigint NOT NULL,kind text NOT NULL,snapshot jsonb NOT NULL);
   CREATE TABLE IF NOT EXISTS ${this.schema}.transitions(id bigserial PRIMARY KEY,campaign_id uuid NOT NULL REFERENCES ${this.schema}.campaigns(id),at timestamptz NOT NULL DEFAULT clock_timestamp(),reason text NOT NULL,state jsonb NOT NULL)`);
 }
 async locked<T>(operator:string,work:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect(),key=`conc-liq-live:4663:${operator.toLowerCase()}`;
  try{const got=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
   assert(got,'Another live controller holds this wallet');try{return await work(db);}finally{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
  }finally{db.release();}
 }
 async create(db:PoolClient,state:PilotState,config:unknown){await db.query(`INSERT INTO ${this.schema}.campaigns(id,operator,state,config) VALUES($1,$2,$3,$4)`,[state.id,state.operator.toLowerCase(),json(state),json(config)]);}
 async current(db:PoolClient,operator:string){const r=(await db.query(`SELECT state,config,monitor,heartbeat_at FROM ${this.schema}.campaigns WHERE operator=$1`,[operator.toLowerCase()])).rows[0];return r as {state:PilotState;config:unknown;monitor:string[];heartbeat_at:string}|undefined;}
 async save(db:PoolClient,state:PilotState,reason:string){
  await db.query(`WITH updated AS (UPDATE ${this.schema}.campaigns SET state=$2,heartbeat_at=clock_timestamp(),monitor='[]' WHERE id=$1 RETURNING id,state)
   INSERT INTO ${this.schema}.transitions(campaign_id,reason,state) SELECT id,$3,state FROM updated`,[state.id,json(state),reason]);
 }
 async monitor(db:PoolClient,id:string,reasons:string[]){await db.query(`UPDATE ${this.schema}.campaigns SET monitor=$2,heartbeat_at=clock_timestamp() WHERE id=$1`,[id,json(reasons)]);}
 async mark(db:PoolClient,id:string,block:string,kind:string,snapshot:unknown){await db.query(`INSERT INTO ${this.schema}.marks(campaign_id,block,kind,snapshot) VALUES($1,$2,$3,$4)`,[id,block,kind,json(snapshot)]);}
 async pending(db:PoolClient,id:string){const r=(await db.query(`SELECT id,campaign_id AS "campaignId",intent,plan,before_state AS before,status,raw,hash,receipt,created_at AS "createdAt",broadcast_at AS "broadcastAt",error FROM ${this.schema}.actions WHERE campaign_id=$1 AND status IN('prepared','signed')`,[id])).rows[0];return r as PilotAction|undefined;}
 async prepare(db:PoolClient,state:PilotState,intent:PilotIntent,plan:PilotPlan,before:PilotSnapshot){
  assert.equal(intent.operator.toLowerCase(),state.operator.toLowerCase());assert.equal(intent.nonce,before.nonce);
  await db.query(`INSERT INTO ${this.schema}.actions(id,campaign_id,nonce,intent,plan,before_state,status) VALUES($1,$2,$3,$4,$5,$6,'prepared')`,[intent.id,state.id,intent.nonce,json(intent),json(plan),json(before)]);
  return (await this.pending(db,state.id))!;
 }
 async signed(db:PoolClient,action:PilotAction,raw:Hex){const hash=await verifyPilotSignature(action.intent,raw);
  const r=await db.query(`UPDATE ${this.schema}.actions SET raw=$2,hash=$3,status='signed' WHERE id=$1 AND status='prepared'`,[action.id,raw,hash]);assert.equal(r.rowCount,1);return {raw,hash};}
 async attempted(db:PoolClient,id:string,error:string|null){await db.query(`UPDATE ${this.schema}.actions SET broadcast_at=clock_timestamp(),error=$2 WHERE id=$1 AND status='signed'`,[id,error]);}
 async cancel(db:PoolClient,id:string,reason:string){const r=await db.query(`UPDATE ${this.schema}.actions SET status='cancelled',error=$2 WHERE id=$1 AND status='prepared'`,[id,reason]);assert.equal(r.rowCount,1,'Cannot cancel a signed transaction');}
 async finish(db:PoolClient,action:PilotAction,state:PilotState,receipt:unknown,status:'confirmed'|'reverted'){
  await db.query('BEGIN');try {
   const r=await db.query(`UPDATE ${this.schema}.actions SET status=$2,receipt=$3 WHERE id=$1 AND status='signed'`,[action.id,status,json(receipt)]);assert.equal(r.rowCount,1);
   await this.save(db,state,`${status}:${action.id}`);await this.mark(db,state.id,state.last.block,'receipt',receipt);await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}
 }
 async close(){await this.pool.end();}
}
export const newPilotId=()=>randomUUID();
