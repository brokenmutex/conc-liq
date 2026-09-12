import assert from 'node:assert/strict';
import {equityHours} from './trading-hours.js';
import {principalAmounts} from '../backtest/principal.js';
import {PAPER_NVDA,type PaperPosition} from './engine.js';
import {quoteValue} from '../simulator/math.js';
import {USDG} from '../constants.js';

export interface SessionMark {
 id:string;sessionId:string;sourceAt:string;observedAt:string;block:string;action:string;status:string;
 tick:number;sqrtPriceX96:string;navQuote:string|null;holdQuote?:string|null;costsPaidQuote:string;exitReserveQuote:string;
 feeAccounting?:string;feeModelFrom?:string|null;
 earnedFee0:string;earnedFee1:string;position:PaperPosition|null;
}
export interface SessionFunding {id:string;budgetQuote:string;createdAt:string}
export interface SessionTrade {sessionId:string;block:string;runId:string;token:0|1;amountIn:string;amountOut:string}
export function marketSession(at:string|number) {
 const s=equityHours(at),day=s.key.split('/')[0]!;
 return {day,regime:s.regime,group:s.regime==='regular'?'market':s.regime==='premarket'?'premarket':
   s.regime==='calendar_unavailable'?'unknown':'non_market',key:`${day}/${s.regime}`};
}
/** Calendar boundaries occur on whole minutes; never prorate price/fee changes. */
export function sessionSegments(from:number,to:number) {
 assert(Number.isFinite(from)&&Number.isFinite(to)&&to>=from);
 const out:{from:number;to:number;session:ReturnType<typeof marketSession>}[]=[];
 let start=from,session=marketSession(from);
 for(let at=Math.floor(from/60000)*60000+60000;at<=to;at+=60000){
  const next=marketSession(at);
  if(next.key!==session.key){out.push({from:start,to:at,session});start=at;session=next;}
 }
 if(start<to)out.push({from:start,to,session});
 return out;
}
const value=(a:bigint,b:bigint,price:string)=>quoteValue({amount0:a,amount1:b,token0:USDG,token1:PAPER_NVDA,quoteToken:USDG,sqrtPriceX96:BigInt(price)});
function inventory(mark:SessionMark) {
 const p=mark.position;
 if(!p)return {usdg:mark.navQuote??'0',nvda:'0',principalQuote:'0',exposurePpm:'0',inRange:false,tickLower:null,tickUpper:null};
 const principal=principalAmounts({liquidity:BigInt(p.liquidity),tickLower:p.tickLower,tickUpper:p.tickUpper,sqrtPriceX96:BigInt(mark.sqrtPriceX96)});
 const q=principal.amount0+BigInt(p.idle0)+BigInt(p.fee0),r=principal.amount1+BigInt(p.idle1)+BigInt(p.fee1);
 const nvda=value(0n,r,mark.sqrtPriceX96),gross=q+nvda;
 return {usdg:String(q),nvda:String(r),principalQuote:String(value(principal.amount0,principal.amount1,mark.sqrtPriceX96)),
  exposurePpm:String(gross>0n?nvda*1000000n/gross:0n),inRange:BigInt(p.liquidity)>0n&&mark.tick>=p.tickLower&&mark.tick<p.tickUpper,
  tickLower:BigInt(p.liquidity)>0n?p.tickLower:null,tickUpper:BigInt(p.liquidity)>0n?p.tickUpper:null};
}
function bucket(key:string) {return {key,milliseconds:0,activeMs:0,inRangeMs:0,capitalMs:0n,exposureMs:0n,
 netPnl:0n,navPnl:0n,holdPnl:0n,fees:0n,gas:0n,swapCost:0n,exitReserveChange:0n,entries:0,exits:0,recenters:0,swaps:0,maxDrawdownPpm:0n};}
type Bucket=ReturnType<typeof bucket>;
const serial=(b:Bucket)=>({key:b.key,hours:b.milliseconds/3600000,activeHours:b.activeMs/3600000,
 sampledInRangePercent:b.activeMs?b.inRangeMs*100/b.activeMs:null,averageExposurePpm:b.milliseconds?String(b.exposureMs/BigInt(b.milliseconds)):null,
 netPnlQuote:String(b.netPnl),navPnlQuote:String(b.navPnl),holdPnlQuote:String(b.holdPnl),alphaQuote:String(b.netPnl-b.holdPnl),
 feeIncomeQuote:String(b.fees),gasQuote:String(b.gas),swapCostVsSpotQuote:String(b.swapCost),exitReserveChangeQuote:String(b.exitReserveChange),
 pnlPerHourQuote:b.milliseconds?String(b.netPnl*3600000n/BigInt(b.milliseconds)):null,
 returnBpsPerHour:b.capitalMs>0n?Number(b.netPnl*10000n*3600000n*1000000n/b.capitalMs)/1000000:null,
 entries:b.entries,exits:b.exits,recenters:b.recenters,swaps:b.swaps,maxCampaignDrawdownPpm:String(b.maxDrawdownPpm)});
export type SessionBucket=ReturnType<typeof serial>;

export function sessionPerformance(funding:readonly SessionFunding[],marks:readonly SessionMark[],trades:readonly SessionTrade[],maxChartPoints=1200) {
 assert(funding.length>0);
 const sessions=new Map(funding.map(s=>[s.id,s])),initial=BigInt(funding[0]!.budgetQuote);
 const grouped=new Map<string,Bucket>(),detailed=new Map<string,Bucket>(),days=new Map<string,{grouped:Map<string,Bucket>;detailed:Map<string,Bucket>}>();
 const get=(map:Map<string,Bucket>,key:string)=>{let b=map.get(key);if(!b){b=bucket(key);map.set(key,b);}return b;};
 const targets=(day:string,group:string,regime:string)=>{
  let d=days.get(day);if(!d){d={grouped:new Map(),detailed:new Map()};days.set(day,d);}
  return [get(grouped,group),get(detailed,regime),get(d.grouped,group),get(d.detailed,regime)];
 };
 for(const key of ['market','premarket','non_market','mixed_boundary','unknown'])get(grouped,key);
 for(const key of ['regular','premarket','afterhours','overnight','weekend','holiday','mixed_boundary','calendar_unavailable'])get(detailed,key);
 const tradeMap=new Map<string,SessionTrade[]>();
 for(const t of trades){const key=`${t.sessionId}/${t.block}`;tradeMap.set(key,[...(tradeMap.get(key)??[]),t]);}
 let previous:SessionMark|null=null,previousEconomic=initial,previousNav=initial,previousReserve=0n,previousHold=initial,peak=initial;
 let baseline:{a:bigint;b:bigint;gas:bigint}|null=null,holdAvailable=false;
 const timeline:any[]=[],boundaries:any[]=[];
 let allocatedGas=0n,matchedTrades=0;
 for(const mark of marks){
  assert(mark.status!=='invalid','Invalid position history cannot be attributed');
  const session=sessions.get(mark.sessionId);assert(session,'Unknown campaign session');
  const at=Date.parse(mark.sourceAt),from=previous?Date.parse(previous.sourceAt):Date.parse(funding[0]!.createdAt);
  assert(at>=from&&Number.isFinite(at),'Position sources must advance');
  const nav=BigInt(mark.navQuote??(!mark.position?session.budgetQuote:assert.fail('Open position has no NAV')));
  const reserve=BigInt(mark.exitReserveQuote),economic=nav+reserve;
  const same=previous?.sessionId===mark.sessionId;
  const gas=BigInt(mark.costsPaidQuote)-(same?BigInt(previous!.costsPaidQuote):0n);assert(gas>=0n,'Charged gas regressed');allocatedGas+=gas;
  const fee0=BigInt(mark.earnedFee0)-(same?BigInt(previous!.earnedFee0):0n),fee1=BigInt(mark.earnedFee1)-(same?BigInt(previous!.earnedFee1):0n);
  assert(fee0>=0n&&fee1>=0n,'Earned fee ledger regressed');
  const fees=value(fee0,fee1,mark.sqrtPriceX96),sessionAt=marketSession(at),startSession=marketSession(from);
  const segments=sessionSegments(from,at),crossed=segments.some(s=>s.session.key!==startSession.key)||sessionAt.key!==startSession.key;
  const interval=targets(crossed&&startSession.day!==sessionAt.day?'mixed_boundary':sessionAt.day,crossed?'mixed_boundary':sessionAt.group,crossed?'mixed_boundary':sessionAt.regime);
  const endpoint=targets(sessionAt.day,sessionAt.group,sessionAt.regime);
  const currentInventory=inventory({...mark,navQuote:String(nav)}),priorInventory=previous?inventory({...previous,navQuote:String(previousNav)}):null;
  for(const segment of segments){
   const ms=segment.to-segment.from;
   for(const b of targets(segment.session.day,segment.session.group,segment.session.regime)){
    b.milliseconds+=ms;b.capitalMs+=previousEconomic*BigInt(ms);b.exposureMs+=BigInt(priorInventory?.exposurePpm??'0')*BigInt(ms);
    if(previous?.position&&BigInt(previous.position.liquidity)>0n){b.activeMs+=ms;if(priorInventory?.inRange)b.inRangeMs+=ms;}
   }
  }
  // Net P&L excludes the unspent exit reserve. The separate NAV bridge
  // reconciles exactly to the dashboard balance after that reserve.
  const markTrades=tradeMap.get(`${mark.sessionId}/${mark.block}`)??[];
  const shortfalls=markTrades.map(t=>value(t.token===0?BigInt(t.amountIn):0n,t.token===1?BigInt(t.amountIn):0n,mark.sqrtPriceX96)-
    value(t.token===1?BigInt(t.amountOut):0n,t.token===0?BigInt(t.amountOut):0n,mark.sqrtPriceX96));
  const swapCost=shortfalls.reduce((n,c)=>n+c,0n);
  const gross=economic-previousEconomic+gas+swapCost,reserveDelta=reserve-previousReserve;
  for(const b of interval){b.netPnl+=gross;b.navPnl+=gross;b.fees+=fees;}
  for(const b of endpoint){b.netPnl-=gas+swapCost;b.navPnl-=gas+swapCost+reserveDelta;b.gas+=gas;b.exitReserveChange+=reserveDelta;
   if(mark.action==='enter')b.entries++;if(mark.action==='exit')b.exits++;if(mark.action==='recenter')b.recenters++;}
  for(const t of markTrades){
   const input=value(t.token===0?BigInt(t.amountIn):0n,t.token===1?BigInt(t.amountIn):0n,mark.sqrtPriceX96);
   const output=value(t.token===1?BigInt(t.amountOut):0n,t.token===0?BigInt(t.amountOut):0n,mark.sqrtPriceX96);
   for(const b of endpoint){b.swapCost+=input-output;b.swaps++;}matchedTrades++;
  }
  const initializingHold=!baseline&&mark.action==='enter'&&!!mark.position;
  if(initializingHold&&mark.position){
   // The original post-acquisition passive inventory is immutable across moves
   // and cash-exit/reentry sessions. Read its original benchmark cost from NAV.
   const hold=(mark as SessionMark&{holdQuote?:string|null}).holdQuote;
   assert(hold!==undefined&&hold!==null,'Entry passive benchmark unavailable');
   const a=BigInt(mark.position.hold0),b=BigInt(mark.position.hold1);
   baseline={a,b,gas:value(a,b,mark.sqrtPriceX96)-BigInt(hold)};holdAvailable=true;
  }
  const hold=baseline?value(baseline.a,baseline.b,mark.sqrtPriceX96)-baseline.gas:initial;
  for(const b of initializingHold?endpoint:interval)b.holdPnl+=hold-previousHold;
  if(economic>peak)peak=economic;
  const drawdown=peak>0n?(peak-economic)*1000000n/peak:0n;
  for(const b of endpoint)if(drawdown>b.maxDrawdownPpm)b.maxDrawdownPpm=drawdown;
  const point={id:mark.id,sessionId:mark.sessionId,sourceAt:mark.sourceAt,observedAt:mark.observedAt,block:mark.block,action:mark.action,status:mark.status,
   ...sessionAt,navQuote:String(nav),economicNavQuote:String(economic),holdQuote:baseline?String(hold):null,
   feesThisIntervalQuote:String(fees),gasThisMarkQuote:String(gas),exitReserveQuote:String(reserve),pnlThisIntervalQuote:String(economic-previousEconomic),
   attribution:crossed?'mixed_boundary':'single_session',...currentInventory,tick:mark.tick,
   priceQuoteX18:String((1n<<192n)*10n**30n/BigInt(mark.sqrtPriceX96)**2n),drawdownPpm:String(drawdown)};
  if(crossed){
   const times=new Set(segments.slice(1).map(s=>s.from));if(marketSession(at).key!==marketSession(Math.max(from,at-1)).key)times.add(at);
   for(const boundary of times)boundaries.push({at:new Date(boundary).toISOString(),from:marketSession(boundary-1),to:marketSession(boundary),
    before:timeline.at(-1)??{sourceAt:new Date(from).toISOString(),economicNavQuote:String(previousEconomic),navQuote:String(previousNav),usdg:String(initial),nvda:'0',tickLower:null,tickUpper:null},
    after:point,quality:'bracketed_not_exact',intervalGrossChangeQuote:String(gross)});
  }
  timeline.push(point);previous=mark;previousNav=nav;previousEconomic=economic;previousReserve=reserve;previousHold=hold;
 }
 assert.equal(matchedTrades,trades.length,'A charged swap has no accepted position mark');
 const sum=(field:'netPnl'|'navPnl'|'gas'|'holdPnl')=>[...grouped.values()].reduce((n,b)=>n+b[field],0n);
 assert.equal(sum('netPnl'),previousEconomic-initial);assert.equal(sum('navPnl'),previousNav-initial);assert.equal(sum('gas'),allocatedGas);
 assert.equal(sum('holdPnl'),previousHold-initial);
 const serialize=(map:Map<string,Bucket>)=>[...map.values()].map(b=>({...serial(b),holdPnlQuote:holdAvailable?String(b.holdPnl):null,alphaQuote:holdAvailable?String(b.netPnl-b.holdPnl):null}));
 const stride=Math.max(1,Math.ceil(timeline.length/maxChartPoints));
 const selected=timeline.filter((p,i)=>i%stride===0||i===timeline.length-1||['enter','exit','recenter'].includes(p.action)||p.attribution==='mixed_boundary'||timeline[i+1]?.attribution==='mixed_boundary');
 const feePeriods:{kind:string;fromSourceAt:string;throughSourceAt:string;marks:number}[]=[];
 for(const m of marks){if(!m.position)continue;const kind=m.feeAccounting??'observed_growth',last=feePeriods.at(-1);
  if(last?.kind===kind){last.throughSourceAt=m.sourceAt;last.marks++;}
  else feePeriods.push({kind,fromSourceAt:m.feeModelFrom??m.sourceAt,throughSourceAt:m.sourceAt,marks:1});}
 return {valid:true as const,feePeriods,basis:'marked_nav_after_charged_gas_before_exit_reserve',timeZone:'America/New_York',sourceThrough:previous?.sourceAt??null,
  initialBudgetQuote:String(initial),economicNavQuote:String(previousEconomic),navQuote:String(previousNav),netPnlQuote:String(previousEconomic-initial),
  navPnlQuote:String(previousNav-initial),exitReserveQuote:String(previousReserve),gasQuote:String(allocatedGas),
  holdPnlQuote:holdAvailable?String(previousHold-initial):null,alphaQuote:holdAvailable?String(previousEconomic-previousHold):null,
  markCount:marks.length,tradeCount:matchedTrades,boundaryCount:boundaries.length,grouped:serialize(grouped),detailed:serialize(detailed),
  days:[...days].map(([day,d])=>({day,grouped:serialize(d.grouped),detailed:serialize(d.detailed)})),
  timeline:maxChartPoints===Infinity?timeline:selected.slice(-3000),boundaries:maxChartPoints===Infinity?boundaries:boundaries.slice(-60),
  chartSampled:selected.length!==timeline.length||selected.length>3000,
  limitations:['Mixed-boundary price and fee changes are not prorated; charges are assigned to their accepted source time',
   'Swap shortfall includes pool fees and own-trade impact versus source spot; already embedded in P&L, never subtracted again',
   'Exposure, capital-hours and time in range use the preceding mark between observations; intrainterval paths are not reconstructed',
   'Fee earnings are hypothetical observed-growth estimates and gas charges are node estimates',
   'Session attribution of a continuous strategy is not a restricted-hours strategy backtest']};
}
