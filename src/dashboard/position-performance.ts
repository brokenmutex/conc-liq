import {sessionSegments,marketSession} from '../paper/session-performance.js';

/** Display contract: raw amounts remain integer strings until browser formatting. */
export interface PositionPoint {
 sourceAt:string;observedAt:string;block:string;action:string;status:string;
 economicNavQuote:string|null;holdQuote:string|null;priceQuoteX18:string;
 usdg:string;nvda:string;exposurePpm:string;inRange:boolean;tickLower:number|null;tickUpper:number|null;
 feesThisIntervalQuote:string|null;gasThisMarkQuote:string|null;swapThisMarkQuote:string|null;swapsThisMark:number;
 drawdownPpm:string;[key:string]:unknown;
}
const sum=(a:bigint|null,b:string|null)=>a===null||b===null?null:a+BigInt(b);
const delta=(a:string|null,b:string|null)=>a===null||b===null?null:String(BigInt(a)-BigInt(b));
const raw=(v:bigint|null)=>v===null?null:String(v);
/** Aggregate unsampled observations. A partial interval at the left edge is
 * excluded; a gap or market boundary gets its own unattributed P&L bucket. */
export function positionWindow(points:readonly PositionPoint[],hours:number,now:number,initial:string,createdAt:string) {
 const cutoff=now-hours*3600000;
 const selected=points.filter(p=>Date.parse(p.sourceAt)>=cutoff&&Date.parse(p.sourceAt)<=now);
 const buckets=new Map<string,any>();
 const bucket=(key:string)=>{if(!buckets.has(key))buckets.set(key,{key,hours:0,activeHours:0,inRangeHours:0,capitalMs:0n,
  pnl:0n,hold:0n,fees:0n,gas:0n,swap:0n,recenters:0,swaps:0});return buckets.get(key);};
 for(const key of ['market','premarket','non_market','mixed_boundary','unobserved'])bucket(key);
 const gaps:{from:string;to:string}[]=[];
 let previous:PositionPoint|undefined,coveredStart:string|null=null,holdSeen=false;
 for(const p of selected){
  const at=Date.parse(p.sourceAt),isFirst=points[0]===p,firstBaseline=isFirst&&Date.parse(createdAt)>=cutoff;
  if(!previous&&!firstBaseline){previous=p;coveredStart=p.sourceAt;continue;}
  const from=previous?Date.parse(previous.sourceAt):Math.min(at,Date.parse(createdAt));
  if(coveredStart===null)coveredStart=new Date(from).toISOString();
  const navDelta=delta(p.economicNavQuote,previous?.economicNavQuote??initial);
  const holdDelta=delta(p.holdQuote??(!holdSeen?initial:null),previous?.holdQuote??(!holdSeen?initial:null));
  if(p.holdQuote!==null)holdSeen=true;
  const gap=at-from>900000;
  const segments=sessionSegments(from,at),endpoint=bucket(marketSession(at).group);
  const crossed=segments.some(s=>s.session.key!==marketSession(at).key);
  const interval=bucket(gap?'unobserved':crossed?'mixed_boundary':marketSession(at).group);
  if(gap)gaps.push({from:new Date(from).toISOString(),to:p.sourceAt});
  else for(const s of segments){const b=bucket(s.session.group),ms=s.to-s.from;b.hours+=ms/3600000;
   if(previous?.economicNavQuote!==null)b.capitalMs+=BigInt(previous?.economicNavQuote??initial)*BigInt(ms);
   if(previous?.tickLower!==null&&previous?.tickLower!==undefined){b.activeHours+=ms/3600000;if(previous.inRange)b.inRangeHours+=ms/3600000;}}
  // Restore costs to interval movement, then assign actual charges to endpoint.
  const costs=p.gasThisMarkQuote===null||p.swapThisMarkQuote===null?null:String(BigInt(p.gasThisMarkQuote)+BigInt(p.swapThisMarkQuote));
  interval.pnl=sum(interval.pnl,navDelta===null||costs===null?null:String(BigInt(navDelta)+BigInt(costs)));
  endpoint.pnl=sum(endpoint.pnl,costs===null?null:String(-BigInt(costs)));
  interval.hold=sum(interval.hold,holdDelta);interval.fees=sum(interval.fees,p.feesThisIntervalQuote);
  endpoint.gas=sum(endpoint.gas,p.gasThisMarkQuote);endpoint.swap=sum(endpoint.swap,p.swapThisMarkQuote);
  endpoint.swaps+=p.swapsThisMark??0;if(p.action==='recenter')endpoint.recenters++;
  previous=p;
 }
 const rows=[...buckets.values()].map(b=>({key:b.key,hours:b.hours,activeHours:b.activeHours,
  inRangePercent:b.activeHours?b.inRangeHours/b.activeHours*100:null,
  netPnlQuote:raw(b.pnl),alphaQuote:!holdSeen||b.pnl===null||b.hold===null?null:String(b.pnl-b.hold),
  feeIncomeQuote:raw(b.fees),gasQuote:raw(b.gas),swapCostQuote:raw(b.swap),recenters:b.recenters,swaps:b.swaps,
  returnBpsPerHour:b.capitalMs>0n&&b.pnl!==null?Number(b.pnl*10000n*3600000n*1000000n/b.capitalMs)/1000000:null}));
 const stride=Math.max(1,Math.ceil(selected.length/1000));
 const timeline=selected.filter((p,i)=>i%stride===0||i===selected.length-1||['enter','exit','recenter'].includes(p.action)||
  (i>0&&(marketSession(p.sourceAt).key!==marketSession(selected[i-1]!.sourceAt).key||Date.parse(p.sourceAt)-Date.parse(selected[i-1]!.sourceAt)>900000))||
  (i+1<selected.length&&Date.parse(selected[i+1]!.sourceAt)-Date.parse(p.sourceAt)>900000));
 return {hours,from:new Date(cutoff).toISOString(),through:new Date(now).toISOString(),coveredStart,
  sourceThrough:selected.at(-1)?.sourceAt??null,sessions:sessionSegments(cutoff,now).map(s=>({from:s.from,to:s.to,group:s.session.group})),markCount:selected.length,sampled:timeline.length!==selected.length,timeline,rows,gaps};
}
