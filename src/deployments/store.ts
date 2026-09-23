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
import {RANGEKEEPER_PAPER_NO_SWAP_PATH,RANGEKEEPER_PAPER_DIRECT_SWAP_PATH,
 RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH} from './rangekeeper-paper-cost.js';
import {buildIndicativePaperOpenPreview} from './paper-preview.js';
import {buildPaperOpenModel,paperOpenModelSchema} from './paper-open-model.js';
import {buildPaperCloseRetainModel,paperCloseRetainModelSchema} from './paper-close-model.js';
import {buildPaperCloseConvertModel,costPaperCloseConvert,paperCloseConvertModelSchema,
 PAPER_STATIC_CONVERT_GAS_PATH,paperCloseConvertQuoteSchema,
 costPaperCloseConvertGasV2,paperCloseConvertGasScopeV2Schema,
 paperCloseConvertGasScopeHashV2,paperCloseConvertGasSizeBandV2,
 paperCloseConvertGasAllowanceStatesV2,PAPER_STATIC_CONVERT_GAS_PATH_V2,
 PAPER_STATIC_CONVERT_GAS_STAGES_V2,
 type PaperCloseConvertModel,type PaperCloseConvertQuote,
 type PaperCloseConvertCostsV2,type PaperCloseConvertGasScopeV2} from './paper-close-convert-model.js';
import {buildPaperPrincipalValuation,paperPrincipalValuationSchema} from './paper-valuation.js';
import {verifyPaperGasEvidence,verifyPaperCloseConvertGasEvidence} from './paper-gas-evidence.js';
import {advancePaperFeeCarry,type CanonicalPaperFeeInterval,type PaperFeeCarry} from './paper-fee-replay.js';
import type {PaperOpenModel} from './paper-open-model.js';
import type {MarketProfile} from './market-profile.js';
import {buildPaperAccounting,paperAccountingSchema,buildPaperConversionAccounting,
 paperConversionAccountingSchema,paperAccountingFromConversionSnapshot,PAPER_ACCOUNTING_POLICY,
 PAPER_CONVERSION_ACCOUNTING_POLICY,PAPER_CONVERSION_ACCOUNTING_POLICY_V2,
 paperConversionAccountingV2Schema,buildPaperConversionAccountingV2,
 paperAccountingFromConversionV2Snapshot} from './paper-accounting.js';
import {loadRuntimeIdentity,type RuntimeIdentity} from '../runtime/identity.js';
import type {PaperCloseConvertGasPersistedEvidence} from './paper-gas-source.js';
import {z} from 'zod';

const paperGasAttestationSchema=z.object({
 verificationClass:z.literal('canonical_candidate_replay_v1'),
 reportHash:z.string().regex(/^[0-9a-f]{64}$/),
 sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 verifiedAt:z.iso.datetime({offset:true}),
}).strict();
const paperCloseConvertGasAttestationSchema=z.object({
 verificationClass:z.literal('canonical_close_convert_gas_replay_v2'),
 evidenceClass:z.literal('fork_estimated'),status:z.literal('provisional'),
 reportHash:z.string().regex(/^[0-9a-f]{64}$/),
 sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 scopeHash:z.string().regex(/^[0-9a-f]{64}$/),sequenceHash:z.string().regex(/^[0-9a-f]{64}$/),
 postWithdrawReplayHash:z.string().regex(/^[0-9a-f]{64}$/),
 sourceReplayHash:z.string().regex(/^[0-9a-f]{64}$/),
 ownedForkReplayBudget:z.object({requests:z.number().int().nonnegative(),
  rejected:z.number().int().nonnegative(),maxRequests:z.number().int().positive()}).strict(),
 runtimeIdentity:z.object({buildId:z.string().regex(/^[a-f0-9]{64}$/),
  configHash:z.string().regex(/^[a-f0-9]{64}$/),nodeVersion:z.string().min(1)}).strict(),
 verifiedAt:z.iso.datetime({offset:true}),
}).strict();
const sealedRuntimeIdentitySchema=z.object({buildId:z.string().regex(/^[a-f0-9]{64}$/),
 configHash:z.string().regex(/^[a-f0-9]{64}$/),nodeVersion:z.string().min(1)}).strict();
const paperFeeMarkSourceSchema=z.object({
 block:z.string().regex(/^(0|[1-9][0-9]*)$/),
 hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 timestamp:z.number().int().nonnegative(),
}).strict();
const paperFeeMarkStateSchema=z.object({tick:z.number().int(),
 sqrtPriceX96:z.string().regex(/^(0|[1-9][0-9]*)$/),
 poolLiquidity:z.string().regex(/^(0|[1-9][0-9]*)$/)}).strict();
const paperFeePositionSchema=z.object({tickLower:z.number().int(),tickUpper:z.number().int(),
 liquidity:z.string().regex(/^[1-9][0-9]*$/)}).passthrough();

async function replayPaperCloseConvert(db:PoolClient,model:PaperCloseConvertModel,
 open:PaperOpenModel,profile:MarketProfile,parameters:Record<string,unknown>,now:number){
 const profileIds=model.costs.stages.map(stage=>stage.profileId),
  gasRows=(await db.query<PaperGasProfileRow>(`
   SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
    allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
    evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
    observed_until AS "observedUntil"
   FROM deployment_calibration_profiles WHERE id=ANY($1::uuid[])`,[profileIds])).rows;
 let costs;
 try{costs=costPaperCloseConvert(gasRows,profile.pool.pool,open.candidate,
  BigInt(model.reference.nativePrice),BigInt(model.costs.gasPriceWei),
  Date.parse(model.costs.gasPriceObservedAt));}
 catch{throw new DeploymentConflict('paper_close_convert_gas_profiles_invalid');}
 const frame={source:model.source,tick:model.poolState.tick,
  sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),
  poolLiquidity:BigInt(model.poolState.poolLiquidity),
  price0:BigInt(model.reference.price0),price1:BigInt(model.reference.price1),
  nativePrice:BigInt(model.reference.nativePrice),referenceEligible:true,
  referenceReasons:[],referenceProofHash:model.referenceProofHash,
  referenceProof:model.referenceProof};
 let rebuilt:PaperCloseConvertModel;
 try{rebuilt=buildPaperCloseConvertModel(open,model.openMarkId,
  {markId:model.previousMarkId,sourceBlock:model.previousSource.block,
   sourceHash:model.previousSource.hash},frame,profile,parameters,
  model.conversionRoute,costs,now);}
 catch{throw new DeploymentConflict('paper_close_convert_model_replay_invalid');}
 if(contentHash(costs)!==contentHash(model.costs)||contentHash(rebuilt)!==contentHash(model))
  throw new DeploymentConflict('paper_close_convert_model_changed');
 return {profileIds,costs,rebuilt};
}

function closeConvertGasScopeV2(profile:MarketProfile,open:PaperOpenModel,
 model:PaperCloseConvertModel,inventory:{token0Raw:string;token1Raw:string}):PaperCloseConvertGasScopeV2{
 const residual0=BigInt(open.candidate.amount0Desired)-BigInt(open.candidate.amount0Minted),
  residual1=BigInt(open.candidate.amount1Desired)-BigInt(open.candidate.amount1Minted);
 if(residual0<0n||residual1<0n)throw new DeploymentConflict('paper_close_convert_open_allowance_invalid');
 const inputAmountRaw=model.conversionRoute.inputAsset==='token0'?inventory.token0Raw:inventory.token1Raw;
 return paperCloseConvertGasScopeV2Schema.parse({poolAddress:profile.pool.pool,
  profileHash:open.profileHash,openModelHash:contentHash(open),candidate:{
   deployedValue:open.candidate.deployedValue,sharePpm:open.candidate.dilutedSharePpm,
   tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
   liquidity:open.candidate.liquidity},routeHash:model.conversionRoute.routeHash,
  inputAsset:model.conversionRoute.inputAsset,inputAmountRaw,
  inventory:{token0Raw:inventory.token0Raw,token1Raw:inventory.token1Raw},
  initialAllowances:{manager0:String(residual0),manager1:String(residual1),router0:'0',router1:'0'}});
}

export class DeploymentConflict extends Error {
 constructor(public readonly code:string){super(code);}
}

export interface PaperAccountingAnchor {
 accountingId:string;markId:string;block:string;hash:string;timestamp:number;
}
export interface PaperAccountingAnchorMismatch {
 accountingId:string;actual:{hash:string;timestamp:number};
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
  const runtimeIdentity=loadRuntimeIdentity()??null;
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
    (id,mode,chain_id,wallet,market_profile_id,allocation,lifecycle,current_revision,runtime_identity)
    VALUES($1,$2,$3,$4,$5,$6,'draft',1,$7)`,
    [id,input.mode,input.chainId,wallet,input.marketProfileId,JSON.stringify(input.allocation),
     runtimeIdentity?JSON.stringify(runtimeIdentity):null]);
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

 /** Read-only input for the next principal mark. The subsequent write checks
  * the latest mark again under lock, so this snapshot cannot authorize a
  * stale or concurrent append. */
 async paperValuationState(id:string){
  const row=(await this.readPool.query<{current_revision:number;profile:unknown;
   profile_hash:string;config_hash:string;open_mark_id:string;
   open_provenance:Record<string,unknown>;latest_mark_id:string;
   latest_source_block:string|null;latest_source_hash:string|null;
   latest_provenance:Record<string,unknown>;proposal:Record<string,unknown>}>(`
   SELECT c.current_revision,p.profile,p.profile_hash,r.config_hash,
    o.id::text AS open_mark_id,o.provenance AS open_provenance,
    m.id::text AS latest_mark_id,m.source_block::text AS latest_source_block,
    m.source_hash AS latest_source_hash,m.provenance AS latest_provenance,v.proposal
   FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
   JOIN LATERAL (SELECT id,provenance FROM deployment_marks
    WHERE campaign_id=c.id AND provenance->>'classification'='paper_model_provisional'
    ORDER BY id LIMIT 1) o ON TRUE
   JOIN LATERAL (SELECT id,source_block,source_hash,provenance FROM deployment_marks
    WHERE campaign_id=c.id ORDER BY id DESC LIMIT 1) m ON TRUE
   JOIN deployment_previews v ON v.id=(o.provenance->>'previewId')::uuid
   WHERE c.id=$1 AND c.mode='paper' AND c.lifecycle IN ('active','paused','closing')`,
   [id])).rows[0];
  if(!row||row.latest_source_block===null||row.latest_source_hash===null||
   !['paper_model_provisional','paper_model_principal_valuation'].includes(
    String(row.latest_provenance.classification)))
   throw new DeploymentConflict('paper_valuation_state_unavailable');
  const profile=marketProfileSchema.safeParse(row.profile),
   open=paperOpenModelSchema.safeParse(row.proposal.paperOpenModel);
  if(!profile.success||!open.success||contentHash(row.profile)!==row.profile_hash||
   open.data.campaignId!==id||open.data.revision!==row.current_revision||
   open.data.profileHash!==row.profile_hash||open.data.configHash!==row.config_hash||
   contentHash(open.data)!==row.open_provenance.modelHash)
   throw new DeploymentConflict('paper_valuation_state_integrity');
  return {openModel:open.data,openMarkId:row.open_mark_id,
   previous:{markId:row.latest_mark_id,sourceBlock:row.latest_source_block,
    sourceHash:row.latest_source_hash},profile:profile.data};
 }

 /** Returns one adjacent, unrecorded paper interval. No network call or write
  * occurs here; the later append rechecks both marks under the campaign lock. */
 async paperFeeSamplingState(id:string){
  const db=await this.readPool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   try{
    const campaign=(await db.query<{mode:string;profile:unknown;profile_hash:string;
     evidence:unknown}>(`SELECT c.mode,p.profile,p.profile_hash,p.evidence
     FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
     WHERE c.id=$1`,[id])).rows[0];
    const profile=marketProfileSchema.safeParse(campaign?.profile),
     evidence=marketProfileEvidenceSchema.safeParse(campaign?.evidence);
    if(!campaign||campaign.mode!=='paper'||!profile.success||!evidence.success||
     contentHash(campaign.profile)!==campaign.profile_hash||
     referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash)
     throw new DeploymentConflict('paper_fee_campaign_unavailable');
    const last=(await db.query<{to_mark_id:string}>(`
     SELECT to_mark_id::text FROM deployment_paper_fee_evidence
     WHERE campaign_id=$1 ORDER BY id DESC LIMIT 1`,[id])).rows[0];
    const markSql=`SELECT id::text,revision,source_block::text,source_hash,inventory,provenance
     FROM deployment_marks WHERE campaign_id=$1`;
    type Mark={id:string;revision:number;source_block:string|null;source_hash:string|null;
     inventory:Record<string,unknown>;provenance:Record<string,unknown>};
    const from=(await db.query<Mark>(last?`${markSql} AND id=$2`:
     `${markSql} ORDER BY id LIMIT 1`,last?[id,last.to_mark_id]:[id])).rows[0];
    if(!from){
     if(last)throw new DeploymentConflict('paper_fee_prior_mark_unavailable');
     await db.query('COMMIT');return null;
    }
    if(!last&&from.provenance.classification!=='paper_model_provisional')
     throw new DeploymentConflict('paper_fee_open_mark_unavailable');
    const to=(await db.query<Mark>(`${markSql} AND id>$2 ORDER BY id LIMIT 1`,
     [id,from.id])).rows[0];
    if(!to){await db.query('COMMIT');return null;}
    const closeClass=String(to.provenance.classification),
     closing=closeClass==='paper_model_partial_close'||closeClass==='paper_model_converted_close';
    if(!['paper_model_principal_valuation','paper_model_partial_close',
      'paper_model_converted_close'].includes(closeClass)||
     !['paper_model_provisional','paper_model_principal_valuation'].includes(
      String(from.provenance.classification))||from.revision!==to.revision)
     throw new DeploymentConflict('paper_fee_next_mark_unsupported');
    if(closing&&closeClass==='paper_model_partial_close'){
     const preview=(await db.query<{proposal:Record<string,unknown>}>(`
      SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
      [to.provenance.previewId,id])).rows[0];
     const close=paperCloseRetainModelSchema.safeParse(preview?.proposal.paperCloseRetainModel);
     if(!close.success||close.data.previousMarkId!==from.id||
      close.data.openMarkId!==to.provenance.openMarkId||
      close.data.openModelHash!==to.provenance.openModelHash||
      contentHash(close.data.source)!==contentHash(to.provenance.source)||
      contentHash(close.data.poolState)!==contentHash(to.provenance.poolState)||
      to.inventory.position!==null)
      throw new DeploymentConflict('paper_fee_close_endpoint_unavailable');
    }
    if(closing&&closeClass==='paper_model_converted_close'){
     const preview=(await db.query<{proposal:Record<string,unknown>}>(`
      SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
      [to.provenance.previewId,id])).rows[0];
     const close=paperCloseConvertModelSchema.safeParse(preview?.proposal.paperCloseConvertModel);
     if(!close.success||close.data.previousMarkId!==from.id||
      close.data.openMarkId!==to.provenance.openMarkId||
      close.data.openModelHash!==to.provenance.openModelHash||
      contentHash(close.data.source)!==contentHash(to.provenance.source)||
      contentHash(close.data.poolState)!==contentHash(to.provenance.poolState)||
      contentHash(close.data)!==to.provenance.closeConvertModelHash||to.inventory.position!==null)
      throw new DeploymentConflict('paper_fee_close_endpoint_unavailable');
    }
    const snapshot=(mark:Mark,positionRequired=true)=>{
     const source=paperFeeMarkSourceSchema.safeParse(mark.provenance.source),
      state=paperFeeMarkStateSchema.safeParse(mark.provenance.poolState),
      position=positionRequired?paperFeePositionSchema.safeParse(mark.inventory.position):null;
     if(!source.success||!state.success||(positionRequired&&!position?.success)||
      source.data.block!==mark.source_block||
      source.data.hash.toLowerCase()!==mark.source_hash?.toLowerCase())
      throw new DeploymentConflict('paper_fee_mark_integrity');
     return {source:source.data,tick:state.data.tick,
      sqrtPriceX96:BigInt(state.data.sqrtPriceX96),
      poolLiquidity:BigInt(state.data.poolLiquidity),position:position?.data??null};
    };
    const before=snapshot(from),after=snapshot(to,!closing);
    if(!before.position||!closing&&(!after.position||
      after.position.liquidity!==before.position.liquidity||
      after.position.tickLower!==before.position.tickLower||
      after.position.tickUpper!==before.position.tickUpper)||
     BigInt(after.source.block)<=BigInt(before.source.block))
     throw new DeploymentConflict('paper_fee_position_or_source_changed');
    await db.query('COMMIT');
    return {profile:profile.data,stream:evidence.data.streamKey,
     targetSetHash:evidence.data.indexerTargetSetHash,fromMarkId:from.id,toMarkId:to.id,
     ending:closing?(closeClass==='paper_model_converted_close'?'close_convert' as const:
      'close_retain' as const):'valuation' as const,
     before:{source:before.source,tick:before.tick,sqrtPriceX96:before.sqrtPriceX96,
      poolLiquidity:before.poolLiquidity},
     after:{source:after.source,tick:after.tick,sqrtPriceX96:after.sqrtPriceX96,
      poolLiquidity:after.poolLiquidity},
     range:{tickLower:before.position.tickLower,tickUpper:before.position.tickUpper},
     liquidity:BigInt(before.position.liquidity)};
   }catch(error){await db.query('ROLLBACK');throw error;}
  }finally{db.release();}
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

 /** Exact candidate scope for a trusted RangeKeeper preview. The selector
  * rejects an over-bound result and validates every returned attestation. */
 async rangeKeeperPaperGasProfiles(poolAddress:string,pathVersion:string,
  sizeBand:string):Promise<PaperGasProfileRow[]>{
  if(!/^0x[0-9a-fA-F]{40}$/.test(poolAddress)||
   ![RANGEKEEPER_PAPER_NO_SWAP_PATH,RANGEKEEPER_PAPER_DIRECT_SWAP_PATH,
    RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH].includes(pathVersion)||
   !/^rk_[0-9a-f]{32}$/.test(sizeBand))
   throw new DeploymentConflict('rangekeeper_paper_gas_scope_invalid');
  return (await this.readPool.query<PaperGasProfileRow>(`
   SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
    allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
    evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
    observed_until AS "observedUntil"
   FROM deployment_calibration_profiles
   WHERE chain_id=4663 AND lower(pool_address)=lower($1) AND path_version=$2
    AND size_band=$3 AND component='gas_units'
   ORDER BY stage,allowance_state,version DESC LIMIT 201`,
   [poolAddress,pathVersion,sizeBand])).rows;
 }

 private async assertPersistedPaperCloseConvertGasEvidence(db:PoolClient,
  input:PaperCloseConvertGasPersistedEvidence,lockCampaign=false){
  const campaign=(await db.query<{mode:string;lifecycle:string;current_revision:number;
   runtime_identity:unknown;open_mark_id:string;chain_id:number;profile:unknown;
   profile_evidence:unknown;profile_hash:string;config:unknown;config_hash:string;
   strategy_id:string;strategy_version:string;state_schema_version:number}>(`
   SELECT c.mode,c.lifecycle,c.current_revision,c.runtime_identity,c.open_mark_id,c.chain_id,
    p.profile,p.evidence AS profile_evidence,p.profile_hash,r.config,r.config_hash,
    r.strategy_id,r.strategy_version,r.state_schema_version
   FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
   WHERE c.id=$1${lockCampaign?' FOR SHARE OF c':''}`,[input.campaignId])).rows[0];
  const runtime=sealedRuntimeIdentitySchema.safeParse(campaign?.runtime_identity),
   profile=marketProfileSchema.safeParse(campaign?.profile),
   profileEvidence=marketProfileEvidenceSchema.safeParse(campaign?.profile_evidence),
   open=paperOpenModelSchema.safeParse(input.openModel),
   scope=paperCloseConvertGasScopeV2Schema.safeParse(input.scope);
  if(!campaign||campaign.mode!=='paper'||!['closing','closed'].includes(campaign.lifecycle)||
   campaign.current_revision!==input.revision||!runtime.success||
   contentHash(runtime.data)!==contentHash(input.runtimeIdentity)||
   !profile.success||!profileEvidence.success||!open.success||!scope.success||
   contentHash(campaign.profile)!==campaign.profile_hash||campaign.profile_hash!==input.profileHash||
   contentHash(profile.data)!==input.profileHash||contentHash(open.data)!==input.openModelHash||
   contentHash(input.profile)!==input.profileHash||contentHash(input.openModel)!==input.openModelHash||
   open.data.campaignId!==input.campaignId||
   open.data.revision!==input.revision||open.data.profileHash!==input.profileHash||
   open.data.configHash!==campaign.config_hash||
   referenceProofHash(profileEvidence.data.referenceProof)!==profileEvidence.data.references.proofHash||
   campaign.strategy_id!=='static_manual_v1'||campaign.strategy_version!=='1.0.0'||
   campaign.state_schema_version!==1||!campaign.config||
   contentHash(campaign.config)!==campaign.config_hash)
   throw new DeploymentConflict('paper_close_convert_gas_campaign_binding_invalid');
  for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
   if(profile.data.pool[key].toLowerCase()!==profileEvidence.data.contractHashes[key].toLowerCase())
    throw new DeploymentConflict('paper_close_convert_gas_profile_integrity');
  const indexed=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM indexer_pools
   WHERE stream_key=$1 AND lower(pool_address)=lower($2) AND chain_id=$3 AND fee=$4
    AND enabled=true AND target_set_hash=$5 AND lower(rwa_address)=lower($6)
    AND created_block<=$7::numeric) AS found`,[profileEvidence.data.streamKey,
    profile.data.pool.pool,campaign.chain_id,profile.data.pool.fee,
    profileEvidence.data.indexerTargetSetHash,
    profile.data.pool.quoteToken===0?profile.data.pool.token1:profile.data.pool.token0,
    input.closeSource.block])).rows[0]?.found;
  if(!indexed)throw new DeploymentConflict('paper_close_convert_gas_indexer_changed');

  const openMark=(await db.query<{revision:number;source_block:string|null;source_hash:string|null;
   provenance:Record<string,unknown>}>(`SELECT revision,source_block::text,source_hash,provenance
   FROM deployment_marks WHERE id=$1 AND campaign_id=$2`,[campaign.open_mark_id,input.campaignId])).rows[0];
  if(!openMark||openMark.revision!==input.revision||openMark.source_block!==open.data.source.block||
   openMark.source_hash?.toLowerCase()!==open.data.source.hash.toLowerCase()||
   openMark.provenance.classification!=='paper_model_provisional'||
   openMark.provenance.modelHash!==input.openModelHash||
   openMark.provenance.source===undefined||contentHash(openMark.provenance.source)!==contentHash(open.data.source))
   throw new DeploymentConflict('paper_close_convert_gas_open_mark_invalid');
  if(contentHash(open.data.source)!==contentHash(input.openSource))
   throw new DeploymentConflict('paper_close_convert_gas_open_source_mismatch');

  const terminal=(await db.query<{revision:number;source_block:string|null;source_hash:string|null;
   inventory:Record<string,unknown>;calibration_profile_ids:string[];
   provenance:Record<string,unknown>}>(`SELECT revision,source_block::text,source_hash,inventory,
    calibration_profile_ids,provenance FROM deployment_marks
    WHERE id=$1 AND campaign_id=$2`,[input.terminalMarkId,input.campaignId])).rows[0];
  if(!terminal||terminal.revision!==input.revision||terminal.source_block!==input.closeSource.block||
   terminal.source_hash?.toLowerCase()!==input.closeSource.hash.toLowerCase()||
   terminal.provenance.classification!=='paper_model_converted_close'||
   terminal.inventory.position!==null||terminal.provenance.openMarkId!==campaign.open_mark_id||
   terminal.provenance.openModelHash!==input.openModelHash)
   throw new DeploymentConflict('paper_close_convert_gas_terminal_mark_invalid');
  const laterMark=(await db.query<{found:boolean}>(`SELECT EXISTS(
   SELECT 1 FROM deployment_marks WHERE campaign_id=$1 AND id>$2) AS found`,
   [input.campaignId,input.terminalMarkId])).rows[0]?.found;
  if(laterMark)throw new DeploymentConflict('paper_close_convert_gas_terminal_not_latest');
  const previousMark=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
   provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
   FROM deployment_marks WHERE campaign_id=$1 AND id<$2 ORDER BY id DESC LIMIT 1`,
   [input.campaignId,input.terminalMarkId])).rows[0];
  if(!previousMark||previousMark.id!==input.previousMarkId)
   throw new DeploymentConflict('paper_close_convert_gas_previous_mark_invalid');
  const terminalPreviewId=terminal.provenance.previewId;
  const terminalPreview=(await db.query<{proposal:Record<string,unknown>}>(`
   SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
   [terminalPreviewId,input.campaignId])).rows[0];
  const closeModel=paperCloseConvertModelSchema.safeParse(terminalPreview?.proposal.paperCloseConvertModel);
  if(!closeModel.success||closeModel.data.campaignId!==input.campaignId||
   closeModel.data.revision!==input.revision||closeModel.data.openMarkId!==campaign.open_mark_id||
   closeModel.data.previousMarkId!==input.previousMarkId||
   closeModel.data.openModelHash!==input.openModelHash||
   closeModel.data.source.block!==input.closeSource.block||
   closeModel.data.source.hash.toLowerCase()!==input.closeSource.hash.toLowerCase()||
   closeModel.data.source.timestamp!==input.closeSource.timestamp||
   closeModel.data.poolState.tick!==input.frame.tick||
   closeModel.data.poolState.sqrtPriceX96!==input.frame.sqrtPriceX96||
   closeModel.data.poolState.poolLiquidity!==input.frame.poolLiquidity||
   closeModel.data.reference.price0!==input.frame.price0||
   closeModel.data.reference.price1!==input.frame.price1||
   closeModel.data.reference.nativePrice!==input.frame.nativePrice||
   closeModel.data.referenceProofHash!==input.frame.referenceProofHash||
   contentHash(closeModel.data.referenceProof)!==contentHash(input.frame.referenceProof)||
   referenceProofHash(input.frame.referenceProof)!==input.frame.referenceProofHash||
   contentHash(terminal.provenance.source)!==contentHash(closeModel.data.source)||
   contentHash(terminal.provenance.reference)!==contentHash(closeModel.data.reference)||
   contentHash(closeModel.data.conversionRoute)!==contentHash(input.route)||
   terminal.provenance.closeConvertModelHash!==contentHash(closeModel.data)||
   contentHash(terminal.provenance.modeledCosts)!==contentHash(closeModel.data.costs)||
   contentHash(terminal.provenance.conversionRoute)!==contentHash(closeModel.data.conversionRoute)||
   contentHash(terminal.inventory.retainedPrincipalLowerBound)!==contentHash(closeModel.data.principal)||
   contentHash(terminal.inventory.idleLowerBound)!==contentHash(closeModel.data.idle)||
   contentHash(terminal.calibration_profile_ids)!==contentHash(
    closeModel.data.costs.stages.map(stage=>stage.profileId)))
   throw new DeploymentConflict('paper_close_convert_gas_saved_model_invalid');
  if(previousMark.source_block!==closeModel.data.previousSource.block||
   previousMark.source_hash?.toLowerCase()!==closeModel.data.previousSource.hash.toLowerCase())
   throw new DeploymentConflict('paper_close_convert_gas_previous_source_invalid');

  const feeRow=(await db.query<{id:string;from_mark_id:string;proof:unknown;proof_hash:string;
   carry:PaperFeeCarry;carry_hash:string}>(`SELECT id::text,from_mark_id::text,proof,proof_hash,carry,carry_hash
   FROM deployment_paper_fee_evidence WHERE campaign_id=$1 AND to_mark_id=$2`,
   [input.campaignId,input.terminalMarkId])).rows[0];
  if(!feeRow||feeRow.from_mark_id!==input.previousMarkId||
   contentHash(feeRow.proof)!==feeRow.proof_hash||contentHash(feeRow.carry)!==feeRow.carry_hash||
   feeRow.id!==input.feeEvidence.id||feeRow.proof_hash!==input.feeEvidence.proofHash||
   feeRow.carry_hash!==input.feeEvidence.carryHash||contentHash(feeRow.carry)!==contentHash(input.feeCarry))
   throw new DeploymentConflict('paper_close_convert_gas_fee_evidence_invalid');
  const proof=feeRow.proof as CanonicalPaperFeeInterval;
  if(proof.coverage.stream!==profileEvidence.data.streamKey||
   proof.coverage.targetSetHash!==profileEvidence.data.indexerTargetSetHash)
   throw new DeploymentConflict('paper_close_convert_gas_fee_coverage_invalid');
  const priorFee=(await db.query<{id:string;proof:unknown;proof_hash:string;
   carry:PaperFeeCarry;carry_hash:string}>(`SELECT id::text,proof,proof_hash,carry,carry_hash
   FROM deployment_paper_fee_evidence WHERE campaign_id=$1 AND to_mark_id=$2`,
   [input.campaignId,input.previousMarkId])).rows[0];
  if(previousMark.provenance.classification==='paper_model_provisional'&&priorFee||
   previousMark.provenance.classification!=='paper_model_provisional'&&(!priorFee||
    contentHash(priorFee.proof)!==priorFee.proof_hash||contentHash(priorFee.carry)!==priorFee.carry_hash))
   throw new DeploymentConflict('paper_close_convert_gas_prior_fee_invalid');
  let carry:PaperFeeCarry;
  try{carry=advancePaperFeeCarry(priorFee?.carry??null,proof,open.data.source);}
  catch{throw new DeploymentConflict('paper_close_convert_gas_fee_replay_invalid');}
  if(contentHash(carry)!==feeRow.carry_hash||contentHash(carry)!==contentHash(input.feeCarry))
   throw new DeploymentConflict('paper_close_convert_gas_fee_replay_invalid');

  const expectedInventory={token0Raw:String(BigInt(closeModel.data.principal.amount0Raw)+
    BigInt(closeModel.data.idle.amount0Raw)+BigInt(carry.token0.lowerAmountRaw)),
   token1Raw:String(BigInt(closeModel.data.principal.amount1Raw)+
    BigInt(closeModel.data.idle.amount1Raw)+BigInt(carry.token1.lowerAmountRaw))};
  const expectedScope=closeConvertGasScopeV2(profile.data,open.data,closeModel.data,expectedInventory);
  if(contentHash(scope.data)!==contentHash(expectedScope)||input.scopeHash!==paperCloseConvertGasScopeHashV2(expectedScope)||
   contentHash(input.route)!==contentHash(closeModel.data.conversionRoute)||
   contentHash(input.quote.path)!==contentHash(input.route.path)||
   input.quote.router.toLowerCase()!==input.route.router.toLowerCase()||
   input.quote.quoter.toLowerCase()!==input.route.quoter.toLowerCase()||
   input.quote.fee!==input.route.fee||input.quote.pathVersion!==input.route.pathVersion||
   input.quote.inputAsset!==input.route.inputAsset||
   input.quote.inputAmountRaw!==expectedScope.inputAmountRaw||
   input.quote.source.block!==input.closeSource.block||
   input.quote.source.hash.toLowerCase()!==input.closeSource.hash.toLowerCase()||
   input.quote.source.timestamp!==input.closeSource.timestamp)
   throw new DeploymentConflict('paper_close_convert_gas_scope_mismatch');
  return {campaign,profile:profile.data,openModel:open.data,closeModel:closeModel.data,
   terminal,feeEvidence:{id:feeRow.id,proofHash:feeRow.proof_hash,carryHash:feeRow.carry_hash,
    carry},scope:expectedScope};
 }

 /** Read-only persisted-input check used after canonical and owned-fork source
  * verification. Registration repeats it under its atomic insert lock. */
 async verifyPersistedPaperCloseConvertGasEvidence(input:PaperCloseConvertGasPersistedEvidence){
  const db=await this.readPool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await this.assertPersistedPaperCloseConvertGasEvidence(db,input);
   await db.query('COMMIT');
  }catch(error){
   await db.query('ROLLBACK');throw error;
  }finally{db.release();}
 }

 /** Atomically registers one complete seven-stage conversion-gas report. The
  * quote route remains v1; only gas path/version and scoped stage set are v2. */
 async registerPaperCloseConvertGasEvidence(raw:unknown,rawAttestation:unknown){
  const report=verifyPaperCloseConvertGasEvidence(raw),attestation=
   paperCloseConvertGasAttestationSchema.parse(rawAttestation),
   runtimeIdentity=loadRuntimeIdentity();
  if(!runtimeIdentity)throw new DeploymentConflict('paper_close_convert_gas_runtime_unavailable');
  if(contentHash(runtimeIdentity)!==contentHash(report.runtimeIdentity)||
   contentHash(runtimeIdentity)!==contentHash(attestation.runtimeIdentity)||
   attestation.reportHash!==report.reportHash||
   attestation.sourceHash.toLowerCase()!==report.source.hash.toLowerCase()||
   attestation.profileHash!==report.profileHash||attestation.scopeHash!==report.scopeHash||
   attestation.sequenceHash!==report.sequenceHash)
   throw new DeploymentConflict('paper_close_convert_gas_attestation_mismatch');
  const sampledAt=Date.parse(report.sampledAt),verifiedAt=Date.parse(attestation.verifiedAt),now=Date.now();
  if(now-sampledAt<0||now-sampledAt>86_400_000||verifiedAt<sampledAt||
   now-verifiedAt<0||now-verifiedAt>300_000||sampledAt-report.source.timestamp*1000<0||
   sampledAt-report.source.timestamp*1000>180_000||
   attestation.ownedForkReplayBudget.requests>attestation.ownedForkReplayBudget.maxRequests||
   attestation.ownedForkReplayBudget.requests<1||attestation.ownedForkReplayBudget.rejected!==0||
   attestation.ownedForkReplayBudget.maxRequests>2000)
   throw new DeploymentConflict('paper_close_convert_gas_evidence_stale');
  const input:PaperCloseConvertGasPersistedEvidence={campaignId:report.campaignId,
   revision:report.revision,terminalMarkId:report.terminalMarkId,previousMarkId:report.previousMarkId,
   runtimeIdentity:report.runtimeIdentity as RuntimeIdentity,
   profile:report.profile as MarketProfile,profileHash:report.profileHash as string,
   openModel:report.openModel as PaperOpenModel,openModelHash:report.openModelHash as string,
   openSource:report.openModel.source,closeSource:report.source as PaperCloseConvertGasPersistedEvidence['closeSource'],
   frame:report.frame as PaperCloseConvertGasPersistedEvidence['frame'],
   route:report.route as PaperCloseConvertGasPersistedEvidence['route'],
   quote:report.quote as PaperCloseConvertGasPersistedEvidence['quote'],
   scope:report.scope as PaperCloseConvertGasPersistedEvidence['scope'],
   scopeHash:report.scopeHash as string,sequenceHash:report.sequenceHash as string,
   reportHash:report.reportHash as string,postWithdrawReplayHash:attestation.postWithdrawReplayHash,
   sourceReplayHash:attestation.sourceReplayHash,
   feeEvidence:report.feeEvidence as PaperCloseConvertGasPersistedEvidence['feeEvidence'],
   feeCarry:report.feeCarry as PaperCloseConvertGasPersistedEvidence['feeCarry']};
  const profile=marketProfileSchema.parse(report.profile),scope=paperCloseConvertGasScopeV2Schema.parse(report.scope),
   sizeBand=paperCloseConvertGasSizeBandV2(scope),allowanceStates=paperCloseConvertGasAllowanceStatesV2(scope);
  if(report.sizeBand!==sizeBand||report.scopeHash!==paperCloseConvertGasScopeHashV2(scope))
   throw new DeploymentConflict('paper_close_convert_gas_scope_invalid');
  return this.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`deployment-close-convert-gas:${profile.pool.pool.toLowerCase()}:${PAPER_STATIC_CONVERT_GAS_PATH_V2}:${sizeBand}`]);
   const persisted=await this.assertPersistedPaperCloseConvertGasEvidence(db,input,true);
   const previous=(await db.query<{id:string;stage:string;allowanceState:string;version:number;
    validation:Record<string,unknown>;observedUntil:Date|null;model:unknown;sourceHash:string}>(`
    SELECT id::text,stage,allowance_state AS "allowanceState",version,validation,
     observed_until AS "observedUntil",model,source_hash AS "sourceHash"
    FROM deployment_calibration_profiles WHERE chain_id=$1 AND lower(pool_address)=lower($2)
     AND path_version=$3 AND size_band=$4 AND component='gas_units'
    ORDER BY stage,allowance_state,version DESC`,
    [persisted.profile.pool.chainId,persisted.profile.pool.pool,
     PAPER_STATIC_CONVERT_GAS_PATH_V2,sizeBand])).rows;
   const matching=previous.filter(row=>row.validation?.reportHash===report.reportHash);
   if(matching.length){
    if(matching.length!==PAPER_STATIC_CONVERT_GAS_STAGES_V2.length||
     matching.some(row=>row.version!==matching[0]!.version)||
     previous.some(row=>row.version>matching[0]!.version)||
     PAPER_STATIC_CONVERT_GAS_STAGES_V2.some((stage,index)=>{
      const evidenceStage=report.stageProfiles[index] as Record<string,unknown>;
      const row=matching.find(item=>item.stage===stage&&
       item.allowanceState===allowanceStates[stage]);
      return !row||row.validation.campaignId!==report.campaignId||
       row.validation.revision!==report.revision||
       row.validation.terminalMarkId!==report.terminalMarkId||
       row.validation.previousMarkId!==report.previousMarkId||
       contentHash(row.validation.runtimeIdentity)!==contentHash(runtimeIdentity)||
       row.validation.scopeHash!==report.scopeHash||
       row.validation.sequenceHash!==report.sequenceHash||
       row.validation.postWithdrawReplayHash!==attestation.postWithdrawReplayHash||
       row.validation.sourceReplayHash!==attestation.sourceReplayHash||
       contentHash(row.model)!==contentHash(evidenceStage.model)||
       contentHash(row.validation.localEvidence)!==contentHash(evidenceStage.evidence)||
       row.sourceHash!==evidenceStage.sourceHash;
     }))throw new DeploymentConflict('paper_close_convert_gas_partial_previous_import');
    const orderedIds=PAPER_STATIC_CONVERT_GAS_STAGES_V2.map(stage=>matching.find(row=>row.stage===stage&&
     row.allowanceState===allowanceStates[stage])!.id);
    return {created:false,version:matching[0]!.version,profileIds:orderedIds,
     reportHash:report.reportHash,sizeBand};
   }
   if(persisted.campaign.lifecycle==='closed')
    throw new DeploymentConflict('paper_close_convert_gas_campaign_closed');
   if(previous.some(row=>row.validation?.reportHash===report.reportHash))
    throw new DeploymentConflict('paper_close_convert_gas_report_superseded');
   if(previous.some(row=>row.observedUntil&&sampledAt<=row.observedUntil.getTime()))
    throw new DeploymentConflict('paper_close_convert_gas_sample_not_newer');
   const version=previous.reduce((max,row)=>Math.max(max,row.version),0)+1,profileIds:string[]=[];
   for(const rawStage of report.stageProfiles as Record<string,unknown>[]){
    const stage=rawStage.stage as typeof PAPER_STATIC_CONVERT_GAS_STAGES_V2[number],
     allowanceState=rawStage.allowanceState as string;
    if(allowanceState!==allowanceStates[stage])
     throw new DeploymentConflict('paper_close_convert_gas_allowance_scope_invalid');
    const id=randomUUID(),validation={validationPolicy:'paper_close_convert_gas_v2',
     statusReason:'one_owned_fork_post_withdraw_replay',sampleCount:1,distinctCampaigns:1,
     reportHash:report.reportHash,canonicalAttestation:attestation,
     runtimeIdentity,campaignId:report.campaignId,revision:report.revision,
     terminalMarkId:report.terminalMarkId,previousMarkId:report.previousMarkId,
     profileHash:report.profileHash,openModelHash:report.openModelHash,
     feeEvidence:report.feeEvidence,scope,scopeHash:report.scopeHash,
     sequenceHash:report.sequenceHash,sizeBand,postWithdrawReplayHash:attestation.postWithdrawReplayHash,
     sourceReplayHash:attestation.sourceReplayHash,localEvidence:rawStage.evidence};
    await db.query(`INSERT INTO deployment_calibration_profiles
     (id,version,chain_id,pool_address,path_version,stage,allowance_state,size_band,
      component,status,evidence_class,model,validation,source_hash,observed_until)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'gas_units','provisional','fork_estimated',
      $9,$10,$11,$12)`,[id,version,persisted.profile.pool.chainId,
       persisted.profile.pool.pool.toLowerCase(),PAPER_STATIC_CONVERT_GAS_PATH_V2,
       stage,allowanceState,sizeBand,JSON.stringify(rawStage.model),JSON.stringify(validation),
       rawStage.sourceHash,report.sampledAt]);
    profileIds.push(id);
   }
   return {created:true,version,profileIds,reportHash:report.reportHash,sizeBand};
  });
 }

 private async selectRegisteredPaperCloseConvertGasV2(db:PoolClient,input:{
  campaignId:string;revision:number;terminalMarkId:string;previousMarkId:string;
  runtimeIdentity:RuntimeIdentity;profile:MarketProfile;open:PaperOpenModel;
  model:PaperCloseConvertModel;inventory:{token0Raw:string;token1Raw:string};
  feeEvidence:{id:string;proofHash:string;carryHash:string};now?:number;
 }):Promise<{costs:PaperCloseConvertCostsV2;binding:{reportHash:string;scopeHash:string;
  sequenceHash:string;sizeBand:string;profileIds:string[]}}>{
  const scope=closeConvertGasScopeV2(input.profile,input.open,input.model,input.inventory),
   scopeHash=paperCloseConvertGasScopeHashV2(scope),sizeBand=paperCloseConvertGasSizeBandV2(scope),
   allowances=paperCloseConvertGasAllowanceStatesV2(scope),now=input.now??Date.now();
  const rows=(await db.query<PaperGasProfileRow&{validation:Record<string,unknown>}>(`
   SELECT id::text,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
    allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
    evidence_class AS "evidenceClass",model,validation,source_hash AS "sourceHash",
    observed_until AS "observedUntil"
   FROM deployment_calibration_profiles WHERE chain_id=$1 AND lower(pool_address)=lower($2)
    AND path_version=$3 AND size_band=$4 AND component='gas_units'
    AND stage=ANY($5::text[]) AND allowance_state=ANY($6::text[])
   ORDER BY stage,version DESC LIMIT 201`,[input.profile.pool.chainId,input.profile.pool.pool,
    PAPER_STATIC_CONVERT_GAS_PATH_V2,sizeBand,[...PAPER_STATIC_CONVERT_GAS_STAGES_V2],
    [...new Set(Object.values(allowances))]])).rows;
  if(rows.length>200)throw new DeploymentConflict('paper_close_convert_gas_profile_query_bound');
  const groups=new Map<string,typeof rows>();
  for(const row of rows){
   const validation=row.validation,reportHash=validation?.reportHash;
   if(typeof reportHash!=='string'||!(/^[0-9a-f]{64}$/.test(reportHash)))continue;
   const attestation=paperCloseConvertGasAttestationSchema.safeParse(validation.canonicalAttestation);
   if(!attestation.success)continue;
   const exact=validation.campaignId===input.campaignId&&validation.revision===input.revision&&
    validation.terminalMarkId===input.terminalMarkId&&validation.previousMarkId===input.previousMarkId&&
    validation.profileHash===input.open.profileHash&&validation.openModelHash===contentHash(input.open)&&
    validation.scopeHash===scopeHash&&validation.sizeBand===sizeBand&&
    contentHash(validation.scope)===contentHash(scope)&&
    contentHash(validation.runtimeIdentity)===contentHash(input.runtimeIdentity)&&
    contentHash(validation.feeEvidence)===contentHash(input.feeEvidence)&&
    validation.sequenceHash===attestation.data.sequenceHash&&
    validation.scopeHash===attestation.data.scopeHash&&
    reportHash===attestation.data.reportHash&&
    validation.postWithdrawReplayHash===attestation.data.postWithdrawReplayHash&&
    validation.sourceReplayHash===attestation.data.sourceReplayHash&&
    contentHash(attestation.data.runtimeIdentity)===contentHash(input.runtimeIdentity);
   if(!exact||row.pathVersion!==PAPER_STATIC_CONVERT_GAS_PATH_V2||
    row.sizeBand!==sizeBand||row.allowanceState!==allowances[row.stage as keyof typeof allowances])continue;
   const group=groups.get(reportHash)??[];group.push(row);groups.set(reportHash,group);
  }
  const candidates=[...groups].filter(([,group])=>group.length===PAPER_STATIC_CONVERT_GAS_STAGES_V2.length&&
   new Set(group.map(row=>row.version)).size===1&&PAPER_STATIC_CONVERT_GAS_STAGES_V2.every(stage=>
    group.filter(row=>row.stage===stage&&row.allowanceState===allowances[stage]).length===1));
  if(candidates.length===0)throw new DeploymentConflict('paper_close_convert_gas_v2_profiles_unavailable');
  candidates.sort((a,b)=>Math.max(...b[1].map(row=>row.version))-Math.max(...a[1].map(row=>row.version)));
  const [reportHash,selected]=candidates[0]!,sequenceHash=String(selected[0]!.validation.sequenceHash);
  if(candidates.length>1&&Math.max(...candidates[0]![1].map(row=>row.version))===
   Math.max(...candidates[1]![1].map(row=>row.version)))
   throw new DeploymentConflict('paper_close_convert_gas_v2_profiles_ambiguous');
  const ordered=PAPER_STATIC_CONVERT_GAS_STAGES_V2.map(stage=>selected.find(row=>row.stage===stage)!);
  const costs=(()=>{try{return costPaperCloseConvertGasV2(ordered,scope,
   BigInt(input.model.reference.nativePrice),BigInt(input.model.costs.gasPriceWei),now,
   input.model.costs.gasPriceObservedAt);}catch{throw new DeploymentConflict('paper_close_convert_gas_v2_profiles_invalid');}})();
  if(costs.scopeHash!==scopeHash||costs.sequenceHash!==sequenceHash||
   costs.stages.some((stage,index)=>stage.profileId!==ordered[index]!.id))
   throw new DeploymentConflict('paper_close_convert_gas_v2_selection_changed');
  return {costs,binding:{reportHash,scopeHash,sequenceHash,sizeBand,
   profileIds:ordered.map(row=>row.id)}};
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
    source:model.source,poolState:model.poolState,reference:model.reference};
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

 /** Append one later principal-only observation under the campaign lock.
  * The caller supplies a confirmed canonical frame and independent proof;
  * stored open math is replayed before this mark becomes visible. */
 async recordTrustedPaperPrincipalValuation(raw:unknown){
  const model=paperPrincipalValuationSchema.parse(raw),modelHash=contentHash(model);
  return this.transaction(async db=>{
   const row=(await db.query<{mode:string;lifecycle:string;current_revision:number;
    profile:unknown;profile_hash:string;config_hash:string}>(`
    SELECT c.mode,c.lifecycle,c.current_revision,p.profile,p.profile_hash,r.config_hash
    FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    WHERE c.id=$1 FOR UPDATE OF c`,[model.campaignId])).rows[0];
   if(!row||row.mode!=='paper'||row.current_revision!==model.revision)
    throw new DeploymentConflict('paper_valuation_campaign_unavailable');
   const sameBlock=(await db.query<{id:string;source_hash:string;provenance:Record<string,unknown>}>(`
    SELECT id::text,source_hash,provenance FROM deployment_marks
    WHERE campaign_id=$1 AND source_block=$2 AND
     provenance->>'classification'='paper_model_principal_valuation' LIMIT 2`,
    [model.campaignId,model.source.block])).rows;
   if(sameBlock.length>1)throw new DeploymentConflict('paper_valuation_duplicate_source');
   if(sameBlock.length===1){
    const existing=sameBlock[0]!;
    if(existing.source_hash.toLowerCase()===model.source.hash.toLowerCase()&&
     existing.provenance.modelHash===modelHash)return {markId:existing.id,replayed:true};
    throw new DeploymentConflict('paper_valuation_conflicting_source');
   }
   const profile=marketProfileSchema.safeParse(row.profile);
   if(!profile.success||contentHash(row.profile)!==row.profile_hash)
    throw new DeploymentConflict('paper_valuation_profile_integrity');
   const openMark=(await db.query<{id:string;revision:number;provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,provenance FROM deployment_marks
    WHERE id=$1 AND campaign_id=$2`,[model.openMarkId,model.campaignId])).rows[0];
   if(!openMark||openMark.revision!==model.revision||
    openMark.provenance.classification!=='paper_model_provisional'||
    !openMark.provenance.previewId)throw new DeploymentConflict('paper_valuation_open_mark_unavailable');
   const preview=(await db.query<{proposal:Record<string,unknown>}>(`
    SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
    [openMark.provenance.previewId,model.campaignId])).rows[0];
   const parsed=paperOpenModelSchema.safeParse(preview?.proposal.paperOpenModel);
   if(!parsed.success||parsed.data.campaignId!==model.campaignId||
    parsed.data.profileHash!==row.profile_hash||parsed.data.configHash!==row.config_hash||
    contentHash(parsed.data)!==openMark.provenance.modelHash||
    contentHash(parsed.data)!==model.openModelHash)
    throw new DeploymentConflict('paper_valuation_open_model_integrity');
   const previous=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE campaign_id=$1 ORDER BY id DESC LIMIT 1`,[model.campaignId])).rows[0];
   if(!previous||previous.source_block===null||previous.source_hash===null)
    throw new DeploymentConflict('paper_valuation_prior_mark_unavailable');
   if(BigInt(model.source.block)===BigInt(previous.source_block))
    throw new DeploymentConflict('paper_valuation_conflicting_source');
   if(!['active','paused','closing'].includes(row.lifecycle))
    throw new DeploymentConflict('paper_valuation_campaign_unavailable');
   const priorTimestamp=(previous.provenance.source as {timestamp?:unknown}|undefined)?.timestamp;
   if(!Number.isSafeInteger(priorTimestamp)||model.source.timestamp<(priorTimestamp as number))
    throw new DeploymentConflict('paper_valuation_source_time_regressed');
   if(previous.id!==model.previousMarkId||
    !['paper_model_provisional','paper_model_principal_valuation'].includes(
     String(previous.provenance.classification)))
    throw new DeploymentConflict('paper_valuation_prior_mark_changed');
   const now=Date.now();
   const frame={source:model.source,tick:model.poolState.tick,
    sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),
    poolLiquidity:BigInt(model.poolState.poolLiquidity),
    price0:BigInt(model.reference.price0),price1:BigInt(model.reference.price1),
    nativePrice:BigInt(model.reference.nativePrice),referenceEligible:true,referenceReasons:[],
    referenceProofHash:model.referenceProofHash,referenceProof:model.referenceProof};
   let replayed;
   try{replayed=buildPaperPrincipalValuation(parsed.data,openMark.id,
    {markId:previous.id,sourceBlock:previous.source_block,sourceHash:previous.source_hash},
    frame,profile.data,now);}
   catch{throw new DeploymentConflict('paper_valuation_model_rejected');}
   if(contentHash(replayed)!==modelHash)throw new DeploymentConflict('paper_valuation_model_changed');
   const inventory={classification:'paper_model_principal_valuation',position:{
    liquidity:parsed.data.candidate.liquidity,tickLower:parsed.data.candidate.range.tickLower,
    tickUpper:parsed.data.candidate.range.tickUpper},
    token0Raw:null,token1Raw:null,nativeWei:null,
    idle0:model.idle.amount0Raw,idle1:model.idle.amount1Raw,
    principal:model.principal,knownLowerBound:model.lowerBound,
    fee0Raw:null,fee1Raw:null};
   const economics={principalOnlyValue:model.lowerBound.principalOnlyValue,
    passiveTokenValue:model.passiveTokenValue,feeIncome:null,paidCosts:null,
    nativeBalance:null,netNav:null,alpha:null};
   const provenance={classification:'paper_model_principal_valuation',modelHash,
    openMarkId:openMark.id,previousMarkId:previous.id,openModelHash:model.openModelHash,
    referenceProofHash:model.referenceProofHash,source:model.source,
    poolState:model.poolState,reference:model.reference,
    unavailable:model.unavailable};
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,provenance)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
    [model.campaignId,model.revision,model.source.block,model.source.hash,
     JSON.stringify(inventory),JSON.stringify(economics),JSON.stringify(provenance)])).rows[0]!;
   await db.query(`UPDATE deployment_campaigns SET range_state=$2,updated_at=clock_timestamp()
    WHERE id=$1`,[model.campaignId,model.poolState.tick>=parsed.data.candidate.range.tickLower&&
     model.poolState.tick<parsed.data.candidate.range.tickUpper?'inside':'outside']);
   return {markId:mark.id,replayed:false};
  });
 }

 /** Stores verified hypothetical fee bounds beside, never inside, the earned
  * fee ledger. The caller must be the canonical chain/indexer reader. */
 async recordTrustedPaperFeeEvidence(campaignId:string,fromMarkId:string,toMarkId:string,
  interval:CanonicalPaperFeeInterval){
  const proofHash=contentHash(interval);
  return this.transaction(async db=>{
   const campaign=(await db.query<{mode:string;profile:unknown;profile_hash:string;
    evidence:unknown}>(`SELECT c.mode,p.profile,p.profile_hash,p.evidence
    FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    WHERE c.id=$1 FOR UPDATE OF c`,[campaignId])).rows[0];
   const profile=marketProfileSchema.safeParse(campaign?.profile),
    evidence=marketProfileEvidenceSchema.safeParse(campaign?.evidence);
   if(!campaign||campaign.mode!=='paper'||!profile.success||!evidence.success||
    contentHash(campaign.profile)!==campaign.profile_hash||
    referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash||
    (['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash',
     'quoterCodeHash'] as const).some(key=>profile.data.pool[key].toLowerCase()!==
      evidence.data.contractHashes[key].toLowerCase()))
    throw new DeploymentConflict('paper_fee_campaign_unavailable');
   const p=profile.data.pool;
   if(interval.pool!==p.pool.toLowerCase()||interval.token0Address!==p.token0.toLowerCase()||
    interval.token1Address!==p.token1.toLowerCase()||interval.fee!==p.fee||
    interval.tickSpacing!==p.tickSpacing||
    interval.coverage.stream!==evidence.data.streamKey||
    interval.coverage.targetSetHash!==evidence.data.indexerTargetSetHash)
    throw new DeploymentConflict('paper_fee_profile_mismatch');
   const marks=(await db.query<{id:string;revision:number;source_block:string|null;
    source_hash:string|null;inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,source_block::text,source_hash,inventory,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND id IN ($2,$3) ORDER BY id`,
    [campaignId,fromMarkId,toMarkId])).rows;
   if(marks.length!==2||marks[0]!.id!==fromMarkId||marks[1]!.id!==toMarkId||
    marks[0]!.revision!==marks[1]!.revision)
    throw new DeploymentConflict('paper_fee_marks_unavailable');
   const [from,to]=marks as [typeof marks[number],typeof marks[number]];
    const closeClass=String(to.provenance.classification),
     closing=closeClass==='paper_model_partial_close'||closeClass==='paper_model_converted_close';
    if(!['paper_model_provisional','paper_model_principal_valuation'].includes(
    String(from.provenance.classification))||
    !['paper_model_principal_valuation','paper_model_partial_close',
     'paper_model_converted_close'].includes(closeClass)||
    from.source_block!==interval.from.block||to.source_block!==interval.to.block||
    from.source_hash?.toLowerCase()!==interval.from.hash.toLowerCase()||
    to.source_hash?.toLowerCase()!==interval.to.hash.toLowerCase())
    throw new DeploymentConflict('paper_fee_mark_source_mismatch');
   for(const mark of closing?[from]:[from,to]){
    const position=mark.inventory.position as Record<string,unknown>|undefined;
    if(!position||position.liquidity!==interval.liquidity||
     position.tickLower!==interval.range.tickLower||
     position.tickUpper!==interval.range.tickUpper)
     throw new DeploymentConflict('paper_fee_position_mismatch');
   }
   if(closing){
    const preview=(await db.query<{proposal:Record<string,unknown>}>(`
     SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
     [to.provenance.previewId,campaignId])).rows[0];
    if(closeClass==='paper_model_partial_close'){
     const close=paperCloseRetainModelSchema.safeParse(preview?.proposal.paperCloseRetainModel);
     if(!close.success||close.data.previousMarkId!==from.id||
      close.data.openMarkId!==to.provenance.openMarkId||
      close.data.openModelHash!==to.provenance.openModelHash||
      contentHash(close.data.source)!==contentHash(to.provenance.source)||
      contentHash(close.data.poolState)!==contentHash(to.provenance.poolState)||
      to.inventory.position!==null)
      throw new DeploymentConflict('paper_fee_close_endpoint_unavailable');
    }else{
     const close=paperCloseConvertModelSchema.safeParse(preview?.proposal.paperCloseConvertModel);
     if(!close.success||close.data.previousMarkId!==from.id||
      close.data.openMarkId!==to.provenance.openMarkId||
      close.data.openModelHash!==to.provenance.openModelHash||
      contentHash(close.data.source)!==contentHash(to.provenance.source)||
      contentHash(close.data.poolState)!==contentHash(to.provenance.poolState)||
      contentHash(close.data)!==to.provenance.closeConvertModelHash||
      to.inventory.position!==null)
      throw new DeploymentConflict('paper_fee_close_endpoint_unavailable');
    }
   }
   const skipped=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_marks
    WHERE campaign_id=$1 AND id>$2 AND id<$3) AS found`,[campaignId,fromMarkId,toMarkId])).rows[0]?.found;
   if(skipped)throw new DeploymentConflict('paper_fee_mark_gap');
   const existing=(await db.query<{id:string;from_mark_id:string;proof_hash:string}>(`
    SELECT id::text,from_mark_id::text,proof_hash FROM deployment_paper_fee_evidence
    WHERE campaign_id=$1 AND to_mark_id=$2`,[campaignId,toMarkId])).rows[0];
   if(existing){
    if(existing.from_mark_id===fromMarkId&&existing.proof_hash===proofHash)
     return {evidenceId:existing.id,replayed:true};
    throw new DeploymentConflict('paper_fee_conflicting_interval');
   }
   const open=(await db.query<{source_block:string|null;source_hash:string|null}>(`
    SELECT source_block::text,source_hash FROM deployment_marks WHERE campaign_id=$1
     AND provenance->>'classification'='paper_model_provisional' ORDER BY id LIMIT 2`,
    [campaignId])).rows;
   if(open.length!==1||!open[0]!.source_block||!open[0]!.source_hash)
    throw new DeploymentConflict('paper_fee_open_mark_unavailable');
   const prior=(await db.query<{carry:PaperFeeCarry;carry_hash:string}>(`
    SELECT carry,carry_hash FROM deployment_paper_fee_evidence
    WHERE campaign_id=$1 AND to_mark_id=$2`,[campaignId,fromMarkId])).rows[0];
   if(from.provenance.classification==='paper_model_provisional'&&prior||
    from.provenance.classification!=='paper_model_provisional'&&!prior)
    throw new DeploymentConflict('paper_fee_prior_evidence_unavailable');
   if(prior&&contentHash(prior.carry)!==prior.carry_hash)
    throw new DeploymentConflict('paper_fee_prior_evidence_integrity');
   let carry:PaperFeeCarry;
   try{carry=advancePaperFeeCarry(prior?.carry??null,interval,
    {block:open[0]!.source_block,hash:open[0]!.source_hash});}
   catch{throw new DeploymentConflict('paper_fee_interval_rejected');}
   const inserted=(await db.query<{id:string}>(`INSERT INTO deployment_paper_fee_evidence
    (campaign_id,from_mark_id,to_mark_id,proof,proof_hash,carry,carry_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
    [campaignId,fromMarkId,toMarkId,JSON.stringify(interval),proofHash,
     JSON.stringify(carry),contentHash(carry)])).rows[0]!;
   return {evidenceId:inserted.id,replayed:false};
  });
 }

 /** Materializes one source mark into a separate provisional accounting
  * journal. Fee intervals must already be verified and adjacent; no historical
  * mark or actual-paid ledger row is rewritten. Call through
  * recordCanonicalNextPaperAccounting outside isolated fixtures. */
 async recordNextPaperAccounting(campaignId:string,
  verifyAnchors:(chainId:number,sources:readonly {block:string;hash:string;timestamp:number}[])=>Promise<void>,
  policyVersion:string=PAPER_ACCOUNTING_POLICY,
  verifyCloseConvert?:(chainId:number,model:PaperCloseConvertModel,
   inputAmountRaw:string)=>Promise<PaperCloseConvertQuote>){
  if(![PAPER_ACCOUNTING_POLICY,PAPER_CONVERSION_ACCOUNTING_POLICY,
   PAPER_CONVERSION_ACCOUNTING_POLICY_V2].includes(policyVersion))
   throw new DeploymentConflict('paper_accounting_policy_unsupported');
  const conversionPolicy=policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY;
  const conversionPolicyV2=policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY_V2;
  const conversionEnabled=conversionPolicy||conversionPolicyV2;
  const currentRuntime=conversionPolicyV2?loadRuntimeIdentity():undefined;
  if(conversionPolicyV2&&!currentRuntime)
   throw new DeploymentConflict('paper_accounting_runtime_unavailable');
  return this.transaction(async db=>{
   const campaign=(await db.query<{mode:string;current_revision:number;allocation:unknown;
    profile:unknown;profile_hash:string;evidence:unknown;config_hash:string;config:unknown;open_mark_id:string;
    runtime_identity:unknown;open_provenance:Record<string,unknown>;proposal:Record<string,unknown>}>(`
    SELECT c.mode,c.current_revision,c.allocation,c.runtime_identity,p.profile,p.profile_hash,p.evidence,r.config_hash,r.config,
     o.id::text AS open_mark_id,o.provenance AS open_provenance,v.proposal
    FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN LATERAL (SELECT id,provenance FROM deployment_marks WHERE campaign_id=c.id
     AND provenance->>'classification'='paper_model_provisional' ORDER BY id LIMIT 1) o ON TRUE
    JOIN deployment_previews v ON v.id=(o.provenance->>'previewId')::uuid
    WHERE c.id=$1 FOR UPDATE OF c`,[campaignId])).rows[0];
   const profile=marketProfileSchema.safeParse(campaign?.profile),
    profileEvidence=marketProfileEvidenceSchema.safeParse(campaign?.evidence),
    open=paperOpenModelSchema.safeParse(campaign?.proposal.paperOpenModel);
   if(!campaign||campaign.mode!=='paper'||!profile.success||!profileEvidence.success||!open.success||
    contentHash(campaign.profile)!==campaign.profile_hash||
    referenceProofHash(profileEvidence.data.referenceProof)!==
     profileEvidence.data.references.proofHash||
    open.data.profileHash!==campaign.profile_hash||
    open.data.configHash!==campaign.config_hash||
    open.data.campaignId!==campaignId||open.data.revision!==campaign.current_revision||
    contentHash(open.data)!==campaign.open_provenance.modelHash)
    throw new DeploymentConflict('paper_accounting_campaign_unavailable');
   if(conversionPolicyV2){
    const storedRuntime=sealedRuntimeIdentitySchema.safeParse(campaign.runtime_identity);
    if(!storedRuntime.success||contentHash(storedRuntime.data)!==contentHash(currentRuntime))
     throw new DeploymentConflict('paper_accounting_runtime_mismatch');
   }
   const invalidated=(await db.query<{found:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM deployment_paper_accounting_invalidations WHERE campaign_id=$1) AS found`,
    [campaignId])).rows[0]?.found;
   if(invalidated)throw new DeploymentConflict('paper_accounting_history_invalidated');
   const allocation=allocationSchema.parse(campaign.allocation);
   if(contentHash(allocation)!==contentHash(open.data.allocation))
    throw new DeploymentConflict('paper_accounting_allocation_changed');
   const mark=(await db.query<{id:string;revision:number;source_block:string|null;
    source_hash:string|null;inventory:Record<string,unknown>;economics:unknown;
    provenance:Record<string,unknown>;calibration_profile_ids:string[]}>(`
    SELECT m.id::text,m.revision,m.source_block::text,m.source_hash,m.inventory,m.economics,
     m.provenance,m.calibration_profile_ids FROM deployment_marks m
    LEFT JOIN deployment_paper_accounting a ON a.source_mark_id=m.id
     AND a.campaign_id=m.campaign_id AND a.policy_version=$2
    WHERE m.campaign_id=$1 AND a.id IS NULL ORDER BY m.id LIMIT 1`,
    [campaignId,policyVersion])).rows[0];
   if(!mark)return null;
   if(mark.revision!==campaign.current_revision||!mark.source_block||!mark.source_hash)
    throw new DeploymentConflict('paper_accounting_mark_unavailable');
   const source=paperFeeMarkSourceSchema.safeParse(mark.provenance.source),
    reference=z.object({price0:z.string().regex(/^(0|[1-9][0-9]*)$/),
     price1:z.string().regex(/^(0|[1-9][0-9]*)$/),
     nativePrice:z.string().regex(/^(0|[1-9][0-9]*)$/)}).strict().safeParse(
      mark.provenance.reference);
   if(!source.success||!reference.success||source.data.block!==mark.source_block||
    source.data.hash.toLowerCase()!==mark.source_hash.toLowerCase())
    throw new DeploymentConflict('paper_accounting_mark_source_invalid');
   const classification=mark.provenance.classification;
   const kind=classification==='paper_model_provisional'?'open':
    classification==='paper_model_principal_valuation'?'valuation':
    classification==='paper_model_partial_close'?'close_retain':
    classification==='paper_model_converted_close'?'close_convert':null;
   if(!kind)throw new DeploymentConflict('paper_accounting_mark_unsupported');
   if(kind==='close_convert'&&!conversionEnabled)
    throw new DeploymentConflict('paper_accounting_mark_unsupported');
   const priorMark=(await db.query<{id:string}>(`SELECT id::text FROM deployment_marks
    WHERE campaign_id=$1 AND id<$2 ORDER BY id DESC LIMIT 1`,[campaignId,mark.id])).rows[0];
   const prior=priorMark?(await db.query<{snapshot:unknown;snapshot_hash:string}>(`
    SELECT snapshot,snapshot_hash FROM deployment_paper_accounting
    WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
    [campaignId,priorMark.id,policyVersion])).rows[0]:null;
   const parsedPriorV1=conversionEnabled?null:paperAccountingSchema.safeParse(prior?.snapshot);
   const parsedPriorConversionV1=conversionPolicy?paperConversionAccountingSchema.safeParse(prior?.snapshot):null;
   const parsedPriorConversionV2=conversionPolicyV2?
    paperConversionAccountingV2Schema.safeParse(prior?.snapshot):null;
   const priorData=parsedPriorConversionV2?.success?parsedPriorConversionV2.data:
    parsedPriorConversionV1?.success?parsedPriorConversionV1.data:
    parsedPriorV1?.success?parsedPriorV1.data:null;
   const priorValid=priorData!==null&&contentHash(priorData)===prior?.snapshot_hash;
   if(conversionPolicyV2&&parsedPriorConversionV2?.success&&
    contentHash(parsedPriorConversionV2.data.runtimeIdentity)!==contentHash(currentRuntime))
    throw new DeploymentConflict('paper_accounting_prior_runtime_mismatch');
   if(kind==='open'?mark.id!==campaign.open_mark_id||priorMark!==undefined:
    !priorMark||!priorValid)
    throw new DeploymentConflict('paper_accounting_prior_snapshot_unavailable');
   const feeRow=kind==='open'?null:(await db.query<{id:string;from_mark_id:string;
    proof:unknown;proof_hash:string;carry:PaperFeeCarry;carry_hash:string}>(`
    SELECT id::text,from_mark_id::text,proof,proof_hash,carry,carry_hash
    FROM deployment_paper_fee_evidence WHERE campaign_id=$1 AND to_mark_id=$2`,
    [campaignId,mark.id])).rows[0];
   if(kind!=='open'&&(!feeRow||feeRow.from_mark_id!==priorMark?.id||
    contentHash(feeRow.proof)!==feeRow.proof_hash||
    contentHash(feeRow.carry)!==feeRow.carry_hash))
    throw new DeploymentConflict('paper_accounting_fee_evidence_unavailable');
   if(feeRow){
    const priorFee=priorMark?(await db.query<{id:string;proof:unknown;proof_hash:string;
     carry:PaperFeeCarry;carry_hash:string}>(`
     SELECT id::text,proof,proof_hash,carry,carry_hash FROM deployment_paper_fee_evidence
     WHERE campaign_id=$1 AND to_mark_id=$2`,[campaignId,priorMark.id])).rows[0]:null;
    if(!priorData||
     (priorData.markKind==='open'?priorFee!==undefined:
      !priorFee||contentHash(priorFee.carry)!==priorFee.carry_hash||
       contentHash(priorFee.proof)!==priorFee.proof_hash||
       priorData.feeEvidence?.id!==priorFee.id||
       priorData.feeEvidence?.proofHash!==priorFee.proof_hash||
       priorData.feeEvidence?.carryHash!==priorFee.carry_hash))
     throw new DeploymentConflict('paper_accounting_prior_fee_unavailable');
    let replayedCarry:PaperFeeCarry;
    try{
     const proof=feeRow.proof as CanonicalPaperFeeInterval;
     if(proof.coverage.stream!==profileEvidence.data.streamKey||
      proof.coverage.targetSetHash!==profileEvidence.data.indexerTargetSetHash)
      throw Error('paper_accounting_coverage_changed');
     replayedCarry=advancePaperFeeCarry(priorFee?.carry??null,proof,open.data.source);
    }catch{throw new DeploymentConflict('paper_accounting_fee_replay_invalid');}
    if(contentHash(replayedCarry)!==feeRow.carry_hash)
     throw new DeploymentConflict('paper_accounting_fee_replay_invalid');
   }
   let close=null,closeConvert:PaperCloseConvertModel|null=null;
   if(kind==='close_retain'){
    const preview=(await db.query<{proposal:Record<string,unknown>}>(`
     SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
     [mark.provenance.previewId,campaignId])).rows[0];
    const parsed=paperCloseRetainModelSchema.safeParse(preview?.proposal.paperCloseRetainModel);
    if(!parsed.success||parsed.data.previousMarkId!==priorMark?.id||
     parsed.data.openMarkId!==campaign.open_mark_id||
     parsed.data.openModelHash!==contentHash(open.data)||
     contentHash(parsed.data.source)!==contentHash(source.data)||
     contentHash(parsed.data.reference)!==contentHash(reference.data)||
     contentHash(parsed.data.retainedLowerBound)!==
      contentHash(mark.inventory.retainedPrincipalLowerBound)||
     contentHash(parsed.data.costs)!==contentHash(mark.provenance.modeledCosts))
     throw new DeploymentConflict('paper_accounting_close_model_invalid');
    close=parsed.data;
   }
   if(kind==='close_convert'){
    const preview=(await db.query<{proposal:Record<string,unknown>}>(`
     SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
     [mark.provenance.previewId,campaignId])).rows[0];
    const parsed=paperCloseConvertModelSchema.safeParse(preview?.proposal.paperCloseConvertModel);
    if(!conversionEnabled||!parsed.success||parsed.data.previousMarkId!==priorMark?.id||
     parsed.data.openMarkId!==campaign.open_mark_id||
     parsed.data.openModelHash!==contentHash(open.data)||
     contentHash(parsed.data.source)!==contentHash(source.data)||
     contentHash(parsed.data.reference)!==contentHash(reference.data)||
     contentHash(parsed.data.principal)!==contentHash(mark.inventory.retainedPrincipalLowerBound)||
     contentHash(parsed.data.idle)!==contentHash(mark.inventory.idleLowerBound)||
     contentHash(parsed.data.costs)!==contentHash(mark.provenance.modeledCosts)||
     contentHash(parsed.data.conversionRoute)!==contentHash(mark.provenance.conversionRoute))
     throw new DeploymentConflict('paper_accounting_convert_model_invalid');
    const profileIds=parsed.data.costs.stages.map(stage=>stage.profileId);
    if(contentHash(profileIds)!==contentHash(mark.calibration_profile_ids))
     throw new DeploymentConflict('paper_accounting_gas_profiles_changed');
    const config=campaign.config&&typeof campaign.config==='object'?
     campaign.config as Record<string,unknown>:null;
    if(!config||contentHash(config)!==campaign.config_hash||
     config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||
     config.stateSchemaVersion!==1)
     throw new DeploymentConflict('paper_accounting_convert_config_changed');
    const {strategyId:_strategyId,strategyVersion:_strategyVersion,
     stateSchemaVersion:_stateSchemaVersion,...parameters}=config;
    await replayPaperCloseConvert(db,parsed.data,open.data,profile.data,parameters,
     Date.parse(parsed.data.costs.gasPriceObservedAt));
    closeConvert=parsed.data;
   }
   if(kind==='open'&&contentHash(open.data.costs)!==contentHash(mark.provenance.modeledCosts))
    throw new DeploymentConflict('paper_accounting_open_cost_invalid');
   if(['open','close_retain'].includes(kind)){
    const ids=(kind==='open'?open.data.costs:close!.costs).stages.map(stage=>stage.profileId);
    if(contentHash(ids)!==contentHash(mark.calibration_profile_ids))
     throw new DeploymentConflict('paper_accounting_gas_profiles_changed');
   }
   const amount=(record:unknown,key:string)=>{
    const raw=record&&typeof record==='object'&&!Array.isArray(record)?
     (record as Record<string,unknown>)[key]:null;
    if(typeof raw!=='string'||!/^(0|[1-9][0-9]*)$/.test(raw))
     throw new DeploymentConflict('paper_accounting_principal_unavailable');
    return raw;
   };
   const principal=kind==='open'?{token0Raw:allocation.token0Raw,token1Raw:allocation.token1Raw}:
    kind==='valuation'?mark.inventory.knownLowerBound:mark.inventory.retainedPrincipalLowerBound;
   const accountingMark={id:mark.id,kind:kind as 'open'|'valuation'|'close_retain'|'close_convert',
    source:source.data,reference:reference.data,
    principal0Raw:closeConvert?String(BigInt(closeConvert.principal.amount0Raw)+
     BigInt(closeConvert.idle.amount0Raw)):amount(principal,'token0Raw'),
    principal1Raw:closeConvert?String(BigInt(closeConvert.principal.amount1Raw)+
     BigInt(closeConvert.idle.amount1Raw)):amount(principal,'token1Raw')};
   const feeEvidence=feeRow?{id:feeRow.id,proofHash:feeRow.proof_hash,
    carryHash:feeRow.carry_hash,carry:feeRow.carry}:null;
   await verifyAnchors(profile.data.pool.chainId,[open.data.source,
    ...(priorData?[priorData.source]:[]),source.data]);
   let closeQuote:PaperCloseConvertQuote|null=null;
   let closeGasV2:PaperCloseConvertCostsV2|null=null,
    closeGasBindingV2:{reportHash:string;scopeHash:string;sequenceHash:string;
     sizeBand:string;profileIds:string[]}|null=null;
   if(closeConvert){
    if(!verifyCloseConvert)throw new DeploymentConflict('paper_accounting_convert_quote_verifier_unavailable');
    const priorStandard=conversionPolicyV2?
     paperAccountingFromConversionV2Snapshot(parsedPriorConversionV2?.success?
      parsedPriorConversionV2.data:null):
     paperAccountingFromConversionSnapshot(parsedPriorConversionV1?.success?
      parsedPriorConversionV1.data:null),
     baseMark={...accountingMark,kind:'valuation' as const};
    let beforeConversion:ReturnType<typeof buildPaperAccounting>;
    try{beforeConversion=buildPaperAccounting(open.data,profile.data,baseMark,
     priorStandard,feeEvidence,null);}
    catch{throw new DeploymentConflict('paper_accounting_convert_input_unavailable');}
    const inputAsset=closeConvert.conversionRoute.inputAsset,
     quoteAsset=profile.data.pool.quoteToken===0?'token0':'token1';
    if(inputAsset===quoteAsset)throw new DeploymentConflict('paper_accounting_convert_direction_invalid');
    const inputAmountRaw=inputAsset==='token0'?beforeConversion.inventory.token0Raw:
     beforeConversion.inventory.token1Raw;
    try{closeQuote=await verifyCloseConvert(profile.data.pool.chainId,closeConvert,inputAmountRaw);}
    catch{throw new DeploymentConflict('paper_accounting_convert_quote_invalid');}
    if(conversionPolicyV2){
     const selected=await this.selectRegisteredPaperCloseConvertGasV2(db,{campaignId,
      revision:campaign.current_revision,terminalMarkId:mark.id,previousMarkId:priorMark!.id,
      runtimeIdentity:currentRuntime!,profile:profile.data,open:open.data,model:closeConvert,
      inventory:beforeConversion.inventory,feeEvidence:{id:feeEvidence!.id,
       proofHash:feeEvidence!.proofHash,carryHash:feeEvidence!.carryHash}});
     closeGasV2=selected.costs;closeGasBindingV2=selected.binding;
    }
   }
   let accounting:unknown;
   if(conversionPolicy){
    const priorConversion=parsedPriorConversionV1?.success?parsedPriorConversionV1.data:null;
    try{accounting=buildPaperConversionAccounting(open.data,profile.data,accountingMark,
     priorConversion,feeEvidence,close,closeConvert,closeQuote);}
    catch{throw new DeploymentConflict('paper_accounting_convert_projection_invalid');}
   }else if(conversionPolicyV2){
    const priorConversion=parsedPriorConversionV2?.success?parsedPriorConversionV2.data:null;
    try{accounting=buildPaperConversionAccountingV2(open.data,profile.data,accountingMark,
     priorConversion,feeEvidence,close,closeConvert,closeQuote,closeGasV2,closeGasBindingV2,
     currentRuntime!);}
    catch{throw new DeploymentConflict('paper_accounting_convert_v2_projection_invalid');}
   }else{
    if(kind==='close_convert')throw new DeploymentConflict('paper_accounting_mark_unsupported');
    const priorStandard=parsedPriorV1?.success?parsedPriorV1.data:null;
    const standardMark={...accountingMark,kind:kind as 'open'|'valuation'|'close_retain'};
    try{accounting=buildPaperAccounting(open.data,profile.data,standardMark,
     priorStandard,feeEvidence,close);}
    catch{throw new DeploymentConflict('paper_accounting_projection_invalid');}
   }
   // Exact Quoter replay may span several RPC reads; bracket it with another
   // canonical pass before persisting this append-only snapshot.
   await verifyAnchors(profile.data.pool.chainId,[open.data.source,
    ...(priorData?[priorData.source]:[]),source.data]);
   const saved=(await db.query<{id:string}>(`INSERT INTO deployment_paper_accounting
    (campaign_id,source_mark_id,policy_version,fee_evidence_id,snapshot,snapshot_hash)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,
    [campaignId,mark.id,policyVersion,feeRow?.id??null,
     JSON.stringify(accounting),contentHash(accounting)])).rows[0]!;
   return {snapshotId:saved.id,markId:mark.id,kind};
  });
 }

 /** Rechecks every saved paper-accounting source and permanently revokes the
  * detected snapshot plus its dependent descendants after a canonical hash or
  * timestamp change. RPC/read failures throw and never create a revocation. */
 async auditPaperAccounting(campaignId:string,
  verifyAnchors:(chainId:number,sources:readonly PaperAccountingAnchor[])=>Promise<PaperAccountingAnchorMismatch|null>,
  policyVersion:string=PAPER_ACCOUNTING_POLICY){
  if(![PAPER_ACCOUNTING_POLICY,PAPER_CONVERSION_ACCOUNTING_POLICY,
   PAPER_CONVERSION_ACCOUNTING_POLICY_V2].includes(policyVersion))
   throw new DeploymentConflict('paper_accounting_policy_unsupported');
  const conversionPolicy=policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY;
  const conversionPolicyV2=policyVersion===PAPER_CONVERSION_ACCOUNTING_POLICY_V2;
  return this.transaction(async db=>{
   const campaign=(await db.query<{mode:string;chain_id:number}>(`
    SELECT mode,chain_id FROM deployment_campaigns WHERE id=$1 FOR UPDATE`,
    [campaignId])).rows[0];
   if(!campaign||campaign.mode!=='paper')
    throw new DeploymentConflict('paper_accounting_campaign_unavailable');
   const existing=(await db.query<{accounting_id:string;detected_accounting_id:string}>(`
    SELECT accounting_id::text,detected_accounting_id::text
    FROM deployment_paper_accounting_invalidations WHERE campaign_id=$1
    ORDER BY accounting_id LIMIT 1`,[campaignId])).rows[0];
   if(existing)return {checked:0,invalidated:[] as string[],
    alreadyInvalidated:true,detectedAccountingId:existing.detected_accounting_id};
   const rows=(await db.query<{id:string;source_mark_id:string;snapshot:unknown;snapshot_hash:string}>(`
    SELECT id::text,source_mark_id::text,snapshot,snapshot_hash
    FROM deployment_paper_accounting WHERE campaign_id=$1 AND policy_version=$2
    ORDER BY source_mark_id LIMIT 10001`,[campaignId,policyVersion])).rows;
   if(rows.length>10000)throw new DeploymentConflict('paper_accounting_audit_bound');
   const sources:PaperAccountingAnchor[]=rows.map(row=>{
    const parsed=conversionPolicy?paperConversionAccountingSchema.safeParse(row.snapshot):
     conversionPolicyV2?paperConversionAccountingV2Schema.safeParse(row.snapshot):
     paperAccountingSchema.safeParse(row.snapshot);
    if(!parsed.success||contentHash(parsed.data)!==row.snapshot_hash||
     parsed.data.campaignId!==campaignId||parsed.data.sourceMarkId!==row.source_mark_id)
     throw new DeploymentConflict('paper_accounting_audit_integrity');
    return {accountingId:row.id,markId:row.source_mark_id,...parsed.data.source};
   });
   if(!sources.length)return {checked:0,invalidated:[] as string[],
    alreadyInvalidated:false,detectedAccountingId:null};
   const mismatch=await verifyAnchors(campaign.chain_id,sources);
   if(!mismatch)return {checked:sources.length,invalidated:[] as string[],
    alreadyInvalidated:false,detectedAccountingId:null};
   const detected=sources.find(source=>source.accountingId===mismatch.accountingId);
   if(!detected||!/^0x[0-9a-fA-F]{64}$/.test(mismatch.actual.hash)||
    !Number.isSafeInteger(mismatch.actual.timestamp)||mismatch.actual.timestamp<0||
    (mismatch.actual.hash.toLowerCase()===detected.hash.toLowerCase()&&
     mismatch.actual.timestamp===detected.timestamp))
    throw new DeploymentConflict('paper_accounting_audit_result_invalid');
   const evidence={verificationClass:'canonical_anchor_recheck_v1',
    detectedAt:new Date().toISOString(),savedSource:{block:detected.block,
     hash:detected.hash,timestamp:detected.timestamp},
    actualSource:{block:detected.block,hash:mismatch.actual.hash,
     timestamp:mismatch.actual.timestamp}};
   const invalidated=(await db.query<{accounting_id:string}>(`
    INSERT INTO deployment_paper_accounting_invalidations
     (campaign_id,accounting_id,detected_accounting_id,reason,evidence)
    SELECT $1,a.id,$2,'canonical_anchor_changed',$3
    FROM deployment_paper_accounting a
     WHERE a.campaign_id=$1 AND a.source_mark_id >= $4
    ORDER BY a.source_mark_id
    ON CONFLICT(accounting_id) DO NOTHING RETURNING accounting_id::text`,
    [campaignId,detected.accountingId,JSON.stringify(evidence),
     detected.markId])).rows.map(row=>row.accounting_id);
   if(!invalidated.length)throw new DeploymentConflict('paper_accounting_invalidation_failed');
   return {checked:sources.length,invalidated,alreadyInvalidated:false,
    detectedAccountingId:detected.accountingId};
  });
 }

 /** A retain-close records a modeled principal lower bound and an explicit
  * unknown capital release. It never turns missing fee or paid-gas evidence
  * into a zero or an exact final balance. */
 async prepareTrustedPaperCloseConvert(operationId:string,workerId:string,
  verifyAnchors:(chainId:number,sources:readonly {block:string;hash:string;timestamp:number}[])=>Promise<void>){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  return this.transaction(async db=>{
   const row=(await db.query<{campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_until:Date|null;mode:string;lifecycle:string;current_revision:number;
    open_mark_id:string;profile:unknown;profile_hash:string;profile_evidence:unknown;
    config:unknown;config_hash:string;
    strategy_id:string;proposal:Record<string,unknown>;request:Record<string,unknown>;
    evidence:Record<string,unknown>;content_digest:string;expected_revision:number;expires_at:Date}>(`
    SELECT o.campaign_id,o.preview_id,o.kind,o.status,o.claimed_by,o.claim_until,c.mode,c.lifecycle,
     c.current_revision,c.open_mark_id,p.profile,p.profile_hash,p.evidence AS profile_evidence,
     r.config,r.config_hash,r.strategy_id,
     v.proposal,v.request,v.evidence,v.content_digest,v.expected_revision,v.expires_at
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_previews v ON v.id=o.preview_id WHERE o.id=$1 FOR UPDATE OF o,c`,
    [operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='close_convert')
    throw new DeploymentConflict('paper_close_convert_operation_unavailable');
   const priorMarks=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;calibration_profile_ids:string[];provenance:Record<string,unknown>}>(`
    SELECT id::text,source_block::text,source_hash,inventory,calibration_profile_ids,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND provenance->>'operationId'=$2 LIMIT 2`,
    [row.campaign_id,operationId])).rows;
   if(row.status==='succeeded'){
    if(priorMarks.length!==1)throw new DeploymentConflict('paper_close_convert_replay_integrity');
    return {markId:priorMarks[0]!.id,replayed:true,pending:false};
   }
   const now=Date.now(),pendingMark=priorMarks[0];
   if(row.lifecycle!=='closing'||row.status!=='reconciling'||row.claimed_by!==workerId||
    !row.claim_until||row.claim_until.getTime()<now)
    throw new DeploymentConflict('paper_close_convert_claim_lost');
   if(priorMarks.length>1)throw new DeploymentConflict('paper_close_convert_replay_integrity');
   if(row.current_revision!==row.expected_revision||(!pendingMark&&row.expires_at.getTime()<=now))
    throw new DeploymentConflict('paper_close_convert_preview_stale');
   if(previewDigest({campaignId:row.campaign_id,expectedRevision:row.expected_revision,
    kind:'close_convert',request:row.request,proposal:row.proposal,evidence:row.evidence,
    expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('paper_close_convert_preview_integrity');
   const parsed=paperCloseConvertModelSchema.safeParse(row.proposal.paperCloseConvertModel),
    profile=marketProfileSchema.safeParse(row.profile),
    profileEvidence=marketProfileEvidenceSchema.safeParse(row.profile_evidence);
   if(!parsed.success||!profile.success||!profileEvidence.success||
    contentHash(row.profile)!==row.profile_hash||
    referenceProofHash(profileEvidence.data.referenceProof)!==profileEvidence.data.references.proofHash||
    (['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
     .some(key=>profile.data.pool[key].toLowerCase()!==
      profileEvidence.data.contractHashes[key].toLowerCase())||
    !row.config||typeof row.config!=='object'||contentHash(row.config)!==row.config_hash||
    row.strategy_id!=='static_manual_v1')
    throw new DeploymentConflict('paper_close_convert_model_integrity');
   const model=parsed.data,config=row.config as Record<string,unknown>;
   if(model.campaignId!==row.campaign_id||model.revision!==row.current_revision||
    referenceProofHash(model.referenceProof)!==model.referenceProofHash||
    config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||
    config.stateSchemaVersion!==1)
    throw new DeploymentConflict('paper_close_convert_config_integrity');
   const {strategyId:_strategyId,strategyVersion:_strategyVersion,
    stateSchemaVersion:_stateSchemaVersion,...parameters}=config;
   const openMark=(await db.query<{id:string;revision:number;source_block:string|null;
    source_hash:string|null;inventory:Record<string,unknown>;provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,source_block::text,source_hash,inventory,provenance
    FROM deployment_marks WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [model.openMarkId,row.campaign_id])).rows[0];
   if(!openMark||openMark.revision!==row.current_revision||
    openMark.provenance.classification!=='paper_model_provisional'||
    !openMark.provenance.operationId||!openMark.provenance.previewId||
    !openMark.source_block||!openMark.source_hash)
    throw new DeploymentConflict('paper_close_convert_open_mark_unavailable');
   const openPreview=(await db.query<{proposal:Record<string,unknown>}>(`
    SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
    [openMark.provenance.previewId,row.campaign_id])).rows[0];
   const openParsed=paperOpenModelSchema.safeParse(openPreview?.proposal.paperOpenModel);
   if(!openParsed.success||openParsed.data.campaignId!==row.campaign_id||
    openParsed.data.revision!==row.current_revision||openParsed.data.profileHash!==row.profile_hash||
    openParsed.data.configHash!==row.config_hash||contentHash(openParsed.data)!==openMark.provenance.modelHash||
    contentHash(openParsed.data)!==model.openModelHash||model.openMarkId!==openMark.id)
    throw new DeploymentConflict('paper_close_convert_open_model_integrity');
   const latest=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND ($2::bigint IS NULL OR id<$2::bigint)
    ORDER BY id DESC LIMIT 1`,[row.campaign_id,pendingMark?.id??null])).rows[0];
   if(!latest||latest.id!==model.previousMarkId||latest.source_block===null||latest.source_hash===null||
    latest.source_block!==model.previousSource.block||
    latest.source_hash.toLowerCase()!==model.previousSource.hash.toLowerCase()||
    BigInt(model.source.block)<=BigInt(latest.source_block)||
    !['paper_model_provisional','paper_model_principal_valuation'].includes(
     String(latest.provenance.classification)))
    throw new DeploymentConflict('paper_close_convert_prior_mark_changed');
   const priorTimestamp=(latest.provenance.source as {timestamp?:unknown}|undefined)?.timestamp;
   if(!Number.isSafeInteger(priorTimestamp)||model.source.timestamp<(priorTimestamp as number))
    throw new DeploymentConflict('paper_close_convert_source_time_regressed');
   if(!pendingMark&&(model.source.timestamp*1000>now||now-model.source.timestamp*1000>180_000||
    Date.parse(model.costs.gasPriceObservedAt)>now||now-Date.parse(model.costs.gasPriceObservedAt)>120_000))
    throw new DeploymentConflict('paper_close_convert_source_stale');
   const {costs}=await replayPaperCloseConvert(db,model,openParsed.data,profile.data,parameters,
    pendingMark?Date.parse(model.costs.gasPriceObservedAt):now);
   const modelHash=contentHash(model),profileIds=costs.stages.map(stage=>stage.profileId);
   if(pendingMark){
    if(pendingMark.source_block!==model.source.block||
     pendingMark.source_hash?.toLowerCase()!==model.source.hash.toLowerCase()||
     pendingMark.provenance.closeConvertModelHash!==modelHash||
     contentHash(pendingMark.inventory.retainedPrincipalLowerBound)!==contentHash(model.principal)||
     contentHash(pendingMark.inventory.idleLowerBound)!==contentHash(model.idle)||
     contentHash(pendingMark.provenance.modeledCosts)!==contentHash(model.costs)||
     contentHash(pendingMark.provenance.conversionRoute)!==contentHash(model.conversionRoute)||
     contentHash(pendingMark.calibration_profile_ids)!==contentHash(profileIds))
     throw new DeploymentConflict('paper_close_convert_pending_mark_conflict');
   }
   const sources=[openParsed.data.source,
    {block:latest.source_block,hash:latest.source_hash,
     timestamp:latest.provenance.source&&typeof latest.provenance.source==='object'?
      Number((latest.provenance.source as Record<string,unknown>).timestamp):-1},model.source];
   if(sources.some(source=>!Number.isSafeInteger(source.timestamp)||source.timestamp<0))
    throw new DeploymentConflict('paper_close_convert_source_invalid');
   await verifyAnchors(profile.data.pool.chainId,sources);
   if(pendingMark)return {markId:pendingMark.id,replayed:true,pending:true};
   const source={classification:'paper_model_converted_close',operationId,previewId:row.preview_id,
    openMarkId:openMark.id,openModelHash:model.openModelHash,
    closeConvertModelHash:modelHash,referenceProofHash:model.referenceProofHash,
    source:model.source,poolState:model.poolState,reference:model.reference,
    modeledCosts:model.costs,conversionRoute:model.conversionRoute,
    quoteAvailable:false,paidCostsAvailable:false,
    unavailable:['fee_capture_pending','canonical_quote_pending','paid_gas','final_custody']};
   const inventory={classification:'paper_model_converted_close',position:null,
    token0Raw:null,token1Raw:null,nativeWei:null,
    retainedPrincipalLowerBound:model.principal,idleLowerBound:model.idle,
    unobserved:['lower_fee_carry','conversion_quote','paid_gas','final_custody']};
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,NULL,$6,$7) RETURNING id::text`,
    [row.campaign_id,row.current_revision,model.source.block,model.source.hash,
     JSON.stringify(inventory),profileIds,JSON.stringify(source)])).rows[0]!;
   await db.query(`UPDATE deployment_operations SET stage='paper_close_convert_mark_pending',
    updated_at=clock_timestamp() WHERE id=$1`,[operationId]);
   return {markId:mark.id,replayed:false,pending:true};
  });
 }

 /** Completes a conversion close only after the adjacent fee carry and a
  * canonical v2 quote/cost snapshot have been persisted. The paid ledger stays
  * unknown; this operation only records provisional modeled capital-out
  * references and the campaign's reconciled paper lifecycle. */
 async completeTrustedPaperCloseConvert(operationId:string,workerId:string,
  verifyAnchors:(chainId:number,sources:readonly {block:string;hash:string;timestamp:number}[])=>Promise<void>,
  verifyCloseConvert:(chainId:number,model:PaperCloseConvertModel,
   inputAmountRaw:string)=>Promise<PaperCloseConvertQuote>){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  const currentRuntime=loadRuntimeIdentity();
  if(!currentRuntime)throw new DeploymentConflict('paper_close_convert_runtime_unavailable');
  return this.transaction(async db=>{
   const row=(await db.query<{campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_until:Date|null;mode:string;lifecycle:string;current_revision:number;
    open_mark_id:string;runtime_identity:unknown;chain_id:number;profile:unknown;profile_hash:string;
    profile_evidence:unknown;config:unknown;
    config_hash:string;strategy_id:string;proposal:Record<string,unknown>;
    request:Record<string,unknown>;evidence:Record<string,unknown>;content_digest:string;
    expected_revision:number;expires_at:Date}>(`
    SELECT o.campaign_id,o.preview_id,o.kind,o.status,o.claimed_by,o.claim_until,
     c.mode,c.lifecycle,c.current_revision,c.open_mark_id,c.runtime_identity,c.chain_id,p.profile,p.profile_hash,
     p.evidence AS profile_evidence,
     r.config,r.config_hash,r.strategy_id,v.proposal,v.request,v.evidence,v.content_digest,
     v.expected_revision,v.expires_at
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_previews v ON v.id=o.preview_id WHERE o.id=$1 FOR UPDATE OF o,c`,
    [operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='close_convert')
    throw new DeploymentConflict('paper_close_convert_operation_unavailable');
   const persistedRuntime=sealedRuntimeIdentitySchema.safeParse(row.runtime_identity);
   if(!persistedRuntime.success||contentHash(persistedRuntime.data)!==contentHash(currentRuntime))
    throw new DeploymentConflict('paper_close_convert_runtime_mismatch');
   const replayed=row.status==='succeeded',now=Date.now();
   if(replayed){
    if(row.lifecycle!=='closed')throw new DeploymentConflict('paper_close_convert_replay_integrity');
   }else if(row.lifecycle!=='closing'||row.status!=='reconciling'||row.claimed_by!==workerId||
    !row.claim_until||row.claim_until.getTime()<now)
    throw new DeploymentConflict('paper_close_convert_claim_lost');
   if(row.current_revision!==row.expected_revision)
    throw new DeploymentConflict('paper_close_convert_preview_stale');
   if(previewDigest({campaignId:row.campaign_id,expectedRevision:row.expected_revision,
    kind:'close_convert',request:row.request,proposal:row.proposal,evidence:row.evidence,
    expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('paper_close_convert_preview_integrity');
   const profile=marketProfileSchema.safeParse(row.profile),
    profileEvidence=marketProfileEvidenceSchema.safeParse(row.profile_evidence),
    config=row.config&&typeof row.config==='object'?row.config as Record<string,unknown>:null,
    modelResult=paperCloseConvertModelSchema.safeParse(row.proposal.paperCloseConvertModel);
   if(!profile.success||!profileEvidence.success||contentHash(row.profile)!==row.profile_hash||
    referenceProofHash(profileEvidence.data.referenceProof)!==profileEvidence.data.references.proofHash||
    (['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
     .some(key=>profile.data.pool[key].toLowerCase()!==
      profileEvidence.data.contractHashes[key].toLowerCase())||!config||
    contentHash(config)!==row.config_hash||row.strategy_id!=='static_manual_v1'||
    config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||
    config.stateSchemaVersion!==1||!modelResult.success)
    throw new DeploymentConflict('paper_close_convert_model_integrity');
   const model=modelResult.data,{strategyId:_strategyId,strategyVersion:_strategyVersion,
    stateSchemaVersion:_stateSchemaVersion,...parameters}=config;
   if(model.campaignId!==row.campaign_id||model.revision!==row.current_revision||
    referenceProofHash(model.referenceProof)!==model.referenceProofHash)
    throw new DeploymentConflict('paper_close_convert_model_integrity');
   const marks=(await db.query<{id:string;revision:number;source_block:string|null;source_hash:string|null;
    inventory:Record<string,unknown>;calibration_profile_ids:string[];provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,source_block::text,source_hash,inventory,calibration_profile_ids,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND provenance->>'operationId'=$2 LIMIT 2`,
    [row.campaign_id,operationId])).rows;
   if(marks.length!==1)throw new DeploymentConflict('paper_close_convert_mark_unavailable');
   const mark=marks[0]!;
   const laterMark=(await db.query<{found:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM deployment_marks WHERE campaign_id=$1 AND id>$2) AS found`,
    [row.campaign_id,mark.id])).rows[0]?.found;
   if(mark.revision!==row.current_revision||
    laterMark||
    mark.provenance.classification!=='paper_model_converted_close'||
    mark.provenance.closeConvertModelHash!==contentHash(model)||
    mark.provenance.previewId!==row.preview_id||mark.provenance.openMarkId!==row.open_mark_id||
    mark.provenance.openModelHash!==model.openModelHash||mark.inventory.position!==null||
    mark.source_block!==model.source.block||mark.source_hash?.toLowerCase()!==model.source.hash.toLowerCase()||
    contentHash(mark.inventory.retainedPrincipalLowerBound)!==contentHash(model.principal)||
    contentHash(mark.inventory.idleLowerBound)!==contentHash(model.idle)||
    contentHash(mark.provenance.modeledCosts)!==contentHash(model.costs)||
    contentHash(mark.provenance.conversionRoute)!==contentHash(model.conversionRoute)||
    contentHash(mark.calibration_profile_ids)!==contentHash(model.costs.stages.map(stage=>stage.profileId)))
    throw new DeploymentConflict('paper_close_convert_mark_integrity');
   const openMark=(await db.query<{id:string;revision:number;source_block:string|null;
    source_hash:string|null;provenance:Record<string,unknown>}>(`
    SELECT id::text,revision,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [model.openMarkId,row.campaign_id])).rows[0];
   const openPreview=(await db.query<{proposal:Record<string,unknown>}>(`
    SELECT v.proposal FROM deployment_marks m JOIN deployment_previews v
     ON v.id=(m.provenance->>'previewId')::uuid WHERE m.id=$1 AND m.campaign_id=$2`,
    [model.openMarkId,row.campaign_id])).rows[0];
   const open=paperOpenModelSchema.safeParse(openPreview?.proposal.paperOpenModel);
   if(!openMark||!open.success||openMark.revision!==row.current_revision||
    openMark.provenance.classification!=='paper_model_provisional'||
    openMark.source_block!==open.data.source.block||
    openMark.source_hash?.toLowerCase()!==open.data.source.hash.toLowerCase()||
    contentHash(open.data)!==model.openModelHash||model.openMarkId!==row.open_mark_id||
    open.data.profileHash!==row.profile_hash||open.data.configHash!==row.config_hash)
    throw new DeploymentConflict('paper_close_convert_open_model_integrity');
   const priorMark=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`SELECT id::text,source_block::text,source_hash,provenance
    FROM deployment_marks WHERE campaign_id=$1 AND id=$2`,
    [row.campaign_id,model.previousMarkId])).rows[0];
   if(!priorMark||priorMark.source_block!==model.previousSource.block||
    priorMark.source_hash?.toLowerCase()!==model.previousSource.hash.toLowerCase()||
    !['paper_model_provisional','paper_model_principal_valuation'].includes(
     String(priorMark.provenance.classification)))
    throw new DeploymentConflict('paper_close_convert_prior_mark_unavailable');
   const {profileIds}=await replayPaperCloseConvert(db,model,open.data,profile.data,parameters,
    Date.parse(model.costs.gasPriceObservedAt));
   if(contentHash(profileIds)!==contentHash(mark.calibration_profile_ids))
    throw new DeploymentConflict('paper_close_convert_gas_profiles_changed');
   const feeRow=(await db.query<{id:string;from_mark_id:string;proof:unknown;proof_hash:string;
    carry:PaperFeeCarry;carry_hash:string}>(`
    SELECT id::text,from_mark_id::text,proof,proof_hash,carry,carry_hash
    FROM deployment_paper_fee_evidence WHERE campaign_id=$1 AND to_mark_id=$2`,
    [row.campaign_id,mark.id])).rows[0];
   if(!feeRow||feeRow.from_mark_id!==model.previousMarkId||
    contentHash(feeRow.proof)!==feeRow.proof_hash||contentHash(feeRow.carry)!==feeRow.carry_hash)
    throw new DeploymentConflict('paper_close_convert_fee_evidence_unavailable');
   const proof=feeRow.proof as CanonicalPaperFeeInterval;
   if(proof.coverage.stream!==profileEvidence.data.streamKey||
    proof.coverage.targetSetHash!==profileEvidence.data.indexerTargetSetHash)
    throw new DeploymentConflict('paper_close_convert_fee_coverage_changed');
   const priorFee=(await db.query<{id:string;proof:unknown;proof_hash:string;
    carry:PaperFeeCarry;carry_hash:string}>(`
    SELECT id::text,proof,proof_hash,carry,carry_hash FROM deployment_paper_fee_evidence
    WHERE campaign_id=$1 AND to_mark_id=$2`,[row.campaign_id,model.previousMarkId])).rows[0];
   if(priorMark.provenance.classification==='paper_model_provisional'&&priorFee||
    priorMark.provenance.classification!=='paper_model_provisional'&&(!priorFee||
     contentHash(priorFee.proof)!==priorFee.proof_hash||contentHash(priorFee.carry)!==priorFee.carry_hash))
    throw new DeploymentConflict('paper_close_convert_prior_fee_unavailable');
   let carry:PaperFeeCarry;
   try{carry=advancePaperFeeCarry(priorFee?.carry??null,proof,open.data.source);}
   catch{throw new DeploymentConflict('paper_close_convert_fee_replay_invalid');}
   if(contentHash(carry)!==feeRow.carry_hash)
    throw new DeploymentConflict('paper_close_convert_fee_replay_invalid');
   const feeEvidence={id:feeRow.id,proofHash:feeRow.proof_hash,
    carryHash:feeRow.carry_hash,carry:feeRow.carry};
   const snapshotRow=(await db.query<{id:string;snapshot:unknown;snapshot_hash:string;
    fee_evidence_id:string|null}>(`SELECT id::text,snapshot,snapshot_hash,fee_evidence_id::text
    FROM deployment_paper_accounting WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
    [row.campaign_id,mark.id,PAPER_CONVERSION_ACCOUNTING_POLICY_V2])).rows;
   if(snapshotRow.length!==1||snapshotRow[0]!.fee_evidence_id!==feeRow.id)
    throw new DeploymentConflict('paper_close_convert_accounting_unavailable');
   const saved=snapshotRow[0]!,snapshot=paperConversionAccountingV2Schema.safeParse(saved.snapshot);
   if(!snapshot.success||contentHash(snapshot.data)!==saved.snapshot_hash||
    snapshot.data.policyVersion!==PAPER_CONVERSION_ACCOUNTING_POLICY_V2||
    snapshot.data.campaignId!==row.campaign_id||snapshot.data.sourceMarkId!==mark.id||
    snapshot.data.markKind!=='close_convert'||snapshot.data.closeModelHash!==contentHash(model)||
    snapshot.data.feeEvidence?.id!==feeRow.id||snapshot.data.feeEvidence.proofHash!==feeRow.proof_hash||
    snapshot.data.feeEvidence.carryHash!==feeRow.carry_hash||snapshot.data.conversion===null||
    snapshot.data.inventory.hasLiquidity!==false||
    contentHash(snapshot.data.runtimeIdentity)!==contentHash(currentRuntime)||
    snapshot.data.conversion.gasEvidence.pathVersion!==PAPER_STATIC_CONVERT_GAS_PATH_V2)
    throw new DeploymentConflict('paper_close_convert_accounting_integrity');
   const previousSnapshotRow=(await db.query<{snapshot:unknown;snapshot_hash:string}>(`
    SELECT snapshot,snapshot_hash FROM deployment_paper_accounting
    WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version=$3`,
    [row.campaign_id,model.previousMarkId,PAPER_CONVERSION_ACCOUNTING_POLICY_V2])).rows[0];
   const previousSnapshot=previousSnapshotRow?
    paperConversionAccountingV2Schema.safeParse(previousSnapshotRow.snapshot):null;
   if(!previousSnapshot?.success||contentHash(previousSnapshot.data)!==previousSnapshotRow!.snapshot_hash||
    previousSnapshot.data.sourceMarkId!==model.previousMarkId||
    previousSnapshot.data.markKind==='close_convert'||
    contentHash(previousSnapshot.data.runtimeIdentity)!==contentHash(currentRuntime))
    throw new DeploymentConflict('paper_close_convert_prior_accounting_unavailable');
   const invalidated=(await db.query<{found:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM deployment_paper_accounting_invalidations WHERE campaign_id=$1) AS found`,
    [row.campaign_id])).rows[0]?.found;
   if(invalidated)throw new DeploymentConflict('paper_close_convert_history_invalidated');
   const principalAndIdle={
    token0Raw:String(BigInt(model.principal.amount0Raw)+BigInt(model.idle.amount0Raw)),
    token1Raw:String(BigInt(model.principal.amount1Raw)+BigInt(model.idle.amount1Raw))};
   const accountingMark={id:mark.id,kind:'close_convert' as const,source:model.source,
    reference:model.reference,principal0Raw:principalAndIdle.token0Raw,
    principal1Raw:principalAndIdle.token1Raw};
   const priorStandard=paperAccountingFromConversionV2Snapshot(previousSnapshot.data),
    baseMark={...accountingMark,kind:'valuation' as const};
   let base;
   try{base=buildPaperAccounting(open.data,profile.data,baseMark,priorStandard,feeEvidence,null);}
   catch{throw new DeploymentConflict('paper_close_convert_input_replay_invalid');}
   const conversion=snapshot.data.conversion!,route=model.conversionRoute,
    savedQuote=paperCloseConvertQuoteSchema.parse({schemaVersion:1,kind:'paper_exact_input_quote_v1',
     source:conversion.source,router:route.router,quoter:route.quoter,path:route.path,fee:route.fee,
     inputAsset:conversion.fromAsset,inputAmountRaw:conversion.inputAmountRaw,
     expectedOutputRaw:conversion.expectedOutputRaw,minimumOutputRaw:conversion.minimumOutputRaw,
     slippageBps:conversion.slippageBps,pathVersion:conversion.pathVersion,
     quoteHash:conversion.quoteHash});
   if(savedQuote.inputAmountRaw!==(savedQuote.inputAsset==='token0'?
    base.inventory.token0Raw:base.inventory.token1Raw))
    throw new DeploymentConflict('paper_close_convert_input_mismatch');
   const selectedGas=await this.selectRegisteredPaperCloseConvertGasV2(db,{campaignId:row.campaign_id,
    revision:row.current_revision,terminalMarkId:mark.id,previousMarkId:model.previousMarkId,
    runtimeIdentity:currentRuntime,profile:profile.data,open:open.data,model,
    inventory:base.inventory,feeEvidence:{id:feeRow.id,proofHash:feeRow.proof_hash,
     carryHash:feeRow.carry_hash}});
   let rebuilt;
   try{rebuilt=buildPaperConversionAccountingV2(open.data,profile.data,accountingMark,
    previousSnapshot.data,feeEvidence,null,model,savedQuote,selectedGas.costs,
    selectedGas.binding,currentRuntime);}
   catch{throw new DeploymentConflict('paper_close_convert_accounting_replay_invalid');}
   if(contentHash(rebuilt)!==saved.snapshot_hash)
    throw new DeploymentConflict('paper_close_convert_accounting_replay_changed');
   const anchors=[open.data.source,previousSnapshot.data.source,model.source];
   await verifyAnchors(profile.data.pool.chainId,anchors);
   let canonicalQuote:PaperCloseConvertQuote;
   try{canonicalQuote=paperCloseConvertQuoteSchema.parse(await verifyCloseConvert(
    profile.data.pool.chainId,model,savedQuote.inputAmountRaw));}
   catch{throw new DeploymentConflict('paper_close_convert_canonical_quote_invalid');}
   if(contentHash(canonicalQuote)!==contentHash(savedQuote))
    throw new DeploymentConflict('paper_close_convert_canonical_quote_changed');
   await verifyAnchors(profile.data.pool.chainId,anchors);
   const capitalOut=snapshot.data.flows.filter(flow=>flow.kind==='modeled_capital_out') as
    {kind:'modeled_capital_out';asset:'token0'|'token1'|'native';
     amountRaw:string;valueQuote:string}[];
   const byAsset=new Map(capitalOut.map(flow=>[flow.asset,flow]));
   if(capitalOut.length!==3||byAsset.size!==3||
    !(['token0','token1','native'] as const).every(asset=>byAsset.has(asset)))
    throw new DeploymentConflict('paper_close_convert_capital_out_unreconciled');
   const expectedLedger=['token0','token1','native'] as const;
   if(replayed){
    const ledger=(await db.query<{entry_key:string;kind:string;token_address:string|null;
     amount_raw:string|null;value_raw:string|null;source:Record<string,unknown>}>(`
     SELECT entry_key,kind,token_address,amount_raw::text,value_raw::text,source
     FROM deployment_ledger WHERE campaign_id=$1 AND operation_id=$2 ORDER BY entry_key`,
     [row.campaign_id,operationId])).rows;
    if(ledger.length!==3||!expectedLedger.every(asset=>{
     const flow=byAsset.get(asset)!,item=ledger.find(entry=>entry.entry_key===
      `paper_close_convert:${operationId}:${asset}`);
     return item?.kind==='capital_out'&&item.amount_raw===null&&item.value_raw===null&&
      item.source.snapshotHash===saved.snapshot_hash&&item.source.accountingId===saved.id&&
      item.source.modeledAmountRaw===flow.amountRaw&&item.source.modeledValueQuote===flow.valueQuote;
    }))throw new DeploymentConflict('paper_close_convert_replay_ledger_integrity');
    return {markId:mark.id,accountingId:saved.id,replayed:true};
   }
   for(const asset of expectedLedger){
    const flow=byAsset.get(asset)!,token=asset==='token0'?profile.data.pool.token0:
     asset==='token1'?profile.data.pool.token1:null;
    await db.query(`INSERT INTO deployment_ledger
     (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
     VALUES($1,$2,$3,'capital_out',$4,NULL,NULL,$5)`,
     [row.campaign_id,operationId,`paper_close_convert:${operationId}:${asset}`,token,
      JSON.stringify({classification:'paper_modeled_conversion_capital_out',operationId,
       previewId:row.preview_id,accountingId:saved.id,policyVersion:PAPER_CONVERSION_ACCOUNTING_POLICY_V2,
       snapshotHash:saved.snapshot_hash,asset,modeledAmountRaw:flow.amountRaw,
       modeledValueQuote:flow.valueQuote,quoteHash:conversion.quoteHash,
       paidCostsAvailable:false,actualCustodyAvailable:false})]);
   }
   await db.query(`UPDATE deployment_campaigns SET lifecycle='closed',range_state='no_liquidity',
    closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[row.campaign_id]);
   await db.query(`UPDATE deployment_operations SET status='succeeded',
    stage='paper_close_convert_reconciled',claimed_by=NULL,claim_until=NULL,
    updated_at=clock_timestamp() WHERE id=$1`,[operationId]);
   return {markId:mark.id,accountingId:saved.id,replayed:false};
  });
 }

 async completeTrustedPaperCloseRetain(operationId:string,workerId:string){
  if(!/^[a-zA-Z0-9._:-]{8,128}$/.test(workerId))throw new DeploymentConflict('invalid_worker_id');
  return this.transaction(async db=>{
   const row=(await db.query<{campaign_id:string;preview_id:string;kind:string;status:string;
    claimed_by:string|null;claim_until:Date|null;mode:string;lifecycle:string;current_revision:number;
    profile:unknown;profile_hash:string;config:unknown;config_hash:string;strategy_id:string;
    proposal:Record<string,unknown>;request:Record<string,unknown>;evidence:Record<string,unknown>;
    content_digest:string;expected_revision:number;expires_at:Date}>(`
    SELECT o.campaign_id,o.preview_id,o.kind,o.status,o.claimed_by,o.claim_until,c.mode,c.lifecycle,
     c.current_revision,p.profile,p.profile_hash,r.config,r.config_hash,r.strategy_id,
     v.proposal,v.request,v.evidence,v.content_digest,v.expected_revision,v.expires_at
    FROM deployment_operations o JOIN deployment_campaigns c ON c.id=o.campaign_id
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_previews v ON v.id=o.preview_id WHERE o.id=$1 FOR UPDATE OF o,c`,
    [operationId])).rows[0];
   if(!row||row.mode!=='paper'||row.kind!=='close_retain')
    throw new DeploymentConflict('paper_close_operation_unavailable');
   if(row.status==='succeeded'){
    const prior=(await db.query<{id:string}>(`SELECT id::text FROM deployment_marks
     WHERE campaign_id=$1 AND provenance->>'operationId'=$2 LIMIT 2`,
     [row.campaign_id,operationId])).rows;
    if(prior.length!==1)throw new DeploymentConflict('paper_close_replay_integrity');
    return {markId:prior[0]!.id,replayed:true};
   }
   if(row.lifecycle!=='closing'||row.status!=='reconciling'||row.claimed_by!==workerId||
    !row.claim_until||row.claim_until.getTime()<Date.now())throw new DeploymentConflict('paper_close_claim_lost');
   if(row.current_revision!==row.expected_revision||row.expires_at.getTime()<=Date.now())
    throw new DeploymentConflict('paper_close_preview_stale');
   if(previewDigest({campaignId:row.campaign_id,expectedRevision:row.expected_revision,
    kind:'close_retain',request:row.request,proposal:row.proposal,evidence:row.evidence,
    expiresAt:row.expires_at})!==row.content_digest)
    throw new DeploymentConflict('paper_close_preview_integrity');
   const parsed=paperCloseRetainModelSchema.safeParse(row.proposal.paperCloseRetainModel),
    profile=marketProfileSchema.safeParse(row.profile);
   if(!parsed.success||!profile.success||contentHash(row.profile)!==row.profile_hash||
    !row.config||typeof row.config!=='object'||contentHash(row.config)!==row.config_hash||
    row.strategy_id!=='static_manual_v1')throw new DeploymentConflict('paper_close_model_integrity');
   const model=parsed.data;
   if(model.campaignId!==row.campaign_id||model.revision!==row.current_revision||
    referenceProofHash(model.referenceProof)!==model.referenceProofHash)
    throw new DeploymentConflict('paper_close_model_integrity');
   const config=row.config as Record<string,unknown>;
   if(config.strategyId!=='static_manual_v1'||config.strategyVersion!=='1.0.0'||
    config.stateSchemaVersion!==1)throw new DeploymentConflict('paper_close_config_integrity');
   const {strategyId:_id,strategyVersion:_version,stateSchemaVersion:_schema,...parameters}=config;
   const openMark=(await db.query<{id:string;campaign_id:string;revision:number;inventory:unknown;
    provenance:Record<string,unknown>}>(`SELECT id::text,campaign_id,revision,inventory,provenance
    FROM deployment_marks WHERE id=$1 AND campaign_id=$2 FOR SHARE`,
    [model.openMarkId,row.campaign_id])).rows[0];
   if(!openMark||openMark.revision!==row.current_revision||
    openMark.provenance.classification!=='paper_model_provisional'||
    openMark.provenance.operationId===undefined||openMark.provenance.previewId===undefined)
    throw new DeploymentConflict('paper_close_open_mark_unavailable');
   const openPreview=(await db.query<{proposal:Record<string,unknown>}>(`
    SELECT proposal FROM deployment_previews WHERE id=$1 AND campaign_id=$2`,
    [openMark.provenance.previewId,row.campaign_id])).rows[0];
   const openParsed=paperOpenModelSchema.safeParse(openPreview?.proposal.paperOpenModel);
   if(!openParsed.success||openParsed.data.campaignId!==row.campaign_id||
    openParsed.data.revision!==row.current_revision||
    openParsed.data.profileHash!==row.profile_hash||openParsed.data.configHash!==row.config_hash||
    contentHash(openParsed.data)!==openMark.provenance.modelHash||
    contentHash(openParsed.data)!==model.openModelHash)
    throw new DeploymentConflict('paper_close_open_model_integrity');
   const latest=(await db.query<{id:string;source_block:string|null;source_hash:string|null;
    provenance:Record<string,unknown>}>(`
    SELECT id::text,source_block::text,source_hash,provenance FROM deployment_marks
    WHERE campaign_id=$1 ORDER BY id DESC LIMIT 1`,[row.campaign_id])).rows[0];
   if(!latest||latest.id!==model.previousMarkId||latest.source_block===null||
    latest.source_hash===null||
    BigInt(model.source.block)<=BigInt(latest.source_block)||
    !['paper_model_provisional','paper_model_principal_valuation'].includes(
     String(latest.provenance.classification)))
    throw new DeploymentConflict('paper_close_prior_mark_changed');
   const priorTimestamp=(latest.provenance.source as {timestamp?:unknown}|undefined)?.timestamp;
   if(!Number.isSafeInteger(priorTimestamp)||model.source.timestamp<(priorTimestamp as number))
    throw new DeploymentConflict('paper_close_source_time_regressed');
   const now=Date.now();
   if(model.source.timestamp*1000>now||now-model.source.timestamp*1000>180_000||
    Date.parse(model.costs.gasPriceObservedAt)>now||
    now-Date.parse(model.costs.gasPriceObservedAt)>120_000)
    throw new DeploymentConflict('paper_close_source_stale');
   const frame={source:model.source,tick:model.poolState.tick,
    sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),
    poolLiquidity:BigInt(model.poolState.poolLiquidity),price0:BigInt(model.reference.price0),
    price1:BigInt(model.reference.price1),nativePrice:BigInt(model.reference.nativePrice),
    referenceEligible:true,referenceReasons:[],referenceProofHash:model.referenceProofHash,
    referenceProof:model.referenceProof};
   const gasRows=(await db.query<PaperGasProfileRow>(`
    SELECT id,version,pool_address AS "poolAddress",path_version AS "pathVersion",stage,
     allowance_state AS "allowanceState",size_band AS "sizeBand",component,status,
     evidence_class AS "evidenceClass",model,source_hash AS "sourceHash",
     observed_until AS "observedUntil" FROM deployment_calibration_profiles
    WHERE chain_id=4663 AND lower(pool_address)=lower($1) AND path_version=$2
     AND component='gas_units' AND allowance_state='zero'
    ORDER BY size_band,stage,version DESC LIMIT 201`,
    [profile.data.pool.pool,PAPER_STATIC_GAS_PATH])).rows;
   const costed=costIndicativePaperOpenPreview({status:'indicative',candidate:openParsed.data.candidate},
    gasRows,profile.data.pool.pool,frame.nativePrice,BigInt(model.costs.gasPriceWei),
    Date.parse(model.costs.gasPriceObservedAt));
   if(costed.costs.status!=='provisional'||contentHash(costed.costs)!==contentHash(model.costs))
    throw new DeploymentConflict('paper_close_cost_profile_changed');
   let replayed;
   try{replayed=buildPaperCloseRetainModel(openParsed.data,openMark.id,
    {markId:latest.id,sourceBlock:latest.source_block,sourceHash:latest.source_hash},
    frame,profile.data,
    parameters,costed,now);}
   catch{throw new DeploymentConflict('paper_close_model_rejected');}
   if(contentHash(replayed)!==contentHash(model))throw new DeploymentConflict('paper_close_model_changed');
   const source={classification:'paper_model_partial_close',operationId,previewId:row.preview_id,
    openMarkId:openMark.id,openModelHash:model.openModelHash,
    referenceProofHash:model.referenceProofHash,source:model.source,
    poolState:model.poolState,reference:model.reference,
    unavailable:['fee_capture','paid_gas','net_economics']};
   const p=profile.data.pool;
   for(const [asset,token,lowerBound] of [
    ['token0',p.token0,model.retainedLowerBound.token0Raw],
    ['token1',p.token1,model.retainedLowerBound.token1Raw],
    ['native',null,null],
   ] as const){
    await db.query(`INSERT INTO deployment_ledger
     (campaign_id,operation_id,entry_key,kind,token_address,amount_raw,value_raw,source)
     VALUES($1,$2,$3,'capital_out',$4,NULL,NULL,$5)`,
     [row.campaign_id,operationId,`paper_close_retain:${operationId}:${asset}`,token,
      JSON.stringify({...source,asset,principalLowerBoundRaw:lowerBound})]);
   }
   const inventory={classification:'paper_model_partial_close',position:null,
    token0Raw:null,token1Raw:null,nativeWei:null,
    retainedPrincipalLowerBound:model.retainedLowerBound,
    unobserved:model.unobserved};
   const mark=(await db.query<{id:string}>(`INSERT INTO deployment_marks
    (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
    VALUES($1,$2,$3,$4,$5,NULL,$6,$7) RETURNING id::text`,
    [row.campaign_id,row.current_revision,model.source.block,model.source.hash,
     JSON.stringify(inventory),model.costs.stages.map(stage=>stage.profileId),
     JSON.stringify({...source,modeledCosts:model.costs,paidCostsAvailable:false})])).rows[0]!;
   await db.query(`UPDATE deployment_campaigns SET lifecycle='closed',range_state='no_liquidity',
    closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[row.campaign_id]);
   await db.query(`UPDATE deployment_operations SET status='succeeded',stage='paper_close_retain_recorded',
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
