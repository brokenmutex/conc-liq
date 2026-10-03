import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {getAddress} from 'viem';
import {assertLiveRuntimeSchemaReady} from '../storage/compatibility.js';
import {contentHash} from './contracts.js';
import {withLiveWalletTransaction,type LiveWalletIdentity} from './live-wallet-store.js';
import {parseRangeKeeperConfig,rangeKeeperConfigHash,type RangeKeeperConfig} from '../strategy/rangekeeper/config.js';
import {rawValue} from '../strategy/rangekeeper/planner.js';
import {marketProfileSchema} from './market-profile.js';
import {parseRangeKeeperJson,rangeKeeperJson,type RangeKeeperLiveState} from '../strategy/rangekeeper/live-domain.js';
import type {AuthorizedRangeKeeperLiveStage,RangeKeeperLiveCampaign,RangeKeeperRuntimeEventInput,RangeKeeperRuntimeEventResult} from './rangekeeper-live-campaign.js';
import type {RangeKeeperSnapshot} from '../strategy/rangekeeper/live-domain.js';
import type {RangeKeeperLiveStageReferences} from './rangekeeper-live-references.js';

const zeroHash='0'.repeat(64);
const lower=(s:string)=>s.toLowerCase();
const safeJson=(v:unknown)=>JSON.parse(rangeKeeperJson(v));
const normalizeAddress=(value:string)=>getAddress(value).toLowerCase();
function stateHash(state:RangeKeeperLiveState){return contentHash(safeJson(state));}
/** Opening capital is frozen at the original independent native reference.
 * Never revalue this baseline at a later mark's native price. */
export function rangeKeeperLiveInitialCapitalValueX18(state:Pick<RangeKeeperLiveState,'initialNativeWei'|'initialStrategyValue'>,
 reviewPayload:unknown):string|null{
 const raw=(reviewPayload as any)?.references?.nativePrice;
 if(typeof raw!=='string'||!(/^[1-9][0-9]*$/.test(raw)))return null;
 const nativePrice=BigInt(raw);
 return (state.initialStrategyValue+rawValue(state.initialNativeWei,nativePrice,18)).toString();
}
function statusFor(kind:RangeKeeperRuntimeEventInput['kind'],state:RangeKeeperLiveState):'starting'|'active'|'blocked'|'closed'{
 if(kind==='initialized'||kind==='stage_receipt'&&state.phase==='entry')return 'starting';
 if(kind==='blocked'||state.phase==='halted')return 'blocked';if(kind==='closed'||state.phase==='closed')return 'closed';
 return 'active';
}

/** Load one campaign and its own revision/allocation/runtime. No wallet-wide singleton assumptions. */
export async function readRangeKeeperLiveCampaign(db:Pool|PoolClient,input:LiveWalletIdentity&{campaignId:string;revision?:number}):Promise<RangeKeeperLiveCampaign>{
 await assertLiveRuntimeSchemaReady(db);const wallet=normalizeAddress(input.address);
 const row=(await db.query<any>(`SELECT c.id,c.chain_id,c.wallet,c.lifecycle,c.current_revision,c.market_profile_id,c.allocation campaign_allocation,
  r.revision,
  p.profile,p.profile_hash,r.config revision_config,r.config_hash revision_config_hash,r.strategy_id,r.strategy_version,r.state_schema_version,
  a.id allocation_id,a.state allocation_state,a.native_spend_wei,a.pending_native_spend_wei,a.exit_reserve_wei,a.allocation_hash,a.source_generation,a.source_hash,
  m.chain_id runtime_chain_id,m.wallet runtime_wallet,m.profile_id runtime_profile_id,m.allocation_id runtime_allocation_id,
  m.profile_hash runtime_profile_hash,m.config_hash runtime_config_hash,m.state_json,m.state_hash,m.state_revision,m.status runtime_status,m.initial_baseline,
  j.payload review_payload
 FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
 JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=$4
 JOIN deployment_live_allocations a ON a.campaign_id=c.id AND a.revision=r.revision AND a.chain_id=c.chain_id AND a.wallet=c.wallet
 LEFT JOIN deployment_live_campaign_runtime m ON m.campaign_id=c.id AND m.revision=r.revision
 LEFT JOIN LATERAL (SELECT payload FROM deployment_live_jobs WHERE campaign_id=c.id AND kind='open' ORDER BY created_at LIMIT 1) j ON TRUE
 WHERE c.id=$1 AND c.chain_id=$2 AND lower(c.wallet)=$3 AND r.strategy_id='rangekeeper_v1' AND a.state<>'released'`,
 [input.campaignId,input.chainId,wallet,input.revision??1])).rows[0];
 assert(row,'RangeKeeper live campaign not found or allocation released');
 assert(row.current_revision===row.revision,'Campaign revision is not current');
 const payload=row.review_payload as any;assert(payload?.policy?.config&&payload?.binding?.buildId,'Frozen open review policy is missing');
 const config=parseRangeKeeperConfig(payload.policy.config);const configHash=rangeKeeperConfigHash(config);
 const marketProfile=marketProfileSchema.parse(row.profile);
 assert(contentHash(marketProfile.pool)===contentHash(config.pool),'Frozen strategy pool differs from registered market profile');
 assert(contentHash(marketProfile.referencePolicy)===contentHash(config.referencePolicy),
  'Frozen strategy reference policy differs from registered market profile');
 assert.equal(payload.policy.configHash,configHash.slice(2),'Frozen kernel config hash mismatch');
 assert.equal(row.strategy_version,config.strategyVersion);assert.equal(lower(config.operator??''),wallet);
 const revisionConfig=row.revision_config;assert.equal(contentHash(revisionConfig),row.revision_config_hash,'Persisted revision config hash mismatch');
 assert(contentHash(row.profile)===row.profile_hash,'Registered market profile hash mismatch');
 const tokens=await db.query<any>(`SELECT token_address,allocated_raw,pending_spend_raw FROM deployment_live_allocation_tokens WHERE allocation_id=$1 ORDER BY token_address`,[row.allocation_id]);
 const nfts=await db.query<any>(`SELECT token_id,status FROM deployment_live_nft_custody WHERE allocation_id=$1 AND status='active' ORDER BY token_id`,[row.allocation_id]);
 const allocation={allocationId:row.allocation_id,campaignId:row.id,revision:row.revision,wallet,
  liquidByTokenAddress:Object.fromEntries(tokens.rows.map((t:any)=>[t.token_address,BigInt(t.allocated_raw)])),
  nativeSpendWei:BigInt(row.native_spend_wei),pendingNativeSpendWei:BigInt(row.pending_native_spend_wei),exitReserveWei:BigInt(row.exit_reserve_wei),
  nftTokenIds:nfts.rows.map((n:any)=>String(n.token_id)),allocationHash:row.allocation_hash,sourceGeneration:Number(row.source_generation),sourceHash:row.source_hash};
 let state:RangeKeeperLiveState|null=null;
 if(row.state_json){
  state=parseRangeKeeperJson<RangeKeeperLiveState>(row.state_json);
  assert(row.runtime_chain_id===input.chainId&&normalizeAddress(row.runtime_wallet)===wallet&&row.runtime_profile_id===row.market_profile_id&&
   row.runtime_allocation_id===row.allocation_id&&row.runtime_profile_hash===row.profile_hash&&row.runtime_config_hash===configHash.slice(2),
   'Persisted campaign runtime identity/config binding changed');
  assert(Number.isSafeInteger(Number(row.state_revision))&&Number(row.state_revision)>0,'Persisted campaign state revision is invalid');
  assert(stateHash(state)===row.state_hash,'Persisted campaign state hash mismatch');
  assert(state.id===row.id&&normalizeAddress(state.operator)===wallet&&state.configHash===configHash&&
   state.buildId===String(payload.binding.buildId),'Persisted strategy state identity/config/build mismatch');
 }else assert(row.state_hash===null&&Number(row.state_revision??0)===0,'Runtime state row is incomplete');
 return {id:row.id,chainId:4663,wallet:getAddress(wallet),revision:row.revision,profileId:row.market_profile_id,profileHash:row.profile_hash,profile:row.profile,
  config,configHash,revisionConfig,revisionConfigHash:row.revision_config_hash,allocation,baseline:row.initial_baseline??{
   requirements:payload.requirements,references:payload.references,source:payload.source},reviewPayload:payload,state,stateHash:row.state_hash,
  stateRevision:Number(row.state_revision??0),status:row.lifecycle};
}

async function appendEvent(client:PoolClient,input:RangeKeeperRuntimeEventInput):Promise<RangeKeeperRuntimeEventResult>{
 await assertLiveRuntimeSchemaReady(client);const wallet=normalizeAddress(input.address);
 assert(input.chainId===4663&&/^[A-Za-z0-9._:-]{1,128}$/.test(input.effectId));
 if(input.kind==='stage_receipt'||input.kind==='opened')assert(input.receiptHash&&/^0x[0-9a-fA-F]{64}$/.test(input.receiptHash),
  'Canonical receipt hash required for successful stage/open effects');
 assert(input.source.block.match(/^(0|[1-9][0-9]*)$/)&&/^0x[0-9a-fA-F]{64}$/.test(input.source.hash));
 assert(input.state.id===input.campaignId&&lower(input.state.operator)===wallet,'Runtime state campaign/wallet mismatch');
 const stateJson=safeJson(input.state),nextHash=contentHash(stateJson),payloadJson=safeJson(input.payload),payloadHash=contentHash(payloadJson);
 const priorEvent=(await client.query<any>(`SELECT id,payload_hash,after_state_hash,sequence FROM deployment_live_runtime_events WHERE campaign_id=$1 AND revision=$2 AND effect_id=$3`,
  [input.campaignId,input.revision,input.effectId])).rows[0];
 if(priorEvent){assert.equal(priorEvent.payload_hash,payloadHash,'Runtime effect replay payload changed');assert.equal(priorEvent.after_state_hash,nextHash,'Runtime effect replay state changed');
  return {state:input.state,stateHash:nextHash,stateRevision:Number(priorEvent.sequence),replayed:true};}
 const runtime=(await client.query<any>(`SELECT * FROM deployment_live_campaign_runtime WHERE campaign_id=$1 AND revision=$2 FOR UPDATE`,[input.campaignId,input.revision])).rows[0];
 if(!runtime){
  assert(input.kind==='initialized'&&input.initial,'First runtime event must initialize an entry state before any stage');
  assert.equal(input.expectedStateHash,null);assert.equal(input.initial.profileHash.length,64);
  const allocation=(await client.query<any>(`SELECT a.*,c.wallet,c.lifecycle,c.market_profile_id,p.profile,p.profile_hash,
   r.strategy_id,r.config,r.config_hash
   FROM deployment_live_allocations a JOIN deployment_campaigns c ON c.id=a.campaign_id
   JOIN deployment_market_profiles p ON p.id=c.market_profile_id
   JOIN deployment_revisions r ON r.campaign_id=a.campaign_id AND r.revision=a.revision
   WHERE a.id=$1 AND a.campaign_id=$2 AND a.revision=$3 AND a.chain_id=$4 AND a.wallet=$5 FOR UPDATE OF a,c,r`,
   [input.initial.allocationId,input.campaignId,input.revision,input.chainId,wallet])).rows[0];
  assert(allocation&&allocation.lifecycle==='opening'&&allocation.state!=='released'&&allocation.strategy_id==='rangekeeper_v1');
  assert.equal(allocation.market_profile_id,input.initial.profileId);assert.equal(allocation.profile_hash,input.initial.profileHash);
  assert.equal(contentHash(allocation.profile),input.initial.profileHash,'Registered profile hash mismatch');
  assert.equal(contentHash(allocation.config),input.initial.revisionConfigHash);
  assert.equal(rangeKeeperConfigHash(input.initial.config),input.initial.configHash);
  assert.equal(input.state.configHash,input.initial.configHash);
  if(input.kind==='initialized')assert.equal(input.state.phase,'entry');else assert.equal(input.state.phase,'holding');
  assert.equal(BigInt(input.initial.initialToken0Raw),input.state.initial0);assert.equal(BigInt(input.initial.initialToken1Raw),input.state.initial1);
  assert.equal(BigInt(input.initial.initialNativeWei),input.state.initialNativeWei);
  const sequence=1;
  await client.query(`INSERT INTO deployment_live_campaign_runtime(campaign_id,revision,chain_id,wallet,profile_id,profile_hash,config_hash,allocation_id,
   state_json,state_hash,state_revision,source_block,source_hash,source_timestamp,status,initial_token0_raw,initial_token1_raw,initial_native_wei,
   initial_baseline,opened_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$19,$15,$16,$17,$18,NULL)`,
   [input.campaignId,input.revision,input.chainId,wallet,input.initial.profileId,input.initial.profileHash,input.initial.configHash.slice(2),input.initial.allocationId,
    stateJson,nextHash,sequence,input.source.block,input.source.hash,input.source.timestamp,input.initial.initialToken0Raw,input.initial.initialToken1Raw,input.initial.initialNativeWei,safeJson(input.initial.baseline),statusFor(input.kind,input.state)]);
  await client.query(`INSERT INTO deployment_live_runtime_events(id,campaign_id,revision,effect_id,sequence,kind,source_block,source_hash,source_timestamp,
   before_state_hash,after_state_hash,receipt_hash,payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
   [randomUUID(),input.campaignId,input.revision,input.effectId,sequence,input.kind,input.source.block,input.source.hash,input.source.timestamp,zeroHash,nextHash,input.receiptHash??null,payloadJson,payloadHash]);
  return {state:input.state,stateHash:nextHash,stateRevision:sequence,replayed:false};
 }
 assert(runtime.status!=='closed','Closed campaign runtime is immutable');assert.equal(runtime.state_hash,input.expectedStateHash,'Runtime compare-and-swap failed');
 assert(BigInt(input.source.block)>=BigInt(runtime.source_block),'Runtime source moved backwards');
 if(BigInt(input.source.block)===BigInt(runtime.source_block))assert(input.source.hash.toLowerCase()===runtime.source_hash.toLowerCase(),'Runtime source reorg requires explicit recovery');
 const sequence=Number(runtime.state_revision)+1,status=statusFor(input.kind,input.state),closedAt=status==='closed';
 await client.query(`UPDATE deployment_live_campaign_runtime SET state_json=$3,state_hash=$4,state_revision=$5,source_block=$6,source_hash=$7,source_timestamp=$8,
  status=$9,spent_cost_value=$10,spent_gas_wei=$11,opened_at=CASE WHEN $13 THEN coalesce(opened_at,clock_timestamp()) ELSE opened_at END,
  closed_at=CASE WHEN $12 THEN clock_timestamp() ELSE closed_at END,updated_at=clock_timestamp()
  WHERE campaign_id=$1 AND revision=$2`,[input.campaignId,input.revision,stateJson,nextHash,sequence,input.source.block,input.source.hash,input.source.timestamp,status,
   input.state.costEvents.reduce((sum,e)=>sum+(e.gasValue??0n)+(e.swapFeeValue??0n)+(e.swapShortfallValue??0n),0n).toString(),input.state.gasSpentWei.toString(),closedAt,input.kind==='opened']);
 await client.query(`INSERT INTO deployment_live_runtime_events(id,campaign_id,revision,effect_id,sequence,kind,source_block,source_hash,source_timestamp,
  before_state_hash,after_state_hash,receipt_hash,payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [randomUUID(),input.campaignId,input.revision,input.effectId,sequence,input.kind,input.source.block,input.source.hash,input.source.timestamp,
   runtime.state_hash,nextHash,input.receiptHash??null,payloadJson,payloadHash]);
 if(input.kind==='opened'){
  await client.query(`UPDATE deployment_campaigns SET lifecycle='active',updated_at=clock_timestamp() WHERE id=$1 AND lifecycle='opening'`,[input.campaignId]);
  await client.query(`UPDATE deployment_live_allocations SET state='active',updated_at=clock_timestamp() WHERE campaign_id=$1 AND revision=$2 AND state='reserved'`,[input.campaignId,input.revision]);
 }
 else if(input.kind==='closed')await client.query(`UPDATE deployment_campaigns SET lifecycle='closed',closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,[input.campaignId]);
 else if(input.kind==='blocked')await client.query(`UPDATE deployment_campaigns SET lifecycle='blocked',updated_at=clock_timestamp() WHERE id=$1`,[input.campaignId]);
 return {state:input.state,stateHash:nextHash,stateRevision:sequence,replayed:false};
}

/** Initialize only from a canonically reconciled successful open+allowance-cleanup effect. */
export async function initializeRangeKeeperLiveCampaignInTransaction(client:PoolClient,input:RangeKeeperRuntimeEventInput){
 assert(input.kind==='initialized'||input.kind==='opened');return appendEvent(client,input);
}
export async function appendRangeKeeperLiveCampaignEventInTransaction(client:PoolClient,input:RangeKeeperRuntimeEventInput){
 return appendEvent(client,input);
}
export async function initializeRangeKeeperLiveCampaign(pool:Pool,input:RangeKeeperRuntimeEventInput){
 return withLiveWalletTransaction(pool,input,client=>initializeRangeKeeperLiveCampaignInTransaction(client,input));
}
export async function appendRangeKeeperLiveCampaignEvent(pool:Pool,input:RangeKeeperRuntimeEventInput){
 return withLiveWalletTransaction(pool,input,client=>appendRangeKeeperLiveCampaignEventInTransaction(client,input));
}

/** Append one source-bound holding valuation for the shared dashboard and the
 * next policy observation. Unavailable references are recorded as null; the
 * custody/state observation remains useful without fabricating NAV. */
export async function recordRangeKeeperLiveValuationMarkInTransaction(client:PoolClient,input:{
 wallet:LiveWalletIdentity;campaignId:string;revision:number;snapshot:RangeKeeperSnapshot;
 references:RangeKeeperLiveStageReferences|null;positionFeeEvidence?:unknown|null;missing?:readonly string[];effectId?:string;
}):Promise<RangeKeeperRuntimeEventResult>{
 const campaign=await readRangeKeeperLiveCampaign(client,{...input.wallet,campaignId:input.campaignId,revision:input.revision});
 assert(campaign.state&&campaign.stateHash,'Campaign runtime state is not initialized');
 const state=structuredClone(campaign.state),snapshot=input.snapshot,source={block:String(snapshot.source.block),
  hash:snapshot.source.hash,timestamp:snapshot.source.timestamp};
 assert(snapshot.operator.toLowerCase()===campaign.wallet.toLowerCase(),'Valuation snapshot operator mismatch');
 assert(BigInt(source.block)>=state.last.source.block&&source.timestamp>=state.last.source.timestamp,'Valuation source moved backwards');
 if(BigInt(source.block)===state.last.source.block)assert(source.hash.toLowerCase()===state.last.source.hash.toLowerCase(),
  'Valuation source conflicts with prior campaign state');
 if(input.references){assert(input.references.source.block===source.block&&input.references.source.hash.toLowerCase()===source.hash.toLowerCase()&&
  input.references.source.timestamp===source.timestamp&&input.references.price0>0n&&input.references.price1>0n&&input.references.nativePrice>0n&&
  /^[0-9a-f]{64}$/.test(input.references.proofHash),'Valuation reference is not bound to observed source');}
 state.last=snapshot;state.lastMarkTimestamp=source.timestamp;
 const runtimeStateHash=contentHash(JSON.parse(rangeKeeperJson(state)));
 const payload={schemaVersion:1,kind:'rangekeeper_live_valuation_mark_v1',campaignId:campaign.id,revision:campaign.revision,
  allocationId:campaign.allocation.allocationId,allocationHash:campaign.allocation.allocationHash,profileId:campaign.profileId,
  profileHash:campaign.profileHash,configHash:campaign.configHash.slice(2),source,snapshot,
  allocation:{liquidByTokenAddress:Object.fromEntries(Object.entries(campaign.allocation.liquidByTokenAddress).map(([a,v])=>[a,v.toString()])),
   nativeSpendWei:campaign.allocation.nativeSpendWei.toString(),pendingNativeSpendWei:campaign.allocation.pendingNativeSpendWei.toString(),
   exitReserveWei:campaign.allocation.exitReserveWei.toString(),nftTokenIds:campaign.allocation.nftTokenIds},
  referenceValuation:input.references?{status:'available',source,proofHash:input.references.proofHash,
   price0:input.references.price0.toString(),price1:input.references.price1.toString(),nativePrice:input.references.nativePrice.toString(),
   evidence:input.references.evidence}:{status:'unavailable',source,missing:[...(input.missing??['independent_reference_unavailable'])]},
  positionFeeEvidence:input.positionFeeEvidence??null,
  runtimeStateHash,accountingState:{phase:state.phase,epoch:state.recenters,initial0:state.initial0,initial1:state.initial1,
   initialNativeWei:state.initialNativeWei,initialStrategyValue:state.initialStrategyValue,
   initialCapitalValue:rangeKeeperLiveInitialCapitalValueX18(state,campaign.reviewPayload),collectedFee0:state.collectedFee0,
   collectedFee1:state.collectedFee1,gasSpentWei:state.gasSpentWei,costEvents:state.costEvents},
  missing:[...(input.missing??[])]};
 const effectId=input.effectId??contentHash({kind:payload.kind,campaignId:campaign.id,revision:campaign.revision,source,
  runtimeStateHash});
 return appendRangeKeeperLiveCampaignEventInTransaction(client,{...input.wallet,campaignId:campaign.id,revision:campaign.revision,
  effectId,kind:'mark',expectedStateHash:campaign.stateHash,state,source,payload});
}

/** Persist the consumed owned-fork capability beside its already-inserted
 * outbox row. A replay is accepted only for byte-identical evidence. */
export async function persistRangeKeeperLiveStageAuthorizationInTransaction(client:PoolClient,input:{
 jobId:string;chainId:4663;wallet:string;campaign:RangeKeeperLiveCampaign;stage:string;authorized:AuthorizedRangeKeeperLiveStage;
}):Promise<{authorizationHash:string;replayed:boolean}>{
 await assertLiveRuntimeSchemaReady(client);
 const {campaign:c,authorized:a}=input,e=a.authorization;
 assert(input.stage===a.authorization.stage,'Authorization stage changed');
 assert(input.chainId===c.chainId&&normalizeAddress(input.wallet)===normalizeAddress(c.wallet),'Stage wallet/campaign identity mismatch');
 assert(e.campaignId===c.id&&e.revision===c.revision&&e.allocationId===c.allocation.allocationId&&
  e.profileId===c.profileId&&e.profileHash===c.profileHash&&e.allocationHash===c.allocation.allocationHash,
  'Stage authorization campaign binding mismatch');
 assert(/^[0-9a-f]{64}$/.test(e.calldataHash),'Stage authorization calldata hash is malformed');
 const raw=safeJson(e),authorizationHash=contentHash(raw),forkEvidenceHash=contentHash({forkReceiptHash:e.forkReceiptHash,evidenceHash:e.evidenceHash});
 const prior=(await client.query<any>(`SELECT authorization_hash FROM deployment_live_stage_authorizations WHERE job_id=$1 AND stage=$2`,
  [input.jobId,input.stage])).rows[0];
 if(prior){assert.equal(prior.authorization_hash,authorizationHash,'Stage authorization replay differs');return {authorizationHash,replayed:true};}
 await client.query(`INSERT INTO deployment_live_stage_authorizations(job_id,stage,chain_id,wallet,campaign_id,revision,allocation_id,profile_id,
  profile_hash,config_hash,allocation_hash,source_block,source_hash,source_timestamp,reference_proof_hash,plan_hash,calldata_hash,gas_used,gas_bound,
  max_fee_per_gas_wei,cost_value,fork_evidence_hash,capability_hash,authorization_json,authorization_hash)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,[
  input.jobId,input.stage,input.chainId,normalizeAddress(input.wallet),c.id,c.revision,c.allocation.allocationId,c.profileId,c.profileHash,
  e.configHash,c.allocation.allocationHash,e.source.block,e.source.hash,e.source.timestamp,e.referenceProofHash,e.planHash,
  // The runtime schema stores calldata as an RPC-style 0x-prefixed hash;
  // the canonical stage-proof hash helper deliberately returns bare hex.
  `0x${e.calldataHash.toLowerCase()}`,
  e.gasUsed,e.gasUnitsBound,e.maxFeePerGasWei,e.costValue,forkEvidenceHash,e.evidenceHash,raw,authorizationHash]);
 return {authorizationHash,replayed:false};
}

export interface CompleteRangeKeeperNftEvidence {
 kind:'complete_position_manager_nft_custody';status:'available';targetStrategyId:'rangekeeper_v1';operator:string;positionManager:string;
 source:{block:string;hash:string;timestamp:number;confirmed:true};enumerationComplete:true;tokenIds:string[];
 balanceOfCount:{status:'available';value:string};knownOwners:Array<{tokenId:string;owner:{status:'available';value:string}}>;missing:[];
}
export interface RangeKeeperNftPosition {tokenId:string;owner:string;liquidity:string;tokensOwed0:string;tokensOwed1:string}
export interface RecordRangeKeeperNftCustodySnapshotInput extends LiveWalletIdentity {
 positionManager:string;source:{block:string;hash:string;timestamp:number};completeEvidence:CompleteRangeKeeperNftEvidence;
 positions:RangeKeeperNftPosition[];retiredEmptyTokenIds:string[];campaignId?:string;allocationId?:string;allocatedTokenIds?:string[];
}
/** Persist complete indexed NFT set/position evidence at the same locked canonical
 * wallet source. Non-empty custody stays separate from liquid wallet allocations. */
export async function recordRangeKeeperNftCustodySnapshotInTransaction(client:PoolClient,input:RecordRangeKeeperNftCustodySnapshotInput){
 await assertLiveRuntimeSchemaReady(client);const wallet=normalizeAddress(input.address),manager=normalizeAddress(input.positionManager),e=input.completeEvidence;
 assert(input.chainId===4663&&e.kind==='complete_position_manager_nft_custody'&&e.status==='available'&&e.targetStrategyId==='rangekeeper_v1'&&
  e.enumerationComplete===true&&e.source.confirmed===true,'Complete canonical NFT enumeration is required');
 assert(normalizeAddress(e.operator)===wallet&&normalizeAddress(e.positionManager)===manager,'NFT evidence wallet/manager binding changed');
 assert(e.source.block===input.source.block&&e.source.hash.toLowerCase()===input.source.hash.toLowerCase()&&e.source.timestamp===input.source.timestamp,'NFT evidence source mismatch');
 const pinned=(await client.query<any>(`SELECT source_block,source_hash,source_timestamp FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2 FOR UPDATE`,[input.chainId,wallet])).rows[0];
 assert(pinned&&String(pinned.source_block)===input.source.block&&String(pinned.source_hash).toLowerCase()===input.source.hash.toLowerCase()&&Number(pinned.source_timestamp)===input.source.timestamp,'NFT source differs from persisted wallet source');
 const ids=e.tokenIds.map((id:string)=>BigInt(id).toString());assert(ids.length<=1000&&new Set(ids).size===ids.length&&ids.every((id:string)=>/^[1-9][0-9]*$/.test(id)),'Invalid complete NFT ID set');
 assert(BigInt(e.balanceOfCount.value)===BigInt(ids.length),'NFT balanceOf count differs from complete set');
 const known=e.knownOwners.map(x=>({id:BigInt(x.tokenId).toString(),owner:normalizeAddress(x.owner.value)})).sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
 assert(known.length===ids.length&&known.every((x,i)=>x.id===[...ids].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1)[i]&&x.owner===wallet),'NFT owner set differs from Transfer replay');
 const positions=input.positions.map(p=>({tokenId:BigInt(p.tokenId).toString(),owner:normalizeAddress(p.owner),liquidity:BigInt(p.liquidity),tokensOwed0:BigInt(p.tokensOwed0),tokensOwed1:BigInt(p.tokensOwed1)})).sort((a,b)=>BigInt(a.tokenId)<BigInt(b.tokenId)?-1:1);
 const sortedIds=[...ids].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);assert(positions.length===ids.length&&positions.every((p,i)=>p.tokenId===sortedIds[i]&&p.owner===wallet),'NFT position data must exactly cover owned set');
 const retired=input.retiredEmptyTokenIds.map(id=>BigInt(id).toString());assert(new Set(retired).size===retired.length&&retired.every(id=>ids.includes(id)),'Retired-empty NFT IDs must be an exact unique subset');
 assert(positions.filter(p=>retired.includes(p.tokenId)).every(p=>p.liquidity===0n&&p.tokensOwed0===0n&&p.tokensOwed1===0n),'Retired-empty NFT has liquidity or owed tokens');
 const allocated=(input.allocatedTokenIds??[]).map(id=>BigInt(id).toString());assert(new Set(allocated).size===allocated.length&&allocated.every(id=>ids.includes(id)),'Allocated NFT is outside complete owned set');
 assert(!allocated.some(id=>positions.find(p=>p.tokenId===id)!.liquidity===0n&&positions.find(p=>p.tokenId===id)!.tokensOwed0===0n&&positions.find(p=>p.tokenId===id)!.tokensOwed1===0n),'Cannot allocate empty NFT');
 if(allocated.length)assert(input.campaignId&&input.allocationId,'Campaign/allocation binding required for allocated NFT');
 const jsonPositions=positions.map(p=>({tokenId:p.tokenId,owner:p.owner,liquidity:p.liquidity.toString(),tokensOwed0:p.tokensOwed0.toString(),tokensOwed1:p.tokensOwed1.toString()}));
 const jsonEvidence=safeJson(e),evidenceHash=contentHash(jsonEvidence),id=randomUUID();
 await client.query(`INSERT INTO deployment_live_nft_custody_snapshots(id,chain_id,wallet,position_manager,source_block,source_hash,source_timestamp,
  enumeration_evidence,evidence_hash,owned_token_ids,positions,retired_empty_token_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  ON CONFLICT(chain_id,wallet,position_manager,source_block,source_hash) DO UPDATE SET enumeration_evidence=EXCLUDED.enumeration_evidence,
  evidence_hash=EXCLUDED.evidence_hash,owned_token_ids=EXCLUDED.owned_token_ids,positions=EXCLUDED.positions,retired_empty_token_ids=EXCLUDED.retired_empty_token_ids`,
  [id,input.chainId,wallet,manager,input.source.block,input.source.hash,input.source.timestamp,jsonEvidence,evidenceHash,
   JSON.stringify(ids),JSON.stringify(jsonPositions),JSON.stringify(retired)]);
 for(const p of positions){
  const isRetired=retired.includes(p.tokenId),isActive=p.liquidity>0n||p.tokensOwed0>0n||p.tokensOwed1>0n;
  const status=isRetired?'retired_empty':isActive?'active':'unmanaged';
  const associate=allocated.includes(p.tokenId);
  if(associate){const prior=(await client.query<any>(`SELECT campaign_id,allocation_id FROM deployment_live_nft_custody WHERE chain_id=$1 AND wallet=$2 AND position_manager=$3 AND token_id=$4 FOR UPDATE`,
    [input.chainId,wallet,manager,p.tokenId])).rows[0];
   assert(!prior?.campaign_id&&!prior?.allocation_id||prior.campaign_id===input.campaignId&&prior.allocation_id===input.allocationId,'NFT already belongs to another campaign allocation');}
  await client.query(`INSERT INTO deployment_live_nft_custody(chain_id,wallet,position_manager,token_id,allocation_id,campaign_id,status,liquidity,tokens_owed0,tokens_owed1,source_block,source_hash,source_timestamp)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(chain_id,wallet,position_manager,token_id) DO UPDATE SET
   allocation_id=coalesce(EXCLUDED.allocation_id,deployment_live_nft_custody.allocation_id),campaign_id=coalesce(EXCLUDED.campaign_id,deployment_live_nft_custody.campaign_id),
   status=EXCLUDED.status,liquidity=EXCLUDED.liquidity,tokens_owed0=EXCLUDED.tokens_owed0,tokens_owed1=EXCLUDED.tokens_owed1,
   source_block=EXCLUDED.source_block,source_hash=EXCLUDED.source_hash,source_timestamp=EXCLUDED.source_timestamp`,
   [input.chainId,wallet,manager,p.tokenId,associate?input.allocationId:null,associate?input.campaignId:null,status,p.liquidity.toString(),p.tokensOwed0.toString(),p.tokensOwed1.toString(),input.source.block,input.source.hash,input.source.timestamp]);
 }
 return {snapshotId:id,evidenceHash,ownedTokenIds:sortedIds,retiredEmptyTokenIds:retired.sort((a,b)=>BigInt(a)<BigInt(b)?-1:1),source:input.source};
}
