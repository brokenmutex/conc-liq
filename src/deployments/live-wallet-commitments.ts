import type {Pool,PoolClient} from 'pg';
import {getAddress} from 'viem';
import type {LiveWalletCommitmentRead} from './live-wallet-reader.js';
import type {PinnedCustodySource} from './live-custody-snapshot.js';
import {readCommitments,readWalletState,type LiveWalletSource} from './live-wallet-store.js';
import {projectLiveWalletCommitmentRows,liveWalletCommitmentFingerprint} from './live-wallet-commitment-projection.js';

/** Existing active ledgers do not contain a proven per-campaign liquid
 * allocation. Preserve their ownership as an explicit block until the wallet
 * executor migration supplies that contract. Closed, reconciled predecessors
 * alone do not reserve current inventory. Reads never migrate or repair rows. */
export async function readLiveWalletCommitments(pool:Pick<Pool,'connect'>,operator:string,options?:{
 source:PinnedCustodySource;verifySource:(source:LiveWalletSource)=>Promise<void>}):Promise<LiveWalletCommitmentRead>{
 const wallet=getAddress(operator).toLowerCase();
 let db:PoolClient;
 try{db=await pool.connect();}catch{return {status:'unavailable',reasons:['live_wallet_commitment_read_unavailable']};}
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const deployment=(await db.query<{id:string;current_revision:number;strategy_id:string}>(`SELECT c.id,c.current_revision,r.strategy_id FROM deployment_campaigns c
   JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
   WHERE c.mode='live' AND lower(c.wallet)=$1 AND (
    c.lifecycle NOT IN ('draft','closed') OR
    EXISTS(SELECT 1 FROM deployment_wallet_reservations wr WHERE wr.campaign_id=c.id AND wr.released_at IS NULL) OR
    EXISTS(SELECT 1 FROM deployment_operations o WHERE o.campaign_id=c.id AND
     o.status IN ('queued','preflighting','executing','confirming','reconciling','blocked')))
   ORDER BY c.id LIMIT 1001`,[wallet])).rows;
  const rows=deployment.map(row=>({campaignId:`deployment:${row.id}`,active:true,known:false}));
  const shared=(await db.query<{present:string|null}>('SELECT to_regclass($1)::text AS present',
   ['deployment_live_allocations'])).rows[0]?.present;
  let proven:ReturnType<typeof projectLiveWalletCommitmentRows>=[];
  const reasons:string[]=[];
  if(shared){
   const identity={chainId:4663 as const,address:wallet},commitments=await readCommitments(db,identity),state=await readWalletState(db,identity);
   if(commitments.allocations.length){
    if(state.commitmentsHash!==liveWalletCommitmentFingerprint(commitments))
     reasons.push('live_wallet_allocation_fingerprint_changed');
    if(state.status!=='available'||!state.source||!options)reasons.push('live_wallet_allocation_source_not_verified');
    else if(BigInt(state.source.block)>options.source.block)reasons.push('live_wallet_allocation_ahead_of_review_source');
    else{try{await options.verifySource(state.source);}catch{reasons.push('live_wallet_allocation_anchor_changed');}}
    if(commitments.allocations.some(a=>!deployment.some(c=>c.id===a.campaignId&&c.current_revision===a.revision&&c.strategy_id==='rangekeeper_v1')))
     reasons.push('live_wallet_allocation_campaign_binding_unknown');
    const unresolved=(await db.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_live_stage_outbox
     WHERE chain_id=4663 AND wallet=$1 AND status IN ('prepared','signed','blocked')) AS pending`,[wallet])).rows[0]?.pending;
    if(unresolved!==false)reasons.push('live_wallet_transaction_unresolved');
    proven=projectLiveWalletCommitmentRows(commitments);
    if(reasons.length)proven=proven.map(row=>({...row,known:false}));
   }
  }
  for(const row of rows){const known=proven.find(p=>p.campaignId===row.campaignId);if(known)Object.assign(row,known);}
  for(const row of proven)if(!rows.some(r=>r.campaignId===row.campaignId))rows.push({...row,known:false} as typeof rows[number]);
  for(const schema of ['rangekeeper_v1','live_pilot_v1'] as const){
   const present=(await db.query<{present:string|null}>('SELECT to_regclass($1)::text AS present',
    [`${schema}.campaigns`])).rows[0]?.present;
   if(!present)continue;
   const legacy=(await db.query<{id:string}>(`SELECT c.id FROM ${schema}.campaigns c
    WHERE lower(c.operator)=$1 AND (coalesce(c.state->>'phase','unknown')<>'closed' OR
     EXISTS(SELECT 1 FROM ${schema}.actions a WHERE a.campaign_id=c.id AND a.status IN ('prepared','signed')))
    ORDER BY c.id LIMIT 1001`,[wallet])).rows;
   rows.push(...legacy.map(row=>({campaignId:`${schema}:${row.id}`,active:true,known:false})));
  }
  await db.query('COMMIT');
  if(deployment.length>1000||rows.length>1000)
   return {status:'unavailable',rows,reasons:['live_wallet_commitment_read_bound_exceeded']};
  return rows.some(row=>!row.known)||reasons.length?{status:'unavailable',rows,
   reasons:[...new Set([...reasons,'active_live_campaign_allocation_not_yet_proven'])]}:
   {status:'available',rows};
 }catch{
  await db.query('ROLLBACK').catch(()=>{});
  return {status:'unavailable',reasons:['live_wallet_commitment_read_unavailable']};
 }finally{db.release();}
}
