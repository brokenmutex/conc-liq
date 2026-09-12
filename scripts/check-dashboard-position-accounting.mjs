// Read-only reconciliation against one repeatable-read database snapshot.
// Run with node --import tsx; only the database URL is read from the runtime env.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import pg from 'pg';
import {readPositionOverview,readPositionDetail} from '../src/dashboard/positions.ts';
const env=parseEnv(readFileSync('data/dashboard-live-pilot.env','utf8'));
const db=new pg.Client({connectionString:env.DATABASE_URL});await db.connect();
const checks=[];
try{
 await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const stream=env.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1',overview=await readPositionOverview(db,stream);
 for(const p of overview.positions.filter(p=>!p.history)){
  const d=await readPositionDetail(db,stream,p.id,168);assert(d.performance);const w=d.performance;
  const sum=k=>w.rows.reduce((n,b)=>{assert.notEqual(b[k],null,`${p.id} ${k} unavailable`);return n+BigInt(b[k]);},0n);
  if(Date.parse(p.createdAt)>=Date.parse(w.from)){
   assert.equal(sum('netPnlQuote'),BigInt(d.position.navQuote)-BigInt(p.initialQuote));
   assert.equal(sum('gasQuote'),BigInt(d.position.gasQuote));assert.equal(sum('swapCostQuote'),BigInt(d.position.swapQuote));
   assert.equal(sum('feeIncomeQuote'),BigInt(d.position.feesQuote));
   if(d.position.holdQuote!==null)assert.equal(sum('alphaQuote'),BigInt(d.position.navQuote)-BigInt(d.position.holdQuote));
  }
  assert(w.timeline.length<=w.markCount);assert(w.timeline.every(x=>Date.parse(x.sourceAt)>=Date.parse(w.from)));
  const serialized=JSON.stringify(d);assert(!serialized.includes('rawTransaction'));assert(!serialized.includes('privateKey'));assert(!serialized.includes('signerKey'));
  for(const hours of [1,6,24]){const selected=await readPositionDetail(db,stream,p.id,hours);assert.equal(selected.performance.hours,hours);}
  checks.push({id:p.id,navQuote:d.position.navQuote,gasQuote:d.position.gasQuote,swapQuote:d.position.swapQuote,feesQuote:d.position.feesQuote,markCount:w.markCount,
   sourceThrough:w.sourceThrough,checks:['net NAV bridge','gas','swap shortfall','earned fees','passive alpha','all four windows','sanitized contract']});
 }
 await db.query('COMMIT');
 const report={at:new Date().toISOString(),checks};writeFileSync('data/dashboard-position-accounting-checks.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
