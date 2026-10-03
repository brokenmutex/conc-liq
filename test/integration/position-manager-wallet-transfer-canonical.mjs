// Actual chain reads, disposable PostgreSQL writes, no signer or publication.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import pg from 'pg';
import {getAddress} from 'viem';
import {createRobinhoodClient} from '../../src/client.ts';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {PostgresPositionManagerWalletTransferStore} from '../../src/nft/position-manager-wallet-transfer-store.ts';
import {scanPositionManagerWalletTransferHistory} from '../../src/nft/position-manager-transfer-index.ts';
import {readCompletePositionManagerNftCustody} from '../../src/deployments/live-transfer-nft-enumeration.ts';

const env=parseEnv(readFileSync(process.argv[2]??'.env','utf8'));
const testUrl=process.env.TEST_DATABASE_URL;
assert(testUrl,'TEST_DATABASE_URL must name a disposable PostgreSQL database');
assert(env.DATABASE_URL&&env.RH_ARCHIVE_RPC_URL,'Registry and archive read configuration is required');
const databaseIdentity=value=>{
 const url=new URL(value);
 return `${url.searchParams.get('host')??url.hostname}:${url.port||'5432'}${url.pathname}`;
};
assert.notEqual(databaseIdentity(testUrl),databaseIdentity(env.DATABASE_URL),'Use a separate test database');
const {Pool}=pg,root=new Pool({connectionString:testUrl,max:2});
const admin=await root.connect(),schema=`wallet_transfer_canonical_${randomUUID().replaceAll('-','')}`;
const wallet=getAddress('0xdb2430b4e9ac14be6554d3942822be74811a1af9');
let store,db,logQueries=0;
try{
 const registry=new Pool({connectionString:env.DATABASE_URL,max:1,options:'-c default_transaction_read_only=on'});
 let registeredProfiles;
 try{registeredProfiles=(await registry.query(`SELECT profile FROM deployment_market_profiles
  WHERE chain_id=4663 AND retired_at IS NULL`)).rows;}finally{await registry.end();}
 assert.equal(registeredProfiles.length,12,'Expected the current twelve registered profiles');
 const managers=[...new Set(registeredProfiles.map(row=>row.profile.pool.positionManager.toLowerCase()))];
 assert.equal(managers.length,1,'Canonical rehearsal requires one registered Position Manager');
 const manager=getAddress(managers[0]);
 const publicClient=createRobinhoodClient(env.RH_PUBLIC_RPC_URL??'https://rpc.mainnet.chain.robinhood.com',20_000,{retryCount:0});
 const archive=createRobinhoodClient(env.RH_ARCHIVE_RPC_URL,20_000,{retryCount:0});
 const [publicHead,archiveHead]=await Promise.all([publicClient.getBlockNumber(),archive.getBlockNumber()]);
 const sourceBlock=(publicHead<archiveHead?publicHead:archiveHead)-128n;
 assert(sourceBlock>=0n);
 const [publicSource,archiveSource]=await Promise.all([
  publicClient.getBlock({blockNumber:sourceBlock}),archive.getBlock({blockNumber:sourceBlock})]);
 assert.equal(publicSource.hash.toLowerCase(),archiveSource.hash.toLowerCase(),'Independent RPC source mismatch');
 assert.equal(publicSource.timestamp,archiveSource.timestamp);
 const source={block:sourceBlock,hash:publicSource.hash,timestamp:Number(publicSource.timestamp)};
 // Pace filtered history queries; retain the scanner's real header/code reads.
 const client={...publicClient,getLogs:async input=>{
  logQueries++;await new Promise(resolve=>setTimeout(resolve,1500));
  return publicClient.getLogs(input);
 }};
 await admin.query(`CREATE SCHEMA ${schema}`);
 await admin.query(`SET search_path=${schema}`);
 await migrateDatabase(admin);
 const scopedUrl=new URL(testUrl);scopedUrl.searchParams.set('options',`-c search_path=${schema}`);
 db=new Pool({connectionString:scopedUrl.toString(),max:2});
 store=new PostgresPositionManagerWalletTransferStore(scopedUrl.toString(),wallet);
 await store.assertReady();
 const scanned=await scanPositionManagerWalletTransferHistory({client,store,chainId:4663,manager,source,
  chunkBlocks:10_000_000n,maxBlocksPerRun:100_000_000n});
 assert.equal(scanned.status,'scanned',JSON.stringify(scanned,(_,value)=>typeof value==='bigint'?String(value):value));
 assert.equal(scanned.completeThroughSource,true);
 assert.equal(scanned.enumerationComplete,false,'Scanning alone cannot prove current custody');
 assert.equal(logQueries,2*Number(sourceBlock/10_000_000n+1n),'Coverage requires both filtered directions for every range');
 const cursorBefore=await store.getCursor(4663,manager,0n);
 assert.equal(cursorBefore.startBlock,0n);
 assert.equal(cursorBefore.coveredThroughBlock,sourceBlock);
 assert.equal(cursorBefore.coveredThroughHash.toLowerCase(),source.hash.toLowerCase());
 const transfersBefore=await store.loadTransfers(4663,manager,0n,sourceBlock,1_000_000);
 await store.close();store=null;
 store=new PostgresPositionManagerWalletTransferStore(scopedUrl.toString(),wallet);
 await store.assertReady();
 assert.deepEqual(await store.getCursor(4663,manager,0n),cursorBefore,'Fresh store lost durable cursor');
 assert.deepEqual(await store.loadTransfers(4663,manager,0n,sourceBlock,1_000_000),transfersBefore);
 const custody=await readCompletePositionManagerNftCustody({client,store,targetStrategyId:'rangekeeper_v1',
  operator:wallet,positionManager:manager,startBlock:0n,source});
 assert.equal(custody.status,'available',JSON.stringify(custody));
 assert.equal(custody.enumerationComplete,true);
 assert.deepEqual(custody.tokenIds,[],'Synthetic rehearsal wallet acquired unexpected upstream NFT custody');
 assert.equal(custody.actionAvailable,false,'Index rehearsal must not authorize an action');
 const globalCounts=(await db.query(`SELECT
  (SELECT count(*) FROM position_manager_transfer_cursors)::int AS cursors,
  (SELECT count(*) FROM position_manager_transfer_checkpoints)::int AS checkpoints,
  (SELECT count(*) FROM position_manager_transfers)::int AS transfers`)).rows[0];
 assert.deepEqual(globalCounts,{cursors:0,checkpoints:0,transfers:0},'Wallet scan contaminated global history');
 assert.equal((await publicClient.getBlock({blockNumber:sourceBlock})).hash.toLowerCase(),source.hash.toLowerCase());
 assert.equal((await archive.getBlock({blockNumber:sourceBlock})).hash.toLowerCase(),source.hash.toLowerCase());
 console.log(JSON.stringify({event:'wallet_transfer_canonical_persistence_verified',chainId:4663,wallet,manager,
  registeredProfiles:registeredProfiles.length,source:{block:String(sourceBlock),hash:source.hash,timestamp:source.timestamp},
  logQueries,chunks:scanned.chunks,transfers:transfersBefore.length,completeFromGenesis:true,
  durableAfterReopen:true,canonicalCustodyComplete:true,globalCounts,upstreamMutations:0}));
}catch(error){
 console.error(JSON.stringify({error:(error instanceof Error?error.stack:String(error))
  .replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,1500),logQueries}));
 process.exitCode=1;
}finally{
 await store?.close();await db?.end();
 await admin.query('SET search_path=public');await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 admin.release();await root.end();
}
