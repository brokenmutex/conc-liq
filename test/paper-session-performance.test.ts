import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sessionPerformance,marketSession,sessionSegments,type SessionMark} from '../src/paper/session-performance.js';
import {paperTradingWindow} from '../src/paper/trading-hours.js';
import {paperPolicySchema} from '../src/paper/config.js';
import {advancePaper,type TransactionPaperPolicy} from '../src/paper/engine.js';
import {readFileSync} from 'node:fs';

const funding=[{id:'1',budgetQuote:'1000000000',createdAt:'2026-09-11T13:28:00Z'}];
const p={liquidity:'100',tickLower:-20,tickUpper:20,idle0:'992000000',idle1:'0',fee0:'0',fee1:'0',hold0:'995000000',hold1:'0',enteredAt:'2026-09-11T13:29:00Z'};
function mark(minute:number,values:Partial<SessionMark>={}):SessionMark{return {id:String(minute),sessionId:'1',sourceAt:`2026-09-11T13:${minute}:00Z`,observedAt:`2026-09-11T13:${minute}:02Z`,block:String(minute),action:'mark',status:'open',tick:0,sqrtPriceX96:String(1n<<96n),navQuote:'990000000',holdQuote:'992000000',costsPaidQuote:'3000000',exitReserveQuote:'2000000',earnedFee0:'0',earnedFee1:'0',position:{...p},...values};}
const trade={runId:'1',sessionId:'1',block:'29',token:0 as const,amountIn:'10000000',amountOut:'5000000'};
const points=[mark(29,{action:'enter'}),mark(30,{navQuote:'1004000000',costsPaidQuote:'4000000',earnedFee0:'2000000'}),
 mark(31,{navQuote:'1002000000',costsPaidQuote:'4000000',earnedFee0:'2000000',exitReserveQuote:'4000000'}),
 mark(32,{action:'recenter',navQuote:'999000000',costsPaidQuote:'10000000',earnedFee0:'2000000',exitReserveQuote:'1000000'}),
 mark(33,{action:'exit',status:'closed',navQuote:'998000000',costsPaidQuote:'12000000',earnedFee0:'2000000',exitReserveQuote:'0',position:{...p,liquidity:'0',idle0:'1010000000'}})];
test('24/7 permits regular, premarket, weekend and holidays without an age timeout',()=>{
 const policy=paperPolicySchema.parse(JSON.parse(readFileSync(new URL('../config/paper-nvda-5000-recenter-continuous.json',import.meta.url),'utf8'))) as TransactionPaperPolicy;
 for(const at of ['2026-09-11T08:00:00Z','2026-09-11T13:30:00Z','2026-09-12T20:00:00Z','2026-12-25T14:00:00Z']){
  const window=paperTradingWindow(at,policy.tradingHours!);assert(window.entryAllowed);assert(!window.exitRequired);assert.equal(window.excludedAt,null);
 }
 assert.equal(paperTradingWindow('bad',policy.tradingHours!).entryAllowed,false);
 const f=JSON.parse(readFileSync(new URL('./fixtures/paper-state-rejected-exit-recovery.json',import.meta.url),'utf8'));
 const prior=structuredClone(f.previous);prior.status='open';prior.pendingSince=null;delete prior.holding;
 prior.position.enteredAt='2026-09-01T12:00:00Z';prior.last={...prior.last,blockTimestamp:'2026-09-11T13:29:00Z',capturedAt:'2026-09-11T13:29:00Z'};
 const input={...f.input,now:'2026-09-11T13:30:00Z',holdingChainReady:true,checkpoint:{...f.input.checkpoint,blockTimestamp:'2026-09-11T13:30:00Z',capturedAt:'2026-09-11T13:30:00Z'}};
 const result=advancePaper(prior,policy,input);assert.equal(result.status,'open');assert(result.reasons.includes('paper_recenter_quote_required'));assert(!result.reasons.includes('paper_scheduled_cash_exit'));
 const risk=advancePaper(prior,policy,{...input,entryReasons:['paper_reference_band_exceeded']});assert.equal(risk.action,'signal_exit');
});
test('market labels honor New York DST, early closes, weekends and unsupported calendars',()=>{
 assert.equal(marketSession('2026-09-11T13:29:59Z').regime,'premarket');assert.equal(marketSession('2026-09-11T13:30:00Z').regime,'regular');
 assert.equal(marketSession('2026-11-02T14:29:59Z').regime,'premarket');assert.equal(marketSession('2026-11-02T14:30:00Z').regime,'regular');
 assert.equal(marketSession('2026-11-27T18:00:00Z').regime,'afterhours');assert.equal(marketSession('2026-12-25T14:00:00Z').regime,'holiday');
 assert.equal(marketSession('2026-09-12T12:00:00Z').group,'non_market');assert.equal(marketSession('2027-01-04T15:00:00Z').group,'unknown');
 const segments=sessionSegments(Date.parse('2026-09-11T13:29:30Z'),Date.parse('2026-09-11T13:30:30Z'));
 assert.deepEqual(segments.map(s=>[s.session.regime,s.to-s.from]),[['premarket',30000],['regular',30000]]);
});
test('open position gains are reported before exit and boundary gains are not assigned to the exit session',()=>{
 const r=sessionPerformance(funding,points.slice(0,2),[trade]);
 assert.equal(r.netPnlQuote,'6000000');assert.equal(r.navPnlQuote,'4000000');assert.equal(r.gasQuote,'4000000');assert.equal(r.boundaryCount,1);
 assert.equal(r.boundaries[0].before.sourceAt,points[0]!.sourceAt);assert.equal(r.boundaries[0].after.sourceAt,points[1]!.sourceAt);
 assert.equal(r.boundaries[0].quality,'bracketed_not_exact');
 const pre=r.grouped.find(b=>b.key==='premarket')!,regular=r.grouped.find(b=>b.key==='market')!,mixed=r.grouped.find(b=>b.key==='mixed_boundary')!;
 assert.equal(pre.netPnlQuote,'-8000000');assert.equal(pre.swapCostVsSpotQuote,'5000000');assert.equal(pre.gasQuote,'3000000');
 assert.equal(regular.netPnlQuote,'-1000000');assert.equal(mixed.netPnlQuote,'15000000');assert.equal(mixed.feeIncomeQuote,'2000000');
 assert.equal(r.days.find(d=>d.day==='2026-09-11')!.grouped.reduce((n,b)=>n+BigInt(b.netPnlQuote),0n),6000000n);
});
test('exit reserve changes are bridged separately; moves do not reset fee income or passive holdings',()=>{
 const r=sessionPerformance(funding,points,[trade]);
 assert.equal(r.netPnlQuote,'-2000000');assert.equal(r.navPnlQuote,'-2000000');assert.equal(r.holdPnlQuote,'-8000000');assert.equal(r.alphaQuote,'6000000');
 assert.equal(r.gasQuote,'12000000');assert.equal(r.grouped.reduce((n,b)=>n+BigInt(b.feeIncomeQuote),0n),2000000n);
 assert.equal(r.grouped.reduce((n,b)=>n+BigInt(b.swapCostVsSpotQuote),0n),5000000n);
 assert.equal(r.grouped.find(b=>b.key==='market')!.recenters,1);assert.equal(r.timeline[3].holdQuote,r.timeline[0].holdQuote);
 const during=sessionPerformance(funding,points.slice(0,3),[trade]);assert.equal(during.netPnlQuote,'6000000');assert.equal(during.navPnlQuote,'2000000');assert.equal(during.exitReserveQuote,'4000000');
});
test('cash continuation carries net funding and counter resets without double charging',()=>{
 const child=mark(34,{sessionId:'2',status:'waiting',position:null,navQuote:null,holdQuote:null,costsPaidQuote:'0',exitReserveQuote:'0',earnedFee0:'0',earnedFee1:'0'});
 const r=sessionPerformance([...funding,{id:'2',budgetQuote:'998000000',createdAt:'2026-09-11T13:33:30Z'}],[...points,child],[trade]);
 assert.equal(r.netPnlQuote,'-2000000');assert.equal(r.gasQuote,'12000000');assert.equal(r.timeline.at(-1).holdQuote,'992000000');
 assert.equal(r.timeline.at(-1).usdg,'998000000');
});
test('history errors cannot silently produce partial totals',()=>{
 assert.throws(()=>sessionPerformance(funding,[points[1]!,points[0]!],[]),/advance/);
 assert.throws(()=>sessionPerformance(funding,[{...points[0]!,status:'invalid'}],[]),/Invalid/);
 assert.throws(()=>sessionPerformance(funding,[points[0]!],[{...trade,block:'999'}]),/no accepted position mark/);
 assert.throws(()=>sessionPerformance(funding,[points[0]!,{...points[1]!,costsPaidQuote:'0'}],[trade]),/gas regressed/);
});
