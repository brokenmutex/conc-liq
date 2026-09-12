import {readFileSync} from 'node:fs';
import {paperPolicySchema} from './paper/config.js';
import assert from 'node:assert/strict';
import pg from 'pg';
import {loadRuntimeIdentity} from './runtime/identity.js';
import {assertSchemaReady} from './storage/compatibility.js';
import {upgradePaperRuntime} from './paper/runtime-upgrade.js';
import {sanitizeRiskError} from './risk/evaluate.js';
async function main(){
 const [sessionFlag,id,buildFlag,fromBuild,policyFlag,policyFile]=process.argv.slice(2),runtime=loadRuntimeIdentity();
 assert(sessionFlag==='--session'&&id&&/^[1-9]\d*$/.test(id)&&buildFlag==='--from-build'&&fromBuild&&/^[a-f0-9]{64}$/.test(fromBuild)&&(process.argv.length===6||(process.argv.length===8&&policyFlag==='--policy'&&policyFile)),
  'Usage: paper-upgrade --session ID --from-build SHA256 [--policy FILE]');assert(runtime,'Use a verified sealed release');assert(process.env.DATABASE_URL);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),db=await pool.connect();
 try{await assertSchemaReady(db);console.log(JSON.stringify(await upgradePaperRuntime(db,process.env.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1',id,fromBuild,runtime,policyFile?paperPolicySchema.parse(JSON.parse(readFileSync(policyFile,'utf8'))):undefined)));}
 finally{db.release();await pool.end();}
}
main().catch(error=>{console.error(sanitizeRiskError(error));process.exitCode=1;});
