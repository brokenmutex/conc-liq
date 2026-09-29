// Real repository projection over an isolated schema. Retained live ledgers,
// if present in this database, are read only; all fixture writes stay scoped.
// Run: TEST_DATABASE_URL=... node --import tsx test/integration/dashboard-risk.mjs
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DashboardRepository} from '../../src/dashboard/repository.ts';
import {loadDashboardConfig} from '../../src/dashboard/config.ts';
import {DEFAULT_RWA_SYMBOLS} from '../../src/constants.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL is required');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
const admin=await pool.connect(),schema=`dashboard_risk_${randomUUID().replaceAll('-','')}`;
let repository;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);
 await admin.query(`SET search_path=${schema}`);
 await migrateDatabase(admin);
 const url=new URL(process.env.TEST_DATABASE_URL);
 url.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 repository=new DashboardRepository(loadDashboardConfig({DATABASE_URL:url.toString(),
  INDEXER_STREAM_KEY:'risk-projection-fixture',ADAPTIVE_PAPER_STATE_PATH:'/nonexistent/risk-fixture.json',
  RISK_GATE_MAX_SNAPSHOT_AGE_SECONDS:'75'}));
 const empty=await repository.positions();
 assert.deepEqual(empty.riskAssets.map(row=>row.rwaSymbol).sort(),[...DEFAULT_RWA_SYMBOLS].sort());
 assert(empty.riskAssets.every(row=>row.snapshotAt===null&&row.executionEligible===false&&
  row.reasons.includes('risk_snapshot_missing_asset')));
 assert.equal(empty.riskFreshnessSeconds,75);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_campaigns')).rows[0].n,0);

 const saveRun=async(at,eligible,assets)=>{
  const run=(await admin.query(`INSERT INTO risk_snapshot_runs
   (schema_version,chain_id,block_number,block_hash,block_timestamp,observed_at,
    registry_fetched_at,registry_sha256,feed_directory_fetched_at,feed_directory_sha256,
    sequencer_status,execution_eligible,reasons,snapshot)
   VALUES(1,4663,100,$1,$2,$2,$2,$1,$2,$1,'unavailable',$3,'[]','{}') RETURNING id`,
   ['0x'+'a'.repeat(64),at,eligible])).rows[0].id;
  for(const asset of assets)await admin.query(`INSERT INTO asset_risk_snapshots
   (run_id,symbol,token_address,oracle_address,execution_eligible,reasons,snapshot)
   VALUES($1,$2,$3,NULL,$4,$5,$6)`,[run,asset.symbol,'0x'+'b'.repeat(40),eligible,
   JSON.stringify(asset.reasons??[]),JSON.stringify(asset.snapshot??{})]);
 };
 const stale=new Date(Date.now()-3600_000).toISOString();
 await saveRun(stale,true,[{symbol:'NVDA'}]);
 const captured=new Date().toISOString();
 const reasons=['sequencer_feed_unavailable','oracle_price_stale'];
 await saveRun(captured,false,[{symbol:'AAPL',reasons,snapshot:{
  flags:{corporateActionPending:true,tradingCapabilitiesTradable:false,multiplierConsistent:true},
  onchain:{oraclePaused:true},oracle:{priceAgeSeconds:'617',feed:{marketHours:'regular'}}}},
 {symbol:'GLD',reasons:['quote_oracle_unavailable']},{symbol:'TEST',reasons:['test_asset_blocked']}]);
 const current=await repository.positions();
 assert.equal(current.riskAssets.find(row=>row.rwaSymbol==='NVDA').snapshotAt,null,
  'missing assets in the newest run must not use an older eligible snapshot');
 assert(current.riskAssets.some(row=>row.rwaSymbol==='TEST'),
  'assets present in the latest run must not be silently dropped');
 const aapl=current.riskAssets.find(row=>row.rwaSymbol==='AAPL'),
  gld=current.riskAssets.find(row=>row.rwaSymbol==='GLD');
 assert.equal(aapl.snapshotAt,captured);
 assert.equal(aapl.executionEligible,false);
 assert.deepEqual(aapl.reasons,reasons);
 assert.equal(aapl.corporateActionPending,true);
 assert.equal(aapl.tradingTradable,false);
 assert.equal(aapl.oraclePaused,true);
 assert.equal(aapl.oracleAgeSeconds,'617');
 assert.equal(aapl.marketHours,'regular');
 assert.equal(gld.oracleAgeSeconds,null);
 assert.equal(gld.oraclePaused,null);
 assert.equal(gld.marketHours,null);
 assert.equal(gld.tradingTradable,null);
 assert.equal(gld.corporateActionPending,null);
 await saveRun(stale,true,[{symbol:'AAPL'}]);
 const aged=await repository.positions();
 assert.equal(aged.riskAssets.find(row=>row.rwaSymbol==='AAPL').snapshotAt,stale,
  'serving an old snapshot must preserve its timestamp, not stamp it fresh');
 assert.equal(aged.riskFreshnessSeconds,75);
 console.log(JSON.stringify({status:'passed',cases:['missing snapshot','configured freshness',
  'latest run only','blocked asset flags and reasons','missing feed stays null','stale timestamp retained']}));
}finally{
 await repository?.close();
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 admin.release();await pool.end();
}
