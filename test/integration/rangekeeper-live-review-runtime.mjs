import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {privateKeyToAccount} from 'viem/accounts';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {readCommitments} from '../../src/deployments/live-wallet-store.ts';
import {liveWalletCommitmentFingerprint} from '../../src/deployments/live-wallet-commitment-projection.ts';
import {createRangeKeeperLiveReviewRuntime} from '../../src/deployments/rangekeeper-live-review-runtime.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('Set TEST_DATABASE_URL to an isolated PostgreSQL test database');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});
const admin=await pool.connect(),schema=`rk_review_runtime_${randomUUID().replaceAll('-','')}`;let scoped;
const address=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`).address.toLowerCase();
const manager='0x2222222222222222222222222222222222222222';
try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);await migrateDatabase(admin);
 const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
 scoped=new pg.Pool({connectionString:url.toString(),max:4});
 const identity={chainId:4663,address},source={block:'100',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)};
 const commitmentsHash=liveWalletCommitmentFingerprint(await readCommitments(scoped,identity));
 let observations=0,verifications=0;
 const runtime=createRangeKeeperLiveReviewRuntime({pool:scoped,wallet:identity,buildId:'b'.repeat(64),
  observeWallet:async()=>{observations++;return {complete:true,missing:[],snapshot:{...identity,source,nonce:'4',pendingNonce:'4',nativeBalanceWei:'1000000000000000000',
   tokens:[{address:'0x3333333333333333333333333333333333333333',balanceRaw:'123'}],commitmentsHash},
   nft:{positionManager:manager,completeEvidence:{kind:'complete_position_manager_nft_custody',status:'available',
    targetStrategyId:'rangekeeper_v1',operator:address,positionManager:manager,source:{...source,confirmed:true},enumerationComplete:true,
    tokenIds:['7'],balanceOfCount:{status:'available',value:'1'},knownOwners:[{tokenId:'7',owner:{status:'available',value:address}}],missing:[]},
    positions:[{tokenId:'7',owner:address,liquidity:'0',tokensOwed0:'0',tokensOwed1:'0'}],retiredEmptyTokenIds:['7']}};},
  verifyCanonical:async anchor=>{verifications++;assert.equal(anchor.hash,source.hash);}});
 const first=await runtime.refreshSnapshot();assert.equal(first.status,'persisted');assert.equal(first.state?.generation,1);
 assert.equal(first.state?.commitmentsHash,liveWalletCommitmentFingerprint(await readCommitments(scoped,identity)),
  'snapshot commitment binding includes the just-persisted retired-empty NFT custody view');
 const same=await runtime.refreshSnapshot();assert.equal(same.status,'persisted');assert.equal(same.state?.generation,1,'unchanged canonical refresh is generation-idempotent');
 assert.equal(observations,2);assert.equal(verifications,4,'anchor is checked before and again inside each wallet lock');
 assert.equal(Number((await scoped.query(`SELECT count(*) FROM deployment_live_nft_custody_snapshots WHERE chain_id=4663 AND wallet=$1`,[address])).rows[0].count),1);
 assert.equal(Number((await scoped.query(`SELECT count(*) FROM deployment_live_nft_custody WHERE chain_id=4663 AND wallet=$1
  AND token_id='7' AND status='retired_empty'`,[address])).rows[0].count),1);
 // A legacy v11 deployment remains read-only even if its process can query the
 // newer tables. No snapshot observer or persistence callback should run.
 const originalQuery=scoped.query.bind(scoped);const proxy=Object.create(scoped);proxy.query=async(sql,...args)=>{
  if(String(sql).includes('max(version)'))return {rows:[{version:11}]};return originalQuery(sql,...args);
 };
 const readonly=createRangeKeeperLiveReviewRuntime({pool:proxy,wallet:identity,buildId:'b'.repeat(64),
  observeWallet:async()=>{throw Error('must not observe on v11');},verifyCanonical:async()=>{}});
 const result=await readonly.refreshSnapshot();assert.equal(result.status,'read_only');
 assert.deepEqual(result.missing,['live_wallet_v12_required_for_snapshot_persistence']);
 assert.equal(Number((await scoped.query(`SELECT generation FROM deployment_live_wallets WHERE chain_id=4663 AND wallet=$1`,[address])).rows[0].generation),1);
 console.log('RangeKeeper review runtime integration: atomic canonical wallet/NFT snapshot, unchanged-generation replay and safe v11 read-only fallback passed');
}finally{
 try{await scoped?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{admin.release();await pool.end();}
}
