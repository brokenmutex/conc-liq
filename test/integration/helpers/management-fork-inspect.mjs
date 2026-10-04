// Read-only PostgreSQL inspectors for the management fork qualification. They read the same durable rows the
// product writes (jobs, stage outbox, campaign runtime, allocations, NFT custody, runtime events) so assertions
// describe persisted evidence rather than worker return values.
import {readRangeKeeperLiveCampaign} from '../../../src/deployments/rangekeeper-live-campaign-store.ts';
import {readCommitments,readWalletState} from '../../../src/deployments/live-wallet-store.ts';
import {parseRangeKeeperJson,rangeKeeperJson} from '../../../src/strategy/rangekeeper/live-domain.ts';

const marker='__rangekeeper_bigint_v1__';
/** Decode the product's bigint marker (and the older {$bigint} shape) from persisted JSON. */
export const decodeBigints=value=>{
 if(Array.isArray(value))return value.map(decodeBigints);
 if(value&&typeof value==='object'){
  const keys=Object.keys(value);
  if(keys.length===1&&(keys[0]===marker||keys[0]==='$bigint'))return BigInt(value[keys[0]]);
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,decodeBigints(v)]));
 }
 return value;
};
export const plain=value=>JSON.parse(rangeKeeperJson(value));

export function createInspector({db,wallet}){
 const identity={chainId:4663,address:wallet};
 const campaign=(campaignId,revision)=>readRangeKeeperLiveCampaign(db,{...identity,campaignId,...(revision?{revision}:{})});
 const jobRow=async id=>(await db.query('SELECT * FROM deployment_live_jobs WHERE id=$1',[id])).rows[0]??null;
 const jobsOf=async(campaignId,kind)=>(await db.query(`SELECT id,kind,status,attempt,priority,idempotency_key,created_at,updated_at,lease_until,
  resume_stage FROM deployment_live_jobs WHERE campaign_id=$1 ${kind?'AND kind=$2':''} ORDER BY created_at,id`,kind?[campaignId,kind]:[campaignId])).rows;
 /** Outbox rows of one job in creation order, with the plan decoded. */
 const stagesOf=async jobId=>(await db.query(`SELECT stage,status,nonce::text nonce,signed_raw,signed_raw_hash,plan_json,intent_json,
  canonical_receipt_json,effect_evidence_json,allowance_cleanup_json,created_at FROM deployment_live_stage_outbox WHERE job_id=$1
  ORDER BY created_at,stage`,[jobId])).rows.map(row=>({...row,nonce:Number(row.nonce),plan:decodeBigints(row.plan_json),kind:row.plan_json?.kind}));
 const confirmedStagesOf=async jobId=>(await stagesOf(jobId)).filter(stage=>stage.status==='confirmed');
 const allOutbox=async()=>(await db.query(`SELECT job_id,stage,status,nonce::text nonce,signed_raw_hash,plan_json->>'kind' kind FROM deployment_live_stage_outbox
  WHERE chain_id=4663 AND wallet=$1 ORDER BY created_at,stage`,[wallet])).rows.map(row=>({...row,nonce:Number(row.nonce)}));
 const allocationRow=async campaignId=>(await db.query(`SELECT id,state,native_spend_wei::text native_spend_wei,pending_native_spend_wei::text pending_native_spend_wei,
  exit_reserve_wei::text exit_reserve_wei,allocation_hash,source_generation,released_at FROM deployment_live_allocations WHERE campaign_id=$1
  ORDER BY created_at DESC LIMIT 1`,[campaignId])).rows[0]??null;
 const allocationTokens=async campaignId=>Object.fromEntries((await db.query(`SELECT t.token_address,t.allocated_raw::text allocated_raw,t.pending_spend_raw::text pending_spend_raw
  FROM deployment_live_allocation_tokens t JOIN deployment_live_allocations a ON a.id=t.allocation_id WHERE a.campaign_id=$1 ORDER BY t.token_address`,[campaignId])).rows
  .map(row=>[row.token_address,{allocated:row.allocated_raw,pending:row.pending_spend_raw}]));
 const custodyOf=async campaignId=>(await db.query(`SELECT token_id::text token_id,status,liquidity::text liquidity,tokens_owed0::text tokens_owed0,
  tokens_owed1::text tokens_owed1,allocation_id FROM deployment_live_nft_custody WHERE campaign_id=$1 ORDER BY token_id::numeric`,[campaignId])).rows
  .map(row=>({tokenId:row.token_id,status:row.status,liquidity:row.liquidity,owed0:row.tokens_owed0,owed1:row.tokens_owed1}));
 const lifecycleOf=async campaignId=>(await db.query('SELECT lifecycle FROM deployment_campaigns WHERE id=$1',[campaignId])).rows[0]?.lifecycle??null;
 const eventsOf=async(campaignId,afterSequence=0)=>(await db.query(`SELECT sequence,kind,effect_id,payload,source_block::text source_block,source_timestamp
  FROM deployment_live_runtime_events WHERE campaign_id=$1 AND sequence>$2 ORDER BY sequence`,[campaignId,afterSequence])).rows
  .map(row=>({sequence:Number(row.sequence),kind:row.kind,payloadKind:row.payload?.kind??null,reason:row.payload?.reason??null,
   decision:row.payload?.decision??null,action:row.payload?.action??null,sourceBlock:row.source_block,sourceTimestamp:Number(row.source_timestamp),payload:row.payload}));
 const lastSequence=async campaignId=>Number((await db.query('SELECT coalesce(max(sequence),0) n FROM deployment_live_runtime_events WHERE campaign_id=$1',[campaignId])).rows[0].n);
 const walletRow=async()=>(await db.query(`SELECT generation,status,nonce::text nonce,pending_nonce::text pending_nonce,native_balance_wei::text native_balance_wei,
  source_block::text source_block,source_hash,source_timestamp,commitments_hash FROM deployment_live_wallets WHERE chain_id=4663 AND wallet=$1`,[wallet])).rows[0];
 const reviewOf=async id=>(await db.query('SELECT id,payload,payload_hash,consumed_by_job,expires_at FROM deployment_live_reviews WHERE id=$1',[id])).rows[0]??null;

 /** The economically meaningful, observation-independent part of a campaign. Planner/valuation marks legitimately
  * rewrite `last`, `policy`, `lastReason` and `lastMarkTimestamp` on a holding campaign, so the sibling-isolation check
  * compares this fingerprint (and the absence of any non-mark event) instead of the raw state hash. */
 const strategicFingerprint=async campaignId=>{
  const c=await campaign(campaignId),s=c.state;
  const state=s?plain({phase:s.phase,desired:s.desired,exitMode:s.exitMode??null,activeTokenId:s.activeTokenId,retiredTokenIds:s.retiredTokenIds,
   economicActions:s.economicActions,recenters:s.recenters,candidate:s.candidate,swapDone:s.swapDone,withdrawDone:s.withdrawDone,
   gasSpentWei:s.gasSpentWei,collectedFee0:s.collectedFee0,collectedFee1:s.collectedFee1,costEvents:s.costEvents,
   initial0:s.initial0,initial1:s.initial1,initialNativeWei:s.initialNativeWei,initialStrategyValue:s.initialStrategyValue,
   reservedActionCost:s.reservedActionCost,haltReason:s.haltReason}):null;
  const jobs=(await jobsOf(campaignId)).map(job=>({id:job.id,kind:job.kind,status:job.status}));
  const outboxRows=Number((await db.query(`SELECT count(*)::int n FROM deployment_live_stage_outbox o JOIN deployment_live_jobs j ON j.id=o.job_id
   WHERE j.campaign_id=$1`,[campaignId])).rows[0].n);
  return {status:c.status,state,allocation:{...plain({liquid:c.allocation.liquidByTokenAddress,nativeSpendWei:c.allocation.nativeSpendWei,
   pendingNativeSpendWei:c.allocation.pendingNativeSpendWei,exitReserveWei:c.allocation.exitReserveWei,nftTokenIds:c.allocation.nftTokenIds}),
   allocationHash:c.allocation.allocationHash},custody:await custodyOf(campaignId),jobs,outboxRows,lifecycle:await lifecycleOf(campaignId)};
 };
 /** Runtime state straight from the runtime table. Unlike `campaign`, it also works for a closed campaign whose allocation
  * was released (readRangeKeeperLiveCampaign refuses released allocations by design). */
 const stateOf=async campaignId=>{
  const row=(await db.query(`SELECT m.state_json,m.state_hash,m.status,c.lifecycle FROM deployment_live_campaign_runtime m
   JOIN deployment_campaigns c ON c.id=m.campaign_id WHERE m.campaign_id=$1`,[campaignId])).rows[0];
  return row?{lifecycle:row.lifecycle,runtimeStatus:row.status,stateHash:row.state_hash,state:parseRangeKeeperJson(row.state_json)}:null;
 };
 const commitments=()=>readCommitments(db,identity);
 const walletState=()=>readWalletState(db,identity);
 return {identity,campaign,stateOf,jobRow,jobsOf,stagesOf,confirmedStagesOf,allOutbox,allocationRow,allocationTokens,custodyOf,lifecycleOf,eventsOf,
  lastSequence,walletRow,reviewOf,strategicFingerprint,commitments,walletState};
}
