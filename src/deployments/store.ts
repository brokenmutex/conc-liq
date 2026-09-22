import {randomUUID} from 'node:crypto';
import pg,{type PoolClient} from 'pg';
import {assertDeploymentSchemaReady} from '../storage/compatibility.js';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../paper/execution-abi.js';
import {acceptInput,allocationSchema,contentHash,draftInput,parseStrategyParameters,previewDigest,previewInput,
 strategyId,type AcceptInput,type DraftInput,type PreviewInput} from './contracts.js';
import {marketProfileEvidenceSchema,marketProfileSchema,referenceProofHash,verifiedMarketProfileSchema,
 type VerifiedMarketProfile} from './market-profile.js';

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

 /** Called only with a fresh canonical proof from verifyMarketProfile. The
  * indexer identity must agree before a profile can enter the draft catalog. */
 async registerVerifiedMarketProfile(raw:VerifiedMarketProfile){
  const proof=verifiedMarketProfileSchema.parse(raw),p=proof.profile.pool;
  const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  if(proof.profileHash!==contentHash(proof.profile))throw new DeploymentConflict('profile_hash_mismatch');
  if(Date.now()-Date.parse(proof.verifiedAt)>300_000||Date.parse(proof.verifiedAt)>Date.now()+30_000)
   throw new DeploymentConflict('profile_proof_stale');
  if(Math.abs(Date.now()-proof.source.timestamp*1000)>180_000)throw new DeploymentConflict('profile_source_stale');
  if(!same(p.factory,UNISWAP_V3_FACTORY)||!same(p.positionManager,NONFUNGIBLE_POSITION_MANAGER)||
   !same(p.router,PAPER_ROUTER)||!same(p.quoter,PAPER_QUOTER))
   throw new DeploymentConflict('unsupported_deployment_contract');
  for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
   if(!same(p[key],proof.contractHashes[key]))throw new DeploymentConflict('profile_code_hash_mismatch');
  if(BigInt(proof.references.price0)<=0n||BigInt(proof.references.price1)<=0n||BigInt(proof.references.nativePrice)<=0n)
   throw new DeploymentConflict('profile_reference_unavailable');
  if(referenceProofHash(proof.referenceProof)!==proof.references.proofHash)
   throw new DeploymentConflict('profile_reference_proof_mismatch');
  return this.transaction(async db=>{
   const row=(await db.query<{target_set_hash:string;created_block:string}>(`SELECT target_set_hash,
    created_block::text FROM indexer_pools WHERE stream_key=$1 AND lower(pool_address)=lower($2)
    AND chain_id=$3 AND fee=$4 AND enabled=true AND lower(rwa_address)=lower($5)`,
    [proof.streamKey,p.pool,p.chainId,p.fee,p.quoteToken===0?p.token1:p.token0])).rows[0];
   if(!row||BigInt(row.created_block)>BigInt(proof.source.block))throw new DeploymentConflict('indexer_pool_unverified');
   const evidence={verificationClass:'canonical_chain_and_independent_reference_v1',
    source:proof.source,streamKey:proof.streamKey,indexerTargetSetHash:row.target_set_hash,
    contractHashes:proof.contractHashes,references:proof.references,referenceProof:proof.referenceProof};
   const id=randomUUID();
   const inserted=(await db.query<{id:string}>(`INSERT INTO deployment_market_profiles
    (id,chain_id,pool_address,token0_address,token1_address,token0_decimals,token1_decimals,
     quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp())
    ON CONFLICT(chain_id,pool_address,profile_hash) DO NOTHING RETURNING id`,
    [id,p.chainId,p.pool.toLowerCase(),p.token0.toLowerCase(),p.token1.toLowerCase(),p.decimals0,p.decimals1,
     p.quoteToken,p.fee,p.tickSpacing,JSON.stringify(proof.profile),JSON.stringify(evidence),proof.profileHash])).rows[0];
   if(inserted)return {id:inserted.id,created:true};
   const existing=(await db.query<{id:string;retired_at:Date|null}>(`SELECT id,retired_at FROM deployment_market_profiles
    WHERE chain_id=$1 AND pool_address=$2 AND profile_hash=$3`,[p.chainId,p.pool.toLowerCase(),proof.profileHash])).rows[0];
   if(!existing||existing.retired_at)throw new DeploymentConflict('market_profile_unavailable');
   return {id:existing.id,created:false};
  });
 }

 async createDraft(raw:DraftInput){
  const input=draftInput.parse(raw),id=randomUUID(),wallet=input.wallet.toLowerCase();
  const config={...parseStrategyParameters(input.strategyId,input.config),strategyId:input.strategyId,strategyVersion:input.strategyVersion,
   stateSchemaVersion:input.stateSchemaVersion};
  const configHash=contentHash(config);
  return this.transaction(async db=>{
   const profile=(await db.query<{chain_id:number;retired_at:Date|null;profile:unknown;evidence:Record<string,unknown>;
    profile_hash:string;pool_address:string;token0_address:string;token1_address:string;fee:number}>(
    `SELECT chain_id,retired_at,profile,evidence,profile_hash,pool_address,token0_address,token1_address,fee
     FROM deployment_market_profiles WHERE id=$1 FOR SHARE`,[input.marketProfileId])).rows[0];
   if(!profile||profile.retired_at||profile.chain_id!==input.chainId)throw new DeploymentConflict('market_profile_unavailable');
   const parsed=marketProfileSchema.safeParse(profile.profile),evidence=marketProfileEvidenceSchema.safeParse(profile.evidence);
   if(!parsed.success||!evidence.success||
    contentHash(parsed.data)!==profile.profile_hash||parsed.data.pool.pool.toLowerCase()!==profile.pool_address.toLowerCase()||
    parsed.data.pool.token0.toLowerCase()!==profile.token0_address.toLowerCase()||
    parsed.data.pool.token1.toLowerCase()!==profile.token1_address.toLowerCase()||parsed.data.pool.fee!==profile.fee)
    throw new DeploymentConflict('market_profile_integrity');
   if(referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash)
    throw new DeploymentConflict('market_profile_integrity');
   for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
    if(parsed.data.pool[key].toLowerCase()!==evidence.data.contractHashes[key].toLowerCase())
     throw new DeploymentConflict('market_profile_integrity');
   const known=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
    WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=$3 AND fee=$4 AND enabled=true
    AND target_set_hash=$5 AND lower(rwa_address)=lower($6)) AS found`,[evidence.data.streamKey,
     profile.pool_address,profile.chain_id,profile.fee,evidence.data.indexerTargetSetHash,
     parsed.data.pool.quoteToken===0?parsed.data.pool.token1:parsed.data.pool.token0])).rows[0]?.found;
   if(!known)throw new DeploymentConflict('market_profile_indexer_changed');
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

 /** Read-only input for paper preflight. Configuration and profile bytes are
  * revalidated at the read boundary; no legacy state or live signer is read. */
 async paperDraft(id:string){
  const row=(await this.readPool.query<{id:string;current_revision:number;allocation:unknown;
   chain_id:number;profile:unknown;evidence:unknown;profile_hash:string;config:unknown;config_hash:string;
   strategy_id:string;strategy_version:string;state_schema_version:number}>(`
   SELECT c.id,c.current_revision,c.allocation,c.chain_id,p.profile,p.evidence,p.profile_hash,
    r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version
   FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
   WHERE c.id=$1 AND c.mode='paper' AND c.lifecycle='draft' AND p.retired_at IS NULL`,[id])).rows[0];
  if(!row)throw new DeploymentConflict('paper_draft_unavailable');
  const profile=marketProfileSchema.safeParse(row.profile),evidence=marketProfileEvidenceSchema.safeParse(row.evidence);
  if(!profile.success||!evidence.success||profile.data.pool.chainId!==row.chain_id||
   contentHash(profile.data)!==row.profile_hash||
   referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash)
   throw new DeploymentConflict('market_profile_integrity');
  for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
   if(profile.data.pool[key].toLowerCase()!==evidence.data.contractHashes[key].toLowerCase())
    throw new DeploymentConflict('market_profile_integrity');
  const known=(await this.readPool.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
   WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=$3 AND fee=$4 AND enabled=true
    AND target_set_hash=$5 AND lower(rwa_address)=lower($6)) AS found`,[evidence.data.streamKey,
    profile.data.pool.pool,row.chain_id,profile.data.pool.fee,evidence.data.indexerTargetSetHash,
    profile.data.pool.quoteToken===0?profile.data.pool.token1:profile.data.pool.token0])).rows[0]?.found;
  if(!known)throw new DeploymentConflict('market_profile_indexer_changed');
  if(!row.config||typeof row.config!=='object'||Array.isArray(row.config)||contentHash(row.config)!==row.config_hash)
   throw new DeploymentConflict('campaign_config_integrity');
  const config=row.config as Record<string,unknown>,idParsed=strategyId.safeParse(row.strategy_id);
  if(!idParsed.success||config.strategyId!==row.strategy_id||config.strategyVersion!==row.strategy_version||
   config.stateSchemaVersion!==row.state_schema_version)throw new DeploymentConflict('campaign_config_integrity');
  const {strategyId:_id,strategyVersion:_version,stateSchemaVersion:_schema,...parameters}=config;
  parseStrategyParameters(idParsed.data,parameters);
  return {id:row.id,revision:row.current_revision,allocation:allocationSchema.parse(row.allocation),
   profile:profile.data,profileHash:row.profile_hash,evidence:evidence.data,
   strategyId:idParsed.data,strategyVersion:row.strategy_version,stateSchemaVersion:row.state_schema_version,
   parameters,configHash:row.config_hash};
 }

 async listMarketProfiles(){
  const rows=(await this.readPool.query<{id:string;chain_id:number;profile:unknown;evidence:unknown;
   profile_hash:string;verified_at:Date;retired_at:Date|null;indexed:boolean}>(`
   SELECT p.id,p.chain_id,p.profile,p.evidence,p.profile_hash,p.verified_at,p.retired_at,
    COALESCE(i.enabled AND i.target_set_hash=(p.evidence->>'indexerTargetSetHash')
     AND lower(i.rwa_address)=lower(CASE WHEN p.quote_token=0 THEN p.token1_address ELSE p.token0_address END),false) AS indexed
   FROM deployment_market_profiles p LEFT JOIN indexer_pools i
    ON i.stream_key=p.evidence->>'streamKey' AND lower(i.pool_address)=lower(p.pool_address)
     AND i.chain_id=p.chain_id AND i.fee=p.fee
   ORDER BY p.verified_at DESC,p.id LIMIT 100`)).rows;
  return rows.map(row=>{
   const profile=marketProfileSchema.safeParse(row.profile),evidence=marketProfileEvidenceSchema.safeParse(row.evidence);
   const valid=profile.success&&evidence.success&&profile.data.pool.chainId===row.chain_id&&
    contentHash(profile.data)===row.profile_hash&&
    referenceProofHash(evidence.data.referenceProof)===evidence.data.references.proofHash&&
    (['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
     .every(key=>profile.data.pool[key].toLowerCase()===evidence.data.contractHashes[key].toLowerCase());
   const p=profile.success?profile.data.pool:null;
   return {id:row.id,chainId:row.chain_id,pool:p?.pool??null,token0:p?.token0??null,token1:p?.token1??null,
    decimals0:p?.decimals0??null,decimals1:p?.decimals1??null,quoteToken:p?.quoteToken??null,
    fee:p?.fee??null,tickSpacing:p?.tickSpacing??null,
    reference0:p?.reference0??null,reference1:p?.reference1??null,
    verifiedAt:row.verified_at,source:valid?evidence.data.source:null,
    draftAvailable:valid&&row.retired_at===null&&row.indexed,
    deploymentAvailable:false,
    reason:!valid?'profile_integrity':row.retired_at?'retired':!row.indexed?'indexer_identity_changed':
     'fresh_preflight_and_execution_unavailable'};
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
