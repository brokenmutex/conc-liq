import {randomUUID} from 'node:crypto';
import pg,{type PoolClient} from 'pg';
import {assertDeploymentSchemaReady} from '../storage/compatibility.js';
import {acceptInput,contentHash,draftInput,parseStrategyParameters,previewDigest,previewInput,type AcceptInput,type DraftInput,type PreviewInput} from './contracts.js';

export class DeploymentConflict extends Error {
 constructor(public readonly code:string){super(code);}
}

/** The new command ledger. It owns no signer and performs no startup DDL. */
export class DeploymentStore {
 private readonly pool:pg.Pool;
 private readonly readPool:pg.Pool;
 constructor(connectionString:string){
  this.pool=new pg.Pool({connectionString,max:3,statement_timeout:15000});
  const readUrl=new URL(connectionString);
  readUrl.searchParams.set('options',`${readUrl.searchParams.get('options')??''} -c default_transaction_read_only=on`.trim());
  this.readPool=new pg.Pool({connectionString:readUrl.toString(),max:2,statement_timeout:15000});
 }
 async assertReady(){await assertDeploymentSchemaReady(this.readPool);}
 async close(){await Promise.all([this.pool.end(),this.readPool.end()]);}

 private async transaction<T>(work:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect();
  try{
   await db.query('BEGIN');
   try{const value=await work(db);await db.query('COMMIT');return value;}
   catch(error){await db.query('ROLLBACK');throw error;}
  }finally{db.release();}
 }

 async createDraft(raw:DraftInput){
  const input=draftInput.parse(raw),id=randomUUID(),wallet=input.wallet.toLowerCase();
  const config={...parseStrategyParameters(input.strategyId,input.config),strategyId:input.strategyId,strategyVersion:input.strategyVersion,
   stateSchemaVersion:input.stateSchemaVersion};
  const configHash=contentHash(config);
  return this.transaction(async db=>{
   const profile=(await db.query<{chain_id:number;retired_at:Date|null}>(
    'SELECT chain_id,retired_at FROM deployment_market_profiles WHERE id=$1 FOR SHARE',[input.marketProfileId])).rows[0];
   if(!profile||profile.retired_at||profile.chain_id!==input.chainId)throw new DeploymentConflict('market_profile_unavailable');
   await db.query(`INSERT INTO deployment_campaigns
    (id,mode,chain_id,wallet,market_profile_id,allocation,lifecycle,current_revision)
    VALUES($1,$2,$3,$4,$5,$6,'draft',1)`,
    [id,input.mode,input.chainId,wallet,input.marketProfileId,JSON.stringify(input.allocation)]);
   await db.query(`INSERT INTO deployment_revisions
    (campaign_id,revision,parent_revision,strategy_id,strategy_version,state_schema_version,config,config_hash)
    VALUES($1,1,NULL,$2,$3,$4,$5,$6)`,
    [id,input.strategyId,input.strategyVersion,input.stateSchemaVersion,JSON.stringify(config),configHash]);
   return {id,revision:1,configHash};
  });
 }

 /** Only a trusted preflight service may create a preview. HTTP never supplies
  * proposal/evidence; it supplies only the operator's requested action. */
 async recordPreview(raw:PreviewInput){
  const input=previewInput.parse(raw),id=randomUUID(),digest=previewDigest(input);
  const remainingMs=input.expiresAt.getTime()-Date.now();
  if(remainingMs<=0)throw new DeploymentConflict('preview_expired');
  if(remainingMs>120_000)throw new DeploymentConflict('preview_expiry_too_distant');
  return this.transaction(async db=>{
   const campaign=(await db.query<{current_revision:number}>(
    'SELECT current_revision FROM deployment_campaigns WHERE id=$1 FOR SHARE',[input.campaignId])).rows[0];
   if(!campaign||campaign.current_revision!==input.expectedRevision)throw new DeploymentConflict('stale_revision');
   await db.query(`INSERT INTO deployment_previews
    (id,campaign_id,expected_revision,kind,request,proposal,evidence,content_digest,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id,input.campaignId,input.expectedRevision,input.kind,JSON.stringify(input.request),
     JSON.stringify(input.proposal),JSON.stringify(input.evidence),digest,input.expiresAt]);
   return {id,contentDigest:digest,expiresAt:input.expiresAt};
  });
 }

 async acceptOperation(campaignId:string,raw:AcceptInput,actor:string){
  const input=acceptInput.parse(raw);
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(actor))throw new DeploymentConflict('invalid_actor');
  const requestDigest=contentHash({campaignId,previewId:input.previewId,
   contentDigest:input.contentDigest,expectedRevision:input.expectedRevision});
  return this.transaction(async db=>{
   const campaign=(await db.query<{mode:'paper'|'live';chain_id:number;wallet:string;current_revision:number;lifecycle:string}>(
    'SELECT mode,chain_id,wallet,current_revision,lifecycle FROM deployment_campaigns WHERE id=$1 FOR UPDATE',[campaignId])).rows[0];
   if(!campaign)throw new DeploymentConflict('campaign_not_found');
   const existing=(await db.query<{id:string;request_digest:string;status:string}>(
    'SELECT id,request_digest,status FROM deployment_operations WHERE campaign_id=$1 AND idempotency_key=$2',
    [campaignId,input.idempotencyKey])).rows[0];
   if(existing){
    if(existing.request_digest!==requestDigest)throw new DeploymentConflict('idempotency_conflict');
    return {id:existing.id,status:existing.status,replayed:true};
   }
   if(campaign.current_revision!==input.expectedRevision)throw new DeploymentConflict('stale_revision');
   const preview=(await db.query<{kind:string;expected_revision:number;content_digest:string;expires_at:Date}>(
    `SELECT kind,expected_revision,content_digest,expires_at FROM deployment_previews
     WHERE id=$1 AND campaign_id=$2 FOR UPDATE`,[input.previewId,campaignId])).rows[0];
   if(!preview||preview.expected_revision!==campaign.current_revision||preview.content_digest!==input.contentDigest)
    throw new DeploymentConflict('stale_preview');
   if(preview.expires_at.getTime()<=Date.now())throw new DeploymentConflict('preview_expired');
   const pending=(await db.query<{id:string}>(`SELECT id FROM deployment_operations WHERE campaign_id=$1 AND status IN
    ('queued','preflighting','executing','confirming','reconciling','blocked') LIMIT 1`,[campaignId])).rows[0];
   if(pending)throw new DeploymentConflict('operation_in_progress');
   if(preview.kind==='open'&&campaign.lifecycle!=='draft')throw new DeploymentConflict('invalid_lifecycle');
   if(preview.kind!=='open'&&campaign.lifecycle==='draft')throw new DeploymentConflict('invalid_lifecycle');
   if(campaign.lifecycle==='closed')throw new DeploymentConflict('campaign_closed');
   if(campaign.mode==='live'&&preview.kind==='open')await this.reserveLiveWallet(db,campaignId,campaign.chain_id,campaign.wallet);
   const id=randomUUID();
   await db.query(`INSERT INTO deployment_operations
    (id,campaign_id,preview_id,actor,idempotency_key,request_digest,kind,status,stage)
    VALUES($1,$2,$3,$4,$5,$6,$7,'queued','accepted')`,
    [id,campaignId,input.previewId,actor,input.idempotencyKey,requestDigest,preview.kind]);
   await db.query(`UPDATE deployment_campaigns SET lifecycle=$2,updated_at=clock_timestamp() WHERE id=$1`,
    [campaignId,preview.kind==='open'?'opening':preview.kind.startsWith('close_')?'closing':campaign.lifecycle]);
   return {id,status:'queued',replayed:false};
  });
 }

 /** Claims only a persisted operation. A recovered claim retains its stage so
  * the worker can reconcile the linked signed intent before any new action. */
 async claimNext(workerId:string,leaseSeconds:number,mode:'paper'|'live'){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>300)throw new DeploymentConflict('invalid_lease');
  if(mode!=='paper'&&mode!=='live')throw new DeploymentConflict('invalid_worker_mode');
  return this.transaction(async db=>{
   const result=await db.query<{id:string;campaign_id:string;status:string;stage:string;attempts:number}>(`
    WITH candidate AS (
      SELECT o.id FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
      WHERE c.mode=$3 AND o.status IN ('queued','preflighting','executing','confirming','reconciling')
        AND (o.claim_until IS NULL OR o.claim_until<clock_timestamp())
      ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1
    )
    UPDATE deployment_operations o SET
      claimed_by=$1,claim_until=clock_timestamp()+($2::integer*interval '1 second'),
      attempts=o.attempts+1,status=CASE WHEN o.status='queued' THEN 'preflighting' ELSE o.status END,
      updated_at=clock_timestamp()
    FROM candidate WHERE o.id=candidate.id
    RETURNING o.id,o.campaign_id,o.status,o.stage,o.attempts`,[workerId,leaseSeconds,mode]);
   return result.rows[0]??null;
  });
 }

 async operation(id:string){
  const result=await this.readPool.query<{id:string;campaign_id:string;kind:string;status:string;stage:string;
   reason:string|null;attempts:number;created_at:Date;updated_at:Date}>(
   `SELECT id,campaign_id,kind,status,stage,reason,attempts,created_at,updated_at
    FROM deployment_operations WHERE id=$1`,[id]);
  return result.rows[0]??null;
 }

 async advanceClaim(id:string,workerId:string,stage:string,
  status:'preflighting'|'executing'|'confirming'|'reconciling'|'blocked',
  reason:string|null){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId)||!/^[a-z][a-z0-9_]{0,63}$/.test(stage))
   throw new DeploymentConflict('invalid_claim_transition');
  const prior:{[key:string]:string[]}={
   preflighting:['preflighting'],executing:['preflighting','executing'],
   confirming:['executing','confirming'],reconciling:['executing','confirming','reconciling'],
   blocked:['preflighting','executing','confirming','reconciling'],
  };
  const allowed=prior[status];
  if(!allowed)throw new DeploymentConflict('invalid_claim_transition');
  const result=await this.pool.query(`UPDATE deployment_operations SET status=$3,stage=$4,reason=$5,
   claimed_by=CASE WHEN $3='blocked' THEN NULL ELSE claimed_by END,
   claim_until=CASE WHEN $3='blocked' THEN NULL ELSE claim_until END,
   updated_at=clock_timestamp()
   WHERE id=$1 AND claimed_by=$2 AND claim_until>=clock_timestamp() AND
     status=ANY($6::text[]) RETURNING id`,
   [id,workerId,status,stage,reason,allowed]);
  if(result.rowCount!==1)throw new DeploymentConflict('claim_lost_or_transition_disallowed');
 }

 async renewClaim(id:string,workerId:string,leaseSeconds:number){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId)||!Number.isSafeInteger(leaseSeconds)||
   leaseSeconds<5||leaseSeconds>300)throw new DeploymentConflict('invalid_lease');
  const result=await this.pool.query(`UPDATE deployment_operations SET
   claim_until=clock_timestamp()+($3::integer*interval '1 second'),updated_at=clock_timestamp()
   WHERE id=$1 AND claimed_by=$2 AND claim_until>=clock_timestamp() AND
    status IN ('preflighting','executing','confirming','reconciling') RETURNING id`,
   [id,workerId,leaseSeconds]);
  if(result.rowCount!==1)throw new DeploymentConflict('claim_lost');
 }

 private async reserveLiveWallet(db:PoolClient,campaignId:string,chainId:number,wallet:string){
  const key=`conc-liq-live:${chainId}:${wallet}`;
  const locked=(await db.query<{locked:boolean}>(
   'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[key])).rows[0]?.locked;
  if(!locked)throw new DeploymentConflict('predecessor_wallet_locked');
  for(const schema of ['rangekeeper_v1','live_pilot_v1']){
   const exists=(await db.query<{present:string|null}>('SELECT to_regclass($1) AS present',[`${schema}.campaigns`])).rows[0]?.present;
   if(!exists)continue;
   const current=(await db.query<{active:boolean}>(`SELECT EXISTS (
    SELECT 1 FROM ${schema}.campaigns WHERE lower(operator)=$1 AND coalesce(state->>'phase','unknown')<>'closed'
   ) AS active`,[wallet])).rows[0]?.active;
   if(current)throw new DeploymentConflict('predecessor_custody_unresolved');
   const unresolved=(await db.query<{active:boolean}>(`SELECT EXISTS (
    SELECT 1 FROM ${schema}.actions a JOIN ${schema}.campaigns c ON c.id=a.campaign_id
    WHERE lower(c.operator)=$1 AND a.status IN ('prepared','signed')
   ) AS active`,[wallet])).rows[0]?.active;
   if(unresolved)throw new DeploymentConflict('predecessor_intent_unresolved');
  }
  try{await db.query(`INSERT INTO deployment_wallet_reservations(chain_id,wallet,campaign_id) VALUES($1,$2,$3)`,
   [chainId,wallet,campaignId]);}
  catch(error){if((error as {code?:string}).code==='23505')throw new DeploymentConflict('wallet_reserved');throw error;}
 }
}
