import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const [envPath,planPath,expectedPlanHash,output]=process.argv.slice(2);
assert(output&&expectedPlanHash,'Usage: run-cap-validation ENV PLAN PLAN_SHA256 OUTPUT_DIRECTORY');
const digest=b=>createHash('sha256').update(b).digest('hex');
const planBytes=fs.readFileSync(planPath),plan=JSON.parse(planBytes);
assert.equal(digest(planBytes),expectedPlanHash,'Pre-registered plan changed');
for(const [file,hash] of Object.entries(plan.codeHashes))assert.equal(digest(fs.readFileSync(file)),hash,`Frozen code changed: ${file}`);
assert(Date.now()>=Date.parse(plan.prospective.scheduledAt),'Validation data window has not ended');
fs.mkdirSync(output,{recursive:true});
const resultPath=path.join(output,'replay.json'),capturePath=path.join(output,'market.json');
if(fs.existsSync(resultPath)){
 const bytes=fs.readFileSync(resultPath),result=JSON.parse(bytes);
 assert.equal(digest(bytes),fs.readFileSync(resultPath+'.sha256','utf8').trim());
 assert.equal(result.planSha256,expectedPlanHash);
 console.log(JSON.stringify({status:'already_completed',resultPath}));process.exit(0);
}
let stage='capture';
try{
 if(!fs.existsSync(capturePath))run('scripts/capture-cap-study.mjs',[envPath,plan.prospective.captureFrom,plan.prospective.captureTo,capturePath]);
 const captureBytes=fs.readFileSync(capturePath);
 assert.equal(digest(captureBytes),fs.readFileSync(capturePath+'.sha256','utf8').trim());
 const {manifest}=JSON.parse(captureBytes);
 assert(Date.parse(manifest.from)<=Date.parse(plan.prospective.allowedFrom),'Missing beginning of prospective window');
 assert(Date.parse(manifest.to)>=Date.parse(plan.prospective.captureTo)-180000,'Missing final prospective checkpoints');
 stage='replay';run('scripts/replay-offhours-caps.mjs',[capturePath,planPath,resultPath]);
 fs.writeFileSync(path.join(output,'completed.json'),JSON.stringify({completedAt:new Date().toISOString(),planSha256:expectedPlanHash,resultPath},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'completed',resultPath}));
}catch(error){
 fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({at:new Date().toISOString(),stage,planSha256:expectedPlanHash,status:'unavailable',message:'Capture, coverage, frozen-code, or replay check failed; inspect service journal.'},null,2)+'\n');
 throw error;
}
function run(script,args){
 const result=spawnSync(process.execPath,['--import','tsx',script,...args],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:25*60*1000,maxBuffer:5*1024*1024});
 fs.writeFileSync(path.join(output,stage+'.log'),result.stdout??'');
 if(result.status!==0){process.stderr.write(result.stderr??'');throw Error(`${stage} failed: ${result.signal??result.status}`);}
}
