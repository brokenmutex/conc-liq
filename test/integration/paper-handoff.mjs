// Executes the real handoff script with isolated files and mocked DB/systemd.
// No production service or database is accessed by this regression.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {inventory,releaseId,hash} from '../../scripts/release-files.mjs';

const root=mkdtempSync(join(tmpdir(),'paper-handoff-'));
try {
  const release=join(root,'release');mkdirSync(join(release,'config'),{recursive:true});
  const policy={mode:'guarded',budgetQuote:'1000',reentry:{cooldownSeconds:600},referencePolicy:{maxGasPriceAgeSeconds:86400,usdgHeartbeatGraceSeconds:1800}};
  writeFileSync(join(release,'config/policy.json'),JSON.stringify(policy));
  const manifest={format:1,sourceCommit:'fixture',nodeVersion:process.version,files:inventory(release)};
  manifest.buildId=releaseId(manifest);writeFileSync(join(release,'release.json'),JSON.stringify(manifest));
  const envFile=join(root,'runtime.env');writeFileSync(envFile,'DATABASE_URL=postgresql://fixture.invalid/isolated\n');
  const oldUnit='old reviewed unit\n',newUnit=`ExecStart=${release}/bin/node ${release}/launch.mjs ${envFile} paper tick\n`;
  const plan={parentId:'53',parentPolicyHash:'old-policy',streamKey:'fixture',previousBuildId:'old',buildId:manifest.buildId,release,envFile,
    configHash:hash(JSON.stringify({DATABASE_URL:'postgresql://fixture.invalid/isolated'})),policyFile:'config/policy.json',
    unitPath:join(root,'installed.service'),preparedUnitPath:join(root,'new.service'),previousUnitPath:join(root,'old.service'),
    previousUnitSha256:hash(oldUnit),preparedUnitSha256:hash(newUnit),hookPath:join(root,'hook.conf'),
    parentEvidencePath:join(root,'parent.json'),resultPath:join(root,'result.json')};
  const parent={id:'53',policy_hash:'old-policy',policy:{...policy,referencePolicy:{maxGasPriceAgeSeconds:86400}},
    state:{status:'closed',action:'exit'},runtime_identity:{buildId:'old'}};
  const hooks=join(root,'hooks.mjs'),trace=join(root,'trace.json');
  writeFileSync(hooks,`
import {registerHooks} from 'node:module';import fs from 'node:fs';
const fixture=JSON.parse(fs.readFileSync(process.env.HANDOFF_TEST_FIXTURE,'utf8'));
let row=fixture.parent,timerStopped=false;const calls=[];
globalThis.__handoffDb=class {async connect(){} async end(){} async query(){return {rows:[row]}}};
globalThis.__handoffExec=(command,args)=>{
 calls.push([command,...args]);fs.writeFileSync(fixture.trace,JSON.stringify(calls));
 if(command==='/usr/bin/systemctl'){
  if(args[0]==='stop'&&args[1]==='conc-liq-paper.timer')timerStopped=true;
  if(args[0]==='show')return 'inactive\\n';
  if(args.includes('conc-liq-usdg-grace-activation.service')&&!timerStopped)throw Error('Handoff dispatched before timer stopped');
  return '';
 }
 if(command===fixture.plan.release+'/bin/node'){
  if(!timerStopped)throw Error('Automatic reentry can race activation');
  row={id:'54',policy_hash:'new-policy',policy:{...fixture.policy,budgetQuote:'987',reentry:{cooldownSeconds:600,previousSessionId:'53'}},
    state:{status:'waiting'},runtime_identity:{buildId:fixture.plan.buildId,configHash:fixture.plan.configHash}};
  return 'created linked session\\n';
 }
 throw Error('Unexpected process execution');
};
registerHooks({resolve(specifier,context,next){
 if(specifier==='pg')return {url:'handoff:pg',shortCircuit:true};
 if(specifier==='node:child_process')return {url:'handoff:exec',shortCircuit:true};
 return next(specifier,context);
},load(url,context,next){
 if(url==='handoff:pg')return {format:'module',source:'export default {Client:globalThis.__handoffDb};',shortCircuit:true};
 if(url==='handoff:exec')return {format:'module',source:'export const execFileSync=globalThis.__handoffExec;',shortCircuit:true};
 return next(url,context);
}});
`);
  const run=(mode,state='closed')=>{
    for(const [file,text] of [[plan.unitPath,oldUnit],[plan.previousUnitPath,oldUnit],[plan.preparedUnitPath,newUnit],[plan.hookPath,'callback']])writeFileSync(file,text);
    writeFileSync(join(root,'plan.json'),JSON.stringify(plan));writeFileSync(trace,'[]');
    const fixturePath=join(root,'fixture.json');writeFileSync(fixturePath,JSON.stringify({parent:{...parent,state:{...parent.state,status:state}},plan,policy,trace}));
    const result=spawnSync(process.execPath,['--import',hooks,resolve('scripts/activate-paper-release.mjs'),join(root,'plan.json'),...(mode?[mode]:[])],
      {encoding:'utf8',env:{...process.env,HANDOFF_TEST_FIXTURE:fixturePath}});
    assert.equal(result.status,0,result.stderr);return JSON.parse(readFileSync(trace,'utf8'));
  };
  assert.deepEqual(run('--arm','open'),[],'Open position must not affect systemd');
  const armed=run('--arm');
  assert.deepEqual(armed,[['/usr/bin/systemctl','stop','conc-liq-paper.timer'],['/usr/bin/systemctl','start','--no-block','conc-liq-usdg-grace-activation.service']]);
  assert.equal(readFileSync(plan.unitPath,'utf8'),oldUnit,'Arming must leave old invocation intact');
  const activated=run();
  assert.equal(activated[0][1],'stop','Timer must stop before release preparation');
  assert.equal(JSON.parse(readFileSync(plan.resultPath,'utf8')).sessionId,'54');
  assert.equal(JSON.parse(readFileSync(plan.resultPath,'utf8')).budgetQuote,'987');
  assert.equal(readFileSync(plan.unitPath,'utf8'),newUnit);
  console.log(JSON.stringify({passed:['open position unchanged','synchronous timer stop before dispatch','deferred release activation','ordinary linked-session start','appropriate worker installed'],scope:'isolated files with mocked DB and systemd'}));
} finally {rmSync(root,{recursive:true,force:true});}
