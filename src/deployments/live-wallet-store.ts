import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { assertLiveWalletSchemaReady } from "../storage/compatibility.js";
import { liveWalletCommitmentFingerprint } from "./live-wallet-commitment-projection.js";
import { parseRangeKeeperConfig, rangeKeeperConfigHash } from "../strategy/rangekeeper/config.js";
import { contentHash } from "./contracts.js";

export const LIVE_CHAIN_ID = 4663 as const;
export interface LiveWalletIdentity { chainId: typeof LIVE_CHAIN_ID; address: string }
export interface LiveWalletSource { block: string; hash: string; timestamp: number }
export interface LiveWalletTokenBalance { address: string; balanceRaw: string }
export interface LiveWalletSnapshotInput extends LiveWalletIdentity {
  source: LiveWalletSource; nonce: string; pendingNonce: string; nativeBalanceWei: string;
  tokens: LiveWalletTokenBalance[]; commitmentsHash: string; snapshotHash?: string;
  status?: "available" | "blocked"; reorgRecovery?: boolean;
  effectProof?: { priorSnapshotHash: string; operationId: string; evidenceHash: string };
}
export interface LiveWalletState extends LiveWalletIdentity {
  generation: number; status: "uninitialized" | "available" | "blocked";
  source: LiveWalletSource | null; snapshotHash: string | null; commitmentsHash: string | null;
  nonce: string | null; pendingNonce: string | null; nativeBalanceWei: string | null;
  tokens: LiveWalletTokenBalance[];
}
export interface LiveWalletReviewInput extends LiveWalletIdentity {
  reviewId?: string; payload: unknown; payloadHash: string; buildId: string;
  source: LiveWalletSource; expiresAt: string | Date; walletGeneration: number; commitmentsHash: string;
}
export interface LiveWalletReview extends LiveWalletReviewInput { reviewId: string; consumedByJob: string | null }
export interface LiveWalletTokenAllocation { address: string; amountRaw: string }
export interface LiveWalletCampaignInput {
  wallet: string; marketProfileId: string; mode: "live"; strategyId: "rangekeeper_v1";
  strategyVersion: string; stateSchemaVersion: number;
  allocation: { token0Raw: string; token1Raw: string; nativeWei: string };
  config: unknown; configHash: string; baseline: unknown; source: LiveWalletSource;
}
export interface LiveWalletReservationInput {
  tokens: LiveWalletTokenAllocation[]; nativeSpendWei: string; exitReserveWei: string;
  nftTokenIds: string[];
}
export interface ConsumeReviewAndReserveInput extends LiveWalletIdentity {
  requestId: string; requestDigest: string; reviewId: string; reviewHash: string;
  campaign: LiveWalletCampaignInput; allocation: LiveWalletReservationInput;
  payload: unknown; buildId?: string; verifySource: (source: LiveWalletSource) => Promise<void>;
}
export interface LiveWalletQueuedResult { campaignId: string; allocationId: string; jobId: string; status: string; replayed: boolean }
export interface LiveWalletCommitments {
  wallet: LiveWalletIdentity;
  allocations: Array<{ allocationId: string; campaignId: string; revision: number; state: string;
    tokens: Array<{ address: string; allocatedRaw: string; pendingSpendRaw: string }>;
    nativeSpendWei: string; pendingNativeSpendWei: string; exitReserveWei: string; nftTokenIds: string[] }>;
  nftCustody: Array<{ manager: string; tokenId: string; campaignId: string | null; status: string;
    allocationId:string|null;liquidity: string; tokensOwed0: string; tokensOwed1: string }>;
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a<b?-1:a>b?1:0).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
};
const lowerAddress = (value: string) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Invalid wallet/token address");
  return value.toLowerCase();
};
const uint = (value: string, field: string) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid unsigned amount: ${field}`);
  return BigInt(value);
};
const normalizeWallet = (wallet: LiveWalletIdentity): LiveWalletIdentity => {
  if (wallet.chainId !== LIVE_CHAIN_ID) throw new Error("Unsupported live wallet chain");
  return { chainId: LIVE_CHAIN_ID, address: lowerAddress(wallet.address) };
};
const lockKey = (w: LiveWalletIdentity) => `conc-liq-live:${w.chainId}:${w.address}`;
function snapshotHashFor(input:{wallet:LiveWalletIdentity;source:LiveWalletSource;nonce:string;pendingNonce:string;nativeBalanceWei:string;tokens:LiveWalletTokenBalance[];commitmentsHash:string}):string{
  const tokens=[...input.tokens].map(t=>({address:lowerAddress(t.address),balanceRaw:t.balanceRaw})).sort((a,b)=>a.address.localeCompare(b.address));
  return sha256(stable({wallet:normalizeWallet(input.wallet),source:input.source,nonce:input.nonce,pendingNonce:input.pendingNonce,
    nativeBalanceWei:input.nativeBalanceWei,tokens,commitmentsHash:input.commitmentsHash}));
}

/** Uses the exact bigint advisory-lock namespace held by legacy live controllers. */
/** True when the persisted wallet source is the review's pinned source, or a strictly later one. A source-only
 * advance leaves the wallet content (and therefore its generation) unchanged, so an inert review pinned to an
 * earlier canonical source remains admissible while a backwards source or a different hash at the same height
 * never is. The caller still verifies that the persisted source itself is canonical. */
export function liveWalletSourceNotBefore(current:LiveWalletSource|null|undefined,pinned:LiveWalletSource):boolean{
  if(!current||!/^(0|[1-9][0-9]*)$/.test(current.block)||!/^(0|[1-9][0-9]*)$/.test(pinned.block))return false;
  const a=BigInt(current.block),b=BigInt(pinned.block);
  if(a===b)return current.hash.toLowerCase()===pinned.hash.toLowerCase()&&current.timestamp===pinned.timestamp;
  return a>b&&current.timestamp>=pinned.timestamp;
}
export async function withLiveWalletTransaction<T>(pool: Pool, wallet: LiveWalletIdentity,
  fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const w = normalizeWallet(wallet), client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey(w)]);
    await client.query("SELECT 1 FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2 FOR UPDATE", [w.chainId,w.address]);
    const result = await fn(client); await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function assertReady(db: Pick<Pool|PoolClient,"query">) { await assertLiveWalletSchemaReady(db); }
export async function readWalletState(db: Pool|PoolClient, wallet: LiveWalletIdentity): Promise<LiveWalletState> {
  const w=normalizeWallet(wallet); await assertReady(db);
  const row=await db.query<any>("SELECT generation,status,source_block,source_hash,source_timestamp,snapshot_hash,commitments_hash,nonce,pending_nonce,native_balance_wei FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2",[w.chainId,w.address]);
  const tokens=await db.query<any>("SELECT token_address,balance_raw FROM deployment_live_wallet_tokens WHERE chain_id=$1 AND wallet=$2 ORDER BY token_address",[w.chainId,w.address]);
  const r=row.rows[0];
  return { ...w, generation:Number(r?.generation??0),status:r?.status??"uninitialized",
    source:r?.source_hash?{block:String(r.source_block),hash:r.source_hash,timestamp:Number(r.source_timestamp)}:null,
    snapshotHash:r?.snapshot_hash??null,commitmentsHash:r?.commitments_hash??null,
    nonce:r?.nonce===null||r?.nonce===undefined?null:String(r.nonce),pendingNonce:r?.pending_nonce===null||r?.pending_nonce===undefined?null:String(r.pending_nonce),
    nativeBalanceWei:r?.native_balance_wei===null||r?.native_balance_wei===undefined?null:String(r.native_balance_wei),
    tokens:tokens.rows.map((t:any)=>({address:t.token_address,balanceRaw:String(t.balance_raw)})) };
}
export async function readCommitments(db: Pool|PoolClient, wallet: LiveWalletIdentity): Promise<LiveWalletCommitments> {
  const w=normalizeWallet(wallet); await assertReady(db);
  const a=await db.query<any>("SELECT id,campaign_id,revision,state,native_spend_wei,pending_native_spend_wei,exit_reserve_wei FROM deployment_live_allocations WHERE chain_id=$1 AND wallet=$2 AND state<>'released' ORDER BY campaign_id,revision",[w.chainId,w.address]);
  const t=await db.query<any>("SELECT allocation_id,token_address,allocated_raw,pending_spend_raw FROM deployment_live_allocation_tokens WHERE chain_id=$1 AND wallet=$2 ORDER BY allocation_id,token_address",[w.chainId,w.address]);
  const n=await db.query<any>("SELECT position_manager,token_id,campaign_id,allocation_id,status,liquidity,tokens_owed0,tokens_owed1 FROM deployment_live_nft_custody WHERE chain_id=$1 AND wallet=$2 ORDER BY position_manager,token_id",[w.chainId,w.address]);
  const allocations=a.rows.map((r:any)=>({allocationId:r.id,campaignId:r.campaign_id,revision:r.revision,state:r.state,
    tokens:t.rows.filter((x:any)=>x.allocation_id===r.id).map((x:any)=>({address:x.token_address,allocatedRaw:String(x.allocated_raw),pendingSpendRaw:String(x.pending_spend_raw)})),
    nativeSpendWei:String(r.native_spend_wei),pendingNativeSpendWei:String(r.pending_native_spend_wei),exitReserveWei:String(r.exit_reserve_wei),
    nftTokenIds:n.rows.filter((x:any)=>x.campaign_id===r.campaign_id&&x.status==='active').map((x:any)=>String(x.token_id))}));
  return {wallet:w,allocations,nftCustody:n.rows.map((x:any)=>({manager:x.position_manager,tokenId:String(x.token_id),campaignId:x.campaign_id,
    allocationId:x.allocation_id,status:x.status,liquidity:String(x.liquidity),tokensOwed0:String(x.tokens_owed0),tokensOwed1:String(x.tokens_owed1)}))};
}
export async function applyWalletSnapshotInTransaction(client: PoolClient,input: LiveWalletSnapshotInput): Promise<LiveWalletState> {
  const w=normalizeWallet(input),source={...input.source};
  if(!input.effectProof){
    const unresolved=(await client.query<any>(`SELECT EXISTS(SELECT 1 FROM deployment_live_stage_outbox WHERE chain_id=$1 AND wallet=$2
      AND (status IN('prepared','signed','blocked') AND canonical_receipt_json IS NULL)) AS yes`,[w.chainId,w.address])).rows[0]?.yes;
    if(unresolved)throw new Error("Wallet snapshot refresh is blocked by an unresolved stage");
  }
  if(!/^0x[0-9a-fA-F]{64}$/.test(source.hash)||!Number.isSafeInteger(source.timestamp)||source.timestamp<=0||!(/^(0|[1-9][0-9]*)$/.test(source.block))) throw new Error("Invalid canonical source");
  for(const [v,k] of [[input.nonce,"nonce"],[input.pendingNonce,"pending nonce"],[input.nativeBalanceWei,"native balance"]] as const)uint(v,k);
  if(!/^[0-9a-f]{64}$/.test(input.commitmentsHash))throw new Error("Invalid commitments hash");
  const tokenRows=input.tokens.map(t=>({address:lowerAddress(t.address),balanceRaw:t.balanceRaw})).sort((a,b)=>a.address.localeCompare(b.address));
  if(tokenRows.length<1||tokenRows.length>8)throw new Error("Wallet token inventory is outside the supported complete set");
  if(new Set(tokenRows.map(t=>t.address)).size!==tokenRows.length)throw new Error("Duplicate wallet token");
  tokenRows.forEach(t=>uint(t.balanceRaw,"token balance"));
  const generationRow=await client.query<any>("SELECT generation,source_block,source_hash,commitments_hash FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2 FOR UPDATE",[w.chainId,w.address]);
  const prior=generationRow.rows[0];
  // `generation` is a content version: it advances only when nonce, pending nonce, native balance, token balances or
  // the commitments fingerprint change. A source-only advance keeps it, so equality means "wallet content unchanged".
  let contentChanged=true;
  if(!input.reorgRecovery&&prior?.source_block!==null&&prior?.source_block!==undefined&&BigInt(source.block)<BigInt(prior.source_block))throw new Error("Wallet source moved backwards; explicit reorg recovery required");
  if(!input.reorgRecovery&&prior?.source_block!==null&&prior?.source_block!==undefined&&BigInt(source.block)===BigInt(prior.source_block)&&prior.source_hash?.toLowerCase()!==source.hash.toLowerCase())throw new Error("Wallet source hash changed at same height; explicit reorg recovery required");
  if(prior){
    const allocated=(await client.query<any>(`SELECT DISTINCT token_address FROM deployment_live_allocation_tokens t JOIN deployment_live_allocations a ON a.id=t.allocation_id
      WHERE a.chain_id=$1 AND a.wallet=$2 AND a.state<>'released'`,[w.chainId,w.address])).rows.map((r:any)=>r.token_address);
    if(allocated.some((a:string)=>!tokenRows.some(t=>t.address===a)))throw new Error("Snapshot omitted a token with a live allocation");
    const previous=await client.query<any>("SELECT native_balance_wei,snapshot_hash,nonce,pending_nonce FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2",[w.chainId,w.address]);
    const previousTokens=(await client.query<any>("SELECT token_address,balance_raw FROM deployment_live_wallet_tokens WHERE chain_id=$1 AND wallet=$2 ORDER BY token_address",[w.chainId,w.address])).rows;
    const changed=String(previous.rows[0]?.native_balance_wei)!==input.nativeBalanceWei||String(previous.rows[0]?.nonce)!==input.nonce||String(previous.rows[0]?.pending_nonce)!==input.pendingNonce||stable(previousTokens.map((r:any)=>({address:r.token_address,balanceRaw:String(r.balance_raw)})))!==stable(tokenRows);
    contentChanged=changed||prior.commitments_hash!==input.commitmentsHash||!(Number(prior.generation)>0);
    if(changed&&allocated.length){const proof=input.effectProof;
      if(!proof||proof.priorSnapshotHash!==previous.rows[0]?.snapshot_hash||!/^([0-9a-f]{64})$/.test(proof.evidenceHash)||!/^[-A-Za-z0-9_:]{1,128}$/.test(proof.operationId))
        throw new Error("Wallet balance delta requires receipt-bound allocation reconciliation");}
  }
  if(liveWalletCommitmentFingerprint(await readCommitments(client,w))!==input.commitmentsHash)throw new Error("Wallet commitment fingerprint does not match persisted allocations");
  const generation=Number(generationRow.rows[0]?.generation??0)+(contentChanged?1:0);
  const computedSnapshotHash=snapshotHashFor({wallet:w,source,nonce:input.nonce,pendingNonce:input.pendingNonce,nativeBalanceWei:input.nativeBalanceWei,tokens:tokenRows,commitmentsHash:input.commitmentsHash});
  if(input.snapshotHash!==undefined&&input.snapshotHash!==computedSnapshotHash)throw new Error("Wallet snapshot hash mismatch");
  const snapshotHash=computedSnapshotHash;
  if(!/^[0-9a-f]{64}$/.test(snapshotHash))throw new Error("Invalid snapshot hash");
  let status=input.nonce===input.pendingNonce?(input.status??"available"):"blocked";
  const age=Date.now()-source.timestamp*1000;if(age< -5_000||age>180_000)status="blocked";
  const obligations=(await client.query<any>(`SELECT token_address,sum(allocated_raw+pending_spend_raw)::numeric AS amount FROM deployment_live_allocation_tokens t
    JOIN deployment_live_allocations a ON a.id=t.allocation_id WHERE a.chain_id=$1 AND a.wallet=$2 AND a.state<>'released' GROUP BY token_address`,[w.chainId,w.address])).rows;
  if(obligations.some((r:any)=>BigInt(tokenRows.find(t=>t.address===r.token_address)?.balanceRaw??"0")<BigInt(r.amount)))status="blocked";
  const nativeObligation=(await client.query<any>(`SELECT coalesce(sum(native_spend_wei+pending_native_spend_wei+exit_reserve_wei),0)::numeric AS amount
    FROM deployment_live_allocations WHERE chain_id=$1 AND wallet=$2 AND state<>'released'`,[w.chainId,w.address])).rows[0]?.amount??"0";
  if(BigInt(input.nativeBalanceWei)<BigInt(nativeObligation))status="blocked";
  await client.query(`INSERT INTO deployment_live_wallets(chain_id,wallet,generation,status,source_block,source_hash,source_timestamp,nonce,pending_nonce,native_balance_wei,snapshot_hash,commitments_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(chain_id,wallet) DO UPDATE SET generation=EXCLUDED.generation,status=EXCLUDED.status,
    source_block=EXCLUDED.source_block,source_hash=EXCLUDED.source_hash,source_timestamp=EXCLUDED.source_timestamp,nonce=EXCLUDED.nonce,pending_nonce=EXCLUDED.pending_nonce,
    native_balance_wei=EXCLUDED.native_balance_wei,snapshot_hash=EXCLUDED.snapshot_hash,commitments_hash=EXCLUDED.commitments_hash,updated_at=clock_timestamp()`,
    [w.chainId,w.address,generation,status,source.block,source.hash,source.timestamp,input.nonce,input.pendingNonce,input.nativeBalanceWei,snapshotHash,input.commitmentsHash]);
  await client.query("DELETE FROM deployment_live_wallet_tokens WHERE chain_id=$1 AND wallet=$2",[w.chainId,w.address]);
  for(const t of tokenRows)await client.query("INSERT INTO deployment_live_wallet_tokens(chain_id,wallet,token_address,generation,balance_raw) VALUES($1,$2,$3,$4,$5)",[w.chainId,w.address,t.address,generation,t.balanceRaw]);
  return { ...w,generation,status,source,snapshotHash,commitmentsHash:input.commitmentsHash,nonce:input.nonce,pendingNonce:input.pendingNonce,nativeBalanceWei:input.nativeBalanceWei,tokens:tokenRows };
}
export async function recordWalletSnapshot(pool:Pool,input:LiveWalletSnapshotInput):Promise<LiveWalletState>{
  return withLiveWalletTransaction(pool,input,async c=>{await assertReady(c);return applyWalletSnapshotInTransaction(c,input);});
}
export async function recordReview(pool:Pool,input:LiveWalletReviewInput):Promise<LiveWalletReview>{
  const w=normalizeWallet(input),id=input.reviewId??randomUUID();
  if(contentHash(input.payload)!==input.payloadHash)throw new Error("Review payload hash mismatch");
  if(!/^[0-9a-f]{64}$/.test(input.buildId)||!/^[0-9a-f]{64}$/.test(input.commitmentsHash))throw new Error("Invalid review identity");
  const expiry=new Date(input.expiresAt); if(!Number.isFinite(expiry.valueOf()))throw new Error("Invalid review expiry");
  return withLiveWalletTransaction(pool,w,async c=>{
    await assertReady(c);const state=await readWalletState(c,w);
    const unresolved=(await c.query<any>(`SELECT EXISTS(SELECT 1 FROM deployment_live_stage_outbox WHERE chain_id=$1 AND wallet=$2
      AND status IN('prepared','signed','blocked') AND canonical_receipt_json IS NULL) AS yes`,[w.chainId,w.address])).rows[0]?.yes;
    if(unresolved)throw new Error("Live review is blocked by an unresolved stage");
    if(state.status!=="available"||!state.source||state.generation!==input.walletGeneration||state.commitmentsHash!==input.commitmentsHash||!liveWalletSourceNotBefore(state.source,input.source))throw new Error("Wallet snapshot changed before review persistence");
    await c.query("INSERT INTO deployment_live_reviews(id,chain_id,wallet,payload,payload_hash,build_id,source_block,source_hash,source_timestamp,wallet_generation,commitments_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[id,w.chainId,w.address,input.payload,input.payloadHash,input.buildId,input.source.block,input.source.hash,input.source.timestamp,input.walletGeneration,input.commitmentsHash,expiry.toISOString()]);
    return {...input,address:w.address,reviewId:id,expiresAt:expiry.toISOString(),consumedByJob:null};
  });
}
export async function readReview(db:Pool|PoolClient,input:LiveWalletIdentity&{reviewId:string}):Promise<LiveWalletReview|null>{
  const w=normalizeWallet(input);await assertReady(db);
  const r=(await db.query<any>("SELECT * FROM deployment_live_reviews WHERE chain_id=$1 AND wallet=$2 AND id=$3",[w.chainId,w.address,input.reviewId])).rows[0];
  if(!r)return null;return {chainId:w.chainId,address:w.address,reviewId:r.id,payload:r.payload,payloadHash:r.payload_hash,buildId:r.build_id,
    source:{block:String(r.source_block),hash:r.source_hash,timestamp:Number(r.source_timestamp)},expiresAt:new Date(r.expires_at).toISOString(),walletGeneration:Number(r.wallet_generation),commitmentsHash:r.commitments_hash,consumedByJob:r.consumed_by_job};
}
export async function lookupLiveJobByRequest(db:Pool|PoolClient,input:LiveWalletIdentity&{requestId:string;requestDigest:string}):Promise<LiveWalletQueuedResult|null>{
  const w=normalizeWallet(input);await assertReady(db);
  const r=(await db.query<any>("SELECT id,campaign_id,allocation_id,request_digest,status FROM deployment_live_jobs WHERE chain_id=$1 AND wallet=$2 AND idempotency_key=$3",[w.chainId,w.address,input.requestId])).rows[0];
  if(!r)return null;if(r.request_digest!==input.requestDigest)throw new Error("IDEMPOTENCY_CONFLICT");
  return {campaignId:r.campaign_id,allocationId:r.allocation_id,jobId:r.id,status:r.status,replayed:true};
}

export async function consumeReviewAndReserve(pool:Pool,input:ConsumeReviewAndReserveInput):Promise<LiveWalletQueuedResult>{
 const w=normalizeWallet(input),digest=input.requestDigest;
 if(!/^[0-9a-f]{64}$/.test(digest)||!/^[0-9a-f]{64}$/.test(input.reviewHash))throw new Error("Invalid request/review digest");
 const campaignWallet=lowerAddress(input.campaign.wallet);
 if(campaignWallet!==w.address||input.campaign.mode!=="live"||input.campaign.strategyId!=="rangekeeper_v1")throw new Error("Campaign wallet/strategy mismatch");
 if(!/^[0-9a-f]{64}$/.test(input.campaign.configHash)||input.campaign.stateSchemaVersion<1)throw new Error("Invalid campaign config identity");
 const tokenAlloc=input.allocation.tokens.map(t=>({address:lowerAddress(t.address),amountRaw:t.amountRaw})).sort((a,b)=>a.address.localeCompare(b.address));
 if(new Set(tokenAlloc.map(t=>t.address)).size!==tokenAlloc.length)throw new Error("Duplicate token allocation");
 tokenAlloc.forEach(t=>uint(t.amountRaw,"token allocation"));
 const nativeSpend=uint(input.allocation.nativeSpendWei,"native spend"),exitReserve=uint(input.allocation.exitReserveWei,"exit reserve");
 const nftIds=input.allocation.nftTokenIds.map(id=>uint(id,"NFT token id").toString());
 if(new Set(nftIds).size!==nftIds.length)throw new Error("Duplicate NFT allocation");
 return withLiveWalletTransaction(pool,w,async c=>{
   await assertReady(c);
   const prior=(await c.query<any>("SELECT id,campaign_id,allocation_id,request_digest,status FROM deployment_live_jobs WHERE chain_id=$1 AND wallet=$2 AND idempotency_key=$3",[w.chainId,w.address,input.requestId])).rows[0];
   if(prior){if(prior.request_digest!==digest)throw new Error("IDEMPOTENCY_CONFLICT");
     return {campaignId:prior.campaign_id,allocationId:prior.allocation_id,jobId:prior.id,status:prior.status,replayed:true};}
   const state=await readWalletState(c,w),review=await readReview(c,{...w,reviewId:input.reviewId});
   if(!review||review.consumedByJob)throw new Error("Review missing or already consumed");
   if(review.payloadHash!==input.reviewHash||input.buildId&&review.buildId!==input.buildId)throw new Error("Review binding mismatch");
   // Generation and commitments equality prove the wallet content is exactly what was reviewed; the persisted source
   // may only have advanced (and must itself be canonical), never moved backwards or forked at the pinned height.
   if(state.status!=="available"||!state.source||state.generation!==review.walletGeneration||state.commitmentsHash!==review.commitmentsHash||
      !liveWalletSourceNotBefore(state.source,review.source))throw new Error("Wallet generation changed since review");
   const dbNow=(await c.query<any>("SELECT clock_timestamp() AS now")).rows[0].now as Date;
   if(dbNow.valueOf()>=new Date(review.expiresAt).valueOf()||dbNow.valueOf()-review.source.timestamp*1000>180_000||review.source.timestamp*1000>dbNow.valueOf()+5_000)throw new Error("Review source stale or expired");
   if(state.nonce===null||state.pendingNonce===null||state.nonce!==state.pendingNonce)throw new Error("Wallet nonce not canonical");
   await input.verifySource(review.source);
   if(state.source.block!==review.source.block)await input.verifySource(state.source);
   // Any prior live campaign without a new allocation ledger remains unknown custody.
   const unknownDeployment=(await c.query<any>(`SELECT c.id FROM deployment_campaigns c WHERE c.mode='live' AND lower(c.wallet)=$1
    AND (c.lifecycle NOT IN ('draft','closed') OR EXISTS(SELECT 1 FROM deployment_wallet_reservations r WHERE r.campaign_id=c.id AND r.released_at IS NULL)
      OR EXISTS(SELECT 1 FROM deployment_operations o WHERE o.campaign_id=c.id AND o.status IN ('queued','preflighting','executing','confirming','reconciling','blocked')))
    AND NOT EXISTS(SELECT 1 FROM deployment_live_allocations a WHERE a.campaign_id=c.id AND a.state<>'released') LIMIT 1`,[w.address])).rows[0];
   if(unknownDeployment)throw new Error("Unknown active deployment wallet commitment");
   for(const schema of ['rangekeeper_v1','live_pilot_v1']){
     const present=(await c.query<any>("SELECT to_regclass($1) IS NOT NULL AS yes",[`${schema}.campaigns`])).rows[0]?.yes;
     if(present){const active=(await c.query<any>(`SELECT c.id FROM ${schema}.campaigns c WHERE lower(c.operator)=$1 AND
       (coalesce(c.state->>'phase','unknown')<>'closed' OR EXISTS(SELECT 1 FROM ${schema}.actions a WHERE a.campaign_id=c.id AND a.status IN ('prepared','signed'))) LIMIT 1`,[w.address])).rows[0];
       if(active)throw new Error(`Unknown active ${schema} wallet commitment`);}
   }
   const existing=(await c.query<any>(`SELECT a.id,a.native_spend_wei,a.pending_native_spend_wei,a.exit_reserve_wei,
      t.token_address,t.allocated_raw,t.pending_spend_raw FROM deployment_live_allocations a
      LEFT JOIN deployment_live_allocation_tokens t ON t.allocation_id=a.id
      WHERE a.chain_id=$1 AND a.wallet=$2 AND a.state<>'released'`,[w.chainId,w.address])).rows;
   const balances=new Map(state.tokens.map(t=>[t.address,BigInt(t.balanceRaw)]));
   const totals=new Map<string,bigint>();let nativeLiability=0n;const seenAllocations=new Set<string>();
   for(const r of existing){if(!seenAllocations.has(r.id)){seenAllocations.add(r.id);nativeLiability+=BigInt(r.native_spend_wei)+BigInt(r.pending_native_spend_wei)+BigInt(r.exit_reserve_wei);}
     if(r.token_address)totals.set(r.token_address,(totals.get(r.token_address)??0n)+BigInt(r.allocated_raw)+BigInt(r.pending_spend_raw));}
   for(const t of tokenAlloc){if(!balances.has(t.address))throw new Error(`Unknown wallet token ${t.address}`);totals.set(t.address,(totals.get(t.address)??0n)+BigInt(t.amountRaw));}
   for(const [address,amount] of totals)if(amount>(balances.get(address)??-1n))throw new Error(`Wallet token oversubscribed ${address}`);
   const nativeBalance=BigInt(state.nativeBalanceWei??"0");nativeLiability+=nativeSpend+exitReserve;
   if(nativeLiability>nativeBalance)throw new Error("Wallet native balance oversubscribed");
   const profile=(await c.query<any>("SELECT chain_id,token0_address,token1_address,profile_hash FROM deployment_market_profiles WHERE id=$1",[input.campaign.marketProfileId])).rows[0];
   if(!profile||profile.chain_id!==w.chainId)throw new Error("Unknown/incompatible market profile");
   const allocatedByAddress=new Map(tokenAlloc.map(t=>[t.address,BigInt(t.amountRaw)]));
   if((allocatedByAddress.get(lowerAddress(profile.token0_address))??0n)!==uint(input.campaign.allocation.token0Raw,"token0 campaign allocation")||
      (allocatedByAddress.get(lowerAddress(profile.token1_address))??0n)!==uint(input.campaign.allocation.token1Raw,"token1 campaign allocation"))throw new Error("Campaign/allocation token amounts mismatch");
   if(uint(input.campaign.allocation.nativeWei,"campaign native allocation")!==nativeSpend+exitReserve)throw new Error("Campaign/native allocation mismatch");
   const nftRows=nftIds.length?await c.query<any>(`SELECT position_manager,token_id,status,liquidity,tokens_owed0,tokens_owed1,campaign_id FROM deployment_live_nft_custody
     WHERE chain_id=$1 AND wallet=$2 AND token_id=ANY($3::numeric[]) FOR UPDATE`,[w.chainId,w.address,nftIds]):{rows:[]};
   if(nftRows.rows.length!==nftIds.length||nftRows.rows.some((r:any)=>r.campaign_id||r.status==='unmanaged'||r.status==='retired_empty'))throw new Error("NFT custody allocation is not proven available");
   const campaignId=randomUUID(),allocationId=randomUUID(),jobId=randomUUID();
   await c.query(`INSERT INTO deployment_campaigns(id,mode,chain_id,wallet,market_profile_id,allocation,lifecycle,current_revision,runtime_identity)
    VALUES($1,'live',$2,$3,$4,$5,'opening',1,$6)`,[campaignId,w.chainId,w.address,input.campaign.marketProfileId,input.campaign.allocation,{buildId:review.buildId,source:input.campaign.source}]);
   await c.query(`INSERT INTO deployment_revisions(campaign_id,revision,parent_revision,strategy_id,strategy_version,state_schema_version,config,config_hash)
    VALUES($1,1,NULL,'rangekeeper_v1',$2,$3,$4,$5)`,[campaignId,input.campaign.strategyVersion,input.campaign.stateSchemaVersion,input.campaign.config,input.campaign.configHash]);
   const allocationHash=sha256(stable({tokens:tokenAlloc,nativeSpendWei:nativeSpend.toString(),exitReserveWei:exitReserve.toString(),nftTokenIds:nftIds}));
   await c.query(`INSERT INTO deployment_live_allocations(id,chain_id,wallet,campaign_id,revision,state,native_spend_wei,pending_native_spend_wei,exit_reserve_wei,source_generation,source_hash,allocation_hash)
    VALUES($1,$2,$3,$4,1,'reserved',$5,0,$6,$7,$8,$9)`,[allocationId,w.chainId,w.address,campaignId,nativeSpend.toString(),exitReserve.toString(),state.generation,review.source.hash,allocationHash]);
   for(const t of tokenAlloc)await c.query("INSERT INTO deployment_live_allocation_tokens(allocation_id,chain_id,wallet,token_address,allocated_raw) VALUES($1,$2,$3,$4,$5)",[allocationId,w.chainId,w.address,t.address,t.amountRaw]);
   for(const n of nftRows.rows)await c.query(`UPDATE deployment_live_nft_custody SET allocation_id=$1,campaign_id=$2 WHERE chain_id=$3 AND wallet=$4 AND position_manager=$5 AND token_id=$6`,[allocationId,campaignId,w.chainId,w.address,n.position_manager,n.token_id]);
   const payloadHash=contentHash(input.payload);
   const baseline=input.campaign.baseline as any;
   const frozen=review.payload as any, submitted=input.payload as any;
   const revisionConfig={...(submitted?.policy?.parameters??{}),strategyId:'rangekeeper_v1',strategyVersion:input.campaign.strategyVersion,stateSchemaVersion:input.campaign.stateSchemaVersion};
   const expectedBaseline={requirements:submitted?.requirements,references:submitted?.references,source:submitted?.source};
   const configHashValid=(()=>{try{return submitted?.policy?.configHash===rangeKeeperConfigHash(parseRangeKeeperConfig(submitted?.policy?.config)).slice(2);}catch{return false;}})();
   const mismatches=[
    !input.payload||typeof input.payload!=='object'||stable(input.payload)!==stable(review.payload)||payloadHash!==review.payloadHash?'payload':null,
    submitted?.binding?.buildId!==review.buildId?'build':null,submitted?.wallet?.commitmentsHash!==review.commitmentsHash?'commitments':null,
    submitted?.source?.hash?.toLowerCase()!==review.source.hash.toLowerCase()?'source':null,
    frozen?.binding?.reviewHash!==submitted?.binding?.reviewHash||frozen?.profileHash!==submitted?.profileHash?'frozen_identity':null,
    submitted?.profileHash!==profile.profile_hash?'profile_hash':null,!submitted?.policy?.config||!configHashValid?'kernel_config':null,
    submitted?.policy?.parametersHash!==contentHash(submitted?.policy?.parameters)?'parameters_hash':null,
    stable(input.campaign.config)!==stable(revisionConfig)||input.campaign.configHash!==contentHash(revisionConfig)?'revision_config':null,
    input.campaign.marketProfileId!==submitted?.profileId?'profile_id':null,stable(input.campaign.baseline)!==stable(expectedBaseline)?'baseline':null,
    String(input.campaign.allocation.token0Raw)!==String(submitted?.requirements?.token0Raw)?'token0':null,
    String(input.campaign.allocation.token1Raw)!==String(submitted?.requirements?.token1Raw)?'token1':null,
    String(input.campaign.allocation.nativeWei)!==String(submitted?.requirements?.nativeWei)?'native':null,
   ].filter(Boolean);
   if(mismatches.length)throw new Error(`Reservation payload does not match frozen review: ${mismatches.join(',')}`);
   await c.query(`INSERT INTO deployment_live_jobs(id,chain_id,wallet,campaign_id,revision,allocation_id,review_id,kind,status,payload,payload_hash,build_id,idempotency_key,request_digest)
    VALUES($1,$2,$3,$4,1,$5,$6,'open','queued',$7,$8,$9,$10,$11)`,[jobId,w.chainId,w.address,campaignId,allocationId,input.reviewId,input.payload,payloadHash,review.buildId,input.requestId,digest]);
   await c.query("UPDATE deployment_live_reviews SET consumed_by_job=$1 WHERE id=$2 AND consumed_by_job IS NULL",[jobId,input.reviewId]);
   if(baseline&&typeof baseline==='object')await c.query(`INSERT INTO deployment_marks(campaign_id,revision,source_block,source_hash,inventory,economics,provenance)
    VALUES($1,1,$2,$3,$4,$5,$6)`,[campaignId,review.source.block,review.source.hash,baseline.inventory??baseline,baseline.economics??null,{...(baseline.provenance??{}),source:review.source}]);
   const refreshed=await readCommitments(c,w),newCommitmentsHash=liveWalletCommitmentFingerprint(refreshed),newGeneration=state.generation+1;
   const newSnapshotHash=snapshotHashFor({wallet:w,source:state.source,nonce:state.nonce!,pendingNonce:state.pendingNonce!,nativeBalanceWei:state.nativeBalanceWei!,tokens:state.tokens,commitmentsHash:newCommitmentsHash});
   await c.query("UPDATE deployment_live_wallets SET generation=$3,commitments_hash=$4,snapshot_hash=$5,updated_at=clock_timestamp() WHERE chain_id=$1 AND wallet=$2",[w.chainId,w.address,newGeneration,newCommitmentsHash,newSnapshotHash]);
   await c.query("UPDATE deployment_live_wallet_tokens SET generation=$3 WHERE chain_id=$1 AND wallet=$2",[w.chainId,w.address,newGeneration]);
   return {campaignId,allocationId,jobId,status:"queued",replayed:false};
 });
}

/** Release a campaign's reserved wallet capital only after campaign closure,
 * all queued/action work is terminal, and its NFTs are proven empty. */
export async function releaseLiveWalletAllocation(pool:Pool,input:LiveWalletIdentity&{allocationId:string}):Promise<void>{
 const w=normalizeWallet(input);
 await withLiveWalletTransaction(pool,w,async c=>{
  await assertReady(c);
  const allocation=(await c.query<any>(`SELECT a.id,a.campaign_id,a.state,c.lifecycle FROM deployment_live_allocations a
   JOIN deployment_campaigns c ON c.id=a.campaign_id WHERE a.id=$1 AND a.chain_id=$2 AND a.wallet=$3 FOR UPDATE OF a,c`,
   [input.allocationId,w.chainId,w.address])).rows[0];
  if(!allocation)throw new Error("Unknown wallet allocation");
  if(allocation.state==='released')return;
  if(allocation.lifecycle!=='closed')throw new Error("Campaign must be canonically closed before allocation release");
  const work=(await c.query<any>(`SELECT EXISTS(SELECT 1 FROM deployment_live_jobs WHERE allocation_id=$1 AND status NOT IN('succeeded','rejected','cancelled')) OR
   EXISTS(SELECT 1 FROM deployment_live_stage_outbox o JOIN deployment_live_jobs j ON j.id=o.job_id WHERE j.allocation_id=$1 AND
    (o.status IN('prepared','signed','blocked') OR (o.signed_raw IS NOT NULL AND o.canonical_receipt_json IS NULL))) AS unresolved`,[input.allocationId])).rows[0]?.unresolved;
  if(work)throw new Error("Unresolved live job or signed transaction prevents release");
  const custody=(await c.query<any>(`SELECT token_id,status,liquidity,tokens_owed0,tokens_owed1 FROM deployment_live_nft_custody
   WHERE allocation_id=$1 FOR UPDATE`,[input.allocationId])).rows;
  if(custody.some((n:any)=>n.status!=='retired_empty'||BigInt(n.liquidity)!==0n||BigInt(n.tokens_owed0)!==0n||BigInt(n.tokens_owed1)!==0n))
   throw new Error("NFT liquidity or unresolved custody prevents allocation release");
  await c.query("UPDATE deployment_live_allocations SET state='released',released_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[input.allocationId]);
  const snapshot=await readCommitments(c,w),fingerprint=liveWalletCommitmentFingerprint(snapshot);
  const state=await readWalletState(c,w);
  if(!state.source||state.nonce===null||state.pendingNonce===null||state.nativeBalanceWei===null)throw new Error("Wallet snapshot unavailable during release");
  const snapshotHash=snapshotHashFor({wallet:w,source:state.source,nonce:state.nonce,pendingNonce:state.pendingNonce,nativeBalanceWei:state.nativeBalanceWei,tokens:state.tokens,commitmentsHash:fingerprint});
  await c.query("UPDATE deployment_live_wallets SET generation=generation+1,commitments_hash=$3,snapshot_hash=$4,updated_at=clock_timestamp() WHERE chain_id=$1 AND wallet=$2",[w.chainId,w.address,fingerprint,snapshotHash]);
  await c.query("UPDATE deployment_live_wallet_tokens SET generation=(SELECT generation FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2) WHERE chain_id=$1 AND wallet=$2",[w.chainId,w.address]);
 });
}
