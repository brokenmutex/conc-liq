// Read-only deployment preflight: a dashboard must understand both persisted
// paper policies and any new policy before the worker begins writing it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import pg from 'pg';
import {verifyRelease} from './release-files.mjs';

const [releasePath,envPath,candidatePath]=process.argv.slice(2);
assert(releasePath&&envPath,'Usage: node scripts/check-dashboard-release.mjs RELEASE ENV [CANDIDATE_POLICY]');
const release=path.resolve(releasePath),manifest=verifyRelease(release);
const env=parseEnv(fs.readFileSync(envPath,'utf8'));
const module=relative=>import(pathToFileURL(path.join(release,'dist/src',relative)).href);
const {paperPolicySchema}=await module('paper/config.js');
const {loadDashboardConfig}=await module('dashboard/config.js');
const {DashboardRepository}=await module('dashboard/repository.js');
const config=loadDashboardConfig(env),db=new pg.Client({connectionString:env.DATABASE_URL,options:'-c default_transaction_read_only=on -c statement_timeout=15000'});
const repository=new DashboardRepository(config);
try {
 await db.connect();
 const rows=(await db.query('SELECT id::text,policy FROM paper_sessions WHERE stream_key=$1 ORDER BY id',[config.streamKey])).rows;
 const policies=[...rows,...(candidatePath?[{id:'candidate',policy:JSON.parse(fs.readFileSync(candidatePath,'utf8'))}]:[])];
 const incompatible=policies.filter(row=>!paperPolicySchema.safeParse(row.policy).success).map(row=>row.id);
 if(incompatible.length){console.log(JSON.stringify({status:'incompatible',buildId:manifest.buildId,sessions:incompatible}));process.exitCode=1;}
 else {
  await repository.assertReady();const snapshot=await repository.snapshot();
  console.log(JSON.stringify({status:'compatible',checkedAt:new Date().toISOString(),buildId:manifest.buildId,
   persistedPolicies:rows.length,candidateChecked:!!candidatePath,snapshotAvailable:!!snapshot.paper}));
 }
}finally{await db.end();await repository.close();}
