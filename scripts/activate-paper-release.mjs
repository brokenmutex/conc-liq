// One reviewed release handoff after a specified session's normal cash exit.
// Invoked by a separate oneshot service from the paper worker's ExecStartPost.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { hash, verifyRelease } from './release-files.mjs';

const [planPath, mode] = process.argv.slice(2);
assert(planPath?.startsWith('/') && (!mode || ['--check','--arm'].includes(mode)), 'Usage: activate-paper-release.mjs /absolute/plan.json [--check|--arm]');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const env = parseEnv(readFileSync(plan.envFile, 'utf8'));
const db = new pg.Client({connectionString:env.DATABASE_URL,
  options:'-c default_transaction_read_only=on -c statement_timeout=10000'});
const systemctl = (...args) => execFileSync('/usr/bin/systemctl', args, {encoding:'utf8',timeout:30000});
const latest = async () => (await db.query('SELECT * FROM paper_sessions WHERE stream_key=$1 ORDER BY id DESC LIMIT 1', [plan.streamKey])).rows[0];
const install = text => {
  const temp = `${plan.unitPath}.handoff`;
  writeFileSync(temp,text,{mode:0o644});renameSync(temp,plan.unitPath);systemctl('daemon-reload');
};
const finish = row => {
  if (existsSync(plan.hookPath)) unlinkSync(plan.hookPath);
  systemctl('daemon-reload');systemctl('start','conc-liq-paper.timer');
  writeFileSync(plan.resultPath,JSON.stringify({activatedAt:new Date().toISOString(),parentId:plan.parentId,
    sessionId:row.id,policy:row.policy,policyHash:row.policy_hash,runtimeIdentity:row.runtime_identity,
    budgetQuote:row.policy.budgetQuote,release:plan.release,executionEligible:false},null,2)+'\n');
  console.log(JSON.stringify({status:'activated',sessionId:row.id,buildId:plan.buildId}));
};
await db.connect();
let paused = false;
try {
  const row = await latest();
  assert(row, 'Paper stream has no session');
  const alreadyStarted = row.runtime_identity?.buildId === plan.buildId;
  if (!alreadyStarted) {
    assert.equal(row.id,plan.parentId,'Paper session advanced outside this handoff');
    assert.equal(row.policy_hash,plan.parentPolicyHash,'Parent policy changed');
    assert.equal(row.runtime_identity?.buildId,plan.previousBuildId,'Parent runtime changed');
    if (row.state.status !== 'closed' && mode !== '--check') {
      assert(row.state.status !== 'invalid','Invalid paper session cannot be handed off');
      console.log(JSON.stringify({status:'waiting_for_cash_exit',sessionId:row.id,positionStatus:row.state.status}));
      process.exitCode=0;
    } else {
      assert(!row.state.reentryStoppedAt,'Manual stop cancels automatic handoff');
    }
  }
  if (!alreadyStarted && row.state.status !== 'closed' && mode !== '--check') {
    // Leave the existing timer, worker and open position untouched.
  } else if (mode === '--arm') {
    // This runs synchronously inside the old worker's ExecStartPost. Stop its
    // timer before returning, so no automatic successor can start while the
    // separate activation service verifies the release and waits for us to end.
    systemctl('stop','conc-liq-paper.timer');
    try { systemctl('start','--no-block','conc-liq-usdg-grace-activation.service'); }
    catch(error) { systemctl('start','conc-liq-paper.timer');throw error; }
    console.log(JSON.stringify({status:'cash_exit_handoff_armed',sessionId:row.id}));
  } else {
    if (mode !== '--check') { systemctl('stop','conc-liq-paper.timer');paused=true; }
    const release = verifyRelease(plan.release);
    assert.equal(release.buildId,plan.buildId);
    const policy = JSON.parse(readFileSync(join(plan.release,plan.policyFile),'utf8'));
    const configHash = hash(JSON.stringify(Object.fromEntries(Object.entries(env).sort(([a],[b])=>a.localeCompare(b,'en')))));
    assert.equal(configHash,plan.configHash,'Runtime configuration changed');
    const normalize = value => {
      const p=structuredClone(value);delete p.budgetQuote;delete p.reentry.previousSessionId;
      delete p.referencePolicy.usdgHeartbeatGraceSeconds;return p;
    };
    assert.deepEqual(normalize(row.policy),normalize(policy),'Unexpected policy change');
    assert.equal(policy.referencePolicy.usdgHeartbeatGraceSeconds,1800);
    const currentUnit=readFileSync(plan.unitPath,'utf8');
    const nextUnit=readFileSync(plan.preparedUnitPath,'utf8');
    assert.equal(hash(nextUnit),plan.preparedUnitSha256,'Prepared unit changed');
    assert([plan.previousUnitSha256,plan.preparedUnitSha256].includes(hash(currentUnit)),'Installed unit changed');
    assert(nextUnit.includes(`${plan.release}/launch.mjs ${plan.envFile} paper tick`));
    if (mode === '--check') {
      console.log(JSON.stringify({status:'plan_verified',sessionId:row.id,positionStatus:row.state.status,buildId:plan.buildId}));
    } else {
      // The old worker must finish before its unit or immutable runtime changes.
      const deadline=Date.now()+30000;
      while (!['inactive','failed'].includes(systemctl('show','conc-liq-paper.service','--property=ActiveState','--value').trim())) {
        assert(Date.now()<deadline,'Paper worker did not become idle');
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      const parent=await latest();
      if (parent.runtime_identity?.buildId !== plan.buildId) {
        assert.equal(parent.id,plan.parentId);
        assert.equal(parent.state.status,'closed');assert.equal(parent.state.action,'exit');
        assert(!parent.state.reentryStoppedAt);
        writeFileSync(plan.parentEvidencePath,JSON.stringify(parent,null,2)+'\n');
        install(nextUnit);
        // The ordinary start command validates canonical ancestry and carries
        // reconciled net cash. It performs no quote, entry or exit simulation.
        const output=execFileSync(join(plan.release,'bin/node'),[join(plan.release,'launch.mjs'),plan.envFile,
          'paper','start','--policy',plan.policyFile,'--after',parent.id],{encoding:'utf8',timeout:45000});
        process.stdout.write(output);
      }
      const child=await latest();
      assert.equal(child.runtime_identity?.buildId,plan.buildId);
      assert.equal(child.runtime_identity?.configHash,plan.configHash);
      assert.equal(child.policy.reentry.previousSessionId,plan.parentId);
      assert.equal(child.policy.referencePolicy.usdgHeartbeatGraceSeconds,1800);
      install(nextUnit);finish(child);paused=false;
    }
  }
} catch (error) {
  if (paused) {
    const row=await latest();
    // Never run the old binary against a successfully created new session.
    install(readFileSync(row?.runtime_identity?.buildId===plan.buildId ? plan.preparedUnitPath : plan.previousUnitPath,'utf8'));
    systemctl('start','conc-liq-paper.timer');
  }
  throw error;
} finally { await db.end(); }
