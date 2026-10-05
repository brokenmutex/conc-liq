// Composed RangeKeeper shared-wallet worker exercise. All signing, token funding,
// publication, and block production terminate at one owned loopback Anvil fork.
//
// Modes (all use the same owned fork, HTTP command server and shared-wallet queue):
//   default / --two-pools / --dashboard-admission / --retain-first   AAPL qualification flow
//   --matrix | --profiles=AAPL:500,NVDA:3000,...   profile matrix: every selected REAL registered
//        profile runs HTTP preflight -> persisted review -> HTTP admission -> worker open ->
//        holding -> HTTP retain preview/operation -> closed with allocation released
//   --concurrency [--concurrency-profiles=A:500,B:3000,C:500]   three campaigns on one wallet
//        (back-to-back admission, single queue, shared risky token, close beside siblings,
//        native gas shortfall)
//   --print-plan   resolve the selection against the registry snapshot and exit (no upstream use)
// Options: --widths=AAPL:500=20,...  --capital-usdg=N  --fund-usdg=N  --fork-timeout-minutes=N
//          --continue-after-failure  --strict-market
// Token approval policy assertions live ONLY in helpers/rangekeeper-live-allowance-policy.mjs.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createDeploymentCommandServer} from '../../src/deployments/server.ts';
import {parseEnv} from 'node:util';
import pg from 'pg';
import {createPublicClient,encodeFunctionData,http,parseAbi} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {createRobinhoodClient} from '../../src/client.ts';
import {rangeKeeperConfirmedSource} from '../../src/strategy/rangekeeper/source.ts';
import {RangeKeeperChain} from '../../src/strategy/rangekeeper/chain.ts';
import {readRangeKeeperReferences} from '../../src/strategy/rangekeeper/reference.ts';
import {parseRangeKeeperConfig} from '../../src/strategy/rangekeeper/config.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {openPaperFork} from '../../src/paper/fork.ts';
import {scanPositionManagerTransferHistory} from '../../src/nft/position-manager-transfer-index.ts';
import {createCanonicalWalletTransferFixture} from './fixtures/rangekeeper-wallet-transfer-fixture.mjs';
import {createRangeKeeperLiveSetupRuntime} from '../../src/deployments/rangekeeper-live-setup-runtime.ts';
import {verifyRangeKeeperLiveSetupPinnedReferences} from '../../src/deployments/rangekeeper-live-setup-runtime.ts';
import {readCanonicalPaperOpenFrame} from '../../src/deployments/paper-preview.ts';
import {createRangeKeeperLiveReviewStoreAdapter,admitRangeKeeperLiveSetup} from '../../src/deployments/rangekeeper-live-review-admission.ts';
import {createRangeKeeperLiveWalletRuntime} from '../../src/deployments/rangekeeper-live-queue-adapters.ts';
import {robinhoodChain} from '../../src/constants.ts';
import {readRangeKeeperLiveCampaign} from '../../src/deployments/rangekeeper-live-campaign-store.ts';
import {readCommitments,readWalletState} from '../../src/deployments/live-wallet-store.ts';
import {allocateLiveWalletBalances} from '../../src/deployments/live-wallet-allocation.ts';
import {projectLiveWalletCommitmentRows} from '../../src/deployments/live-wallet-commitment-projection.ts';
import {rangeKeeperLiveSetupPreflightInput} from '../../src/deployments/rangekeeper-live-setup-preflight.ts';
import {DashboardRepository} from '../../src/dashboard/repository.ts';
import {loadDashboardConfig} from '../../src/dashboard/config.ts';
import {createRangeKeeperLiveManagementRuntime} from '../../src/deployments/rangekeeper-live-management.ts';
import {createRangeKeeperLiveManagementObserver} from '../../src/deployments/rangekeeper-live-management-observer.ts';
import {DEFAULT_MATRIX,DEFAULT_CONCURRENCY,describeProfile,selectProfiles,runProfileMatrix,runConcurrencyScenarios,
 refreshLocalSource,diagnoseLatestMark,marketClosedStaleReference} from './helpers/rangekeeper-live-pool-matrix.mjs';
import {assertAllowancePolicyAfterJob,assertAllowancePolicyAfterClose,assertOpenApprovalShapes,assertRetainStagePlans,
 assertFreshWalletAllowances,readNonzeroAllowanceKeys,probeNonzeroToNonzeroApprove,ALLOWANCE_POLICY} from './helpers/rangekeeper-live-allowance-policy.mjs';

const env=parseEnv(readFileSync(process.argv[2]??'.env','utf8'));
const testUrl=process.env.TEST_DATABASE_URL;
assert(testUrl,'TEST_DATABASE_URL must name the disposable PostgreSQL test database');
assert(env.RH_ARCHIVE_RPC_URL,'Archive RPC URL is unavailable');
const decodeBigints=value=>Array.isArray(value)?value.map(decodeBigints):value&&typeof value==='object'?
 Object.fromEntries(Object.entries(value).map(([k,v])=>[k,v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===1&&'$bigint'in v?
  BigInt(v.$bigint):v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===1&&'__rangekeeper_bigint_v1__'in v?
   BigInt(v.__rangekeeper_bigint_v1__):decodeBigints(v)])):value;
const operatorConfig=parseRangeKeeperConfig(JSON.parse(readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8')));
const argValue=name=>{const arg=process.argv.find(item=>item.startsWith(`--${name}=`));return arg===undefined?undefined:arg.slice(name.length+3);};
const twoPools=process.argv.includes('--two-pools');
const profilesOption=argValue('profiles');
const matrixMode=process.argv.includes('--matrix')||profilesOption!==undefined;
const concurrencyMode=process.argv.includes('--concurrency');
const printPlan=process.argv.includes('--print-plan');
// The matrix and concurrency drivers always use the actual HTTP command server.
const dashboardAdmission=process.argv.includes('--dashboard-admission')||matrixMode||concurrencyMode;
const retainFirst=process.argv.includes('--retain-first');
assert(!retainFirst||twoPools&&dashboardAdmission,'Retain qualification requires two pools and actual dashboard admission');
assert(!(matrixMode&&concurrencyMode),'Run --matrix and --concurrency as separate invocations: retained inventory would change the concurrency start state');
assert(!((matrixMode||concurrencyMode)&&(twoPools||retainFirst)),'--matrix/--concurrency replace the legacy --two-pools/--retain-first flow');
const widthOption=process.argv.find(arg=>arg.startsWith('--full-width-spacings='));
const fullWidthSpacings=widthOption?Number(widthOption.split('=')[1]):operatorConfig.limits.fullWidthSpacings;
assert(Number.isSafeInteger(fullWidthSpacings)&&fullWidthSpacings>=2&&fullWidthSpacings<=2000&&fullWidthSpacings%2===0);
const numberOption=(name,fallback)=>{const text=argValue(name);if(text===undefined)return fallback;const value=Number(text);
 assert(Number.isFinite(value)&&value>0,`--${name} must be a positive number`);return value;};
const forkTimeoutMs=Math.round(numberOption('fork-timeout-minutes',matrixMode||concurrencyMode?300:10)*60_000);
const capitalUsdg=numberOption('capital-usdg',concurrencyMode?30:50),fundUsdg=numberOption('fund-usdg',125);
const widthOverrides=new Map();
for(const item of (argValue('widths')??'').split(',').filter(Boolean)){
 const match=/^([A-Za-z0-9]+:\d+)=(\d+)$/.exec(item);assert(match,`Malformed --widths entry: ${item}`);
 const width=Number(match[2]);assert(width>=2&&width<=2000&&width%2===0,`--widths ${item} must be an even width in tick spacings`);
 widthOverrides.set(match[1].toUpperCase(),[width]);
}
const continueAfterFailure=process.argv.includes('--continue-after-failure'),strictMarket=process.argv.includes('--strict-market');
const planSentinel=Symbol('plan printed');
const anvilBinary=process.env.ANVIL_BINARY_TEST??env.ANVIL_BINARY??'/root/.foundry/bin/anvil';
const {Pool}=pg,root=new Pool({connectionString:testUrl,max:8}),admin=await root.connect(),schema=`rk_worker_fork_${randomUUID().replaceAll('-','')}`;
let db,fork,commandServer,dashboardRepository,managementRuntime;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);await migrateDatabase(admin);
 const scopedUrl=new URL(testUrl);scopedUrl.searchParams.set('options',`-c search_path=${schema}`);
 db=new Pool({connectionString:scopedUrl.toString(),max:8});
 dashboardRepository=new DashboardRepository(loadDashboardConfig({...env,DATABASE_URL:scopedUrl.toString(),
  ADAPTIVE_PAPER_STATE_PATH:'/tmp/conc-liq-absent-adaptive-live-qualification.json'}));
 const productionReadPool=new Pool({connectionString:env.DATABASE_URL,max:2,options:'-c default_transaction_read_only=on'});
 let profileRows,profileRow;
 try{const result=await productionReadPool.query(`SELECT id,profile,evidence,profile_hash,chain_id,pool_address,token0_address,token1_address,
   token0_decimals,token1_decimals,quote_token,fee,tick_spacing,verified_at FROM deployment_market_profiles
   WHERE chain_id=4663 AND retired_at IS NULL ORDER BY verified_at DESC`,[]);
  profileRows=result.rows;profileRow=profileRows.find(row=>row.pool_address.toLowerCase()===operatorConfig.pool.pool.toLowerCase());
 }finally{await productionReadPool.end();}
 assert(profileRow,'Registered AAPL market profile is unavailable');
 assert(profileRows.length===12,'Expected all twelve registered market profiles for token inventory scope');
 const secondProfileRow=profileRows.find(row=>row.id!==profileRow.id&&row.profile.pool.reference0==='USDG/USD'&&
  row.profile.pool.reference1==='AAPL/USD'&&row.profile.pool.fee===3000);
 if(twoPools)assert(secondProfileRow,'Registered second AAPL fee-3000 pool is unavailable');
 const matrixSelections=matrixMode?selectProfiles(profileRows,profilesOption!==undefined?profilesOption.split(',').filter(Boolean):DEFAULT_MATRIX):[];
 const concurrencySelections=concurrencyMode?selectProfiles(profileRows,(argValue('concurrency-profiles')?.split(',').filter(Boolean))??DEFAULT_CONCURRENCY):[];
 assert(!concurrencyMode||concurrencySelections.length===3&&new Set(concurrencySelections.map(item=>item.row.id)).size===3,
  'Concurrency needs three distinct registered profiles');
 if(matrixMode)assert(new Set(matrixSelections.map(item=>item.row.id)).size===matrixSelections.length,'Duplicate profile in the matrix selection');
 if(printPlan){
  const classes=new Map();
  for(const item of [...matrixSelections,...concurrencySelections])classes.set(`${item.view.quoteSide}/fee${item.view.fee}/spacing${item.view.tickSpacing}`,item.view.symbol);
  console.log(JSON.stringify({event:'rangekeeper_pool_matrix_plan',registeredProfileCount:profileRows.length,
   registered:profileRows.map(row=>describeProfile(row)),matrix:matrixSelections.map(item=>item.view),
   concurrency:concurrencySelections.map(item=>item.view),structuralClasses:[...classes.keys()],capitalUsdg,fundUsdg,
   widthOverrides:Object.fromEntries(widthOverrides),forkTimeoutMs,allowancePolicy:ALLOWANCE_POLICY}));
  throw planSentinel;
 }
 const upstreamReads={archive:{},public:{}};
 const countingFetch=label=>async(input,init)=>{
  try{const body=JSON.parse(String(init?.body??'{}'));
   for(const item of Array.isArray(body)?body:[body])upstreamReads[label][item?.method??'unknown']=(upstreamReads[label][item?.method??'unknown']??0)+1;
  }catch{upstreamReads[label].unparsed=(upstreamReads[label].unparsed??0)+1;}
  return fetch(input,init);
 };
 const upstream=createRobinhoodClient(env.RH_ARCHIVE_RPC_URL,20_000,{retryCount:0,beforeRequest:async()=>{},fetchFn:countingFetch('archive')});
 const publicRpcUrl=env.RH_PUBLIC_RPC_URL??'https://rpc.mainnet.chain.robinhood.com',publicClient=createRobinhoodClient(publicRpcUrl,20_000,{retryCount:0,beforeRequest:async()=>{},fetchFn:countingFetch('public')});
 const [archiveHead,publicHead]=await Promise.all([upstream.getBlockNumber(),publicClient.getBlockNumber()]);
 const baselineBlock=(archiveHead<publicHead?archiveHead:publicHead)-128n;assert(baselineBlock>0n);
 const [archiveSource,publicSource]=await Promise.all([upstream.getBlock({blockNumber:baselineBlock}),publicClient.getBlock({blockNumber:baselineBlock})]);
 assert.equal(archiveSource.hash.toLowerCase(),publicSource.hash.toLowerCase(),'Public and archive canonical baseline differ');
 const sourceBaseline={block:baselineBlock,hash:archiveSource.hash,timestamp:Number(archiveSource.timestamp)};
 const syntheticAccount=privateKeyToAccount(`0x${'6'.repeat(64)}`),wallet=syntheticAccount.address.toLowerCase();
 const walletTransferFixture=await createCanonicalWalletTransferFixture({client:publicClient,source:sourceBaseline,
  manager:operatorConfig.pool.positionManager,wallet,beforeQuery:async()=>await new Promise(resolve=>setTimeout(resolve,1500))});
 const transferStore=walletTransferFixture.store;
 for(const row of profileRows)await db.query(`INSERT INTO deployment_market_profiles(id,chain_id,pool_address,token0_address,token1_address,token0_decimals,token1_decimals,
  quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[row.id,row.chain_id,row.pool_address,
   row.token0_address,row.token1_address,row.token0_decimals,row.token1_decimals,row.quote_token,
   row.fee,row.tick_spacing,row.profile,row.evidence,row.profile_hash,row.verified_at]);
 const source={number:BigInt(sourceBaseline.block),hash:sourceBaseline.hash,timestamp:BigInt(sourceBaseline.timestamp)};
 const pinned=await upstream.getBlock({blockNumber:source.number});assert.equal(pinned.hash.toLowerCase(),source.hash.toLowerCase());
 assert.equal(Number(pinned.timestamp),Number(source.timestamp));
 fork=await openPaperFork({source,rpcUrl:env.RH_ARCHIVE_RPC_URL,beforeRead:async()=>{},
  anvilBinary,timeoutMs:forkTimeoutMs,maxRequests:100_000});
 assert(Object.isFrozen(fork.source),'Owned fork did not freeze its canonical source anchor');
 assert.equal(fork.source.number,source.number);assert.equal(fork.source.hash.toLowerCase(),source.hash.toLowerCase());
 const local=createRobinhoodClient(fork.localUrl,30_000,{retryCount:0,beforeRequest:async()=>{}});
 assert.equal(await local.getChainId(),4663);
 // Warm the immutable deployment identity reads at the fork anchor before
 // generating recent local wallet state; this keeps first-use archive lookups
 // away from the time-sensitive setup observation.
 const warmPool=await local.readContract({address:operatorConfig.pool.factory,
  abi:parseAbi(['function getPool(address,address,uint24) view returns(address)']),functionName:'getPool',
  args:[operatorConfig.pool.token0,operatorConfig.pool.token1,operatorConfig.pool.fee],blockNumber:source.number});
 assert.equal(warmPool.toLowerCase(),operatorConfig.pool.pool.toLowerCase());
 await new RangeKeeperChain(local,operatorConfig.pool).verify({block:source.number,hash:source.hash,timestamp:Number(source.timestamp)});
 // Whole-wallet custody checks verify every registered profile. Warm that
 // immutable metadata outside the short-lived funded source as well.
 for(const registered of profileRows)
  await new RangeKeeperChain(local,registered.profile.pool).verify({block:source.number,hash:source.hash,timestamp:Number(source.timestamp)});
 // Exercise each token's balance path at the immutable base as well, so
 // proxy implementation code and balance storage are present before local
 // history is extended. All reads are canonical; no code is replaced.
 const warmedBalanceTokens=new Set();
 for(const row of profileRows)for(const address of [row.profile.pool.token0,row.profile.pool.token1]){
  const key=address.toLowerCase();if(warmedBalanceTokens.has(key))continue;
  await local.readContract({address,abi:parseAbi(['function balanceOf(address) view returns(uint256)']),
   functionName:'balanceOf',args:[wallet],blockNumber:source.number});
  warmedBalanceTokens.add(key);
 }
 // Warm only immutable slot and oracle reads at the fork anchor, before
 // local confirmations. Fresh-source eligibility is still checked normally.
 const warmSelections=new Map([profileRow,...(twoPools?[secondProfileRow]:[]),
  ...[...matrixSelections,...concurrencySelections].map(item=>item.row)].map(row=>[row.id,row]));
 for(const selected of warmSelections.values()){
  const anchored={block:source.number,hash:source.hash,timestamp:Number(source.timestamp)};
  await local.readContract({address:selected.profile.pool.pool,abi:parseAbi([
   'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)']),functionName:'slot0',blockNumber:source.number});
  await local.readContract({address:selected.profile.pool.pool,abi:parseAbi(['function liquidity() view returns(uint128)']),
   functionName:'liquidity',blockNumber:source.number});
  await readRangeKeeperReferences(local,anchored,selected.profile);
 }
 // The worker's snapshot and admission need a fresh source. Keep canonical
 // historical time fixed during confirmations, then jump only the first local
 // funding block to current time; no upstream state is ever changed.
 await fork.rpc('anvil_setBlockTimestampInterval',[0]);
 await fork.rpc('anvil_mine',['0x40','0x0']);
 const usdToken=operatorConfig.pool.token0,donor=operatorConfig.operator,amount=BigInt(Math.round(fundUsdg*10**operatorConfig.pool.decimals0));
 await fork.rpc('anvil_setBalance',[wallet,'0x56bc75e2d63100000']);
 await fork.rpc('anvil_impersonateAccount',[donor]);await fork.rpc('anvil_setBalance',[donor,'0x56bc75e2d63100000']);
 const transfer=encodeFunctionData({abi:parseAbi(['function transfer(address to,uint256 amount) returns (bool)']),functionName:'transfer',
  args:[wallet,amount]});
 const donorTokenBalance=await local.readContract({address:usdToken,abi:parseAbi(['function balanceOf(address) view returns(uint256)']),
  functionName:'balanceOf',args:[donor]});
 assert(donorTokenBalance>=amount,`Local impersonation donor balance too small: ${donorTokenBalance}`);
 await fork.rpc('anvil_setNextBlockTimestamp',[Math.floor(Date.now()/1000)]);
 const fundHash=await fork.rpc('eth_sendTransaction',[{from:donor,to:usdToken,data:transfer,gas:'0x30000'}]);
 let fundingReceipt=null;const inclusionDeadline=Date.now()+20_000;
 while(!fundingReceipt&&Date.now()<inclusionDeadline){
  fundingReceipt=await local.getTransactionReceipt({hash:fundHash}).catch(()=>null);
  if(!fundingReceipt)await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert(fundingReceipt,'Local funding transaction was not included before confirmation mining');
 await fork.rpc('anvil_mine',['0x40','0x0']);
 const localSource=await rangeKeeperConfirmedSource(local);
 if(fundingReceipt.status!=='success'){
  const trace=await fork.rpc('debug_traceTransaction',[fundHash,{}]).catch(error=>({error:String(error)}));
  throw Error(`bounded local token funding reverted: ${JSON.stringify({hash:fundHash,donorTokenBalance:String(donorTokenBalance),gasUsed:String(fundingReceipt.gasUsed),trace}).slice(0,2000)}`);
 }
 assert(localSource.block>=fundingReceipt.blockNumber&&localSource.timestamp<=Math.floor(Date.now()/1000),
  `Funded source did not confirm in time: ${JSON.stringify({sourceBlock:String(localSource.block),receiptBlock:String(fundingReceipt.blockNumber),
   sourceTimestamp:localSource.timestamp,now:Math.floor(Date.now()/1000)})}`);
 await scanPositionManagerTransferHistory({client:local,store:transferStore,chainId:4663,manager:operatorConfig.pool.positionManager,
  startBlock:0n,source:{block:localSource.block,hash:localSource.hash,timestamp:localSource.timestamp},chunkBlocks:1_000n,maxBlocksPerRun:100_000n});
 const testClient=createPublicClient({chain:robinhoodChain,transport:http(fork.localUrl,{retryCount:0})});
 const canonicalProfile=profileRow.profile;
 const profile={pool:profileRow.profile.pool,referencePolicy:profileRow.profile.referencePolicy};
 const runtimeStore={listMarketProfiles:async()=>profileRows.map(row=>({id:row.id,draftAvailable:true})),paperSetupProfile:async id=>{
  const row=profileRows.find(item=>item.id===id);return row?{id,profile:row.profile,profileHash:row.profile_hash}:null;
 }};
 const transferApi=transferStore;
const setup=createRangeKeeperLiveSetupRuntime({store:runtimeStore,indexer:db,client:local,walletAddress:wallet,buildId:'e'.repeat(64),
  rpcUrl:fork.localUrl,anvilBinary,transferStore:transferApi,persistReviews:true,
  onSimulationFailure:error=>console.error(JSON.stringify({event:'live_dashboard_fork_feasibility_failed',
   reason:(error instanceof Error?error.stack:String(error)).replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,2000)}))});
 let commandUrl,commandHeaders,commandReady=true;
 if(dashboardAdmission){
  const origin='http://127.0.0.1:4174';
  commandServer=createDeploymentCommandServer({async createDraft(){throw Error('unexpected draft writer');},
   async acceptOperation(){throw Error('unexpected operation writer');},async operation(){return null;},
   async listMarketProfiles(){return profileRows;}},{origin,liveWalletReview:()=>setup.walletReview(),
   rangeKeeperLiveSetupPreflight:input=>setup.setupPreflight(input),
   rangeKeeperLiveSetupAdmission:input=>setup.admitSetup(input),rangeKeeperLiveAdmissionReady:async()=>commandReady,
   rangeKeeperLiveRetainPreview:campaignId=>managementRuntime.retainPreview(campaignId),
   rangeKeeperLiveRetainAdmission:(campaignId,input)=>managementRuntime.retainOperation(campaignId,input),
   dashboardRead:async path=>{
    try{const url=new URL(path,'http://127.0.0.1'),id=url.pathname==='/api/positions'?undefined:url.pathname.slice(15);
     return await dashboardRepository.positions(id,Number(url.searchParams.get('hours')??24));}
    catch(error){console.error(JSON.stringify({event:'live_positions_api_error',stack:error instanceof Error?error.stack:String(error)}));throw error;}}});
  commandServer.listen(0,'127.0.0.1');await once(commandServer,'listening');
  commandUrl=`http://127.0.0.1:${commandServer.address().port}`;
  const session=await fetch(commandUrl+'/api/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
  assert.equal(session.status,200);
  commandHeaders={origin,'content-type':'application/json',cookie:session.headers.get('set-cookie').split(';')[0],
   'x-csrf-token':(await session.json()).csrfToken};
  const initialPositions=await fetch(commandUrl+'/api/positions');
  const initialPositionsBody=await initialPositions.json();
  assert.equal(initialPositions.status,200,JSON.stringify(initialPositionsBody));
 }
 const reviewSetup=async input=>{
  if(!dashboardAdmission)return setup.setupPreflight(input);
  const response=await fetch(commandUrl+'/api/deployments/rangekeeper/live-setup-preflight',{
   method:'POST',headers:commandHeaders,body:JSON.stringify(input)});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.admissionAvailable,true);return result;
 };
 const admitSetup=async(input,deps)=>{
  if(!dashboardAdmission)return admitRangeKeeperLiveSetup(input,deps);
  const response=await fetch(commandUrl+'/api/deployments/rangekeeper/live-setup-admit',{
   method:'POST',headers:commandHeaders,body:JSON.stringify(input)});
  const result=await response.json();assert.equal(response.status,202,JSON.stringify(result));
  const replay=await fetch(commandUrl+'/api/deployments/rangekeeper/live-setup-admit',{
   method:'POST',headers:commandHeaders,body:JSON.stringify(input)});
  assert.equal(replay.status,200);assert.deepEqual(await replay.json(),{...result,replayed:true});return result;
 };

 const registeredTokenMetadata=new Map();
 for(const row of profileRows)for(const [address,decimals] of [[row.profile.pool.token0,row.profile.pool.decimals0],[row.profile.pool.token1,row.profile.pool.decimals1]]){
  const key=address.toLowerCase(),previous=registeredTokenMetadata.get(key);assert(previous===undefined||previous===decimals,'Registered token decimals conflict');
  registeredTokenMetadata.set(key,decimals);
 }
 const readFreeCapital=async()=>{
  const identity={chainId:4663,address:wallet},[walletState,commitments]=await Promise.all([readWalletState(db,identity),readCommitments(db,identity)]);
  assert.equal(walletState.status,'available');
  const allocation=allocateLiveWalletBalances({nativeBalanceWei:walletState.nativeBalanceWei,
   tokens:walletState.tokens.map(token=>({address:token.address,decimals:registeredTokenMetadata.get(token.address.toLowerCase()),
    symbol:token.address,balanceRaw:token.balanceRaw})),commitments:projectLiveWalletCommitmentRows(commitments),commitmentsStatus:'available'});
  assert.equal(allocation.status,'available',allocation.blockers.join(','));
  return {nativeWei:allocation.native.availableWei,tokens:Object.fromEntries(allocation.tokens.map(token=>[token.address.toLowerCase(),token.availableRaw]))};
 };
 let signerCalls=0,rawSigned=[];
 const withWorkerDiagnostics=runtime=>{
  const wrap=(owner,key,phase)=>{const original=owner[key];if(typeof original!=='function')return;
   owner[key]=async function(...args){try{return await original.apply(this,args);}catch(error){
    console.error(JSON.stringify({event:'live_worker_phase_error',phase,stack:(error instanceof Error?error.stack:String(error))
     .replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,3000)}));throw error;}};};
  for(const key of ['initializeOpeningCampaign','nextStage','verifyPreparedIntent','completeOpeningLifecycle'])wrap(runtime.adapters,key,`adapter.${key}`);
  for(const key of ['prepareStage','recordSigned','reconcileStage','finish'])wrap(runtime.queue,key,`queue.${key}`);
  for(const key of ['signIntent','publishRaw','waitForCanonicalReceipt'])wrap(runtime.adapters,key,`adapter.${key}`);
  return runtime;
 };
 const createWorkerRuntime=(failAckAfterPublishOnce,extra={})=>withWorkerDiagnostics(createRangeKeeperLiveWalletRuntime({pool:db,client:local,walletAddress:wallet,transferStore,
  loadProfiles:async()=>profileRows.map(row=>({profile:row.profile})),rpcUrl:fork.localUrl,anvilBinary,...extra,
  options:{signerEnabled:true,publisherEnabled:true,leaseMs:300_000},
  testHooks:{enabled:true,fork,mineConfirmations:64,failAckAfterPublishOnce,signIntent:async intent=>{
   // Pin the next local block to wall-clock time before the stage is signed;
   // interval=0 then keeps all 64 confirmation headers at this same timestamp.
   await fork.rpc('anvil_setNextBlockTimestamp',[Math.floor(Date.now()/1000)]);
   signerCalls++;
   const values={nonce:intent.nonce,value:intent.value,gas:intent.gas,maxFeePerGas:intent.maxFeePerGas,
    maxPriorityFeePerGas:intent.maxPriorityFeePerGas};
   try{
    for(const [key,value] of Object.entries(values))assert(value!==undefined&&value!==null,`Synthetic signer received missing ${key}`);
    const raw=await syntheticAccount.signTransaction({chainId:4663,type:'eip1559',nonce:intent.nonce,
     to:intent.to,data:intent.data,value:BigInt(intent.value),gas:BigInt(intent.gas),
     maxFeePerGas:BigInt(intent.maxFeePerGas),maxPriorityFeePerGas:BigInt(intent.maxPriorityFeePerGas),accessList:[]});
    rawSigned.push(raw);return raw;
   }catch(error){console.error(JSON.stringify({event:'live_worker_signer_error',fields:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value==null?null:String(value)])),
     stack:error instanceof Error?error.stack:String(error)}));throw error;}
  }}}));
const preflightLimits={maxDeploymentValue:String(operatorConfig.limits.maxDeploymentValue),minDeploymentValue:'1',
  minDeploymentPpm:operatorConfig.limits.minDeploymentPpm,maxSwapInputValue:String(operatorConfig.limits.maxSwapInputValue),
  maxSwapInputPpm:operatorConfig.limits.maxSwapInputPpm,maxSwapShortfallValue:String(operatorConfig.limits.maxSwapShortfallValue),
  maxRecenters:operatorConfig.limits.maxRecenters,maxLiquiditySharePpm:operatorConfig.limits.maxLiquiditySharePpm,
  maxObservationGapSeconds:operatorConfig.limits.maxObservationGapSeconds,
  maxExposurePpm:operatorConfig.limits.maxExposurePpm,maxLossValue:String(operatorConfig.limits.maxLossValue),
  maxDrawdownPpm:operatorConfig.limits.maxDrawdownPpm,maxActionCost:String(operatorConfig.limits.maxActionCost),
  maxRollingCost:String(operatorConfig.limits.maxRollingCost),maxCampaignCost:String(operatorConfig.limits.maxCampaignCost),
  exitReserveWei:String(operatorConfig.limits.exitReserveWei),maxSlippageBps:operatorConfig.limits.maxSlippageBps};

 if(matrixMode||concurrencyMode){
  // Profile matrix / shared-wallet concurrency qualification (see header). All
  // transactions are signed by the synthetic local account and published only to
  // the owned fork; the upstream stays read-only behind the bounded fork proxy.
  const identity={chainId:4663,address:wallet};
  const emit=(event,fields={})=>console.error(JSON.stringify({event,...fields,at:new Date().toISOString()}));
  const matrixCtx={wallet,identity,local,fork,db,setup,commandUrl,commandHeaders,profileRows,operatorConfig,transferStore,anvilBinary,
   preflightLimits,readFreeCapital,decodeBigints,emit,worker:null,observer:null};
  let observer=null;
  // Same wiring as production: a non-open job re-anchors a stale wallet snapshot before planning.
  matrixCtx.worker=createWorkerRuntime(false,{refreshWalletSnapshot:async()=>{await refreshLocalSource(matrixCtx);await observer.refreshWallet();}});
  observer=createRangeKeeperLiveManagementObserver({pool:db,client:local,wallet:identity,
   loadProfiles:async()=>profileRows.map(row=>({id:row.id,profile:row.profile,profileHash:row.profile_hash})),transferStore,
   buildId:'e'.repeat(64),rpcUrl:fork.localUrl,anvilBinary,enqueue:input=>matrixCtx.worker.queue.enqueue(input),
   queueReady:matrixCtx.worker.adapters.managementObservationReady});
  matrixCtx.observer=observer;
  managementRuntime=createRangeKeeperLiveManagementRuntime({pool:db,wallet:identity,buildId:'e'.repeat(64),persistReviews:true,
   observe:observer.observe,verifyPinned:observer.verifyPinned,enqueue:input=>matrixCtx.worker.queue.enqueue(input)});
  const initialInventory=await setup.walletReview();assert.equal(initialInventory.status,'available',initialInventory.blockers.join(','));
  await assertFreshWalletAllowances({local,wallet,profileRows,operatorConfig});
  const capitalQuoteRaw=String(Math.round(capitalUsdg*10**operatorConfig.pool.decimals0));
  const runOptions={capitalQuoteRaw,widthOverrides,continueAfterFailure};
  const profiles=matrixMode?await runProfileMatrix(matrixCtx,matrixSelections,runOptions):undefined;
  const concurrency=concurrencyMode?await runConcurrencyScenarios(matrixCtx,concurrencySelections,runOptions):undefined;
  const outcomes=[...(profiles??[]).map(item=>item.outcome),...(concurrency?[concurrency.outcome]:[])];
  const count=name=>outcomes.filter(outcome=>outcome===name).length;
  const failed=outcomes.some(outcome=>['FAIL','FIXTURE_BLOCK','INFRA_BLOCK','NOT_RUN'].includes(outcome))||
   strictMarket&&outcomes.includes('MARKET_BLOCK');
  const matrixReport={event:failed?'rangekeeper_live_pool_matrix_failed':'rangekeeper_live_pool_matrix_verified',chainId:4663,wallet,
   mode:{matrix:matrixMode,concurrency:concurrencyMode},allowancePolicy:ALLOWANCE_POLICY,capitalUsdg,fundUsdg,
   source:{block:String(localSource.block),hash:localSource.hash,timestamp:localSource.timestamp},custodyBaseline:walletTransferFixture.baseline,
   registeredProfileCount:profileRows.length,
   structuralClasses:[...new Set([...matrixSelections,...concurrencySelections].map(item=>`${item.view.quoteSide}/fee${item.view.fee}/spacing${item.view.tickSpacing}`))],
   summary:{pass:count('PASS'),fail:count('FAIL'),marketBlock:count('MARKET_BLOCK'),fixtureBlock:count('FIXTURE_BLOCK'),
    infraBlock:count('INFRA_BLOCK'),notRun:count('NOT_RUN')},
   table:(profiles??[]).map(item=>({profile:item.label,quoteSide:item.profile.quoteSide,fee:item.profile.fee,tickSpacing:item.profile.tickSpacing,
    width:item.width??null,open:(item.openStages??[]).map(stage=>`${stage.kind}:${stage.gasUsed}`),
    close:(item.closeStages??[]).map(stage=>`${stage.kind}:${stage.gasUsed}`),outcome:item.outcome,reason:item.reason??null})),
   profiles,concurrency,signerCalls,
   forkReadBudget:fork.budget,forkReadDiagnostics:fork.diagnostics,directUpstreamReads:upstreamReads,upstreamMutations:0,
   upstreamMutationBoundary:{signer:'synthetic_local_account_only',publisher:'branded_owned_fork_only',upstreamClient:'read_only'}};
  console.log(JSON.stringify(matrixReport,(_,value)=>typeof value==='bigint'?String(value):value));
  if(failed)process.exitCode=1;
 }
 if(!matrixMode&&!concurrencyMode){
 const diagnosticFrame=await readCanonicalPaperOpenFrame(local,profile,{block:String(localSource.block),hash:localSource.hash,timestamp:localSource.timestamp});
 if(!diagnosticFrame.referenceEligible){
  const oracle=diagnosticFrame.referenceProof?.token0?.oracle;
  console.error(JSON.stringify({event:'live_worker_oracle_age_diagnostic',source:diagnosticFrame.source,reasons:diagnosticFrame.referenceReasons,
   token0:oracle?{priceAgeSeconds:oracle.priceAgeSeconds,feedHeartbeatSeconds:oracle.feed?.heartbeatSeconds,
    updatedAt:oracle.state?.updatedAt,reasons:oracle.reasons}:null}));
 }
 assert(diagnosticFrame.referenceEligible&&diagnosticFrame.price0&&diagnosticFrame.price1&&diagnosticFrame.nativePrice,
  `Funded local source lacks independent references: ${JSON.stringify({source:diagnosticFrame.source,reasons:diagnosticFrame.referenceReasons})}`);
 // In production the worker extends wallet history on its own cadence, so the head is
 // past the newest checkpoint whenever an operator reviews. Advance the fork head (same
 // timestamp) and require the review to anchor at the checkpoint rather than head-64.
 await fork.rpc('anvil_mine',['0x20','0x0']);
 assert((await rangeKeeperConfirmedSource(local)).block>localSource.block,'Fork head did not advance past the history checkpoint');
 const initialInventory=await setup.walletReview();assert.equal(initialInventory.status,'available',initialInventory.blockers.join(','));
 const initialBalanceByAddress=new Map(initialInventory.tokens.map(token=>[token.address.toLowerCase(),token.balanceRaw]));
 const preflightInput=rangeKeeperLiveSetupPreflightInput.parse({profileId:profileRow.id,capitalQuoteRaw:'50000000',
  fullWidthSpacings,limits:preflightLimits});
 const preflight=await reviewSetup(preflightInput);
 assert.equal(preflight.status,'indicative',JSON.stringify(preflight.missing));assert.equal(preflight.executionEligible,false);
 assert.equal(preflight.source.block,String(localSource.block),'Setup review did not anchor at the history checkpoint');
 assert.equal(initialInventory.source.block,String(localSource.block),'Wallet review did not anchor at the history checkpoint');
 const persisted=preflight.reviewPersistence;
 assert.equal(persisted?.status,'persisted',JSON.stringify(persisted));
 const reviewStore=createRangeKeeperLiveReviewStoreAdapter(db,wallet);
 const admission=await admitSetup({reviewId:persisted.reviewId,reviewHash:persisted.reviewHash,requestId:randomUUID()},
  {...reviewStore,wallet,buildId:'e'.repeat(64),revalidatePinned:async payload=>{
   assert.equal(payload.profileHash,profileRow.profile_hash);
   assert.equal(payload.profileId,profileRow.id);
   const expectedDisplay={pool:canonicalProfile.pool.pool,fee:canonicalProfile.pool.fee,tickSpacing:canonicalProfile.pool.tickSpacing,
    token0:canonicalProfile.pool.token0,token1:canonicalProfile.pool.token1,quoteToken:canonicalProfile.pool.quoteToken,
    decimals0:canonicalProfile.pool.decimals0,decimals1:canonicalProfile.pool.decimals1};
   assert.deepEqual(payload.profile,expectedDisplay,'Frozen display profile differs from the registered profile');
   assert.equal(contentHash(canonicalProfile),payload.profileHash,'Registered profile fingerprint changed');
   const valid=await verifyRangeKeeperLiveSetupPinnedReferences({client:local,profile:canonicalProfile,
    source:payload.source,profileHash:payload.profileHash,references:{price0:payload.references.price0,price1:payload.references.price1,
     nativePrice:payload.references.nativePrice,semanticProofHash:payload.references.semanticProofHash}});
   if(!valid){let frameDiagnostic;try{const frame=await readCanonicalPaperOpenFrame(local,canonicalProfile,payload.source);
    frameDiagnostic={referenceEligible:frame.referenceEligible,reasons:frame.referenceReasons,
     prices:[String(frame.price0),String(frame.price1),String(frame.nativePrice)],proofHash:frame.referenceProofHash};
   }catch(error){frameDiagnostic={error:error instanceof Error?error.message:String(error)};}
    const details={source:payload.source,
     ageSeconds:Math.floor(Date.now()/1000)-payload.source.timestamp,candidateExpiry:payload.candidate.expiresAt,
     expected:payload.references,frame:frameDiagnostic};
    console.error(JSON.stringify({event:'live_worker_pinned_revalidation_failed',details}));
    throw Error(`Pinned-reference revalidation diagnostic: ${JSON.stringify(details)}`);
   }
   return payload;
  },verifyCanonical:async s=>{
   const h=await local.getBlock({blockNumber:BigInt(s.block)});assert.equal(h.hash.toLowerCase(),s.hash.toLowerCase());}});
 assert.equal(admission.status,'queued',JSON.stringify(admission));
 const freeCapitalAfterAdmission=await readFreeCapital();
 let runtime=createWorkerRuntime(true);
 const first=await runtime.worker.execute();
 if(first.status!=='blocked'||!first.reason?.match(/injected_owned_fork_publish_ack_loss/)){
  const rows=(await db.query(`SELECT stage,status,nonce,intent_json,before_json FROM deployment_live_stage_outbox WHERE job_id=$1`,[admission.jobId])).rows;
  console.error(JSON.stringify({event:'live_worker_first_stage_unexpected',result:first,signerCalls,
   outbox:rows.map(row=>({stage:row.stage,status:row.status,nonce:String(row.nonce),intent:row.intent_json,
    authorizationKeys:Object.keys(row.before_json?.authorization??{})}))}));
 }
 assert.equal(first.status,'blocked',JSON.stringify(first));assert.match(first.reason,/injected_owned_fork_publish_ack_loss/,JSON.stringify(first));
 const jobId=admission.jobId,campaignId=admission.campaignId;
 const firstOutbox=(await db.query(`SELECT stage,status,signed_raw,signed_raw_hash FROM deployment_live_stage_outbox WHERE job_id=$1`,[jobId])).rows[0];
 assert(firstOutbox&&firstOutbox.signed_raw&&firstOutbox.status==='signed','Lost publish acknowledgement did not preserve signed raw bytes');
 const rawBeforeRestart=firstOutbox.signed_raw,hashBeforeRestart=firstOutbox.signed_raw_hash;
 // Simulate the process crash after the local publisher accepted these exact
 // bytes but before the worker persisted the acknowledgement. Only this crash
 // fixture expires its own fenced lease; ordinary stage progression uses the
 // queue's production yield path.
 await db.query(`UPDATE deployment_live_jobs SET lease_until=clock_timestamp()-interval '1 second'
  WHERE id=$1 AND status='blocked'`,[jobId]);
 runtime=createWorkerRuntime(false);
 const restart=await runtime.worker.execute();
 assert.equal(restart.status,'reconciled',JSON.stringify(restart));assert.equal(restart.stage,firstOutbox.stage);
 const recovered=(await db.query(`SELECT signed_raw,signed_raw_hash,status FROM deployment_live_stage_outbox WHERE job_id=$1 AND stage=$2`,
  [jobId,firstOutbox.stage])).rows[0];
 assert.equal(recovered.signed_raw,rawBeforeRestart,'Restart changed signed bytes');assert.equal(recovered.signed_raw_hash,hashBeforeRestart);
 assert.equal(signerCalls,1,'Restart signed a second transaction instead of recovering exact bytes');
 let crashAtFinish=true;
 const finishLifecycle=runtime.adapters.completeOpeningLifecycle;
 runtime.adapters.completeOpeningLifecycle=async value=>{if(crashAtFinish){crashAtFinish=false;throw Error('injected_crash_after_queue_finish');}
  return finishLifecycle(value);};
 const stageNames=[firstOutbox.stage];let workerResult=restart;
 for(let attempt=0;attempt<12;attempt++){
  const row=(await db.query(`SELECT status,lease_until FROM deployment_live_jobs WHERE id=$1`,[jobId])).rows[0];
  if(row.status==='succeeded')break;
  workerResult=await runtime.worker.execute();
  if(workerResult.stage&&!stageNames.includes(workerResult.stage))stageNames.push(workerResult.stage);
  if(workerResult.status==='idle')break;
  if(workerResult.status==='blocked'&&workerResult.reason==='injected_crash_after_queue_finish')break;
  assert(!['disabled'].includes(workerResult.status),`Worker gate closed: ${JSON.stringify(workerResult)}`);
 }
 let durable=(await db.query(`SELECT status FROM deployment_live_jobs WHERE id=$1`,[jobId])).rows[0];
 assert.equal(durable.status,'succeeded','OPEN queue job did not reach cleanup completion');
 let campaign=await readRangeKeeperLiveCampaign(db,{chainId:4663,address:wallet,campaignId,revision:1});
 if(campaign.status==='opening'){
  // Queue finish and campaign handoff are separate idempotent effects. A new
  // worker composition recovers the handoff from the already verified cleanup row.
  runtime=createWorkerRuntime(false);
  await runtime.worker.execute();campaign=await readRangeKeeperLiveCampaign(db,{chainId:4663,address:wallet,campaignId,revision:1});
 }
 assert.equal(campaign.status,'active');assert.equal(campaign.state?.phase,'holding');assert(campaign.state?.activeTokenId);
 const stages=(await db.query(`SELECT stage,status,plan_json,signed_raw_hash,canonical_receipt_json,effect_evidence_json,allowance_cleanup_json
  FROM deployment_live_stage_outbox WHERE job_id=$1 ORDER BY created_at,stage`,[jobId])).rows;
 assert(stages.length>=2,`Expected at least swap and mint lifecycle stages, got ${stages.map(s=>s.stage).join(',')}`);
 assert(stages.every(row=>row.status==='confirmed'&&row.canonical_receipt_json&&row.effect_evidence_json),'Every submitted stage needs canonical receipt evidence');
 assert.equal(new Set(stages.map(row=>row.signed_raw_hash)).size,stages.length,'Stage transaction hashes must be unique');
 const state=campaign.state,costHashes=state.costEvents.map(cost=>String(cost.hash).toLowerCase());
 assert.equal(costHashes.length,stages.length,'Every canonical stage receipt must be charged exactly once');
 assert.equal(new Set(costHashes).size,costHashes.length,'Receipt economics were replayed more than once');
 assert.deepEqual(new Set(costHashes),new Set(stages.map(row=>String(row.signed_raw_hash).toLowerCase())));
 const minted=await local.readContract({address:profile.pool.positionManager,
  abi:parseAbi(['function ownerOf(uint256 tokenId) view returns (address)']),functionName:'ownerOf',args:[BigInt(state.activeTokenId)]});
 assert.equal(minted.toLowerCase(),wallet,'Minted NFT is not held by the synthetic shared wallet');
 const position=await local.readContract({address:profile.pool.positionManager,
  abi:parseAbi(['function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)']),
  functionName:'positions',args:[BigInt(state.activeTokenId)]});assert(position[7]>0n,'Minted position has no liquidity');
 let finalWalletState=await readWalletState(db,{chainId:4663,address:wallet});
 assert.equal(finalWalletState.status,'available');assert(finalWalletState.source?.block);
 const freeCapitalAfterOpen=await readFreeCapital();
 assert.deepEqual(freeCapitalAfterOpen,freeCapitalAfterAdmission,'Opening changed free wallet capital outside the campaign allocation');
 const selectedTokens=new Set([profile.pool.token0,profile.pool.token1].map(address=>address.toLowerCase()));
 for(const token of finalWalletState.tokens){if(!selectedTokens.has(token.address.toLowerCase()))
  assert.equal(token.balanceRaw,initialBalanceByAddress.get(token.address.toLowerCase()),
   `Unrelated registered-pool token balance changed: ${token.address}`);}
 const allowanceCtx={local,wallet,profileRows,operatorConfig};
 const firstOpenShape=assertOpenApprovalShapes([{label:'AAPL open',stages,pool:profile.pool,candidate:preflight.candidate}],
  {decode:decodeBigints,initialNonzero:new Set()});
 let allowanceObservation=await assertAllowancePolicyAfterJob(allowanceCtx,{label:'AAPL open',stages,activePools:[profile.pool]});
 const nonzeroAfterFirstOpen=await readNonzeroAllowanceKeys(allowanceCtx);
 const nonzeroApproveProbe=await probeNonzeroToNonzeroApprove(allowanceCtx);
 let secondOpenShape=null;
 let secondCampaignEvidence=null,finalCampaignIds=[campaignId];
 if(twoPools){
  const secondCanonicalProfile=secondProfileRow.profile,secondProfile=secondCanonicalProfile.pool;
  const freeBeforeSecond=await readFreeCapital(),commitmentsBeforeSecond=await readCommitments(db,{chainId:4663,address:wallet});
  const firstCommitmentBefore=commitmentsBeforeSecond.allocations.find(row=>row.campaignId===campaignId);
  assert(firstCommitmentBefore,'First campaign allocation disappeared before second admission');
  const firstStateBefore=await readRangeKeeperLiveCampaign(db,{chainId:4663,address:wallet,campaignId,revision:1});
  const firstStateHashBefore=firstStateBefore.stateHash,firstPositionBefore=await local.readContract({address:profile.pool.positionManager,
   abi:parseAbi(['function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)']),
   functionName:'positions',args:[BigInt(firstStateBefore.state.activeTokenId)]});
  const secondPreflight=await reviewSetup(rangeKeeperLiveSetupPreflightInput.parse({profileId:secondProfileRow.id,
   capitalQuoteRaw:'30000000',fullWidthSpacings,limits:preflightLimits}));
  assert.equal(secondPreflight.status,'indicative',JSON.stringify(secondPreflight.missing));
  assert.equal(secondPreflight.executionEligible,false);
  const secondReview=secondPreflight.reviewPersistence;
  assert.equal(secondReview?.status,'persisted',JSON.stringify(secondReview));
  const secondAdmission=await admitSetup({reviewId:secondReview.reviewId,reviewHash:secondReview.reviewHash,requestId:randomUUID()},
   {...createRangeKeeperLiveReviewStoreAdapter(db,wallet),wallet,buildId:'e'.repeat(64),revalidatePinned:async payload=>{
    assert.equal(payload.profileHash,secondProfileRow.profile_hash);assert.equal(payload.profileId,secondProfileRow.id);
    assert.equal(contentHash(secondCanonicalProfile),payload.profileHash,'Second registered profile fingerprint changed');
    const expectedDisplay={pool:secondProfile.pool,fee:secondProfile.fee,tickSpacing:secondProfile.tickSpacing,
     token0:secondProfile.token0,token1:secondProfile.token1,quoteToken:secondProfile.quoteToken,
     decimals0:secondProfile.decimals0,decimals1:secondProfile.decimals1};
    assert.deepEqual(payload.profile,expectedDisplay,'Second frozen display profile differs from registry');
    const valid=await verifyRangeKeeperLiveSetupPinnedReferences({client:local,profile:secondCanonicalProfile,
     source:payload.source,profileHash:payload.profileHash,references:{price0:payload.references.price0,price1:payload.references.price1,
      nativePrice:payload.references.nativePrice,semanticProofHash:payload.references.semanticProofHash}});
    if(!valid)throw Error(`Second pool pinned-reference revalidation failed: ${JSON.stringify({source:payload.source,
     ageSeconds:Math.floor(Date.now()/1000)-payload.source.timestamp,profileId:payload.profileId})}`);
    return payload;
   },verifyCanonical:async pinnedSource=>{
    const header=await local.getBlock({blockNumber:BigInt(pinnedSource.block)});
    assert.equal(header.hash.toLowerCase(),pinnedSource.hash.toLowerCase());
   }});
  assert.equal(secondAdmission.status,'queued',JSON.stringify(secondAdmission));
  const freeAfterSecondAdmission=await readFreeCapital(),commitmentsAfterSecondAdmission=await readCommitments(db,{chainId:4663,address:wallet});
  const secondCommitmentAfterAdmission=commitmentsAfterSecondAdmission.allocations.find(row=>row.campaignId===secondAdmission.campaignId);
  assert(secondCommitmentAfterAdmission,'Second allocation was not reserved');
  const sharedStable=secondProfile.token0.toLowerCase()===profile.pool.token0.toLowerCase()?profile.pool.token0:
   secondProfile.token0.toLowerCase()===profile.pool.token1.toLowerCase()?profile.pool.token1:
   secondProfile.token1.toLowerCase()===profile.pool.token0.toLowerCase()?profile.pool.token0:profile.pool.token1;
  assert(firstCommitmentBefore.tokens.some(token=>token.address.toLowerCase()===sharedStable.toLowerCase())&&
   secondCommitmentAfterAdmission.tokens.some(token=>token.address.toLowerCase()===sharedStable.toLowerCase()),
   'Concurrent AAPL fee-tier allocations do not share the USDG token commitment');
  for(const [address,freeRaw] of Object.entries(freeBeforeSecond.tokens)){
   const reserved=secondCommitmentAfterAdmission.tokens.find(token=>token.address.toLowerCase()===address)?.allocatedRaw??'0';
   const pending=secondCommitmentAfterAdmission.tokens.find(token=>token.address.toLowerCase()===address)?.pendingSpendRaw??'0';
   assert.equal(BigInt(freeRaw)-BigInt(freeAfterSecondAdmission.tokens[address]??'0'),BigInt(reserved)+BigInt(pending),
    `Second reservation did not conserve free token inventory ${address}`);
  }
  assert.equal(BigInt(freeBeforeSecond.nativeWei)-BigInt(freeAfterSecondAdmission.nativeWei),
   BigInt(secondCommitmentAfterAdmission.nativeSpendWei)+BigInt(secondCommitmentAfterAdmission.pendingNativeSpendWei)+
    BigInt(secondCommitmentAfterAdmission.exitReserveWei),'Second reservation did not conserve free native inventory');
  const secondRuntime=createWorkerRuntime(false);let secondWorkerResult;
  for(let attempt=0;attempt<16;attempt++){
   const currentJob=(await db.query(`SELECT status FROM deployment_live_jobs WHERE id=$1`,[secondAdmission.jobId])).rows[0];
   if(currentJob?.status==='succeeded')break;
   secondWorkerResult=await secondRuntime.worker.execute();
   assert(!['blocked','disabled','idle'].includes(secondWorkerResult.status),
    `Second pool worker stopped: ${JSON.stringify(secondWorkerResult)}`);
  }
  const secondJob=(await db.query(`SELECT status FROM deployment_live_jobs WHERE id=$1`,[secondAdmission.jobId])).rows[0];
  assert.equal(secondJob?.status,'succeeded','Second AAPL fee-3000 campaign did not reach cleanup completion');
  const secondCampaign=await readRangeKeeperLiveCampaign(db,{chainId:4663,address:wallet,campaignId:secondAdmission.campaignId,revision:1});
  assert.equal(secondCampaign.status,'active');assert.equal(secondCampaign.profileId,secondProfileRow.id);
  assert.equal(secondCampaign.state?.phase,'holding');assert(secondCampaign.state?.activeTokenId);
  const secondStages=(await db.query(`SELECT stage,status,plan_json,signed_raw_hash,canonical_receipt_json,effect_evidence_json,allowance_cleanup_json
   FROM deployment_live_stage_outbox WHERE job_id=$1 ORDER BY created_at,stage`,[secondAdmission.jobId])).rows;
  assert(secondStages.length>=2&&secondStages.every(row=>row.status==='confirmed'&&row.canonical_receipt_json&&row.effect_evidence_json),
   'Second campaign lacks complete canonical stage receipt evidence');
  const secondCostHashes=secondCampaign.state.costEvents.map(cost=>String(cost.hash).toLowerCase());
  assert.equal(secondCostHashes.length,secondStages.length,'Second campaign receipt costs were omitted or double-counted');
  assert.deepEqual(new Set(secondCostHashes),new Set(secondStages.map(row=>String(row.signed_raw_hash).toLowerCase())));
  const secondTokenId=String(secondCampaign.state.activeTokenId);
  assert.notEqual(secondTokenId,String(firstStateBefore.state.activeTokenId),'Campaigns reused one NFT token ID');
  const secondPosition=await local.readContract({address:secondProfile.positionManager,
   abi:parseAbi(['function ownerOf(uint256 tokenId) view returns (address)','function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)']),
   functionName:'positions',args:[BigInt(secondTokenId)]});
  // ownerOf is separately checked because viem's positions tuple is the function above.
  const secondOwner=await local.readContract({address:secondProfile.positionManager,
   abi:parseAbi(['function ownerOf(uint256 tokenId) view returns (address)']),functionName:'ownerOf',args:[BigInt(secondTokenId)]});
  assert.equal(secondOwner.toLowerCase(),wallet);assert(secondPosition[7]>0n,'Second pool position has no liquidity');
  const firstAfterSecond=await readRangeKeeperLiveCampaign(db,{chainId:4663,address:wallet,campaignId,revision:1});
  assert.equal(firstAfterSecond.stateHash,firstStateHashBefore,'Opening the second pool changed first campaign state hash');
  assert.deepEqual(firstAfterSecond.state,firstStateBefore.state,'Opening the second pool changed first campaign strategy state');
  const commitmentsAfterSecond=await readCommitments(db,{chainId:4663,address:wallet});
  const firstCommitmentAfter=commitmentsAfterSecond.allocations.find(row=>row.campaignId===campaignId);
  assert.deepEqual(firstCommitmentAfter,firstCommitmentBefore,'Opening the second pool changed first campaign allocation');
  const activeNfts=commitmentsAfterSecond.nftCustody.filter(row=>row.status==='active');
  assert.equal(activeNfts.length,2,'Two active campaign NFTs are not represented in wallet custody');
  assert(activeNfts.some(row=>row.tokenId===String(firstStateBefore.state.activeTokenId)&&row.campaignId===campaignId)&&
   activeNfts.some(row=>row.tokenId===secondTokenId&&row.campaignId===secondAdmission.campaignId),
   'Campaign NFT custody is not independently attributed');
  const firstPositionAfter=await local.readContract({address:profile.pool.positionManager,
   abi:parseAbi(['function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)']),
   functionName:'positions',args:[BigInt(firstStateBefore.state.activeTokenId)]});
  assert.deepEqual(firstPositionAfter.map(String),firstPositionBefore.map(String),'Second pool open changed first NFT position');
  const allWalletOutbox=(await db.query(`SELECT nonce FROM deployment_live_stage_outbox WHERE chain_id=4663 AND wallet=$1`,[wallet])).rows;
  assert.equal(new Set(allWalletOutbox.map(row=>String(row.nonce))).size,allWalletOutbox.length,'Wallet-wide transaction nonces collided');
  const freeAfterSecondOpen=await readFreeCapital();
  assert.deepEqual(freeAfterSecondOpen,freeAfterSecondAdmission,'Second open spent capital outside its own reserved allocation');
  secondOpenShape=assertOpenApprovalShapes([{label:'second pool open',stages:secondStages,pool:secondProfile,candidate:secondPreflight.candidate}],
   {decode:decodeBigints,initialNonzero:nonzeroAfterFirstOpen});
  allowanceObservation=await assertAllowancePolicyAfterJob(allowanceCtx,{label:'second pool open',stages:secondStages,
   activePools:[profile.pool,secondProfile]});
  finalWalletState=await readWalletState(db,{chainId:4663,address:wallet});
  secondCampaignEvidence={profileId:secondProfileRow.id,pool:secondProfile.pool,jobId:secondAdmission.jobId,campaignId:secondAdmission.campaignId,
   stageCount:secondStages.length,tokenId:secondTokenId,liquidity:String(secondPosition[7]),freeCapitalConserved:true,
   firstCampaignStateHashUnchanged:firstAfterSecond.stateHash===firstStateHashBefore,firstAllocationUnchanged:true,
   sharedToken:sharedStable,activeNftCount:activeNfts.length,walletNonceCount:allWalletOutbox.length};
  finalCampaignIds.push(secondAdmission.campaignId);
 }
 let retainedClosureEvidence=null;
 if(retainFirst){
  const {createRangeKeeperLiveManagementObserver}=await import('../../src/deployments/rangekeeper-live-management-observer.ts');
  const managementWorker=createWorkerRuntime(false),identity={chainId:4663,address:wallet};
  const observer=createRangeKeeperLiveManagementObserver({pool:db,client:local,wallet:identity,
   loadProfiles:async()=>profileRows.map(row=>({id:row.id,profile:row.profile,profileHash:row.profile_hash})),transferStore,buildId:'e'.repeat(64),
   rpcUrl:fork.localUrl,anvilBinary,enqueue:input=>managementWorker.queue.enqueue(input),
   queueReady:managementWorker.adapters.managementObservationReady});
  const holdingObservation=await observer.observeHoldingCampaigns();
  assert.equal(holdingObservation.recorded,2,JSON.stringify(holdingObservation));
  managementRuntime=createRangeKeeperLiveManagementRuntime({pool:db,wallet:identity,buildId:'e'.repeat(64),
   persistReviews:true,observe:observer.observe,verifyPinned:observer.verifyPinned,enqueue:input=>managementWorker.queue.enqueue(input)});
  const positionsResponse=await fetch(commandUrl+'/api/positions'),positionsBody=await positionsResponse.json();
  assert.equal(positionsResponse.status,200,JSON.stringify(positionsBody));
  const holdings=positionsBody.positions.filter(position=>finalCampaignIds.includes(position.deployment?.campaignId));
  assert.equal(holdings.length,2,'Actual Positions API omitted a concurrent live campaign');
  const projectionMarketBlocks=[];
  for(const position of holdings){
   if(position.accounting!=='recorded'){
    const diagnostic=await diagnoseLatestMark(db,position.deployment.campaignId,decodeBigints);
    console.error(JSON.stringify({event:'live_holding_projection_diagnostic',campaignId:position.deployment?.campaignId,reasons:position.reasons,mark:diagnostic}));
    if(marketClosedStaleReference(diagnostic)){projectionMarketBlocks.push({campaignId:position.deployment.campaignId,phase:'holding',staleFlags:diagnostic.staleFlags});continue;}
   }
   assert.equal(position.accounting,'recorded',JSON.stringify(position.reasons));
   assert([position.navQuote,position.feesQuote,position.gasQuote,position.holdQuote].every(value=>typeof value==='string'),
    `Holding economics remain unavailable: ${JSON.stringify(position)}`);
  }
  const nonzeroBeforeRetain=await readNonzeroAllowanceKeys(allowanceCtx);
  const siblingId=finalCampaignIds[1],siblingBefore=await readRangeKeeperLiveCampaign(db,{...identity,campaignId:siblingId}),
   siblingAllocationBefore=(await readCommitments(db,identity)).allocations.find(row=>row.campaignId===siblingId);
  const previewResponse=await fetch(commandUrl+`/api/deployments/${campaignId}/live/retain-preview`,{
   method:'POST',headers:commandHeaders,body:'{}'});assert.equal(previewResponse.status,200);
  const preview=await previewResponse.json();assert.equal(preview.status,'indicative',JSON.stringify(preview));
  assert.equal(preview.actionAvailable,true);assert.equal(preview.executionEligible,false);
  const retainInput={previewId:preview.previewId,contentDigest:preview.contentDigest,
   expectedRevision:preview.expectedRevision,idempotencyKey:randomUUID()},retainPath=commandUrl+`/api/deployments/${campaignId}/live/retain-operations`;
  const retainResponse=await fetch(retainPath,{method:'POST',headers:commandHeaders,body:JSON.stringify(retainInput)});
  const retained=await retainResponse.json();assert.equal(retainResponse.status,202,JSON.stringify(retained));
  const replayBefore=await fetch(retainPath,{method:'POST',headers:commandHeaders,body:JSON.stringify(retainInput)});
  assert.equal(replayBefore.status,200);assert.equal((await replayBefore.json()).jobId,retained.jobId);
  for(let attempt=0;attempt<16;attempt++){
   if((await db.query('SELECT status FROM deployment_live_jobs WHERE id=$1',[retained.jobId])).rows[0]?.status==='succeeded')break;
   const result=await managementWorker.worker.execute();
   assert(!['blocked','disabled','idle'].includes(result.status),`Retain worker stopped: ${JSON.stringify(result)}`);
  }
  const closed=(await db.query(`SELECT c.lifecycle,r.state_json,r.state_hash FROM deployment_campaigns c
   JOIN deployment_live_campaign_runtime r ON r.campaign_id=c.id AND r.revision=c.current_revision WHERE c.id=$1`,[campaignId])).rows[0];
  assert.equal(closed?.lifecycle,'closed');const closedState=decodeBigints(closed.state_json);
  assert.equal(closedState.phase,'closed');assert.equal(closedState.activeTokenId,null);
  const retainStages=(await db.query(`SELECT stage,status,plan_json,signed_raw_hash,allowance_cleanup_json FROM deployment_live_stage_outbox
   WHERE job_id=$1 ORDER BY created_at`,[retained.jobId])).rows;
  const closeShape=assertRetainStagePlans(retainStages,{decode:decodeBigints,label:'AAPL retain',nonzeroBefore:nonzeroBeforeRetain,
   closingPool:profile.pool,siblingPools:[secondProfileRow.profile.pool]});
  const closeAllowance=await assertAllowancePolicyAfterClose(allowanceCtx,{label:'AAPL retain',retainStages,siblingPools:[secondProfileRow.profile.pool]});
  assert.equal(closedState.costEvents.length,stages.length+retainStages.length,'Retain receipt costs were omitted or duplicated');
  assert.equal(new Set(closedState.costEvents.map(event=>event.hash)).size,closedState.costEvents.length);
  assert.equal((await db.query('SELECT state FROM deployment_live_allocations WHERE campaign_id=$1',[campaignId])).rows[0]?.state,'released');
  const siblingAfter=await readRangeKeeperLiveCampaign(db,{...identity,campaignId:siblingId});
  assert.equal(siblingAfter.stateHash,siblingBefore.stateHash,'Retain close changed sibling campaign state');
  assert.deepEqual((await readCommitments(db,identity)).allocations.find(row=>row.campaignId===siblingId),siblingAllocationBefore,
   'Retain close changed sibling allocation');
  const replayAfter=await fetch(retainPath,{method:'POST',headers:commandHeaders,body:JSON.stringify(retainInput)});
  assert.equal(replayAfter.status,200);assert.equal((await replayAfter.json()).jobId,retained.jobId,'Closed campaign retry created a new job');
  const detailResponse=await fetch(commandUrl+`/api/positions/live-dep-${campaignId}?hours=0`);
  assert.equal(detailResponse.status,200);const detail=await detailResponse.json();
  if(detail.position.accounting!=='recorded'){
   const terminal=(await db.query(`SELECT m.state_json,m.state_hash,m.config_hash,e.payload,e.payload_hash,
    e.source_block::text,e.source_hash,e.source_timestamp FROM deployment_live_campaign_runtime m
    JOIN deployment_live_runtime_events e ON e.campaign_id=m.campaign_id AND e.revision=m.revision
    WHERE m.campaign_id=$1 AND e.kind='closed' ORDER BY e.sequence DESC LIMIT 1`,[campaignId])).rows[0];
   writeFileSync('/tmp/conc-liq-live-retain-terminal-diagnostic-20261003.json',
    JSON.stringify({position:detail.position,terminal},null,2).replace(/https?:\/\/[^"\s]+/g,'[redacted-url]'),{mode:0o600});
  }
  assert.equal(detail.position.status,'closed');
  let terminalEconomicsRecorded=true;
  if(detail.position.accounting!=='recorded'){
   const diagnostic=await diagnoseLatestMark(db,campaignId,decodeBigints);
   console.error(JSON.stringify({event:'live_terminal_projection_diagnostic',reasons:detail.position.reasons,mark:diagnostic}));
   assert(marketClosedStaleReference(diagnostic),`Terminal economics unavailable: ${JSON.stringify(detail.position.reasons)}`);
   terminalEconomicsRecorded=false;projectionMarketBlocks.push({campaignId,phase:'closed',staleFlags:diagnostic.staleFlags});
  }else{
   assert.equal(detail.position.accounting,'recorded',JSON.stringify(detail.position));
   assert(typeof detail.position.navQuote==='string'&&typeof detail.position.gasQuote==='string','Terminal economics were not retained');
   assert(detail.performance?.markCount>=2&&detail.performance?.rows?.some(row=>typeof row.netPnlQuote==='string'),
    `Live history remains unavailable: ${JSON.stringify(detail.performance)}`);
  }
  retainedClosureEvidence={jobId:retained.jobId,campaignId,stageCount:retainStages.length,closeShape,closeAllowance,siblingAllocationUnchanged:true,
   replayAfterClosure:true,holdingEconomicsCount:holdings.length,terminalNavQuote:detail.position.navQuote,
   terminalNativeWei:detail.position.inventory.nativeWei,terminalEconomicsRecorded,
   projectionMarketBlocks:projectionMarketBlocks.length?projectionMarketBlocks:undefined};
  finalWalletState=await readWalletState(db,identity);
 }
 const report={event:'rangekeeper_shared_wallet_worker_fork_verified',chainId:4663,wallet,profileId:profileRow.id,
  source:{block:String(localSource.block),hash:localSource.hash,timestamp:localSource.timestamp},
  custodyBaseline:walletTransferFixture.baseline,jobId,campaignId,stages:stages.map(row=>({stage:row.stage,status:row.status,hash:row.signed_raw_hash})),
  recovery:{lostAckBlocked:true,signedRawPreserved:recovered.signed_raw===rawBeforeRestart,signerCalls,queueFinishHandoffRecovered:crashAtFinish===false},
  position:{tokenId:String(state.activeTokenId),liquidity:String(position[7])},costEvents:costHashes.length,stageCount:stages.length,
  dashboardHttpAdmission:dashboardAdmission,registeredProfileCount:profileRows.length,registeredTokenCount:initialBalanceByAddress.size,
  freeCapitalUnchanged:true,
  untouchedSiblingTokenAddresses:[...initialBalanceByAddress.keys()].filter(address=>!selectedTokens.has(address)),
  allowancePolicy:allowanceObservation,openApprovalShapes:{first:firstOpenShape,second:secondOpenShape},nonzeroApproveProbe,walletGeneration:String(finalWalletState.generation),
  pools:{count:finalCampaignIds.length,campaignIds:finalCampaignIds,second:secondCampaignEvidence},
  retainedClosure:retainedClosureEvidence,
  directUpstreamReads:upstreamReads,forkReadBudget:fork.budget,forkReadDiagnostics:fork.diagnostics,upstreamMutations:0,
  upstreamMutationBoundary:{signer:'synthetic_local_account_only',publisher:'branded_owned_fork_only',
   upstreamClient:'read_only',rejectedPinnedReadMethods:Object.keys(fork.diagnostics.rejectedPinnedReads)}};
 console.log(JSON.stringify(report,(_,value)=>typeof value==='bigint'?String(value):value));
 }
}catch(error){
 if(error!==planSentinel){
  console.error(JSON.stringify({error:(error instanceof Error?error.stack:String(error)).replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,1200),
   forkBudget:fork?.budget??null,forkDiagnostics:fork?.diagnostics??null}));
  process.exitCode=1;
 }
}finally{
 if(commandServer){commandServer.closeAllConnections();commandServer.close();await once(commandServer,'close');}
 try{if(fork)await fork.close();}catch{}
 try{await db?.end();}catch{}
 try{await dashboardRepository?.close();}catch{}
 try{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}catch{}
 try{admin.release();await root.end();}catch{}
}
