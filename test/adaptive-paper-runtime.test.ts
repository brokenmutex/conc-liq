import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {migrateAdaptivePaperRuntime} from '../src/adaptive-paper-runtime.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
test('adaptive runtime migration changes only identity and appends exact provenance',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adaptive-runtime-')),path=join(dir,'state.json'),from={buildId:'a'.repeat(64),configHash:'b'.repeat(64),nodeVersion:process.version},to={...from,buildId:'c'.repeat(64)};
 const config={version:'adaptive_paper_60m_v1',value:1},state={version:1,createdAt:'2026-09-16T00:00:00Z',config,configHash:sha(JSON.stringify(config,null,2)+'\n'),runtime:from,assets:[{symbol:'NVDA',model:{cash:{bigint:'10'}}}],lastPollAt:'2026-09-16T01:00:00Z'};
 const raw=JSON.stringify(state,null,2)+'\n';await writeFile(path,raw);
 try{
  const result=await migrateAdaptivePaperRuntime(path,from.buildId,to),migrated=JSON.parse(await readFile(path,'utf8'));
  assert.equal(result.stateSha256,sha(raw));assert.deepEqual(migrated.runtime,to);assert.equal(migrated.runtimeHistory.length,1);
  assert.deepEqual(migrated.runtimeHistory[0].from,from);assert.deepEqual(migrated.runtimeHistory[0].to,to);assert.equal(migrated.runtimeHistory[0].stateSha256,sha(raw));
  const {runtime,runtimeHistory,...rest}=migrated;assert.deepEqual(rest,Object.fromEntries(Object.entries(state).filter(([key])=>key!=='runtime')));
  await assert.rejects(()=>migrateAdaptivePaperRuntime(path,from.buildId,to),/Prior adaptive runtime changed/);
  await assert.rejects(()=>migrateAdaptivePaperRuntime(path,to.buildId,{...to,buildId:'d'.repeat(64),configHash:'e'.repeat(64)}),/identical environment/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
