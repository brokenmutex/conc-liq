import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {readPaperChain} from './paper/reentry.js';
import {readSessionPerformance} from './paper/session-performance-store.js';
import type {PaperSessionRow} from './paper/store.js';
import {assertSchemaReady} from './storage/compatibility.js';
import {sanitizeRiskError} from './risk/evaluate.js';
async function main(){
 const [flag,output]=process.argv.slice(2);assert(flag==='--output'&&output?.startsWith('/')&&process.argv.length===4,'Usage: paper-performance --output /absolute/directory');
 assert(output);
 assert(process.env.DATABASE_URL,'DATABASE_URL is required');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),db=await pool.connect();
 let report;
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='30s'");await assertSchemaReady(db);
  const row=(await db.query<PaperSessionRow>('SELECT * FROM paper_sessions WHERE stream_key=$1 ORDER BY id DESC LIMIT 1',[process.env.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1'])).rows[0];assert(row,'No paper campaign');
  const chain=await readPaperChain(db,row);
  report={computedAt:new Date().toISOString(),campaignRoot:chain[0]!.id,sessionIds:chain.map(s=>s.id),policies:chain.map(s=>({id:s.id,policy:s.policy,policyHash:s.policy_hash,runtimeIdentity:s.runtime_identity})),
   performance:await readSessionPerformance(db,chain,true),executionEligible:false};
  await db.query('COMMIT');
 }finally{db.release();await pool.end();}
 await mkdir(output,{recursive:true});
 const path=join(output,`campaign-${report.campaignRoot}-${report.computedAt.replaceAll(':','-')}.json`),raw=JSON.stringify(report,null,2)+'\n';
 await writeFile(path,raw,{flag:'wx'});await writeFile(path+'.sha256',createHash('sha256').update(raw).digest('hex')+'\n',{flag:'wx'});
 console.log(JSON.stringify({path,rootSessionId:report.campaignRoot,marks:report.performance.markCount,boundaries:report.performance.boundaryCount,netPnlQuote:report.performance.netPnlQuote,executionEligible:false}));
}
main().catch(error=>{console.error(sanitizeRiskError(error));process.exitCode=1;});
