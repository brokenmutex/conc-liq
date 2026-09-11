import fs from 'node:fs';import assert from 'node:assert/strict';import {parseEnv} from 'node:util';import {createHash} from 'node:crypto';
import {ExperimentSource} from '../src/experiment/source.ts';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {evaluatePaperReference} from '../src/paper/reference.ts';
const [envPath,from,to,output]=process.argv.slice(2);assert(output&&!fs.existsSync(output));
const source=new ExperimentSource(parseEnv(fs.readFileSync(envPath,'utf8')).DATABASE_URL);
const referencePolicy={kind:'continuous_bounded_v1',maxHeldAgeSeconds:345600,maxDeviationPpm:50000,maxGasPriceAgeSeconds:86400,usdgHeartbeatGraceSeconds:1800};
try{
 await source.connect();await source.db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const rows=await source.checkpoints(from,to);assert(rows.length>1);await source.coverage(rows.at(-1).block,rows.at(-1).target_set_hash);
 const seed=await source.seed(rows[0]),health=await source.health(rows[0].observed_at,new Date(Date.parse(rows.at(-1).observed_at)+30000).toISOString());
 const events=await source.events(rows[0].block,rows.at(-1).block);assert(await source.historyValid(rows.map(r=>r.id)));
 await source.db.query('COMMIT');
 const market=new ExperimentMarket(seed),frames=[];let ei=0,hi=0,lo=0;
 for(const row of rows){
  const batch=[];while(ei<events.length&&BigInt(events[ei].block)<=BigInt(row.block))batch.push(events[ei++]);
  const decision=new Date(Date.parse(row.observed_at)+30000).toISOString(),now=Date.parse(decision);
  while(hi<health.length&&Date.parse(health[hi].snapshot.observedAt)<=now)hi++;
  while(lo<hi&&Date.parse(health[lo].snapshot.observedAt)<now-360000)lo++;
  const samples=health.slice(lo,hi),f=source.frame(row,samples,batch,decision);
  const ref=evaluatePaperReference({snapshot:row.snapshot,checkpoint:{id:f.id,block:f.block,hash:f.hash,blockTimestamp:f.sourceAt,capturedAt:f.capturedAt,tick:f.tick,sqrtPriceX96:f.price,liquidity:f.liquidity,feeGrowth0:f.global0,feeGrowth1:f.global1,targetSetHash:f.targetSetHash},policy:referencePolicy});
  f.referenceEligible=ref.eligible&&row.pool_unlocked;f.referencePrice=ref.referencePriceX18;f.referenceReasons=ref.reasons;
  f.allHealthIds=samples.map(s=>s.id);
  for(const e of batch)market.apply(e);market.verify(f);frames.push(f);
 }
 assert.equal(ei,events.length);
 const manifest={capturedAt:new Date().toISOString(),from:frames[0].sourceAt,to:frames.at(-1).sourceAt,checkpoints:frames.length,events:events.length,healthSamples:health.length,canonical:true,marketReconciled:true,referencePolicy,timing:'Historical checkpoint capture plus 30 seconds; missing contemporary preflight evidence is not reconstructed'};
 const raw=JSON.stringify({manifest,seed,health,frames})+'\n';fs.writeFileSync(output,raw,{flag:'wx'});fs.writeFileSync(output+'.sha256',createHash('sha256').update(raw).digest('hex')+'\n',{flag:'wx'});console.log(JSON.stringify(manifest));
}finally{await source.close();}
