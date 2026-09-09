import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {ExperimentSource} from '../src/experiment/source.ts';
import {ExperimentMarket} from '../src/experiment/market.ts';

const [envPath,paperPath,output]=process.argv.slice(2);
assert(envPath&&paperPath&&output,'Usage: node --import tsx scripts/capture-management-audit.mjs PRIVATE_ENV PAPER_SOURCE OUTPUT');
const hash=x=>createHash('sha256').update(x).digest('hex');
const raw=fs.readFileSync(paperPath,'utf8');
assert.equal(hash(raw),fs.readFileSync(paperPath+'.sha256','utf8').trim());
const paper=JSON.parse(raw),times=paper.observations.map(o=>Date.parse(o.source_at));
const source=new ExperimentSource(parseEnv(fs.readFileSync(envPath,'utf8')).DATABASE_URL);
await source.connect();
try{
 await source.db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const rows=(await source.checkpoints(new Date(Math.min(...times)).toISOString(),new Date(Math.max(...times)).toISOString()))
  .filter(r=>Date.parse(r.observed_at)<=Date.parse(paper.asOf));
 assert(rows.length>1);
 const ids=new Set(rows.map(r=>r.id));
 assert(paper.observations.every(o=>ids.has(o.checkpoint_id)),'Frozen paper source checkpoint missing');
 await source.coverage(rows.at(-1).block,rows.at(-1).target_set_hash);
 assert(await source.historyValid(rows.map(r=>r.id)),'Canonical source revoked');
 const seed=await source.seed(rows[0]),events=await source.events(rows[0].block,rows.at(-1).block);
 const market=new ExperimentMarket(seed),frames=[];let i=0;
 for(const r of rows){
  const assigned=[];
  while(i<events.length&&BigInt(events[i].block)<=BigInt(r.block))assigned.push(events[i++]);
  const f=source.frame(r,paper.health,assigned);
  for(const e of assigned)market.apply(e);
  market.verify(f);assert(f.dataValid);
  frames.push(f);
 }
 assert.equal(i,events.length);
 const costEvidence=await source.costs();
 await source.db.query('COMMIT');
 const data={manifest:{capturedAt:new Date().toISOString(),paperAsOf:paper.asOf,paperPath,paperSha256:hash(raw),
  source:'repeatable-read PostgreSQL; canonical event replay checked against every checkpoint',executionEligible:false,
  decisionBoundary:'Frame gates are retrospective checkpoint evidence, not proof of historical current-risk availability. Recorded paper decisions are retained separately.'},seed,frames,costEvidence};
 const text=JSON.stringify(data,null,2)+'\n';
 fs.writeFileSync(output,text,{flag:'wx'});fs.writeFileSync(output+'.sha256',hash(text)+'\n',{flag:'wx'});
 console.log(JSON.stringify({frames:frames.length,events:events.length,from:frames[0].sourceAt,to:frames.at(-1).sourceAt,sha256:hash(text)}));
}finally{await source.close();}
