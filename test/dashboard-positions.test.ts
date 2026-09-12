import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {positionWindow,type PositionPoint} from '../src/dashboard/position-performance.js';
import {createDashboardServer} from '../src/dashboard/server.js';
import {loadDashboardConfig} from '../src/dashboard/config.js';

function point(at:string,nav:string,extra:Partial<PositionPoint>={}):PositionPoint{return {
 sourceAt:at,observedAt:at,block:'1',action:'mark',status:'open',economicNavQuote:nav,holdQuote:'100000000',priceQuoteX18:'220000000000000000000',
 usdg:'50000000',nvda:'227272727272727272',exposurePpm:'500000',inRange:true,tickLower:222390,tickUpper:222430,
 feesThisIntervalQuote:'0',gasThisMarkQuote:'0',swapThisMarkQuote:'0',swapsThisMark:0,drawdownPpm:'0',...extra};}
const total=(rows:any[],field:string)=>rows.reduce((n,b)=>n+BigInt(b[field]),0n);
test('week attribution preserves exact net P&L and allocates boundary charges once',()=>{
 const created='2026-09-11T13:28:00Z',points=[point('2026-09-11T13:29:00Z','99000000',{action:'enter',gasThisMarkQuote:'500000',swapThisMarkQuote:'500000',swapsThisMark:1}),
 point('2026-09-11T13:30:00Z','102000000',{gasThisMarkQuote:'100000',feesThisIntervalQuote:'700000'}),point('2026-09-11T13:31:00Z','101500000')];
 const w=positionWindow(points,168,Date.parse(points.at(-1)!.sourceAt),'100000000',created);
 assert.equal(total(w.rows,'netPnlQuote'),1500000n);assert.equal(total(w.rows,'gasQuote'),600000n);assert.equal(total(w.rows,'swapCostQuote'),500000n);
 assert.equal(w.rows.find(r=>r.key==='mixed_boundary')!.netPnlQuote,'3100000');assert.equal(w.rows.find(r=>r.key==='mixed_boundary')!.feeIncomeQuote,'700000');
 assert.equal(total(w.rows,'alphaQuote'),1500000n);assert.equal(w.hours,168);assert(w.sessions.some(s=>s.group==='non_market'));
});
test('left-edge partial intervals are excluded, without charging older gas or swaps',()=>{
 const points=[point('2026-09-12T11:30:00Z','100000000'),point('2026-09-12T12:01:00Z','90000000',{gasThisMarkQuote:'2000000'}),point('2026-09-12T12:30:00Z','91000000')];
 const w=positionWindow(points,1,Date.parse('2026-09-12T13:00:00Z'),'100000000','2026-09-12T11:00:00Z');
 assert.equal(w.coveredStart,'2026-09-12T12:01:00Z');assert.equal(total(w.rows,'netPnlQuote'),1000000n);assert.equal(total(w.rows,'gasQuote'),0n);
 assert.equal(w.gaps.length,1);assert.equal(w.rows.find(r=>r.key==='unobserved')!.netPnlQuote,'1000000');
});
test('week view shows only available marks and keeps unknown gas and NAV unknown',()=>{
 const p=point('2026-09-12T12:00:00Z','100000000',{economicNavQuote:null,gasThisMarkQuote:null,holdQuote:null});
 const w=positionWindow([p],168,Date.parse(p.sourceAt),'100000000','2026-09-12T11:59:00Z');
 assert.equal(w.timeline.length,1);assert.equal(w.markCount,1);assert.equal(w.rows.find(r=>r.key==='non_market')!.netPnlQuote,null);
 assert.equal(w.rows.find(r=>r.key==='non_market')!.gasQuote,null);assert.equal(w.rows.find(r=>r.key==='non_market')!.alphaQuote,null);
});
test('pre-entry cash does not poison later passive-hold attribution',()=>{
 const ps=[point('2026-09-12T12:00:00Z','100000000',{holdQuote:null}),point('2026-09-12T12:01:00Z','99000000',{action:'enter',holdQuote:'99500000'})];
 const w=positionWindow(ps,1,Date.parse(ps[1]!.sourceAt),'100000000','2026-09-12T11:59:00Z');
 assert.equal(total(w.rows,'alphaQuote'),-500000n);
});
test('downsampling preserves full performance totals and entry / recenter markers',()=>{
 const start=Date.parse('2026-09-12T12:00:00Z');
 const ps=Array.from({length:2200},(_,i)=>point(new Date(start+i*1000).toISOString(),String(100000000+i),{action:i===1199?'recenter':'mark',feesThisIntervalQuote:'1'}));
 const w=positionWindow(ps,168,start+2200*1000,'100000000',ps[0]!.sourceAt);
 assert(w.sampled);assert(w.timeline.length<ps.length);assert(w.timeline.some(p=>p.action==='recenter'));assert.equal(total(w.rows,'netPnlQuote'),2199n);assert.equal(total(w.rows,'feeIncomeQuote'),2200n);
});
test('HTTP position endpoint validates identifiers and permits 168 hours; legacy stays behind diagnostics',async()=>{
 const requests:any[]=[];const server=createDashboardServer({snapshot:async()=>({} as any),positions:async(id,hours)=>{requests.push({id,hours});return id==='paper-999'?null:{positions:[]};}},
  {...loadDashboardConfig({DATABASE_URL:'postgresql://unused/test'}),port:0});
 await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 try{
  assert.equal((await fetch(base+'/api/positions/paper-60?hours=168')).status,200);assert.deepEqual(requests[0],{id:'paper-60',hours:168});
  assert.equal((await fetch(base+'/api/positions/paper-60?hours=169')).status,400);assert.equal((await fetch(base+'/api/positions/nope')).status,400);
  assert.equal((await fetch(base+'/api/positions/paper-999')).status,404);assert.equal((await fetch(base+'/api/positions',{method:'POST'})).status,405);
  const page=await fetch(base+'/');assert.match(await page.text(),/Positions/);assert.match(page.headers.get('Content-Security-Policy')??'',/script-src 'self'/);
  assert.equal((await fetch(base+'/legacy')).status,200);assert.equal((await fetch(base+'/preview')).status,200);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
