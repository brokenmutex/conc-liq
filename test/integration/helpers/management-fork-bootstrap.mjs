// Bootstrap of the owned-fork RangeKeeper management qualification: isolated v14 schema, registry snapshot copied from the
// read-only registry database, one branded loopback Anvil fork pinned to an archive-verified canonical block, a synthetic
// shared wallet funded on that fork only, the real wallet-history index, the real setup runtime and the real command server.
// Nothing here can sign, publish or write to anything but the owned fork: the upstream clients are read-only transports and
// the wallet is a throwaway key. Adapted from rangekeeper-live-worker-fork.mjs (not imported: that file is a script).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {parseEnv} from 'node:util';
import pg from 'pg';
import {parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {createDeploymentCommandServer} from '../../../src/deployments/server.ts';
import {migrateDatabase} from '../../../src/storage/migrations.ts';
import {createRobinhoodClient} from '../../../src/client.ts';
import {rangeKeeperConfirmedSource} from '../../../src/strategy/rangekeeper/source.ts';
import {RangeKeeperChain} from '../../../src/strategy/rangekeeper/chain.ts';
import {readRangeKeeperReferences} from '../../../src/strategy/rangekeeper/reference.ts';
import {parseRangeKeeperConfig} from '../../../src/strategy/rangekeeper/config.ts';
import {openPaperFork} from '../../../src/paper/fork.ts';
import {scanPositionManagerTransferHistory} from '../../../src/nft/position-manager-transfer-index.ts';
import {createCanonicalWalletTransferFixture} from '../fixtures/rangekeeper-wallet-transfer-fixture.mjs';
import {createRangeKeeperLiveSetupRuntime} from '../../../src/deployments/rangekeeper-live-setup-runtime.ts';
import {createLocalClient,createForkClock,createPriceMover,fundErc20,sleep} from './management-fork-chain.mjs';

/** The upstream archive endpoint cannot serve fork state (quota exhausted, unreachable). Never retried in a loop. */
export class UpstreamBlockedError extends Error {
 constructor(message,detail){super(message);this.name='UpstreamBlockedError';this.detail=detail;}
}
const redact=text=>String(text).replace(/https?:\/\/\S+/gi,'[redacted-url]');

/** One read-only JSON-RPC probe. A monthly-capacity 429 is a hard block (reported, never hammered); an ordinary
 * rate-limit 429 backs off a bounded number of times. */
async function probeUpstream(name,url,{attempts=4,baseDelayMs=5000}={}){
 for(let attempt=0;attempt<attempts;attempt++){
  let status=0,text='';
  try{
   const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},redirect:'error',
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]}),signal:AbortSignal.timeout(20_000)});
   status=response.status;text=await response.text();
  }catch(error){throw new UpstreamBlockedError(`${name} upstream unreachable`,redact(error instanceof Error?error.message:error).slice(0,300));}
  let body=null;try{body=JSON.parse(text);}catch{/* not JSON */}
  if(status===200&&body?.result)return BigInt(body.result);
  const message=redact(body?.error?.message??text).slice(0,300);
  if(status===429||body?.error?.code===429){
   if(/monthly|capacity|quota/i.test(message))throw new UpstreamBlockedError(`${name} upstream quota is exhausted`,message);
   await sleep(baseDelayMs*3**attempt);continue;
  }
  throw new UpstreamBlockedError(`${name} upstream returned HTTP ${status}`,message);
 }
 throw new UpstreamBlockedError(`${name} upstream stayed rate limited after backoff`,'HTTP 429');
}

export const walletSecret=`0x${'6'.repeat(64)}`;

export async function bootstrapManagementFork({envFile,testUrl,archiveEnvName='RH_ARCHIVE_RPC_URL',operatorConfigPath,buildId,log,
 walletUsdg=400_000_000n,moverUsdg=400_000_000_000n,forkBudgetMs=4*60*60*1000}){
 const env=parseEnv(readFileSync(envFile,'utf8'));
 const archiveUrl=env[archiveEnvName];
 assert(testUrl,'TEST_DATABASE_URL must name the disposable PostgreSQL test database');
 assert(archiveUrl,`Upstream archive URL (${archiveEnvName}) is unavailable`);
 assert(env.DATABASE_URL,'The read-only registry snapshot DATABASE_URL is unavailable');
 const publicUrl=env.RH_PUBLIC_RPC_URL??'https://rpc.mainnet.chain.robinhood.com';
 const anvilBinary=process.env.ANVIL_BINARY_TEST??env.ANVIL_BINARY??'/root/.foundry/bin/anvil';
 const counters={archive:0,public:0};
 // Fail fast, before any schema work, when the upstream cannot serve the fork.
 const [archiveProbeHead,publicProbeHead]=[await probeUpstream('archive',archiveUrl),await probeUpstream('public',publicUrl)];
 log('upstream_probe',{archiveHead:String(archiveProbeHead),publicHead:String(publicProbeHead)});
 const operatorConfig=parseRangeKeeperConfig(JSON.parse(readFileSync(operatorConfigPath,'utf8')));
 const {Pool}=pg,root=new Pool({connectionString:testUrl,max:8}),admin=await root.connect(),schema=`rk_mgmt_fork_${randomUUID().replaceAll('-','')}`;
 let db,fork,commandServer;
 const cleanup=async()=>{
  if(commandServer){commandServer.closeAllConnections();commandServer.close();try{await once(commandServer,'close');}catch{/* closed */}}
  try{if(fork)await fork.close();}catch{/* best effort */}
  try{await db?.end();}catch{/* best effort */}
  try{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}catch{/* best effort */}
  try{admin.release();await root.end();}catch{/* best effort */}
 };
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);await migrateDatabase(admin);
  const scopedUrl=new URL(testUrl);scopedUrl.searchParams.set('options',`-c search_path=${schema}`);
  db=new Pool({connectionString:scopedUrl.toString(),max:10});
  const registryPool=new Pool({connectionString:env.DATABASE_URL,max:2,options:'-c default_transaction_read_only=on'});
  let profileRows;
  try{profileRows=(await registryPool.query(`SELECT id,profile,evidence,profile_hash,chain_id,pool_address,token0_address,token1_address,
    token0_decimals,token1_decimals,quote_token,fee,tick_spacing,verified_at FROM deployment_market_profiles
    WHERE chain_id=4663 AND retired_at IS NULL ORDER BY verified_at DESC`,[])).rows;}
  finally{await registryPool.end();}
  const poolOf=row=>row.profile.pool;
  const p500=profileRows.find(row=>row.pool_address.toLowerCase()===operatorConfig.pool.pool.toLowerCase());
  const p3000=profileRows.find(row=>row.id!==p500?.id&&poolOf(row).reference0==='USDG/USD'&&poolOf(row).reference1==='AAPL/USD'&&poolOf(row).fee===3000);
  assert(p500,'Registered AAPL fee-500 market profile is unavailable');
  assert(p3000,'Registered AAPL fee-3000 market profile is unavailable');
  for(const row of profileRows)await db.query(`INSERT INTO deployment_market_profiles(id,chain_id,pool_address,token0_address,token1_address,
   token0_decimals,token1_decimals,quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[row.id,row.chain_id,row.pool_address,row.token0_address,row.token1_address,
    row.token0_decimals,row.token1_decimals,row.quote_token,row.fee,row.tick_spacing,row.profile,row.evidence,row.profile_hash,row.verified_at]);
  const upstream=createRobinhoodClient(archiveUrl,20_000,{retryCount:0,beforeRequest:async()=>{counters.archive++;}});
  const publicClient=createRobinhoodClient(publicUrl,20_000,{retryCount:0,beforeRequest:async()=>{counters.public++;}});
  const [archiveHead,publicHead]=await Promise.all([upstream.getBlockNumber(),publicClient.getBlockNumber()]);
  const baselineBlock=(archiveHead<publicHead?archiveHead:publicHead)-128n;assert(baselineBlock>0n);
  const [archiveSource,publicSource]=await Promise.all([upstream.getBlock({blockNumber:baselineBlock}),publicClient.getBlock({blockNumber:baselineBlock})]);
  assert.equal(archiveSource.hash.toLowerCase(),publicSource.hash.toLowerCase(),'Public and archive canonical baseline differ');
  const source={number:baselineBlock,hash:archiveSource.hash,timestamp:archiveSource.timestamp};
  const account=privateKeyToAccount(walletSecret),wallet=account.address.toLowerCase();
  const sourceBaseline={block:baselineBlock,hash:archiveSource.hash,timestamp:Number(archiveSource.timestamp)};
  const walletTransferFixture=await createCanonicalWalletTransferFixture({client:publicClient,source:sourceBaseline,
   manager:operatorConfig.pool.positionManager,wallet,beforeQuery:async()=>await sleep(1500)});
  const transferStore=walletTransferFixture.store;
  // The fork budget covers the whole multi-scenario run: every local request also checks this deadline.
  fork=await openPaperFork({source,rpcUrl:archiveUrl,beforeRead:async()=>{},anvilBinary,timeoutMs:forkBudgetMs,maxRequests:300_000});
  assert(Object.isFrozen(fork.source),'Owned fork did not freeze its canonical source anchor');
  assert.equal(fork.source.number,source.number);assert.equal(fork.source.hash.toLowerCase(),source.hash.toLowerCase());
  const local=createLocalClient(fork);
  assert.equal(await local.getChainId(),4663);
  // Warm immutable identity, balance, slot and oracle reads at the fork anchor before time-sensitive local history exists.
  const anchored={block:source.number,hash:source.hash,timestamp:Number(source.timestamp)};
  for(const registered of profileRows)await new RangeKeeperChain(local,registered.profile.pool).verify(anchored);
  const warmed=new Set();
  for(const row of profileRows)for(const address of [row.profile.pool.token0,row.profile.pool.token1]){
   const key=address.toLowerCase();if(warmed.has(key))continue;warmed.add(key);
   await local.readContract({address,abi:parseAbi(['function balanceOf(address) view returns(uint256)']),functionName:'balanceOf',args:[wallet],blockNumber:source.number});
  }
  for(const selected of [p500,p3000]){
   await local.readContract({address:selected.profile.pool.pool,abi:parseAbi(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)']),
    functionName:'slot0',blockNumber:source.number});
   await local.readContract({address:selected.profile.pool.pool,abi:parseAbi(['function liquidity() view returns(uint128)']),
    functionName:'liquidity',blockNumber:source.number});
   await readRangeKeeperReferences(local,anchored,selected.profile);
  }
  const clock=createForkClock(fork,local);
  await fork.rpc('anvil_setBlockTimestampInterval',[0]);
  await fork.rpc('anvil_mine',['0x40','0x0']);
  const usdToken=operatorConfig.pool.token0,donor=operatorConfig.operator;
  await fork.rpc('anvil_setBalance',[wallet,'0x56bc75e2d63100000']);
  const walletFunding=await fundErc20(fork,local,{token:usdToken,to:wallet,amount:walletUsdg,donor,clock});
  const mover=await createPriceMover({fork,local,clock,router:operatorConfig.pool.router});
  const moverFunding=await mover.fund(usdToken,moverUsdg,donor);
  await clock.tick(65);
  const localSource=await rangeKeeperConfirmedSource(local);
  await scanPositionManagerTransferHistory({client:local,store:transferStore,chainId:4663,manager:operatorConfig.pool.positionManager,
   startBlock:0n,source:{block:localSource.block,hash:localSource.hash,timestamp:localSource.timestamp},chunkBlocks:1_000n,maxBlocksPerRun:100_000n});
  const runtimeStore={listMarketProfiles:async()=>profileRows.map(row=>({id:row.id,draftAvailable:true})),paperSetupProfile:async id=>{
   const row=profileRows.find(item=>item.id===id);return row?{id,profile:row.profile,profileHash:row.profile_hash}:null;
  }};
  // Production keeps the wallet's NFT transfer index current from the supervised worker's maintenance loop. This harness mines
  // fresh confirmation batches before every admission, so the setup runtime extends the same index to its pinned source first.
  const ensureWalletHistory=async({source:pinned})=>{
   const result=await scanPositionManagerTransferHistory({client:local,store:transferStore,chainId:4663,manager:operatorConfig.pool.positionManager,
    startBlock:0n,source:{block:BigInt(pinned.block),hash:pinned.hash,timestamp:pinned.timestamp},chunkBlocks:1_000n,maxBlocksPerRun:100_000n});
   return result.status==='scanned'&&result.completeThroughSource?{status:'available',completeThroughSource:true}:
    {status:'unavailable',reason:`wallet_history_incomplete_at_source:${result.reason??result.status}`};
  };
  const setup=createRangeKeeperLiveSetupRuntime({store:runtimeStore,indexer:db,client:local,walletAddress:wallet,buildId,rpcUrl:fork.localUrl,
   anvilBinary,transferStore,persistReviews:true,ensureWalletHistory,
   onSimulationFailure:error=>log('live_setup_fork_feasibility_failed',{reason:redact(error instanceof Error?error.stack:String(error)).slice(0,1500)})});
  const runtimeRef={current:null},state={commandReady:true};
  const origin='http://127.0.0.1:4174';
  commandServer=createDeploymentCommandServer({async createDraft(){throw Error('unexpected draft writer');},
   async acceptOperation(){throw Error('unexpected operation writer');},async operation(){return null;},
   async listMarketProfiles(){return profileRows;}},{origin,liveWalletReview:()=>setup.walletReview(),
   rangeKeeperLiveSetupPreflight:input=>setup.setupPreflight(input),rangeKeeperLiveSetupAdmission:input=>setup.admitSetup(input),
   rangeKeeperLiveAdmissionReady:async()=>state.commandReady,
   rangeKeeperLiveRetainPreview:campaignId=>runtimeRef.current.retainPreview(campaignId),
   rangeKeeperLiveRetainAdmission:(campaignId,input)=>runtimeRef.current.retainOperation(campaignId,input)});
  commandServer.listen(0,'127.0.0.1');await once(commandServer,'listening');
  const commandUrl=`http://127.0.0.1:${commandServer.address().port}`;
  const session=await fetch(commandUrl+'/api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
  assert.equal(session.status,200);
  const commandHeaders={origin,'content-type':'application/json',cookie:session.headers.get('set-cookie').split(';')[0],
   'x-csrf-token':(await session.json()).csrfToken};
  // The throwaway wallet address may already carry canonical history (a public test key); nonces are asserted relative to its start.
  const baseNonce=await local.getTransactionCount({address:wallet});
  return {baseNonce,env:{archiveEnvName},anvilBinary,schema,db,fork,local,clock,mover,account,wallet,profileRows,p500,p3000,operatorConfig,transferStore,
   setup,runtimeRef,state,commandServer,commandUrl,commandHeaders,counters,buildId,
   funding:{wallet:walletFunding,mover:moverFunding},source:{block:String(source.number),hash:source.hash,timestamp:Number(source.timestamp)},
   localSource:{block:String(localSource.block),hash:localSource.hash,timestamp:localSource.timestamp},
   walletCustodyBaseline:walletTransferFixture.baseline,close:cleanup};
 }catch(error){await cleanup();throw error;}
}
