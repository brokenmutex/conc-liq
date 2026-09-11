export type PaperTradingHours = {kind:'continuous_v1'} | {
 kind:'us_equity_off_hours_v1'; entryCutoffSeconds:1800; exitLeadSeconds:600;
}
const holidays=new Set(['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25']);
const early=new Set(['2026-11-27','2026-12-24']);
const formatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function equityHours(at:string|number){
 const time=typeof at==='number'?at:Date.parse(at);
 if(!Number.isFinite(time))return {regime:'calendar_unavailable',allowed:false,key:'invalid'};
 const p=Object.fromEntries(formatter.formatToParts(time).map(p=>[p.type,p.value]));
 const day=`${p.year}-${p.month}-${p.day}`,minute=Number(p.hour)*60+Number(p.minute);
 const regime=p.year!=='2026'?'calendar_unavailable':['Sat','Sun'].includes(p.weekday!)?'weekend':holidays.has(day)?'holiday':
  minute>=570&&minute<(early.has(day)?780:960)?'regular':minute>=240&&minute<570?'premarket':minute>=(early.has(day)?780:960)&&minute<1200?'afterhours':'overnight';
 return {regime,allowed:['weekend','afterhours','overnight'].includes(regime),key:day+'/'+(minute>=780?'late':'early')};
}
const deadlines=new Map<string,number>();
/** 2026 Nasdaq calendar; unsupported years and holidays fail closed. */
export function paperTradingWindow(at:string|number,policy:PaperTradingHours){
 const time=typeof at==='number'?at:Date.parse(at),session=equityHours(time);
 if(policy.kind==='continuous_v1')return {...session,allowed:Number.isFinite(time),entryAllowed:Number.isFinite(time),exitRequired:!Number.isFinite(time),excludedAt:null};
 if(!session.allowed)return {...session,entryAllowed:false,exitRequired:true,excludedAt:null};
 let end=deadlines.get(session.key);
 if(end===undefined){
  end=Math.floor(time/900000)*900000+900000;
  while(equityHours(end).allowed&&end-time<=8*86400000)end+=900000;
  if(end-time>8*86400000)throw Error('Off-hours boundary unavailable');
  deadlines.set(session.key,end);
 }
 return {...session,entryAllowed:time<end-policy.entryCutoffSeconds*1000,
  exitRequired:time>=end-policy.exitLeadSeconds*1000,excludedAt:new Date(end).toISOString()};
}
