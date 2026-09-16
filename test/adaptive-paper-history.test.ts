import assert from 'node:assert/strict';
import {appendFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {adaptiveHistoryPoint,appendAdaptivePaperMark,readAdaptivePaperMarks,type AdaptivePaperMark} from '../src/adaptive-paper-history.js';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {NVDA_PAPER_MARKET,marketValue} from '../src/paper/market.js';
import {positionWindow,type PositionPoint} from '../src/dashboard/position-performance.js';

const price=sqrtRatioAtTick(222600);
function mark(block:string,at:string,extra:Partial<AdaptivePaperMark>={}):AdaptivePaperMark{return {version:1,symbol:'NVDA',sourceAt:at,observedAt:at,block,
 continuity:'continuous',action:'mark',status:'open',navQuote:'1000000000',holdQuote:'1000000000',sqrtPriceX96:String(price),priceQuoteX18:'215000000000000000000',
 usdg:'500000000',rwa:'2000000000000000000',exposurePpm:'500000',inRange:true,tickLower:222590,tickUpper:222610,fees0:'0',fees1:'0',
 gasThisMarkQuote:'0',swapThisMarkQuote:'0',swapsThisMark:0,drawdownPpm:'0',...extra};}

test('adaptive sidecar history deduplicates blocks and maps continuous chart attribution',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adaptive-paper-history-')),state=join(dir,'state.json');
 try{
  const first=mark('10','2026-09-16T17:00:00.000Z',{continuity:'baseline',gasThisMarkQuote:null,swapThisMarkQuote:null});
  const second=mark('11','2026-09-16T17:01:00.000Z',{navQuote:'1000100000',action:'recenter',fees0:'1000',gasThisMarkQuote:'25000',swapThisMarkQuote:'5000',swapsThisMark:1});
  await appendAdaptivePaperMark(state,first);await appendAdaptivePaperMark(state,second);await appendAdaptivePaperMark(state,{...second,observedAt:'2026-09-16T17:01:01.000Z'});
  await appendFile(`${state}.nvda.marks.jsonl`,'{"version":');
  const marks=await readAdaptivePaperMarks(state,'NVDA');assert.equal(marks.length,2);assert.equal(marks[1]!.observedAt,'2026-09-16T17:01:01.000Z');
  const points=marks.map((item,index)=>adaptiveHistoryPoint(NVDA_PAPER_MARKET,item,marks[index-1]) as PositionPoint);
  assert.equal(points[0]!.gasThisMarkQuote,null);assert.equal(points[1]!.gasThisMarkQuote,'25000');assert.equal(points[1]!.swapThisMarkQuote,'5000');assert.equal(points[1]!.action,'recenter');
  assert.equal(points[1]!.feesThisIntervalQuote,String(marketValue(NVDA_PAPER_MARKET,price,1000n,0n)));
  const window=positionWindow(points,1,Date.parse(second.sourceAt),'1000000000','2026-09-16T16:00:00.000Z');
  assert.equal(window.markCount,2);assert.equal(window.timeline.length,2);assert.equal(window.gaps.length,0);
  const lifetime=positionWindow(points,24,Date.parse(second.sourceAt),'1000000000','2026-09-16T16:00:00.000Z');
  assert.equal(lifetime.gaps.length,1);assert.equal(lifetime.rows.find(row=>row.key==='market')!.netPnlQuote,'100000');
  assert.equal(lifetime.rows.find(row=>row.key==='unobserved')!.gasQuote,null);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('missing adaptive sidecar is a valid pre-history state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adaptive-paper-history-'));
 try{assert.deepEqual(await readAdaptivePaperMarks(join(dir,'state.json'),'NVDA'),[]);}finally{await rm(dir,{recursive:true,force:true});}
});
