import type {PoolClient} from 'pg';
import type {PaperSessionRow} from '../paper/store.js';
import {readPaperChain,paperCampaignSummary} from '../paper/reentry.js';
import {readSessionPerformance} from '../paper/session-performance-store.js';
import {principalAmounts,sqrtRatioAtTick} from '../backtest/principal.js';
import {quoteValue} from '../simulator/math.js';
import {USDG} from '../constants.js';
import {PAPER_NVDA} from '../paper/engine.js';
import {positionWindow,type PositionPoint} from './position-performance.js';

const value=(a:string|bigint,b:string|bigint,sqrt:string)=>BigInt(a)+(BigInt(b)<0n?-1n:1n)*quoteValue({amount0:0n,amount1:BigInt(b)<0n?-BigInt(b):BigInt(b),token0:USDG,token1:PAPER_NVDA,quoteToken:USDG,sqrtPriceX96:BigInt(sqrt)});
const price=(sqrt:string)=>String((1n<<192n)*10n**30n/BigInt(sqrt)**2n);
const range=(p:any)=>p&&BigInt(p.liquidity)>0n?[price(String(sqrtRatioAtTick(p.tickUpper))),price(String(sqrtRatioAtTick(p.tickLower)))]:null;
const iso=(v:any)=>v?new Date(v).toISOString():null;
const sub=(a:string|null,b:string|null)=>a===null||b===null?null:String(BigInt(a)-BigInt(b));
function inventory(p:any,sqrt:string,idle0:string,idle1:string,fee0='0',fee1='0') {
 const a=p?principalAmounts({liquidity:BigInt(p.liquidity),tickLower:p.tickLower,tickUpper:p.tickUpper,sqrtPriceX96:BigInt(sqrt)}):{amount0:0n,amount1:0n};
 const usdg=a.amount0+BigInt(idle0)+BigInt(fee0),nvda=a.amount1+BigInt(idle1)+BigInt(fee1),stock=value(0n,nvda,sqrt),gross=usdg+stock;
 return {usdg:String(usdg),nvda:String(nvda),exposurePpm:String(gross>0n?stock*1000000n/gross:0n)};
}
function strategy(policy:any,live=false){return {widthTicks:policy.halfWidthSpacings==null?null:policy.halfWidthSpacings*10,
 allocationPpm:policy.lpAllocationPpm??null,tradingHours:policy.tradingHours??null,inventoryExitPpm:policy.inventoryExitPpm??null,
 recenter:policy.recenter??null,reentry:policy.reentry??null,holdingPolicy:policy.holdingPolicy??null,referencePolicy:policy.referencePolicy??null,live};}
function paperGroups(rows:PaperSessionRow[]){
 const byId=new Map(rows.map(r=>[r.id,r])),parents=new Set(rows.map(r=>(r.policy as any).reentry?.previousSessionId).filter(Boolean));
 return rows.filter(r=>!parents.has(r.id)).map(latest=>{const chain=[latest],seen=new Set([latest.id]);let row=latest;
  while((row.policy as any).reentry?.previousSessionId){const parent=byId.get((row.policy as any).reentry.previousSessionId);if(!parent||seen.has(parent.id))break;seen.add(parent.id);chain.unshift(parent);row=parent;}
  return {latest,chain};});
}
function paperSummary(latest:PaperSessionRow,chain:PaperSessionRow[],newest:string){
 const s=latest.state,p=s.position,summary=paperCampaignSummary(chain),invalid=s.status==='invalid'||!!s.invalidatedAt;
 const queued=s.status==='closed'&&!s.reentryStoppedAt&&(latest.policy as any).reentry&&latest.id===newest&&s.action==='exit';
 const status=invalid?'invalid':s.status==='closed'?(queued?'waiting':'closed'):s.status==='exit_pending'?'exiting':!p||p.liquidity==='0'?'waiting':
  s.reasons.length?'paused':s.last&&(s.last.tick<p.tickLower||s.last.tick>=p.tickUpper)?'recentring':'open';
 const nav=invalid?null:summary.navQuote===null?null:String(BigInt(summary.navQuote)+BigInt(s.exitReserveQuote));
 return {id:`paper-${latest.id}`,label:`P-${chain[0]!.id}${chain.length>1?` → ${latest.id}`:''}`,mode:'paper',asset:'NVDA',quote:'USDG',fee:500,
  sessionIds:chain.map(r=>r.id),hasLiquidity:!!p&&BigInt(p.liquidity)>0n,status,history:status==='closed'||invalid,initialQuote:summary.initialBudgetQuote,navQuote:nav,
  holdQuote:invalid?null:summary.holdQuote,feesQuote:invalid?null:chain.length===1?s.feeValueQuote:null,gasQuote:invalid?null:summary.costsPaidQuote,
  swapQuote:null,exitEstimateQuote:invalid?null:s.exitReserveQuote,drawdownPpm:invalid?null:s.maxDrawdownPpm,
  createdAt:chain[0]!.created_at.toISOString(),endedAt:status==='closed'?latest.updated_at.toISOString():s.invalidatedAt??null,
  sourceAt:s.last?.blockTimestamp??null,heartbeatAt:iso(latest.heartbeat_at),reasons:[...s.reasons,...latest.monitor_reasons],invalidatedAt:s.invalidatedAt??null,
  reserveQuote:'0',strategy:strategy(latest.policy),range:range(p),priceQuoteX18:s.last?price(s.last.sqrtPriceX96):null,
  inventory:p&&s.last?inventory(p,s.last.sqrtPriceX96,p.idle0,p.idle1,p.fee0,p.fee1):{usdg:summary.navQuote??latest.policy.budgetQuote,nvda:'0',exposurePpm:'0'},
  tokenId:null,accounting:invalid?'invalid':'recorded',nextAction:queued?'Re-entry after cooldown and healthy price / chain checks':status==='waiting'?'Entry requires healthy price / chain checks':null};
}
async function paperRows(db:PoolClient,stream:string){return (await db.query<PaperSessionRow>('SELECT * FROM paper_sessions WHERE stream_key=$1 ORDER BY id DESC',[stream])).rows;}
async function liveRows(db:PoolClient){
 const exists=(await db.query("SELECT to_regclass('live_pilot_v1.campaigns') IS NOT NULL AS present")).rows[0]?.present;
 if(!exists)return [];
 return (await db.query(`SELECT c.id,c.state,c.heartbeat_at,c.monitor,c.config->'strategy' AS strategy,
  m.at AS mark_at,m.snapshot AS mark FROM live_pilot_v1.campaigns c LEFT JOIN LATERAL
  (SELECT at,snapshot FROM live_pilot_v1.marks WHERE campaign_id=c.id AND kind='mark' ORDER BY id DESC LIMIT 1) m ON TRUE ORDER BY c.heartbeat_at DESC`)).rows;
}
function liveSummary(r:any){
 const s=r.state,m=r.mark,snap=m?.snapshot??s.last,p=snap.position,hasLp=p&&BigInt(p.liquidity)>0n;
 const status=s.phase==='halted'?'paused':s.phase==='exit'?'exiting':s.phase==='recenter'?'recentring':s.phase==='closed'?(s.desired==='running'?'waiting':'closed'):
  s.phase==='entry'?'waiting':r.monitor?.length?'paused':hasLp&&(snap.tick<p.tickLower||snap.tick>=p.tickUpper)?'recentring':'open';
 const currentMark=m&&m.snapshot.block===s.last.block;
 return {id:`live-${r.id}`,label:`L-${r.id.slice(0,8)}`,mode:'live',asset:'NVDA',quote:'USDG',fee:500,hasLiquidity:!!s.last.position&&BigInt(s.last.position.liquidity)>0n,status,history:status==='closed',
  initialQuote:s.initialCapitalQuote,navQuote:m?.netNavQuote??null,holdQuote:m?.benchmarkQuote??null,
  feesQuote:m?String(value(BigInt(s.collectedFee0)+BigInt(m.uncollected0),BigInt(s.collectedFee1)+BigInt(m.uncollected1),snap.sqrtPriceX96)):null,
  gasQuote:m?.gasValuationQuote??null,swapQuote:null,exitEstimateQuote:null,drawdownPpm:null,
  createdAt:s.createdAt,endedAt:status==='closed'?s.closedAt:null,sourceAt:m?new Date(Number(snap.timestamp)*1000).toISOString():null,
  heartbeatAt:iso(r.heartbeat_at),reasons:[...(r.monitor??[]),...(s.haltReason?[s.haltReason]:[]),...(!currentMark?['valuation_waiting_for_current_state']:[])],
  reserveQuote:s.reserveUsdg,strategy:strategy(r.strategy??{},true),range:range(p),priceQuoteX18:price(snap.sqrtPriceX96),
  inventory:inventory(p,snap.sqrtPriceX96,String(BigInt(snap.usdg)-BigInt(s.reserveUsdg)),snap.nvda,m?.uncollected0,m?.uncollected1),
  tokenId:s.tokenId,accounting:m?'recorded':'unavailable',nextAction:s.phase==='closed'&&s.desired==='running'?'Re-entry after cooldown and healthy price / chain checks':null};
}
export async function readPositionOverview(db:PoolClient,stream:string){
 const paper=await paperRows(db,stream),live=await liveRows(db);
 return {serverTime:new Date().toISOString(),refreshMs:10000,positions:[...live.map(liveSummary),...paperGroups(paper).map(g=>paperSummary(g.latest,g.chain,paper[0]?.id??''))]};
}
export async function readPositionDetail(db:PoolClient,stream:string,id:string,hours:number){
 const now=Date.now();
 if(id.startsWith('paper-')){
  const rows=await paperRows(db,stream),group=paperGroups(rows).find(g=>`paper-${g.latest.id}`===id);if(!group)return null;
  const position=paperSummary(group.latest,group.chain,rows[0]?.id??'');
  if(position.status==='invalid')return {position,performance:null,events:[],limitations:['Invalidated campaign; original reason and timestamp retained.']};
  try {
   const chain=await readPaperChain(db,group.latest),report=await readSessionPerformance(db,chain,true);
   const points=report.timeline as PositionPoint[];
   position.navQuote=report.economicNavQuote;position.holdQuote=report.holdPnlQuote===null?null:String(BigInt(report.initialBudgetQuote)+BigInt(report.holdPnlQuote));
   position.gasQuote=report.gasQuote;position.feesQuote=String(report.grouped.reduce((n,b)=>n+BigInt(b.feeIncomeQuote),0n));
   position.swapQuote=String(report.grouped.reduce((n,b)=>n+BigInt(b.swapCostVsSpotQuote),0n)) as any;
   position.drawdownPpm=String(points.reduce((n,p)=>BigInt(p.drawdownPpm)>n?BigInt(p.drawdownPpm):n,0n));
   const performance=positionWindow(points,hours,now,report.initialBudgetQuote,position.createdAt);
   const runIds=chain.flatMap(s=>[s.state.execution?.entryRunId,...(s.state.execution?.recenterRunIds??[]),s.state.execution?.exitRunId].filter(Boolean));
   const events=runIds.length?(await db.query(`SELECT id::text,action,source_block::text AS block,observed_at AS at,
    snapshot->'result'->>'scope' AS scope,snapshot->'result'->'range' AS range,
    CASE WHEN snapshot->'result'->>'scope'='paper_inventory_recenter' THEN snapshot->'result'->'trade'
     WHEN action='entry' THEN snapshot->'result'->'entrySwap' ELSE snapshot->'result'->'exitSwap' END AS trade,
    snapshot->'result'->>'entryGasWei' AS entry_gas_wei,snapshot->'result'->>'exitGasWei' AS exit_gas_wei FROM paper_execution_runs WHERE id=ANY($1::bigint[]) ORDER BY paper_execution_runs.id DESC`,[runIds])).rows:[];
   return {position,performance,events:events.filter(e=>Date.parse(e.at)>=now-hours*3600000),
    counts:{recenters:report.grouped.reduce((n,b)=>n+b.recenters,0),swaps:report.tradeCount},limitations:report.limitations};
  }catch {
   return {position:{...position,accounting:'unavailable',navQuote:null,holdQuote:null,feesQuote:null,gasQuote:null,swapQuote:null,
    reasons:[...position.reasons,'campaign_history_evidence_unavailable']},performance:null,events:[],limitations:['Campaign history could not be validated. Original records are preserved; no performance is inferred.']};
  }
 }
 const row=(await liveRows(db)).find(r=>`live-${r.id}`===id);if(!row)return null;
 const position=liveSummary(row),s=row.state;
 const marks=(await db.query(`SELECT id::text,at,snapshot FROM live_pilot_v1.marks WHERE campaign_id=$1 AND kind='mark' ORDER BY live_pilot_v1.marks.id LIMIT 100001`,[row.id])).rows;
 if(marks.length>100000)throw new Error('Position history exceeds bounded mark limit');
 const collected=(await db.query(`SELECT at,state->>'collectedFee0' AS fee0,state->>'collectedFee1' AS fee1,state->>'phase' AS phase,
  reason FROM live_pilot_v1.transitions WHERE campaign_id=$1 AND reason LIKE 'confirmed:%' ORDER BY id`,[row.id])).rows;
 const actions=(await db.query(`SELECT id::text,created_at AS at,plan->>'kind' AS action,status,hash,
  before_state->>'sqrtPriceX96' AS sqrt,receipt->'facts' AS facts,receipt->'gasValuation'->>'quote' AS gas,
  receipt->'after'->>'timestamp' AS source_time,plan-'deadline' AS plan FROM live_pilot_v1.actions WHERE campaign_id=$1 ORDER BY nonce`,[row.id])).rows;
 let previous:PositionPoint|undefined,previousGas:string|null='0',previousFee0=0n,previousFee1=0n,peak=BigInt(s.initialCapitalQuote),fee0=0n,fee1=0n,ci=0;
 const used=new Set<string>(),points:PositionPoint[]=[];let totalSwap=0n,feeIncome=0n,feesValid=true,recenters=0;
 for(const m of marks){const v=m.snapshot,snap=v.snapshot,p=snap.position;
  while(ci<collected.length&&new Date(collected[ci]!.at).getTime()<=new Date(m.at).getTime()){fee0=BigInt(collected[ci]!.fee0);fee1=BigInt(collected[ci]!.fee1);ci++;}
  const current0=fee0+BigInt(v.uncollected0),current1=fee1+BigInt(v.uncollected1);
  // Collect rounding may regress by one raw unit. Keep signed changes visible.
  const fees=value(current0-previousFee0,current1-previousFee1,snap.sqrtPriceX96);
  if(current0<previousFee0-1n||current1<previousFee1-1n)feesValid=false;
  previousFee0=current0;previousFee1=current1;feeIncome+=fees;
  const matched=actions.filter(a=>!used.has(a.id)&&a.facts&&BigInt(a.facts.block)<=BigInt(snap.block));
  let swap=0n,swaps=0,action='mark';
  for(const a of matched){used.add(a.id);if(a.status!=='confirmed')continue;
   if(a.action==='swap'){swap-=value(a.facts.walletDeltas.usdg,a.facts.walletDeltas.nvda,a.sqrt);swaps++;}
   if(a.action==='mint')action=previous?.status==='recenter'?'recenter':'enter';
   if(a.action==='withdraw')action='withdraw';
  }
  if((v.phase==='closed'||v.phase==='exit'&&(!p||p.liquidity==='0')&&snap.nvda==='0')&&previous?.action!=='exit')action='exit';
  // Replacement mints are identified by the management phase preceding confirmation.
  if(action==='enter'&&previous?.status==='recenter'){action='recenter';recenters++;}
  else if(action==='recenter')recenters++;
  totalSwap+=swap;
  const nav=v.netNavQuote??null;if(nav!==null&&BigInt(nav)>peak)peak=BigInt(nav);
  const point:PositionPoint={id:m.id,sourceAt:new Date(Number(snap.timestamp)*1000).toISOString(),observedAt:iso(m.at)!,block:snap.block,action,status:v.phase,
   economicNavQuote:nav,holdQuote:v.benchmarkQuote??null,priceQuoteX18:price(snap.sqrtPriceX96),
   ...inventory(p,snap.sqrtPriceX96,String(BigInt(snap.usdg)-BigInt(s.reserveUsdg)),snap.nvda,v.uncollected0,v.uncollected1),
   inRange:!!p&&BigInt(p.liquidity)>0n&&snap.tick>=p.tickLower&&snap.tick<p.tickUpper,
   tickLower:p&&BigInt(p.liquidity)>0n?p.tickLower:null,tickUpper:p&&BigInt(p.liquidity)>0n?p.tickUpper:null,
   feesThisIntervalQuote:feesValid?String(fees):null,gasThisMarkQuote:sub(v.gasValuationQuote??null,previousGas),swapThisMarkQuote:String(swap),swapsThisMark:swaps,
   drawdownPpm:nav!==null&&peak>0n?String((peak-BigInt(nav))*1000000n/peak):'0'};
  previousGas=v.gasValuationQuote??null;points.push(point);previous=point;
 }
 position.swapQuote=String(totalSwap) as any;position.feesQuote=feesValid?String(feeIncome):null;
 position.drawdownPpm=points.length?String(points.reduce((n,p)=>BigInt(p.drawdownPpm)>n?BigInt(p.drawdownPpm):n,0n)) as any:null;
 const events=actions.filter(a=>Date.parse(a.source_time?new Date(Number(a.source_time)*1000).toISOString():a.at)>=now-hours*3600000)
  .map(a=>({id:a.id,at:a.source_time?new Date(Number(a.source_time)*1000).toISOString():iso(a.at),action:a.action,status:a.status,hash:a.hash,
   block:a.facts?.block??null,gasQuote:a.gas??null,walletDeltas:a.facts?.walletDeltas??null,plan:a.plan})).reverse();
 return {position,performance:positionWindow(points,hours,now,s.initialCapitalQuote,s.createdAt),events,
  counts:{recenters,swaps:actions.filter(a=>a.action==='swap'&&a.status==='confirmed').length},
  limitations:['Live NAV includes wallet inventory, NFT principal and claimable fees, less receipt-valued gas. Reserved USDG is excluded.',
   'Swap shortfall is measured from receipt token deltas against pre-transaction spot and is already included in NAV.',
   'Future live exit cost is unavailable. Market boundaries and gaps are not interpolated for P&L attribution.',
   ...(!feesValid?['Historical collected / claimable fee counters do not reconcile; fee income is unavailable.']:[])]};
}
