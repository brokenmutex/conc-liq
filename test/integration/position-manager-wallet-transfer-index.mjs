import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {getAddress} from 'viem';
import {migrateDatabase,MIGRATIONS} from '../../src/storage/migrations.ts';
import {MIGRATION_CHECKSUMS} from '../../src/storage/migration-checksums.ts';
import {PostgresPositionManagerTransferStore,scanPositionManagerTransferHistory,scanPositionManagerWalletTransferHistory} from '../../src/nft/position-manager-transfer-index.ts';
import {PostgresPositionManagerWalletTransferStore} from '../../src/nft/position-manager-wallet-transfer-store.ts';
import {readCompletePositionManagerNftCustody} from '../../src/deployments/live-transfer-nft-enumeration.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('Set TEST_DATABASE_URL to an explicitly disposable database');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8}),admin=await pool.connect();
const schema=`pm_wallet_${randomUUID().replaceAll('-','')}`,upgradeSchema=`pm_wallet_v13_${randomUUID().replaceAll('-','')}`;
let globalStore,aStore,bStore,cStore,upgradeGlobal,upgradeWallet;
const manager='0x1111111111111111111111111111111111111111',walletA='0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 walletB='0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',walletC='0xcccccccccccccccccccccccccccccccccccccccc',other='0xdddddddddddddddddddddddddddddddddddddddd';
const hash=(n,epoch=0)=>`0x${(BigInt(n)+1000n+(epoch?100_000n:0n)).toString(16).padStart(64,'0')}`;
const block=(n,epoch=0)=>({number:BigInt(n),hash:hash(n,epoch),parentHash:hash(Math.max(0,n-1),epoch),timestamp:1_800_000_000n+BigInt(n)});
const checkpoint=(n,epoch=0)=>({number:BigInt(n),hash:hash(n,epoch),parentHash:hash(Math.max(0,n-1),epoch),timestamp:1_800_000_000+n});
const makeLog=(n,logIndex,from,to,tokenId,epoch=0)=>({address:manager,eventName:'Transfer',blockNumber:BigInt(n),
 blockHash:hash(n,epoch),transactionHash:hash(10_000+n*10+logIndex,epoch),transactionIndex:0,logIndex,
 args:{from:getAddress(from),to:getAddress(to),tokenId:BigInt(tokenId)}});
const logs=[makeLog(1,0,'0x0000000000000000000000000000000000000000',walletA,1),
 makeLog(2,0,walletA,walletA,1),makeLog(3,0,walletA,walletB,1),
 makeLog(4,0,'0x0000000000000000000000000000000000000000',walletB,2),makeLog(5,0,walletB,walletA,2)];
function chain({epoch=0,conflictDuplicate=false,latest=69}={}){
 return {getChainId:async()=>4663,getBlock:async(args={})=>block(Number(args.blockNumber??latest),epoch),
  getBytecode:async()=> '0x6000',getLogs:async args=>{
   const inRange=logs.filter(row=>row.blockNumber>=args.fromBlock&&row.blockNumber<=args.toBlock)
    .filter(row=>!args.args?.from||row.args.from.toLowerCase()===args.args.from.toLowerCase())
    .filter(row=>!args.args?.to||row.args.to.toLowerCase()===args.args.to.toLowerCase());
   const result=inRange.map(row=>({...row,blockHash:hash(Number(row.blockNumber),epoch),transactionHash:hash(10_000+Number(row.blockNumber)*10+row.logIndex,epoch)}));
   if(conflictDuplicate&&args.args?.from?.toLowerCase()===walletA&&args.fromBlock<=2n&&args.toBlock>=2n){
    const self=result.find(row=>row.blockNumber===2n);if(self)result.push({...self,args:{...self.args,tokenId:99n}});
   }
   return result;
  },readContract:async args=>args.functionName==='balanceOf'?1n:({1n:walletB,2n:walletA})[args.args[0]]};
}
const source={block:5n,hash:hash(5),timestamp:Number(block(5).timestamp)};
const scopedUrl=(name=schema)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${name}`);return url.toString();};
try{
 await admin.query(`CREATE SCHEMA "${schema}"`);await admin.query(`SET search_path="${schema}"`);
 await migrateDatabase(admin);
 const connection=scopedUrl();globalStore=new PostgresPositionManagerTransferStore(connection);
 aStore=new PostgresPositionManagerWalletTransferStore(connection,walletA);
 bStore=new PostgresPositionManagerWalletTransferStore(connection,walletB);
 cStore=new PostgresPositionManagerWalletTransferStore(connection,walletC);
 await Promise.all([aStore.assertReady(),bStore.assertReady(),cStore.assertReady()]);
 const walletScopeDescriptor=Object.getOwnPropertyDescriptor(aStore,'walletScope');
 assert(walletScopeDescriptor&&!walletScopeDescriptor.writable&&!walletScopeDescriptor.configurable,
  'Wallet scope must be immutable at runtime, not only TypeScript-readonly');
 assert.equal(Reflect.set(aStore,'walletScope',getAddress(walletB)),false);
 assert.throws(()=>Object.defineProperty(aStore,'walletScope',{value:getAddress(walletB)}));

 // A self-transfer is returned by both indexed filters but must persist once.
 const scans=await Promise.all([walletA,walletB].map(async wallet=>scanPositionManagerWalletTransferHistory({client:chain(),
  store:wallet===walletA?aStore:bStore,chainId:4663,manager,source})));
 assert(scans.every(x=>x.status==='scanned'&&x.completeThroughSource));
 assert.deepEqual((await aStore.loadTransfers(4663,manager,0n,5n,20)).map(x=>x.tokenId.toString()),['1','1','1','2']);
 assert.deepEqual((await bStore.loadTransfers(4663,manager,0n,5n,20)).map(x=>x.tokenId.toString()),['1','2','2']);
 // The global index remains a distinct complete event stream for this manager.
 const globalScan=await scanPositionManagerTransferHistory({client:chain(),store:globalStore,chainId:4663,manager,
  startBlock:0n,source,chunkBlocks:2n,maxBlocksPerRun:6n});
 assert.equal(globalScan.status,'scanned');assert.equal((await globalStore.loadTransfers(4663,manager,0n,5n,20)).length,5);
 const aCustody=await readCompletePositionManagerNftCustody({client:chain(),store:aStore,targetStrategyId:'rangekeeper_v1',
  operator:walletA,positionManager:manager,startBlock:0n,source});
 const bCustody=await readCompletePositionManagerNftCustody({client:chain(),store:bStore,targetStrategyId:'rangekeeper_v1',
  operator:walletB,positionManager:manager,startBlock:0n,source});
 assert.equal(aCustody.status,'available');assert.deepEqual(aCustody.tokenIds,['2']);
 assert.equal(bCustody.status,'available');assert.deepEqual(bCustody.tokenIds,['1']);
 const globalCustody=await readCompletePositionManagerNftCustody({client:chain(),store:globalStore,targetStrategyId:'rangekeeper_v1',
  operator:walletA,positionManager:manager,startBlock:0n,source});
 assert.equal(globalCustody.status,'available');assert.deepEqual(globalCustody.tokenIds,['2']);
 const wrongWallet=await readCompletePositionManagerNftCustody({client:chain(),store:aStore,targetStrategyId:'rangekeeper_v1',
  operator:walletB,positionManager:manager,startBlock:0n,source});
 assert.equal(wrongWallet.status,'unavailable');assert.equal(wrongWallet.enumerationComplete,false);

 // Restart/resume retains each isolated checkpoint and does not touch global rows.
 await aStore.close();aStore=new PostgresPositionManagerWalletTransferStore(connection,walletA);await aStore.assertReady();
 const resumed=await scanPositionManagerWalletTransferHistory({client:chain(),store:aStore,chainId:4663,manager,source});
 assert.equal(resumed.status,'scanned');assert.equal(resumed.chunks,0);
 assert.equal((await aStore.loadReplayEvidence(4663,manager,0n,5n,20)).transfers.length,4);

 // Failed identity or coverage writes roll back cursor, event, and checkpoints together.
 await cStore.initializeCursor(4663,manager,0n);
 const h0=checkpoint(0),h1=checkpoint(1),badEvent={blockNumber:1n,blockHash:hash(1),transactionHash:hash(777),transactionIndex:0,
  logIndex:0,from:getAddress('0x0000000000000000000000000000000000000000'),to:getAddress(walletC),tokenId:9n};
 const broken={chainId:4663,manager,startBlock:0n,fromBlock:0n,toBlock:1n,fromCheckpoint:null,checkpoint:checkpoint(1),
  eventBlocks:[h0,h1],transfers:[badEvent,{...badEvent,tokenId:10n}]};
 await assert.rejects(()=>cStore.saveChunk(broken),/event_conflict/);
 assert.equal((await cStore.getCursor(4663,manager,0n)).nextBlock,0n);
 assert.equal((await cStore.loadTransfers(4663,manager,0n,1n,10)).length,0);
 const checkpointCount=async()=>Number((await admin.query(`SELECT count(*) FROM position_manager_wallet_transfer_checkpoints
  WHERE chain_id=4663 AND position_manager=$1 AND wallet_address=$2`,[manager,walletC])).rows[0].count);
 assert.equal(await checkpointCount(),0,'Failed event identity must roll back checkpoint inserts too');
 await assert.rejects(()=>cStore.saveChunk({...broken,transfers:[badEvent],eventBlocks:[checkpoint(99),checkpoint(1)]}),/checkpoint.*range|event_checkpoint/i,
  'Out-of-range checkpoint evidence must be rejected');
 assert.equal((await cStore.getCursor(4663,manager,0n)).nextBlock,0n);
 assert.equal(await checkpointCount(),0);
 await cStore.saveChunk({...broken,transfers:[badEvent]});
 assert.equal((await cStore.getCursor(4663,manager,0n)).nextBlock,2n);
 await admin.query(`DELETE FROM position_manager_wallet_transfer_checkpoints WHERE chain_id=4663 AND position_manager=$1
  AND wallet_address=$2 AND start_block=0 AND block_number=1`,[manager,walletC]);
 const nextChunk={chainId:4663,manager,startBlock:0n,fromBlock:2n,toBlock:2n,fromCheckpoint:checkpoint(1),checkpoint:checkpoint(2),
  eventBlocks:[checkpoint(2)],transfers:[]};
 await assert.rejects(()=>cStore.saveChunk(nextChunk),/previous_checkpoint_mismatch/,
  'A cursor cannot be extended when its covered boundary checkpoint is missing');
 await assert.rejects(()=>cStore.saveChunk({...nextChunk,fromCheckpoint:{...checkpoint(1),hash:hash(777)}}),/coverage_gap|previous_checkpoint_mismatch/,
  'A cursor cannot be extended from a changed predecessor identity');
 assert.equal((await cStore.getCursor(4663,manager,0n)).nextBlock,2n);
 await assert.rejects(()=>cStore.saveChunk({...broken,fromBlock:1n,toBlock:2n,fromCheckpoint:null,checkpoint:block(2),
  eventBlocks:[block(1),block(2)],transfers:[]}),/contiguous|predecessor|coverage/);
 assert.equal((await cStore.getCursor(4663,manager,0n)).nextBlock,2n);
 const aEvidence=await aStore.loadReplayEvidence(4663,manager,0n,5n,20),aCursor=await aStore.getCursor(4663,manager,0n);
 await assert.rejects(()=>aStore.savePinnedCheckpoint(4663,manager,0n,{...checkpoint(5),hash:hash(500)}),/checkpoint_conflict/);
 assert.deepEqual(await aStore.getCursor(4663,manager,0n),aCursor);
 assert.equal((await aStore.loadReplayEvidence(4663,manager,0n,5n,20)).transfers.length,aEvidence.transfers.length);

 // Rewind one wallet namespace; sibling and global histories are unchanged.
 const boundary=(await aStore.recentCheckpoints(4663,manager,0n,256)).find(x=>x.number===3n);assert(boundary);
 await aStore.rewind(4663,manager,0n,4n,boundary);
 assert.equal((await aStore.getCursor(4663,manager,0n)).coveredThroughBlock,3n);
 assert.equal((await aStore.getCursor(4663,manager,0n)).nextBlock,4n);
 assert.equal((await bStore.getCursor(4663,manager,0n)).coveredThroughBlock,5n);
 assert.equal((await globalStore.getCursor(4663,manager,0n)).coveredThroughBlock,5n);
 const incomplete=await readCompletePositionManagerNftCustody({client:chain(),store:aStore,targetStrategyId:'rangekeeper_v1',
  operator:walletA,positionManager:manager,startBlock:0n,source});
 assert.equal(incomplete.status,'unavailable');assert.equal(incomplete.enumerationComplete,false);

 // Upgrade a real v13 schema with existing global transfer history. The new
 // wallet namespace must begin absent, not copied from global coverage.
 await admin.query(`CREATE SCHEMA "${upgradeSchema}"`);await admin.query(`SET search_path="${upgradeSchema}"`);
 await admin.query(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),method TEXT NOT NULL CHECK(method IN ('applied','verified_baseline')))`);
 assert.equal(MIGRATIONS.length,14);assert.equal(MIGRATION_CHECKSUMS.length,14);
 for(let index=0;index<13;index++){
  await admin.query(MIGRATIONS[index]);
  await admin.query('INSERT INTO schema_migrations(version,checksum,method) VALUES($1,$2,$3)',[index+1,MIGRATION_CHECKSUMS[index],'applied']);
 }
 const upgradeConnection=scopedUrl(upgradeSchema);upgradeGlobal=new PostgresPositionManagerTransferStore(upgradeConnection);
 const v13Scan=await scanPositionManagerTransferHistory({client:chain(),store:upgradeGlobal,chainId:4663,manager,startBlock:0n,
  source,chunkBlocks:2n,maxBlocksPerRun:6n});
 assert.equal(v13Scan.status,'scanned');
 const oldCursor=await upgradeGlobal.getCursor(4663,manager,0n),oldCheckpoints=await upgradeGlobal.recentCheckpoints(4663,manager,0n,256),
  oldEvents=await upgradeGlobal.loadTransfers(4663,manager,0n,5n,20);
 assert(oldCursor&&oldEvents.length===5&&oldCheckpoints.length>0);
 await upgradeGlobal.close();upgradeGlobal=undefined;
 assert.deepEqual(await migrateDatabase(admin),[14],'v13-to-v14 upgrade applies only the wallet-history migration');
 upgradeGlobal=new PostgresPositionManagerTransferStore(upgradeConnection);
 upgradeWallet=new PostgresPositionManagerWalletTransferStore(upgradeConnection,walletA);
 await upgradeWallet.assertReady();
 assert.deepEqual(await upgradeGlobal.getCursor(4663,manager,0n),oldCursor,'v14 must preserve the global cursor byte-for-byte');
 assert.deepEqual(await upgradeGlobal.recentCheckpoints(4663,manager,0n,256),oldCheckpoints,'v14 must preserve global checkpoints');
 assert.deepEqual(await upgradeGlobal.loadTransfers(4663,manager,0n,5n,20),oldEvents,'v14 must preserve global events');
 assert.equal(await upgradeWallet.getCursor(4663,manager,0n),null,'v14 must not infer wallet history from the global index');
 const upgradeScan=await scanPositionManagerWalletTransferHistory({client:chain(),store:upgradeWallet,chainId:4663,manager,source});
 assert.equal(upgradeScan.status,'scanned');assert.equal(upgradeScan.completeThroughSource,true);
 assert.equal((await upgradeWallet.getCursor(4663,manager,0n)).coveredThroughBlock,5n,
  'Wallet coverage appears only after an explicit scoped scan');
 console.log('wallet transfer index PG: wallet/global isolation, from/to/self log dedupe, resume, atomic conflict rollback, pinned checkpoint collision, wallet-only rewind, complete/incomplete custody passed');
}finally{
 await Promise.allSettled([globalStore?.close(),aStore?.close(),bStore?.close(),cStore?.close(),upgradeGlobal?.close(),upgradeWallet?.close()]);
 await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
 admin.release();await pool.end();
}
