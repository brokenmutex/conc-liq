import {randomUUID} from 'node:crypto';
import pg,{type PoolClient} from 'pg';
import {assertDeploymentSchemaReady} from '../storage/compatibility.js';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../paper/execution-abi.js';
import {acceptInput,allocationSchema,contentHash,draftInput,parseStrategyParameters,previewDigest,previewInput,
 strategyId,type AcceptInput,type DraftInput,type PreviewInput} from './contracts.js';
import {marketProfileEvidenceSchema,marketProfileSchema,referenceProofHash,verifiedMarketProfileSchema,
 type VerifiedMarketProfile} from './market-profile.js';
import {PAPER_STATIC_GAS_PATH,costIndicativePaperOpenPreview,type PaperGasProfileRow} from './paper-cost.js';
import {PAPER_STATIC_GAS_STAGES} from './paper-cost.js';
import {buildIndicativePaperOpenPreview} from './paper-preview.js';
import {buildPaperOpenModel,paperOpenModelSchema} from './paper-open-model.js';
import {verifyPaperGasEvidence} from './paper-gas-evidence.js';
import {z} from 'zod';

const paperGasAttestationSchema=z.object({
 verificationClass:z.literal('canonical_candidate_replay_v1'),
 reportHash:z.string().regex(/^[0-9a-f]{64}$/),
 sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 verifiedAt:z.iso.datetime({offset:true}),
}).strict();

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

 /** Bounded, read-only calibration lookup. The resolver validates each model,
  * source identity, freshness and complete stage set before exposing costs. */
 async paperGasProfiles(poolAddress:string):Promise<PaperGasProfileRow[]>{
  return (await this.readPool.query<PaperGasProfileRow>(`
   SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
    allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
    evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
    observed_until AS "observedUntil"
   FROM deployment_calibration_profiles
   WHERE chain_id=4663 AND lower(pool_address)=lower($1) AND path_version=$2
    AND component='gas_units' AND allowance_state='zero'
   ORDER BY size_band,stage,version DESC LIMIT 201`,[poolAddress,PAPER_STATIC_GAS_PATH])).rows;
 }

 /** Trusted ingestion after verifyPaperGasSource has replayed the candidate
  * on canonical chain data. Gas estimates remain provisional fork evidence. */
 async registerPaperGasEvidence(raw:unknown,rawAttestation:unknown){
  const report=verifyPaperGasEvidence(raw),attestation=paperGasAttestationSchema.parse(rawAttestation);
  const source=report.source as {block:string;hash:string;timestamp:number};
  const profile=marketProfileSchema.parse(report.profile),sampledAt=Date.parse(report.sampledAt as string);
  const now=Date.now(),verifiedAt=Date.parse(attestation.verifiedAt);
  if(attestation.reportHash!==report.reportHash||attestation.sourceHash.toLowerCase()!==source.hash.toLowerCase()||
   attestation.profileHash!==report.profileHash)throw new DeploymentConflict('paper_gas_attestation_mismatch');
  if(now-sampledAt<0||now-sampledAt>86_400_000||verifiedAt<sampledAt||
   now-verifiedAt<0||now-verifiedAt>300_000||sampledAt-source.timestamp*1000<0||
   sampledAt-source.timestamp*1000>180_000)
   throw new DeploymentConflict('paper_gas_evidence_stale');
  const candidate=report.candidate as {deployedValue:string;dilutedSharePpm:string;
   range:{tickLower:number;tickUpper:number}};
  const sizeBand=`exact_${contentHash({pool:profile.pool.pool.toLowerCase(),
   value:candidate.deployedValue,share:candidate.dilutedSharePpm,
   lower:candidate.range.tickLower,upper:candidate.range.tickUpper}).slice(0,32)}`;
  return this.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`deployment-paper-gas:${profile.pool.pool.toLowerCase()}:${sizeBand}`]);
   const known=(await db.query<{id:string;profile:unknown;evidence:unknown;retired_at:Date|null}>(`
    SELECT id,profile,evidence,retired_at FROM deployment_market_profiles
    WHERE chain_id=4663 AND lower(pool_address)=lower($1) AND profile_hash=$2 FOR SHARE`,
    [profile.pool.pool,report.profileHash])).rows[0];
   if(!known||known.retired_at||contentHash(known.profile)!==report.profileHash)
    throw new DeploymentConflict('paper_gas_market_profile_unavailable');
   const evidence=marketProfileEvidenceSchema.safeParse(known.evidence);
   if(!evidence.success)throw new DeploymentConflict('paper_gas_market_profile_unavailable');
   for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
    if(profile.pool[key].toLowerCase()!==evidence.data.contractHashes[key].toLowerCase())
     throw new DeploymentConflict('paper_gas_market_profile_integrity');
   const indexed=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
    WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=4663 AND fee=$3
     AND enabled=true AND target_set_hash=$4 AND lower(rwa_address)=lower($5)
     AND created_block<=$6::numeric) AS found`,
    [evidence.data.streamKey,profile.pool.pool,profile.pool.fee,evidence.data.indexerTargetSetHash,
     profile.pool.quoteToken===0?profile.pool.token1:profile.pool.token0,source.block])).rows[0]?.found;
   if(!indexed)throw new DeploymentConflict('paper_gas_indexer_changed');
   const previous=(await db.query<{id:string;stage:string;version:number;validation:Record<string,unknown>;
    observed_until:Date|null}>(`
    SELECT DISTINCT ON (stage) id,stage,version,validation,observed_until
    FROM deployment_calibration_profiles WHERE chain_id=4663 AND lower(pool_address)=lower($1)
     AND path_version=$2 AND allowance_state='zero' AND size_band=$3 AND component='gas_units'
    ORDER BY stage,version DESC`,[profile.pool.pool,PAPER_STATIC_GAS_PATH,sizeBand])).rows;
   const matching=previous.filter(row=>row.validation?.reportHash===report.reportHash);
   if(matching.length){
    if(matching.length!==PAPER_STATIC_GAS_STAGES.length||previous.length!==PAPER_STATIC_GAS_STAGES.length||
     matching.some(row=>row.version!==matching[0]!.version))
     throw new DeploymentConflict('paper_gas_partial_previous_import');
    return {created:false,version:matching[0]!.version,profileIds:matching.map(row=>row.id),
     reportHash:report.reportHash,sizeBand};
   }
   const older=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1
    FROM deployment_calibration_profiles WHERE chain_id=4663 AND lower(pool_address)=lower($1)
     AND path_version=$2 AND allowance_state='zero' AND size_band=$3 AND component='gas_units'
     AND validation->>'reportHash'=$4) AS found`,
    [profile.pool.pool,PAPER_STATIC_GAS_PATH,sizeBand,report.reportHash])).rows[0]?.found;
   if(older)throw new DeploymentConflict('paper_gas_report_superseded');
   if(previous.some(row=>row.observed_until&&sampledAt<=row.observed_until.getTime()))
    throw new DeploymentConflict('paper_gas_sample_not_newer');
   const version=previous.reduce((max,row)=>Math.max(max,row.version),0)+1;
   const profileIds:string[]=[];
   for(const rawStage of report.stageProfiles as Record<string,unknown>[]){
    const id=randomUUID(),stage=rawStage.stage as string;
    const validation={validationPolicy:'calibration_v1',statusReason:'one_owned_fork_sample',
     sampleCount:1,distinctCampaigns:0,reportHash:report.reportHash,
     canonicalAttestation:attestation,localEvidence:rawStage.evidence};
    await db.query(`INSERT INTO deployment_calibration_profiles
     (id,version,chain_id,pool_address,path_version,stage,allowance_state,size_band,
      component,status,evidence_class,model,validation,source_hash,observed_until)
     VALUES($1,$2,4663,$3,$4,$5,'zero',$6,'gas_units','provisional','fork_estimated',
      $7,$8,$9,$10)`,[id,version,profile.pool.pool.toLowerCase(),PAPER_STATIC_GAS_PATH,
      stage,sizeBand,JSON.stringify(rawStage.model),JSON.stringify(validation),rawStage.sourceHash,
      report.sampledAt]);
    profileIds.push(id);
   }
   return {created:true,version,profileIds,reportHash:report.reportHash,sizeBand};
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

 /** Commits one modeled paper open under the operation claim. It writes no
  * transaction intent, paid gas, or net economics. Retrying a committed open
  * returns its existing mark without appending capital twice. */
 async completeTrustedPaperOpen(operationId:string,workerId:string){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  return this.transaction(async db=>{
   const row=(await db.query<{id:string;campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_until:Date|null;mode:string;lifecycle:string;current_revision:number;
    allocation:unknown;profile:unknown;profile_hash:string;config:unknown;config_hash:string;
    strategy_id:string;strategy_version:string;state_schema_version:number;
    proposal:Record<string,unknown>;request:Record<string,unknown>;evidence:Record<string,unknown>;
    content_digest:string;expected_revision:number;expires_at:Date}>(`
    SELECT o.id,o.campaign_id,o.preview_id,o.kind,o.status,o.claimed_by,o.claim_until,
     c.mode,c.lifecycle,c.current_revision,c.allocation,p.profile,p.profile_hash,
     r.config,r.config_hash,r.strategy_id,r.strategy_version,r.state_schema_version,
     v.proposal,v.request,v.evidence,v.content_digest,v.expected_revision,v.expires_at
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_previews v ON v.id=o.preview_id
    WHERE o.id=$1 FOR UPDATE OF o,c`,[operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='open')throw new DeploymentConflict('paper_open_operation_unavailable');
   if(row.status==='succeeded'){
    const existing=(await db.query<{id:string}>(`SELECT id::text FROM deployment_marks
     WHERE campaign_id=$1 AND provenance->>'operationId'=$2 LIMIT 2`,
     [row.campaign_id,operationId])).rows;
    if(existing.length!==1)throw new DeploymentConflict('paper_open_replay_integrity');
    return {markId:existing[0]!.id,replayed:true};
   }
   if(row.lifecycle!=='opening'||row.status!=='reconciling'||row.claimed_by!==workerId||
    !row.claim_until||row.claim_until.getTime()<Date.now())throw new DeploymentConflict('paper_open_claim_lost');
   if(row.current_revision!==row.expected_revision||row.expires_at.getTime()<=Date.now())
    throw new DeploymentConflict('paper_open_preview_stale');
   if(previewDigest({campaignId:row.campaign_id,expectedRevision:row.expected_revision,kind:'open',
    request:row.request,proposal:row.proposal,evidence:row.evidence,expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('paper_open_preview_integrity');
   const parsed=paperOpenModelSchema.safeParse(row.proposal.paperOpenModel);
   if(!parsed.success)throw new DeploymentConflict('paper_open_model_unavailable');
   const model=parsed.data,profile=marketProfileSchema.safeParse(row.profile);
   if(!profile.success||model.campaignId!==row.campaign_id||model.revision!==row.current_revision||
    model.profileHash!==row.profile_hash||contentHash(row.profile)!==row.profile_hash||
    !row.config||typeof row.config!=='object'||contentHash(row.config)!==row.config_hash||
    model.configHash!==row.config_hash||row.strategy_id!=='static_manual_v1'||
    row.strategy_version!=='1.0.0'||row.state_schema_version!==1||
    model.strategyId!==row.strategy_id||referenceProofHash(model.referenceProof)!==model.referenceProofHash)
    throw new DeploymentConflict('paper_open_model_integrity');
   const config=row.config as Record<string,unknown>;
   const {strategyId:_id,strategyVersion:_version,stateSchemaVersion:_schema,...parameters}=config;
   if(_id!==row.strategy_id||_version!==row.strategy_version||_schema!==row.state_schema_version)
    throw new DeploymentConflict('paper_open_config_integrity');
   const allocation=allocationSchema.parse(row.allocation);
   const draft={id:row.campaign_id,revision:row.current_revision,allocation,profile:profile.data,
    profileHash:row.profile_hash,configHash:row.config_hash,strategyId:'static_manual_v1' as const,
    strategyVersion:row.strategy_version,stateSchemaVersion:row.state_schema_version,
    parameters:parseStrategyParameters('static_manual_v1',parameters)};
   const now=Date.now();
   if(model.source.timestamp*1000>now||now-model.source.timestamp*1000>180_000||
    now-Date.parse(model.costs.gasPriceObservedAt)>120_000||
    Date.parse(model.costs.gasPriceObservedAt)>now)
    throw new DeploymentConflict('paper_open_source_stale');
   const frame={source:model.source,tick:model.poolState.tick,
    sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),
    poolLiquidity:BigInt(model.poolState.poolLiquidity),
    price0:BigInt(model.reference.price0),price1:BigInt(model.reference.price1),
    nativePrice:BigInt(model.reference.nativePrice),referenceEligible:true,referenceReasons:[],
    referenceProofHash:model.referenceProofHash,referenceProof:model.referenceProof};
   const indicative=buildIndicativePaperOpenPreview(draft,frame,now);
   if(indicative.status!=='indicative'||indicative.candidateHash!==model.candidateHash||
    contentHash(indicative.candidate)!==contentHash(model.candidate)||
    contentHash(allocation)!==contentHash(model.allocation))
    throw new DeploymentConflict('paper_open_candidate_mismatch');
   const gasRows=(await db.query<PaperGasProfileRow>(`
    SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
     allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
     evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
     observed_until AS "observedUntil" FROM deployment_calibration_profiles
    WHERE chain_id=4663 AND lower(pool_address)=lower($1) AND path_version=$2
     AND component='gas_units' AND allowance_state='zero'
    ORDER BY size_band,stage,version DESC LIMIT 201`,
    [profile.data.pool.pool,PAPER_STATIC_GAS_PATH])).rows;
   const costed=costIndicativePaperOpenPreview(indicative,gasRows,profile.data.pool.pool,
    frame.nativePrice,BigInt(model.costs.gasPriceWei),Date.parse(model.costs.gasPriceObservedAt));
   if(costed.costs.status!=='provisional'||contentHash(costed.costs)!==contentHash(model.costs))
    throw new DeploymentConflict('paper_open_cost_profile_changed');
   let replayed;
   try{replayed=buildPaperOpenModel(draft,frame,costed);}
   catch{throw new DeploymentConflict('paper_open_limits_or_model_changed');}
   if(contentHash(replayed)!==contentHash(model))throw new DeploymentConflict('paper_open_model_changed');
   const previous=(await db.query<{n:number}>(`SELECT count(*)::int AS n FROM deployment_marks
    WHERE campaign_id=$1`,[row.campaign_id])).rows[0]?.n;
   if(previous!==0)throw new DeploymentConflict('paper_open_previous_mark');
   const p=profile.data.pool;
   const value=(amount:string,price:string,decimals:number)=>
    String(BigInt(amount)*BigInt(price)/10n**BigInt(decimals));
   const source={classification:'paper_model_provisional',previewId:row.preview_id,
    modelHash:contentHash(model),referenceProofHash:model.referenceProofHash,
    source:model.source};
   for(const [asset,token,amount,price,decimals] of [
    ['token0',p.token0,allocation.token0Raw,model.reference.price0,p.decimals0],
    ['token1',p.token1,allocation.token1Raw,model.reference.price1,p.decimals1],
    ['native',null,allocation.nativeWei,model.reference.nativePrice,18],
   ] as const){
    await db.query(`INSERT INTO deployment_ledger
     (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
     VALUES($1,$2,$3,'capital_in',$4,$5,$6,$7)`,
     [row.campaign_id,operationId,`paper_open:${operationId}:${asset}`,token,amount,
      value(amount,price,decimals),JSON.stringify({...source,asset})]);
   }
   const inventory={classification:'paper_model_provisional',token0Raw:allocation.token0Raw,
    token1Raw:allocation.token1Raw,nativeWei:allocation.nativeWei,
    position:{liquidity:model.candidate.liquidity,tickLower:model.candidate.range.tickLower,
     tickUpper:model.candidate.range.tickUpper,amount0Minted:model.candidate.amount0Minted,
     amount1Minted:model.candidate.amount1Minted},
    idle0:String(BigInt(allocation.token0Raw)-BigInt(model.candidate.amount0Minted)),
    idle1:String(BigInt(allocation.token1Raw)-BigInt(model.candidate.amount1Minted))};
   const provenance={...source,operationId,candidateHash:model.candidateHash,
    modeledCosts:model.costs,paidCostsAvailable:false};
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,NULL,$6,$7) RETURNING id::text`,
    [row.campaign_id,row.current_revision,model.source.block,model.source.hash,
     JSON.stringify(inventory),model.costs.stages.map(stage=>stage.profileId),
     JSON.stringify(provenance)])).rows[0]!;
   await db.query(`UPDATE deployment_campaigns SET lifecycle='active',
    range_state=$2,updated_at=clock_timestamp() WHERE id=$1`,
    [row.campaign_id,model.candidate.feeEarningAtEntry?'inside':'outside']);
   await db.query(`UPDATE deployment_operations SET status='succeeded',stage='paper_open_recorded',
    claimed_by=NULL,claim_until=NULL,updated_at=clock_timestamp() WHERE id=$1`,[operationId]);
   return {markId:mark.id,replayed:false};
  });
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
