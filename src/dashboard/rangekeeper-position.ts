import type {PoolClient} from 'pg';
import {parseRangeKeeperJson,type RangeKeeperLiveState} from '../strategy/rangekeeper/live-domain.js';
import type {RangeKeeperTxPlan} from '../strategy/rangekeeper/calldata.js';

interface RangeKeeperRow {id:string;state:unknown;heartbeat_at:Date|null;monitor:unknown}
const iso=(seconds:number)=>new Date(seconds*1000).toISOString();

/** Read only the separate live ledger; an older dashboard database may lack it. */
export async function readRangeKeeperRows(db:PoolClient):Promise<RangeKeeperRow[]>{
 const exists=(await db.query("SELECT to_regclass('rangekeeper_v1.campaigns') IS NOT NULL AS present")).rows[0]?.present;
 if(!exists)return [];
 return (await db.query<RangeKeeperRow>(`SELECT id,state,heartbeat_at,monitor FROM rangekeeper_v1.campaigns ORDER BY heartbeat_at DESC NULLS LAST`)).rows;
}

export function rangeKeeperPosition(row:RangeKeeperRow){
 const s=parseRangeKeeperJson<RangeKeeperLiveState>(row.state),p=s.last.position;
 const hasLiquidity=!!p&&p.liquidity>0n;
 const outside=hasLiquidity&&(s.last.tick<p.tickLower||s.last.tick>=p.tickUpper);
 const status=s.phase==='halted'?'halted':s.phase==='exit'||s.desired==='stopped'&&s.phase!=='closed'?'exiting':
  s.phase==='recenter'||outside?'recentring':s.phase==='closed'?'closed':s.phase==='entry'?'waiting':'open';
 return {id:`live-rk-${row.id}`,label:`RK-${row.id.slice(0,8)}`,mode:'live',asset:'AAPL',quote:'USDG',fee:500,
  hasLiquidity,status,history:s.phase==='closed',initialQuote:null,navQuote:null,holdQuote:null,feesQuote:null,gasQuote:null,
  swapQuote:null,exitEstimateQuote:null,drawdownPpm:null,createdAt:iso(s.createdAt),endedAt:s.closedAt?iso(s.closedAt):null,
  sourceAt:iso(s.last.source.timestamp),heartbeatAt:row.heartbeat_at?.toISOString()??null,
  reasons:Array.isArray(row.monitor)?row.monitor.filter((x):x is string=>typeof x==='string'):[],
  reserveQuote:null,strategy:{widthTicks:p?(p.tickUpper-p.tickLower)/2:20,live:true,policyId:'rangekeeper_v1'},
  range:null,priceQuoteX18:null,inventory:{usdg:String(s.last.wallet0),nvda:String(s.last.wallet1),exposurePpm:null},
  tokenId:s.activeTokenId===null?null:String(s.activeTokenId),accounting:'unavailable',nextAction:null,
  rangekeeper:{phase:s.phase,desired:s.desired,tick:s.last.tick,tickLower:p?.tickLower??null,tickUpper:p?.tickUpper??null,
   sourceBlock:String(s.last.source.block),sourceHash:s.last.source.hash,liquidity:p?String(p.liquidity):null,
   wallet0:String(s.last.wallet0),wallet1:String(s.last.wallet1),nativeWei:String(s.last.nativeWei),
   nonzeroAllowances:s.last.allowances.filter(a=>a.amount>0n).length,expiresAt:iso(s.expiresAt),lastReason:s.lastReason}};
}

export async function rangeKeeperDetail(db:PoolClient,row:RangeKeeperRow,hours:number){
 const position=rangeKeeperPosition(row),cutoff=new Date(Date.now()-hours*3600000);
 const actions=(await db.query(`SELECT created_at,nonce,status,hash,plan FROM rangekeeper_v1.actions
  WHERE campaign_id=$1 AND created_at>=$2 ORDER BY nonce DESC LIMIT 100`,[row.id,cutoff])).rows;
 const lastMint=(await db.query(`SELECT plan FROM rangekeeper_v1.actions WHERE campaign_id=$1
  AND status='confirmed' AND plan->>'kind'='mint' ORDER BY nonce DESC LIMIT 1`,[row.id])).rows[0];
 const mint=lastMint?parseRangeKeeperJson<RangeKeeperTxPlan>(lastMint.plan):null;
 return {position,performance:null,events:actions.map(a=>({at:a.created_at.toISOString(),nonce:a.nonce,
  action:a.plan.kind,status:a.status,hash:a.hash})),
  mintedValueQuote:mint?.kind==='mint'?String(mint.candidate.deployedValue/1_000_000_000_000n):null,
  limitations:['Current independent-reference NAV, net P&L, LP fees and passive alpha are not yet recorded for RangeKeeper. Minted value is historical, not current NAV.']};
}
