import type {PoolClient} from 'pg';
import {parseRangeKeeperJson,type RangeKeeperLiveState} from '../strategy/rangekeeper/live-domain.js';
import type {RangeKeeperTxPlan} from '../strategy/rangekeeper/calldata.js';
import {sqrtRatioAtTick} from '../backtest/principal.js';
import {positionWindow,type PositionPoint} from './position-performance.js';

interface RangeKeeperRow {id:string;state:unknown;config:unknown;heartbeat_at:Date|null;monitor:unknown;valuation:unknown|null;first_source_timestamp:string|null}
const iso=(seconds:number)=>new Date(seconds*1000).toISOString();
const raw=(n:bigint|null)=>n===null?null:String(n/1_000_000_000_000n);
const value=(amount:bigint,price:bigint,decimals:number)=>amount*price/10n**BigInt(decimals);
interface RangeKeeperValuation {source:{block:bigint;timestamp:number};phase:string;nav:bigint;gasValue:bigint|null;
 inventory0:bigint;inventory1:bigint;grossFee0:bigint;grossFee1:bigint;exposurePpm:number;poolPriceTick:number;
 activeTokenId:bigint|null;recenterCount:number;reference:{eligible:boolean;price0:bigint|null;price1:bigint|null}}
function valuation(rawMark:unknown):RangeKeeperValuation|null{
 if(!rawMark)return null;
 const mark=parseRangeKeeperJson<RangeKeeperValuation>(rawMark);
 return mark.reference?.eligible&&mark.reference.price0!==null&&mark.reference.price1!==null&&
  typeof mark.nav==='bigint'&&typeof mark.source?.timestamp==='number'?mark:null;
}
function priceAtTick(tick:number,quoteToken:number){
 const sqrt=sqrtRatioAtTick(tick),q=1n<<192n;
 return quoteToken===0?String(q*10n**30n/(sqrt*sqrt)):String(sqrt*sqrt*10n**30n/q);
}
function rangePrices(position:RangeKeeperLiveState['last']['position'],quoteToken:number){
 if(!position||position.liquidity===0n)return null;
 return [priceAtTick(position.tickLower,quoteToken),priceAtTick(position.tickUpper,quoteToken)].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
}

/** Read only the separate live ledger; an older dashboard database may lack it. */
export async function readRangeKeeperRows(db:PoolClient):Promise<RangeKeeperRow[]>{
 const exists=(await db.query("SELECT to_regclass('rangekeeper_v1.campaigns') IS NOT NULL AS present")).rows[0]?.present;
 if(!exists)return [];
 return (await db.query<RangeKeeperRow>(`SELECT c.id,c.state,c.config,c.heartbeat_at,c.monitor,m.snapshot AS valuation,
  f.first_source_timestamp
  FROM rangekeeper_v1.campaigns c LEFT JOIN LATERAL
  (SELECT snapshot FROM rangekeeper_v1.marks WHERE campaign_id=c.id AND kind='valuation' ORDER BY id DESC LIMIT 1) m ON TRUE
  LEFT JOIN LATERAL (SELECT snapshot->'source'->>'timestamp' AS first_source_timestamp FROM rangekeeper_v1.marks
   WHERE campaign_id=c.id AND kind='valuation' ORDER BY id LIMIT 1) f ON TRUE
  ORDER BY c.heartbeat_at DESC NULLS LAST`)).rows;
}

export function rangeKeeperPosition(row:RangeKeeperRow){
 const s=parseRangeKeeperJson<RangeKeeperLiveState>(row.state),p=s.last.position;
 const pool=(row.config as any)?.pool,mark=valuation(row.valuation);
 const price0=mark?.reference.price0??null,price1=mark?.reference.price1??null;
 const isCurrent=mark?.source.block===s.last.source.block;
 const hold=mark&&pool&&price0!==null&&price1!==null?
  value(s.initial0,price0,pool.decimals0)+value(s.initial1,price1,pool.decimals1):null;
 const fees=mark&&pool&&price0!==null&&price1!==null?
  value(mark.grossFee0,price0,pool.decimals0)+value(mark.grossFee1,price1,pool.decimals1):null;
 const swap=s.costEvents.every(e=>e.swapFeeValue!==null&&e.swapShortfallValue!==null)?
  s.costEvents.reduce((n,e)=>n+e.swapFeeValue!+e.swapShortfallValue!,0n):null;
 const hasLiquidity=!!p&&p.liquidity>0n;
 const outside=hasLiquidity&&(s.last.tick<p.tickLower||s.last.tick>=p.tickUpper);
 const status=s.phase==='halted'?'halted':s.phase==='exit'||s.desired==='stopped'&&s.phase!=='closed'?'exiting':
  s.phase==='recenter'||outside?'recentring':s.phase==='closed'?'closed':s.phase==='entry'?'waiting':'open';
 return {id:`live-rk-${row.id}`,label:`RK-${row.id.slice(0,8)}`,mode:'live',
  asset:(pool?.quoteToken===0?pool?.reference1:pool?.reference0)?.split('/')[0]??'AAPL',quote:'USDG',fee:pool?.fee??500,
  quoteIsToken0:pool?.quoteToken===0,hasLiquidity,status,history:s.phase==='closed',initialQuote:raw(s.initialStrategyValue),
  navQuote:mark&&mark.gasValue!==null?raw(mark.nav-mark.gasValue):null,holdQuote:raw(hold),feesQuote:raw(fees),gasQuote:raw(mark?.gasValue??null),
  swapQuote:raw(swap),exitEstimateQuote:null,drawdownPpm:null,
  createdAt:iso(Math.min(s.createdAt,Number(row.first_source_timestamp??s.createdAt))),endedAt:s.closedAt?iso(s.closedAt):null,
  sourceAt:mark?iso(mark.source.timestamp):null,heartbeatAt:row.heartbeat_at?.toISOString()??null,
  reasons:Array.isArray(row.monitor)?row.monitor.filter((x):x is string=>typeof x==='string'):[],
  reserveQuote:pool?.quoteToken===0?String(s.reserve0):String(s.reserve1),strategy:{widthTicks:p?(p.tickUpper-p.tickLower)/2:20,live:true,policyId:'rangekeeper_v1'},
  range:rangePrices(p,pool?.quoteToken??0),priceQuoteX18:priceAtTick(s.last.tick,pool?.quoteToken??0),
  inventory:{usdg:String(pool?.quoteToken===0?mark?.inventory0??s.last.wallet0:mark?.inventory1??s.last.wallet1),
   nvda:String(pool?.quoteToken===0?mark?.inventory1??s.last.wallet1:mark?.inventory0??s.last.wallet0),exposurePpm:mark?String(mark.exposurePpm):null},
  tokenId:s.activeTokenId===null?null:String(s.activeTokenId),accounting:mark?'recorded':'unavailable',nextAction:null,
  rangekeeper:{phase:s.phase,desired:s.desired,tick:s.last.tick,tickLower:p?.tickLower??null,tickUpper:p?.tickUpper??null,
   sourceBlock:String(s.last.source.block),sourceHash:s.last.source.hash,liquidity:p?String(p.liquidity):null,
   wallet0:String(s.last.wallet0),wallet1:String(s.last.wallet1),nativeWei:String(s.last.nativeWei),valuationCurrent:isCurrent,
   nonzeroAllowances:s.last.allowances.filter(a=>a.amount>0n).length,expiresAt:iso(s.expiresAt),lastReason:s.lastReason}};
}

export async function rangeKeeperDetail(db:PoolClient,row:RangeKeeperRow,hours:number){
 const position=rangeKeeperPosition(row),cutoff=new Date(Date.now()-hours*3600000);
 const s=parseRangeKeeperJson<RangeKeeperLiveState>(row.state),pool=(row.config as any).pool;
 const actions=(await db.query(`SELECT created_at,nonce,status,hash,plan FROM rangekeeper_v1.actions
  WHERE campaign_id=$1 AND created_at>=$2 ORDER BY nonce DESC LIMIT 100`,[row.id,cutoff])).rows;
 const lastMint=(await db.query(`SELECT plan FROM rangekeeper_v1.actions WHERE campaign_id=$1
  AND status='confirmed' AND plan->>'kind'='mint' ORDER BY nonce DESC LIMIT 1`,[row.id])).rows[0];
 const mint=lastMint?parseRangeKeeperJson<RangeKeeperTxPlan>(lastMint.plan):null;
 const marks=(await db.query(`SELECT id::text,at,snapshot FROM rangekeeper_v1.marks
  WHERE campaign_id=$1 AND kind='valuation' AND at>=$2 ORDER BY rangekeeper_v1.marks.id LIMIT 100001`,[row.id,cutoff])).rows;
 if(marks.length>100000)throw new Error('RangeKeeper history exceeds bounded mark limit');
 const prior=(await db.query(`SELECT id::text,at,snapshot FROM rangekeeper_v1.marks
  WHERE campaign_id=$1 AND kind='valuation' AND at<$2 ORDER BY rangekeeper_v1.marks.id DESC LIMIT 1`,[row.id,cutoff])).rows[0];
 if(prior)marks.unshift(prior);
 const transitions=(await db.query(`SELECT at,state FROM rangekeeper_v1.transitions WHERE campaign_id=$1
  AND at<=(SELECT COALESCE(max(at),$2) FROM rangekeeper_v1.marks WHERE campaign_id=$1 AND kind='valuation')
  ORDER BY id LIMIT 100001`,[row.id,new Date()])).rows;
 if(transitions.length>100000)throw new Error('RangeKeeper transition history exceeds bound');
 let ti=0,priorState:RangeKeeperLiveState|null=null,priorFee0=0n,priorFee1=0n,priorGas=0n,priorSwap=0n,peak:bigint|null=null;
 let priorToken:bigint|null=null,entered=false;
 const points:PositionPoint[]=[];
 for(const r of marks){
  const m=valuation(r.snapshot);if(!m)continue;
  while(ti<transitions.length&&transitions[ti]!.at<=r.at){priorState=parseRangeKeeperJson<RangeKeeperLiveState>(transitions[ti]!.state);ti++;}
  const current=priorState,active=current?.last.position??null;
  const p=active&&active.tokenId===m.activeTokenId?active:null;
  const p0=m.reference.price0!,p1=m.reference.price1!,gas=m.gasValue;
  const nav=gas===null?null:m.nav-gas;
  if(nav!==null&&(peak===null||nav>peak))peak=nav;
  const hold=value(s.initial0,p0,pool.decimals0)+value(s.initial1,p1,pool.decimals1);
  const fee0=m.grossFee0-priorFee0,fee1=m.grossFee1-priorFee1;
  const swap=current?.costEvents.every(e=>e.swapFeeValue!==null&&e.swapShortfallValue!==null)?
   current.costEvents.reduce((n,e)=>n+e.swapFeeValue!+e.swapShortfallValue!,0n):
   !current&&gas===0n?0n:null;
  const sourceAt=iso(m.source.timestamp);
  const action=m.activeTokenId===priorToken?'mark':m.activeTokenId===null?'exit':entered?'recenter':'enter';
  if(m.activeTokenId!==null)entered=true;
  points.push({id:r.id,sourceAt,observedAt:r.at.toISOString(),block:String(m.source.block),action,status:m.phase,
   economicNavQuote:raw(nav),holdQuote:raw(hold),priceQuoteX18:priceAtTick(m.poolPriceTick,pool.quoteToken),
   usdg:String(pool.quoteToken===0?m.inventory0:m.inventory1),nvda:String(pool.quoteToken===0?m.inventory1:m.inventory0),
   exposurePpm:String(m.exposurePpm),inRange:!!p&&m.poolPriceTick>=p.tickLower&&m.poolPriceTick<p.tickUpper,
   tickLower:p?.tickLower??null,tickUpper:p?.tickUpper??null,
   feesThisIntervalQuote:raw(value(fee0,p0,pool.decimals0)+value(fee1,p1,pool.decimals1)),
   gasThisMarkQuote:gas===null?null:raw(gas-priorGas),swapThisMarkQuote:swap===null?null:raw(swap-priorSwap),
   swapsThisMark:0,drawdownPpm:nav!==null&&peak!==null&&peak>0n?String((peak-nav)*1_000_000n/peak):'0'});
  priorFee0=m.grossFee0;priorFee1=m.grossFee1;if(gas!==null)priorGas=gas;if(swap!==null)priorSwap=swap;
  priorToken=m.activeTokenId;
 }
 const performance=positionWindow(points,hours,Date.now(),position.initialQuote!,position.createdAt);
 return {position,performance,events:actions.map(a=>({at:a.created_at.toISOString(),nonce:a.nonce,
  action:a.plan.kind,status:a.status,hash:a.hash})),
  mintedValueQuote:mint?.kind==='mint'?String(mint.candidate.deployedValue/1_000_000_000_000n):null,
  counts:{recenters:s.recenters,recenterAttempts:null,swaps:actions.filter(a=>a.status==='confirmed'&&a.plan.kind==='swap').length},
  limitations:['NAV and passive inventory use recorded independent references. Pool price is derived from the recorded tick.',
   'The first available valuation and any gaps do not reconstruct prior interval costs. Future exit cost is unavailable.']};
}
