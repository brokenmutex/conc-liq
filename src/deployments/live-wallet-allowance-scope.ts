import assert from 'node:assert/strict';
import type {Pool,PoolClient} from 'pg';
import {marketProfileSchema,type MarketProfile} from './market-profile.js';
import {RANGEKEEPER_ALLOWANCE_POLICY,allowanceCeiling,allowancePairKey,rangeKeeperAllowanceExposure,
 type RangeKeeperAllowancePolicy,type WalletAllowanceScope} from '../strategy/rangekeeper/allowance-policy.js';

/** One RangeKeeper campaign of the shared wallet, as far as allowances are concerned. */
export interface RangeKeeperWalletAllowanceUse {
 campaignId:string;lifecycle:string;pool:MarketProfile['pool'];exposure:readonly [bigint,bigint];
}
const lower=(s:string)=>s.toLowerCase();
const poolPairs=(pool:MarketProfile['pool'])=>[pool.token0,pool.token1].flatMap(token=>
 [pool.router,pool.positionManager].map(spender=>allowancePairKey(token,spender)));
/** A campaign still uses its pool's allowances until its lifecycle is closed (a blocked or opening campaign will resume). */
const active=(use:RangeKeeperWalletAllowanceUse)=>use.lifecycle!=='closed'&&use.lifecycle!=='draft';
const price=(value:unknown)=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value)?BigInt(value):null;
const amount=(value:unknown)=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)?BigInt(value):0n;

/** Every non-draft RangeKeeper campaign of the wallet with its immutable exposure. Reads only persisted campaign data
 * (initial allocation, frozen review limits and prices), the same inputs `rangeKeeperCampaignAllowancePolicy` uses. */
export async function readRangeKeeperWalletAllowanceUses(db:Pick<Pool|PoolClient,'query'>,wallet:string):Promise<RangeKeeperWalletAllowanceUse[]>{
 const present=(await db.query<{ok:boolean}>(`SELECT to_regclass('deployment_live_jobs') IS NOT NULL AND
  to_regclass('deployment_live_allocations') IS NOT NULL AND to_regclass('deployment_live_campaign_runtime') IS NOT NULL AS ok`)).rows[0]?.ok;
 if(present!==true)return [];
 const rows=(await db.query<any>(`SELECT c.id,c.lifecycle,p.profile,m.initial_token0_raw::text AS initial0,m.initial_token1_raw::text AS initial1,
   (SELECT json_object_agg(lower(t.token_address),t.allocated_raw::text) FROM deployment_live_allocation_tokens t WHERE t.allocation_id=a.id) AS allocated,
   j.payload #>> '{policy,config,limits,maxDeploymentValue}' AS max_deployment_value,
   j.payload #>> '{references,price0}' AS price0,j.payload #>> '{references,price1}' AS price1
  FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
  JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision AND r.strategy_id='rangekeeper_v1'
  LEFT JOIN deployment_live_campaign_runtime m ON m.campaign_id=c.id AND m.revision=c.current_revision
  LEFT JOIN deployment_live_allocations a ON a.campaign_id=c.id AND a.revision=c.current_revision
  LEFT JOIN LATERAL (SELECT payload FROM deployment_live_jobs WHERE campaign_id=c.id AND kind='open' ORDER BY created_at LIMIT 1) j ON TRUE
  WHERE c.mode='live' AND lower(c.wallet)=$1 AND c.lifecycle<>'draft' ORDER BY c.id LIMIT 1001`,[lower(wallet)])).rows;
 assert(rows.length<=1000,'Registered allowance scope bound exceeded');
 return rows.map(row=>{
  // An unreadable profile of a live campaign must stop the wallet: it could be the very user of a pair.
  const parsed=marketProfileSchema.safeParse(row.profile);
  assert(parsed.success,`Campaign ${row.id} market profile is unreadable for allowance scope`);
  const pool=parsed.data.pool,allocated=row.allocated??{};
  const initial0=row.initial0!==null&&row.initial0!==undefined?amount(row.initial0):amount(allocated[lower(pool.token0)]),
   initial1=row.initial1!==null&&row.initial1!==undefined?amount(row.initial1):amount(allocated[lower(pool.token1)]);
  const price0=price(row.price0),price1=price(row.price1);
  return {campaignId:row.id,lifecycle:row.lifecycle,pool,exposure:rangeKeeperAllowanceExposure({initial:[initial0,initial1],
   maxDeploymentValue:amount(row.max_deployment_value),decimals:[pool.decimals0,pool.decimals1],
   prices:price0!==null&&price1!==null?[price0,price1]:null})};
 });
}

/** Wallet integrity scope. `excludeCampaignId` removes a closing campaign from the pairs still in use (its own pairs must be
 * zero or retained by siblings once its close is complete); its exposure still bounds the ceiling. */
export function buildWalletAllowanceScope(uses:readonly RangeKeeperWalletAllowanceUse[],registered:readonly MarketProfile[],
 excludeCampaignId?:string):WalletAllowanceScope{
 const tokens=new Set<string>(),spenders=new Set<string>(),usedPairs=new Set<string>(),ceiling=new Map<string,bigint>();
 for(const pool of [...registered.map(p=>p.pool),...uses.map(u=>u.pool)]){
  tokens.add(lower(pool.token0));tokens.add(lower(pool.token1));spenders.add(lower(pool.router));spenders.add(lower(pool.positionManager));
 }
 for(const use of uses){
  if(active(use)&&use.campaignId!==excludeCampaignId)for(const pair of poolPairs(use.pool))usedPairs.add(pair);
  [use.pool.token0,use.pool.token1].forEach((token,i)=>{
   const cap=allowanceCeiling(use.exposure[i]!),prior=ceiling.get(lower(token))??0n;
   if(cap>prior)ceiling.set(lower(token),cap);
  });
 }
 return {tokens,spenders,used:usedPairs,ceiling};
}
/** Pairs another active campaign of the wallet still uses; closing campaign `campaignId` must not zero them. */
export function retainedAllowancePairs(uses:readonly RangeKeeperWalletAllowanceUse[],campaignId:string):Set<string>{
 return new Set(uses.filter(u=>active(u)&&u.campaignId!==campaignId).flatMap(u=>poolPairs(u.pool)));
}
/** persistent_capped_v1 for a campaign, derived from the same wallet read as the integrity scope. */
export function allowancePolicyFromUses(uses:readonly RangeKeeperWalletAllowanceUse[],campaignId:string):RangeKeeperAllowancePolicy{
 const use=uses.find(u=>u.campaignId===campaignId);
 assert(use,'Campaign is missing from the wallet allowance scope');
 return {kind:RANGEKEEPER_ALLOWANCE_POLICY,exposure:use.exposure,retain:retainedAllowancePairs(uses,campaignId)};
}
