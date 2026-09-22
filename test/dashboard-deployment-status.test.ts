import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const context=vm.createContext({
 document:{querySelector:()=>({addEventListener(){}}),addEventListener(){}},
 window:{addEventListener(){}},
 fetch:()=>new Promise(()=>{}),
 AbortSignal,
});
vm.runInContext(readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8'),context);
const run=(expression:string)=>vm.runInContext(expression,context);

function position(status:string,lifecycle:string,extra:Record<string,unknown>={}){
 return {id:`paper-dep-${status}`,label:'Manual-1',mode:'paper',asset:'BASE',quote:'USDG',
  fee:3000,status,history:lifecycle==='closed',hasLiquidity:true,initial:null,capital:null,
  fees:null,sourceAt:new Date().toISOString(),reasons:[],deployment:{lifecycle,
   strategyId:'static_manual_v1',rangeState:'inside',operation:{stage:null,reason:null}},...extra};
}

test('deployment badges preserve manual hold, pause and blocked recovery',()=>{
 const outside=position('outside','active',{deployment:{lifecycle:'active',strategyId:'static_manual_v1',
  rangeState:'outside',operation:{stage:null,reason:null}}});
 const paused=position('paused','paused',{deployment:{lifecycle:'paused',strategyId:'static_manual_v1',
  rangeState:'outside',operation:{stage:null,reason:null}}});
 const blocked=position('blocked','blocked',{reasons:['source_stale'],deployment:{lifecycle:'blocked',
  strategyId:'static_manual_v1',rangeState:'outside',operation:{stage:'recovery',reason:'receipt <mismatch>'}}});
 Object.assign(context,{outside,paused,blocked});
 assert.match(run('row(outside,null)'),/badge outside[^>]*>Outside range/);
 assert.match(run('condition(outside)'),/Outside range · manual hold/);
 assert.doesNotMatch(run('row(outside,null)'),/Management paused/);
 assert.match(run('row(paused,null)'),/badge paused[^>]*>Management paused/);
 assert.match(run('condition(paused)'),/Management paused · outside range/);
 const blockedRow=run('row(blocked,null)');
 assert.match(blockedRow,/badge blocked[^>]*>Recovery blocked/);
 assert.match(blockedRow,/receipt &lt;mismatch&gt; · recovery · source stale/);
 assert.doesNotMatch(blockedRow,/receipt <mismatch>/);
});

test('attention filter excludes normal manual hold and includes recovery and stale sources',()=>{
 const current=[position('open','active'),position('outside','active'),position('paused','paused'),
  position('blocked','blocked'),position('waiting','opening'),position('exiting','closing'),
  position('outside','active',{id:'stale-outside',reasons:['source_stale'],
   sourceAt:new Date(Date.now()-181000).toISOString()})];
 Object.assign(context,{current});
 run('positions=current;statusFilter="attention"');
 assert.deepEqual(Array.from(run('visible("paper")'),(p:any)=>p.id),
  ['paper-dep-paused','paper-dep-blocked','paper-dep-exiting','stale-outside']);
 run('statusFilter="outside"');
 assert.deepEqual(Array.from(run('visible("paper")'),(p:any)=>p.id),
  ['paper-dep-outside','stale-outside']);
 assert.match(run('condition(current[4])'),/Opening in progress/);
 assert.match(run('condition(current[5])'),/Close in progress/);
 const closed=position('closed','closed');Object.assign(context,{closed});
 assert.match(run('condition(closed)'),/Campaign closed/);
});
