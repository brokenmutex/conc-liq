import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
const [capturePath,planPath,expectedPlanHash,output]=process.argv.slice(2);assert(output&&expectedPlanHash);
const digest=b=>createHash('sha256').update(b).digest('hex');
const bytes=fs.readFileSync(planPath),plan=JSON.parse(bytes);assert.equal(digest(bytes),expectedPlanHash,'Frozen plan changed');
for(const [file,hash] of Object.entries(plan.codeHashes))assert.equal(digest(fs.readFileSync(file)),hash,`Frozen code changed: ${file}`);
assert(Date.now()>=Date.parse(plan.prospective.scheduledAt),'Validation data window has not ended');
fs.mkdirSync(output,{recursive:true});
try{
 const raw=fs.readFileSync(capturePath);assert.equal(digest(raw),fs.readFileSync(capturePath+'.sha256','utf8').trim());
 const {manifest}=JSON.parse(raw);
 assert(Date.parse(manifest.from)>=Date.parse(plan.prospective.captureFrom)&&Date.parse(manifest.from)<=Date.parse(plan.prospective.allowedFrom),'Wrong prospective start');
 assert(Date.parse(manifest.to)>=Date.parse(plan.prospective.captureTo)-180000&&Date.parse(manifest.to)<=Date.parse(plan.prospective.captureTo),'Wrong prospective end');
 const resultPath=path.join(output,'replay.json');
 if(fs.existsSync(resultPath)){
  const saved=fs.readFileSync(resultPath);assert.equal(digest(saved),fs.readFileSync(resultPath+'.sha256','utf8').trim());
  const prior=JSON.parse(saved);assert.equal(prior.planSha256,expectedPlanHash);assert.equal(prior.captureSha256,digest(raw));
 }else{
  const r=spawnSync(process.execPath,['--import','tsx','scripts/replay-offhours-recenter.mjs',capturePath,planPath,resultPath],{encoding:'utf8',timeout:30*60*1000,maxBuffer:8*1024*1024});
  fs.writeFileSync(path.join(output,'replay.log'),r.stdout??'');if(r.status!==0){process.stderr.write(r.stderr??'');throw Error(`Replay failed: ${r.signal??r.status}`);}
 }
 fs.writeFileSync(path.join(output,'completed.json'),JSON.stringify({at:new Date().toISOString(),planSha256:expectedPlanHash,captureSha256:digest(raw),resultPath},null,2)+'\n');
 console.log(JSON.stringify({status:'completed',resultPath}));
}catch(error){fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({at:new Date().toISOString(),status:'unavailable',planSha256:expectedPlanHash,message:'Capture or replay validation failed; inspect service journal.'},null,2)+'\n');throw error;}
