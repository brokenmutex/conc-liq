import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {marketProfileSchema,referenceProofHash} from '../../src/deployments/market-profile.ts';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY,USDG} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {PostgresResearchCandidateStore} from '../../src/research/postgres-candidate-store.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('Set TEST_DATABASE_URL to a database where isolated schemas may be created');
const adminPool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
const admin=await adminPool.connect(),schema=`research_candidate_${randomUUID().replaceAll('-','')}`;
let reader;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);
 await admin.query(`SET search_path=${schema}`);
 assert.deepEqual(await migrateDatabase(admin),[1,2,3,4,5,6,7,8]);
 const url=new URL(process.env.TEST_DATABASE_URL);
 url.searchParams.set('options',`-c search_path=${schema}`);
 reader=new PostgresResearchCandidateStore(url.toString());
 const poolAddress=`0x${'a'.repeat(40)}`,token0=`0x${'1'.repeat(40)}`;
 const codeHash=`0x${'b'.repeat(64)}`,targetSetHash=`0x${'c'.repeat(64)}`;
 const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,pool:poolAddress,
  token0,token1:USDG,quoteToken:1,decimals0:18,decimals1:6,fee:3000,tickSpacing:60,
  positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
  poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
  managerCodeHash:codeHash,quoterCodeHash:codeHash,reference0:'BASE/USD',reference1:'USDG/USD',
  nativeReference:'ETH/USD',numeraire:'USD'},
  referencePolicy:{token0:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
   token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
   nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
 const proof={fixture:true},source={block:'100',hash:`0x${'d'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)};
 const references={price0:'1000000000000000000',price1:'1000000000000000000',nativePrice:'2000000000000000000000',
  proofHash:referenceProofHash(proof)};
 const contractHashes={poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
  managerCodeHash:codeHash,quoterCodeHash:codeHash};
 const profileHash=contentHash(profile),id=randomUUID();
 const evidence={verificationClass:'canonical_chain_and_independent_reference_v1',source,streamKey:'test-stream',
  indexerTargetSetHash:targetSetHash,contractHashes,references,referenceProof:proof};
 await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
  created_block,target_set_hash,enabled) VALUES('test-stream',$1,4663,'BASE',$2,3000,1,$3,true)`,
  [poolAddress,token0,targetSetHash]);
 await admin.query(`INSERT INTO deployment_market_profiles
  (id,chain_id,pool_address,token0_address,token1_address,token0_decimals,token1_decimals,quote_token,fee,
   tick_spacing,profile,evidence,profile_hash,verified_at)
  VALUES($1,4663,$2,$3,$4,18,6,1,3000,60,$5,$6,$7,clock_timestamp())`,
  [id,poolAddress,token0,USDG,JSON.stringify(profile),JSON.stringify(evidence),profileHash]);

 const page=await reader.listCurrentProfiles();
 assert.equal(page.hasMore,false);assert.equal(page.profiles.length,1);
 assert.equal(page.profiles[0].id,id);assert.equal(page.profiles[0].draftAvailable,true);
 const loaded=await reader.loadCurrentProfile(id);
 assert.equal(loaded?.registryEnabled,true);assert.equal(loaded?.profileHash,profileHash);

 await admin.query(`UPDATE deployment_market_profiles SET token0_decimals=19 WHERE id=$1`,[id]);
 assert.deepEqual((await reader.listCurrentProfiles()).profiles,[]);
 assert.equal(await reader.loadCurrentProfile(id),null);
 await admin.query(`UPDATE deployment_market_profiles SET token0_decimals=18 WHERE id=$1`,[id]);

 await admin.query(`UPDATE indexer_pools SET target_set_hash=$1 WHERE stream_key='test-stream' AND pool_address=$2`,
  [`0x${'e'.repeat(64)}`,poolAddress]);
 assert.deepEqual((await reader.listCurrentProfiles()).profiles,[]);
 assert.equal(await reader.loadCurrentProfile(id),null);

 await admin.query(`UPDATE indexer_pools SET target_set_hash=$1,enabled=false
  WHERE stream_key='test-stream' AND pool_address=$2`,[targetSetHash,poolAddress]);
 assert.deepEqual((await reader.listCurrentProfiles()).profiles,[]);
 assert.equal(await reader.loadCurrentProfile(id),null);

 await admin.query(`UPDATE indexer_pools SET enabled=true WHERE stream_key='test-stream' AND pool_address=$1`,[poolAddress]);
 await admin.query(`UPDATE deployment_market_profiles SET profile_hash=$1 WHERE id=$2`,['f'.repeat(64),id]);
 assert.deepEqual((await reader.listCurrentProfiles()).profiles,[]);
 assert.equal(await reader.loadCurrentProfile(id),null);
 console.log('Research candidate profile registry/hash integration checks passed');
}finally{
 if(reader)await reader.close();
 await admin.query('RESET search_path').catch(()=>{});
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});
 admin.release();await adminPool.end();
}
