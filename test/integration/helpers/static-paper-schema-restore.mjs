// Disposable PostgreSQL backup/restore rehearsal for one completed canonical
// paper schema. The target is a random local database; public is never restored.
import assert from 'node:assert/strict';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {contentHash} from '../../../src/deployments/contracts.ts';

const run=promisify(execFile);
const fixtureSchema=/^(?:static_canonical|static_convert_browser|paper_close_convert_v3)_[a-f0-9]{32}$/;
const scopedIdentityTables=['deployment_market_profiles','deployment_campaigns','deployment_revisions',
 'deployment_previews','deployment_operations','deployment_operation_intents','deployment_wallet_reservations',
 'deployment_ledger','deployment_marks','deployment_calibration_profiles','deployment_paper_fee_evidence',
 'deployment_paper_accounting','deployment_paper_accounting_invalidations','indexer_pools'];
const appendOnlyTables=['deployment_revisions','deployment_previews','deployment_ledger','deployment_marks',
 'deployment_calibration_profiles','deployment_paper_fee_evidence','deployment_paper_accounting',
 'deployment_paper_accounting_invalidations'];

function localConnection(testDatabaseUrl){
 const url=new URL(testDatabaseUrl),socket=url.searchParams.get('host');
 if(!['localhost','127.0.0.1','[::1]','::1'].includes(url.hostname.toLowerCase())&&
  !(socket&&socket.startsWith('/')))throw Error('TEST_DATABASE_URL must point to local PostgreSQL');
 if(!socket?.startsWith('/'))throw Error('restore rehearsal requires a local PostgreSQL Unix socket');
 const env={};
 if(url.password)env.PGPASSWORD=decodeURIComponent(url.password);
 const sanitized=new URL(url);sanitized.password='';
 // Keep only connection options accepted for this isolated local rehearsal.
 for(const key of [...sanitized.searchParams.keys()])
  if(!['host','port','sslmode','application_name'].includes(key))sanitized.searchParams.delete(key);
 return {url,sanitized,env};
}

async function evidenceSnapshot(pool,schema){
 const rows=async query=>(await pool.query(query)).rows.map(row=>row.row),
  records=async (query,values)=>(await pool.query(query,values)).rows;
 const campaigns=await rows(`SELECT to_jsonb(c) AS row FROM ${schema}.deployment_campaigns c ORDER BY c.id`);
 assert(campaigns.length>0,'canonical fixture schema contains no deployment campaigns');
 assert(campaigns.every(row=>row.lifecycle==='closed'),
  'stop the canonical worker and close every fixture campaign before restore rehearsal');
 const campaignIds=campaigns.map(row=>row.id);
 const migrations=await rows(`SELECT to_jsonb(m) AS row FROM ${schema}.schema_migrations m ORDER BY version`),
  profiles=await rows(`SELECT to_jsonb(p) AS row FROM ${schema}.deployment_market_profiles p ORDER BY id`),
  pools=await rows(`SELECT to_jsonb(i) AS row FROM ${schema}.indexer_pools i ORDER BY stream_key,pool_address`),
  revisions=await rows(`SELECT to_jsonb(r) AS row FROM ${schema}.deployment_revisions r ORDER BY campaign_id,revision`),
  previews=await rows(`SELECT to_jsonb(p) AS row FROM ${schema}.deployment_previews p ORDER BY campaign_id,created_at,id`),
  operations=await rows(`SELECT to_jsonb(o) AS row FROM ${schema}.deployment_operations o ORDER BY campaign_id,created_at,id`),
  intents=await rows(`SELECT to_jsonb(i) AS row FROM ${schema}.deployment_operation_intents i ORDER BY operation_id,stage`),
  reservations=await rows(`SELECT to_jsonb(w) AS row FROM ${schema}.deployment_wallet_reservations w ORDER BY campaign_id`),
  marks=await rows(`SELECT to_jsonb(m) AS row FROM ${schema}.deployment_marks m ORDER BY campaign_id,id`),
  ledger=await rows(`SELECT to_jsonb(l) AS row FROM ${schema}.deployment_ledger l ORDER BY campaign_id,id`),
  calibrations=await rows(`SELECT to_jsonb(p) AS row FROM ${schema}.deployment_calibration_profiles p ORDER BY id`),
  accounting=await rows(`SELECT to_jsonb(a) AS row FROM ${schema}.deployment_paper_accounting a ORDER BY campaign_id,id`),
  feeEvidence=await rows(`SELECT to_jsonb(f) AS row FROM ${schema}.deployment_paper_fee_evidence f ORDER BY campaign_id,id`),
  invalidations=await rows(`SELECT to_jsonb(i) AS row FROM ${schema}.deployment_paper_accounting_invalidations i ORDER BY campaign_id,id`),
  triggers=await records(`SELECT c.relname AS table_name,t.tgname,t.tgenabled FROM pg_trigger t
   JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
   [schema,appendOnlyTables]),
  sequences=await records(`SELECT schemaname,sequencename,start_value,min_value,max_value,increment_by,cycle,last_value
   FROM pg_sequences WHERE schemaname=$1 AND sequencename LIKE 'deployment_%' ORDER BY sequencename`,[schema]),
  constraints=await records(`SELECT c.relname AS table_name,k.conname,k.contype,pg_get_constraintdef(k.oid) AS definition
   FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,k.conname`,
   [schema,scopedIdentityTables]),
  indexes=await records(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='${schema}'
   AND tablename=ANY($1::text[]) ORDER BY tablename,indexname`,[scopedIdentityTables]);
 const result={migrations,campaigns,profiles,pools,revisions,previews,operations,intents,reservations,
  marks,ledger,calibrations,accounting,feeEvidence,invalidations,triggers,sequences,constraints,indexes};
 assert(result.marks.length>0,'canonical fixture has no economic marks');
 assert(result.operations.some(row=>campaignIds.includes(row.campaign_id)&&
  ['close_retain','close_convert'].includes(row.kind)&&row.status==='succeeded'),
  'fixture has no completed static paper economic exit');
 return result;
}

async function assertAppendOnly(pool,schema,snapshot){
 const client=await pool.connect();
 const mutationRejected=[],emptyTablesSkipped=[];
 try{
  const guards=[
   {table:'deployment_revisions',key:['campaign_id','revision'],rows:snapshot.revisions,set:'config=config'},
   {table:'deployment_previews',key:['id'],rows:snapshot.previews,set:'request=request'},
   {table:'deployment_ledger',key:['id'],rows:snapshot.ledger,set:'source=source'},
   {table:'deployment_marks',key:['id'],rows:snapshot.marks,set:'inventory=inventory'},
   {table:'deployment_calibration_profiles',key:['id'],rows:snapshot.calibrations,set:'model=model'},
   {table:'deployment_paper_fee_evidence',key:['id'],rows:snapshot.feeEvidence,set:'proof=proof'},
   {table:'deployment_paper_accounting',key:['id'],rows:snapshot.accounting,set:'snapshot=snapshot'},
   {table:'deployment_paper_accounting_invalidations',key:['id'],rows:snapshot.invalidations,set:'evidence=evidence'},
  ];
  const guardedTables=new Set(snapshot.triggers.filter(trigger=>trigger.tgname.endsWith('_append_only')&&
   trigger.tgenabled==='O').map(trigger=>trigger.table_name));
  assert(appendOnlyTables.every(table=>guardedTables.has(table)),
   'all eight restored evidence tables must retain enabled append-only triggers');
  await client.query('BEGIN');
  for(const guard of guards){
   const {table,rows:tableRows}=guard,row=tableRows[0];
   if(!row){emptyTablesSkipped.push(table);continue;}
   const where=guard.key.map((column,index)=>`${column}=$${index+1}`).join(' AND '),
    values=guard.key.map(column=>row[column]);
   await client.query('SAVEPOINT evidence_update_guard');
   await assert.rejects(client.query(`UPDATE ${schema}.${table} SET ${guard.set} WHERE ${where}`,values),
    /append.only/i,`${table} update guard`);
   await client.query('ROLLBACK TO SAVEPOINT evidence_update_guard');
   await client.query('RELEASE SAVEPOINT evidence_update_guard');
   await client.query('SAVEPOINT evidence_delete_guard');
   await assert.rejects(client.query(`DELETE FROM ${schema}.${table} WHERE ${where}`,values),
    /append.only/i,`${table} delete guard`);
   await client.query('ROLLBACK TO SAVEPOINT evidence_delete_guard');
   await client.query('RELEASE SAVEPOINT evidence_delete_guard');
   mutationRejected.push(table);
  }
  return {enabledTriggers:snapshot.triggers.filter(trigger=>trigger.tgname.endsWith('_append_only')&&
   trigger.tgenabled==='O').map(trigger=>`${trigger.table_name}.${trigger.tgname}`),mutationRejected,
   testedTableCount:mutationRejected.length,emptyTablesSkipped};
 }finally{
  try{await client.query('ROLLBACK');}catch{}
  client.release();
 }
}

/** Dump one completed disposable canonical schema, restore to a fresh local
 * database, and compare all campaign/economic identities. The source schema
 * is read-only to this helper and remains available to its caller. */
export async function rehearseStaticPaperSchemaRestore({testDatabaseUrl,
 sourceSchema,timeoutMs=120_000}){
 if(!fixtureSchema.test(sourceSchema??''))
  throw Error('restore rehearsal requires a recognized, randomly named paper fixture schema');
 const {url,sanitized,env:passwordEnv}=localConnection(testDatabaseUrl);
 const dbName=`conc_liq_restore_${randomUUID().replaceAll('-','')}`;
 const owner=decodeURIComponent(url.username),socket=url.searchParams.get('host');
 if(!/^[a-zA-Z_][a-zA-Z0-9_$-]{0,62}$/.test(owner))
  throw Error('local test database role name is not safe for isolated restore');
 const basePool=new pg.Pool({connectionString:testDatabaseUrl,max:2});
 const targetUrl=new URL(sanitized);targetUrl.pathname=`/${dbName}`;
 const targetPoolConfig=targetUrl.toString();
 const temp=await mkdtemp(join(tmpdir(),'conc-liq-static-paper-restore-'));
 try{await chmod(temp,0o700);}catch(error){await rm(temp,{recursive:true,force:true});throw error;}
 const archive=join(temp,'canonical.dump');
 let targetPool,sourceClient,created=false;
 const pgEnv={PATH:process.env.PATH??'/usr/bin:/bin',HOME:process.env.HOME??'/root',
  ...passwordEnv};
 const options={timeout:timeoutMs,maxBuffer:8*1024*1024,env:pgEnv};
 try{
  sourceClient=await basePool.connect();
  await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshotId=(await sourceClient.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
  const before=await evidenceSnapshot(sourceClient,sourceSchema);
  // Root's test role does not have CREATEDB. Use the local postgres OS account
  // for this random isolated target without changing role grants.
  await run('sudo',['-n','-u','postgres','createdb',`--host=${socket}`,
   `--port=${url.port||'5432'}`,`--owner=${owner}`,dbName],options);
  created=true;
  await run('pg_dump',['--format=custom','--no-owner','--no-privileges',
   '--schema',sourceSchema,'--snapshot',snapshotId,'--file',archive,sanitized.toString()],options);
  await sourceClient.query('COMMIT');sourceClient.release();sourceClient=null;
  await run('pg_restore',['--exit-on-error','--no-owner','--no-privileges',
   '--dbname',targetPoolConfig,archive],options);
  targetPool=new pg.Pool({connectionString:targetPoolConfig,max:2});
  const after=await evidenceSnapshot(targetPool,sourceSchema);
  const sections=Object.keys(before),mismatches=sections.filter(key=>
   contentHash(after[key])!==contentHash(before[key]));
  const constraintDetails=mismatches.includes('constraints')?(()=>{
   const key=row=>`${row.table_name}.${row.conname}`,
    source=new Map(before.constraints.map(row=>[key(row),row.definition])),
    restored=new Map(after.constraints.map(row=>[key(row),row.definition]));
   return [...new Set([...source.keys(),...restored.keys()])].filter(name=>source.get(name)!==restored.get(name))
    .slice(0,12).map(name=>({name,source:source.get(name)??null,restored:restored.get(name)??null}));
  })():undefined;
  assert.deepEqual(mismatches,[],
   `restored evidence identity sections changed: ${JSON.stringify(Object.fromEntries(mismatches.map(key=>
    [key,{source:contentHash(before[key]),restored:contentHash(after[key])}])))}`+
    (constraintDetails?` constraints=${JSON.stringify(constraintDetails)}`:''));
  const publicObjects=await targetPool.query(`SELECT count(*)::int AS count FROM pg_class c
   JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
   AND c.relkind IN ('r','p','v','m','S','f')`);
  assert.equal(publicObjects.rows[0].count,0,'restore must not add objects to public');
  const appendOnly=await assertAppendOnly(targetPool,sourceSchema,after);
  const sourceAfter=await evidenceSnapshot(basePool,sourceSchema);
  assert.equal(contentHash(sourceAfter),contentHash(before),
   'backup/restore must preserve the original canonical fixture schema');
  return {status:'passed',sourceSchema,
   evidenceClass:sourceSchema.startsWith('paper_close_convert_v3_')?
    'synthetic_injected_verifier_database_mechanics':'canonical_process_fixture',targetDatabase:dbName,
   campaigns:after.campaigns.length,operations:after.operations.length,marks:after.marks.length,
   ledgerRows:after.ledger.length,accountingRows:after.accounting.length,
   modelIdentityRows:after.calibrations.length+after.accounting.length,
   operationIntentRows:after.intents.length,sequenceCount:after.sequences.length,
   constraintCount:after.constraints.length,indexCount:after.indexes.length,
   evidenceHash:contentHash(after),appendOnly,publicObjects:0,
   sourcePreserved:true,targetDatabaseRemoved:true,temporaryArchiveRemoved:true};
 }finally{
  try{
   await targetPool?.end();
  }finally{try{
   if(created){
    try{await basePool.query(`DROP DATABASE IF EXISTS "${dbName}"`);}
    catch{await run('sudo',['-n','-u','postgres','dropdb',`--host=${socket}`,
     `--port=${url.port||'5432'}`,'--force','--if-exists',dbName],options);}
   }
  }finally{
   if(sourceClient){try{await sourceClient.query('ROLLBACK');}catch{}sourceClient.release();}
   await basePool.end();await rm(temp,{recursive:true,force:true});
  }}
 }
}
