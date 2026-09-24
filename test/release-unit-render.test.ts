import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
// @ts-expect-error Release tooling is a JavaScript module.
import { inventory, releaseId } from '../scripts/release-files.mjs';

it('renders loopback command API and supervised operation worker against one sealed release', () => {
 const temp=mkdtempSync(join(tmpdir(),'conc-liq-unit-render-'));
 const release=join(temp,'release'),output=join(temp,'rendered'),envFile=join(temp,'private-runtime.env');
 mkdirSync(release);writeFileSync(join(release,'sentinel'),'fixture');
 const manifest={format:1,sourceCommit:'unit-render-fixture',nodeVersion:process.version,files:inventory(release),buildId:''};
 manifest.buildId=releaseId(manifest);writeFileSync(join(release,'release.json'),JSON.stringify(manifest));
 try{
  const stdout=execFileSync(process.execPath,[resolve('scripts/render-release-units.mjs'),release,envFile,output],
   {cwd:process.cwd(),encoding:'utf8'});
  const report=JSON.parse(stdout) as {installed:boolean;rendered:string[];skipped:Record<string,string>};
  assert.equal(report.installed,false,'rendering must not install or start services');
  assert(report.rendered.includes('conc-liq-deployment-command.service'));
  assert(report.rendered.includes('conc-liq-paper-operation-worker.service'));
  assert.equal(report.skipped['conc-liq-deployment-command.service'],undefined);
  assert.equal(report.skipped['conc-liq-paper-operation-worker.service'],undefined);

  const command=readFileSync(join(output,'conc-liq-deployment-command.service'),'utf8');
  assert.match(command,/WorkingDirectory=.*\/release/);
  assert.match(command,/ExecStart=.*\/release\/bin\/node .*\/release\/launch\.mjs .*private-runtime\.env deployments$/m);
  assert.match(command,/Restart=on-failure/);
  assert.doesNotMatch(command,/npm run|\/root\/conc-liq\/\.tools\/node/);
  const worker=readFileSync(join(output,'conc-liq-paper-operation-worker.service'),'utf8');
  assert.match(worker,/Environment=DEPLOYMENT_PAPER_OPERATION_WORKER=1/);
  assert.match(worker,/ExecStart=.*\/release\/bin\/node .*\/release\/launch\.mjs .*private-runtime\.env deployments-paper-worker$/m);
  assert.match(worker,/Restart=on-failure/);
  assert.match(worker,/KillMode=control-group/);
  assert.doesNotMatch(worker,/npm run|\/root\/conc-liq\/\.tools\/node/);
 }finally{rmSync(temp,{recursive:true,force:true});}
});
