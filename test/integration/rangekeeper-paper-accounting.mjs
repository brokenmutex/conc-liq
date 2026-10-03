// Isolated PostgreSQL proof for RangeKeeper's hypothetical observed-flow
// economics journal on the deployed v11 schema. Test-only marks and chain
// anchors are shaped using the existing RangeKeeper deployment fixtures; no
// live transaction, production database, migration above v11, or earned-fee
// ledger write is performed.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {MIGRATIONS} from '../../src/storage/migrations.ts';
import {MIGRATION_CHECKSUMS} from '../../src/storage/migration-checksums.ts';
import {DeploymentStore,DeploymentConflict} from '../../src/deployments/store.ts';
import {marketProfileSchema,referenceProofHash} from '../../src/deployments/market-profile.ts';
import {contentHash,rangeKeeperParameters} from '../../src/deployments/contracts.ts';
import {UNISWAP_V3_FACTORY,NONFUNGIBLE_POSITION_MANAGER} from '../../src/constants.ts';
import {PAPER_ROUTER,PAPER_QUOTER} from '../../src/paper/execution-abi.ts';
import {sqrtRatioAtTick,principalAmounts} from '../../src/backtest/principal.ts';
import {replayPaperMint} from '../../src/v3/position-math.ts';
import {readIndexedPaperFeeInterval} from '../../src/deployments/paper-fee-replay.ts';
import {buildRangeKeeperPaperConfirmedOpenInventory} from
 '../../src/deployments/rangekeeper-paper-confirmed-open-adapter.ts';
import {recordCanonicalNextRangeKeeperPaperAccounting,
 RANGEKEEPER_PAPER_ACCOUNTING_POLICY} from '../../src/deployments/paper-accounting.ts';
import {auditCanonicalRangeKeeperPaperAccounting} from '../../src/deployments/paper-accounting.ts';
import {ExperimentMarket} from '../../src/experiment/market.ts';

assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');
assert(new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('/conc_liq_rk_economics_check_20261003'),
 'This integration is restricted to the disposable RangeKeeper economics database');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});
const admin=await pool.connect(),schema=`rk_paper_accounting_${randomUUID().replaceAll('-','')}`;
let store,indexer;

/** Apply only the already-frozen production migration prefix used by v11.
 * This is test-schema bootstrap, not a production migration path. */
async function migrateV11(client){
 await client.query(`CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  method TEXT NOT NULL CHECK(method IN ('applied','verified_baseline')))`);
 for(let index=0;index<11;index++){
  await client.query(MIGRATIONS[index]);
  await client.query('INSERT INTO schema_migrations(version,checksum,method) VALUES($1,$2,$3)',
   [index+1,MIGRATION_CHECKSUMS[index],'applied']);
 }
}

try{
 await admin.query(`CREATE SCHEMA "${schema}"`);
 await admin.query(`SET search_path="${schema}"`);
 await migrateV11(admin);
 const scopedUrl=new URL(process.env.TEST_DATABASE_URL);
 scopedUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 const runtimeIdentity={buildId:'1'.repeat(64),configHash:'2'.repeat(64),nodeVersion:process.version};
 process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify(runtimeIdentity);
 store=new DeploymentStore(scopedUrl.toString());await store.assertReady();
 assert.equal((await admin.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0].v,11);
 indexer=new pg.Pool({connectionString:scopedUrl.toString(),max:2});

 // Reuse the registered-profile, fixed-frame and indexer fixture conventions
 // from deployments.mjs.  This is a test-only operation-result fixture: it
 // uses the confirmed-open model/inventory builders and real accounting,
 // fee-replay and append-only store methods, but does not claim a live fill.
 const wallet='0x1111111111111111111111111111111111111111',poolAddress='0x'+'a'.repeat(40),
  token0='0x'+'b'.repeat(40),token1='0x'+'c'.repeat(40),codeHash='0x'+'a'.repeat(64),
  blockHash=n=>'0x'+n.repeat(64),stream='rk-accounting-test',targetSetHash='0x'+'f'.repeat(64),
  Q128=1n<<128n;
 const market=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,pool:poolAddress,
  token0,token1,quoteToken:1,decimals0:18,decimals1:6,fee:3000,tickSpacing:60,
  positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
  poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
  managerCodeHash:codeHash,quoterCodeHash:codeHash,reference0:'BASE/USD',reference1:'USDG/USD',
  nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{token0:{kind:'stock_token',
   maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
   token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
   nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
 const profileProof={fixture:'independent-reference-proof'},profileHash=contentHash(market),
  reference={price0:'1000000000000000000',price1:'1000000000000000000',
   nativePrice:'1000000000000000000',proofHash:referenceProofHash(profileProof)},
  markReference={...reference,eligible:true,proof:profileProof},
  openAt={block:'100',hash:blockHash('1'),timestamp:Math.floor(Date.now()/1000)-50},
  beforeRecenterAt={block:'101',hash:blockHash('2'),timestamp:openAt.timestamp+10},
  recenterAt={block:'102',hash:blockHash('3'),timestamp:openAt.timestamp+20},
  nextAt={block:'103',hash:blockHash('4'),timestamp:openAt.timestamp+30},
  secondRecenterAt={block:'104',hash:blockHash('5'),timestamp:openAt.timestamp+40},
  closeAt={block:'105',hash:blockHash('6'),timestamp:openAt.timestamp+50};
 await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
  created_block,target_set_hash,enabled) VALUES($1,$2,4663,'BASE',$3,3000,1,$4,true)`,
  [stream,poolAddress,token0,targetSetHash]);
 const registered=await store.registerVerifiedMarketProfile({profile:market,profileHash,
  streamKey:stream,source:openAt,contractHashes:{poolCodeHash:codeHash,token0CodeHash:codeHash,
   token1CodeHash:codeHash,managerCodeHash:codeHash,quoterCodeHash:codeHash},references:reference,
  referenceProof:profileProof,verifiedAt:new Date().toISOString()});
 const allocation={token0Raw:'1000000000000000000',token1Raw:'1000000000',nativeWei:'10000000000000000'},
  limits={minDeploymentValue:'0',maxDeploymentValue:'1000000000000000000',
   minDeploymentPpm:0,maxSwapInputValue:'1000000000000000000',maxSwapInputPpm:1000000,
   maxSwapShortfallValue:'1000000000000000000',maxSlippageBps:50,maxRecenters:3,
   maxLiquiditySharePpm:100000,maxObservationGapSeconds:300,maxExposurePpm:1000000,
   maxLossValue:'1000000000000000000',maxDrawdownPpm:1000000,
   exitReserveWei:'0',maxActionCost:'1000000000000000000',
   maxRollingCost:'1000000000000000000',maxCampaignCost:'1000000000000000000'};
 const parsedParameters=rangeKeeperParameters.parse({fullWidthSpacings:2,limits}),
  draft=await store.createDraft({mode:'paper',chainId:4663,wallet,marketProfileId:registered.id,
   strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,allocation,
   config:parsedParameters});
 const decimals0=market.pool.decimals0,
  decimals1=market.pool.decimals1,range0={tickLower:-60,tickUpper:60},
  range1={tickLower:-120,tickUpper:120},range2={tickLower:-180,tickUpper:180},
  sqrt0=sqrtRatioAtTick(0),sqrt1=sqrtRatioAtTick(0),
  mint0=replayPaperMint(sqrt0,range0,10n**15n,10n**8n,0n),
  mint1=replayPaperMint(sqrt1,range1,10n**15n,10n**8n,0n),
  mint2=replayPaperMint(sqrt1,range2,10n**15n,10n**8n,0n),
  candidate={kind:'entry',range:range0,swap:null,amount0Desired:'1000000000000000',
   amount1Desired:'100000000',amount0Min:'0',amount1Min:'0',liquidity:String(mint0.liquidity),
   deployedValue:'1000000000000000',sourceBlock:'100',sourceHash:openAt.hash,expiresAt:openAt.timestamp+90},
  model={kind:'rangekeeper_paper_open_model',status:'indicative',actionAvailable:false,
   campaignId:draft.id,revision:1,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',
   kernelPolicyHash:'a'.repeat(64),kernelBuildId:'b'.repeat(64),candidateHash:'c'.repeat(64),
   source:openAt,poolState:{tick:0,sqrtPriceX96:String(sqrt0),poolLiquidity:'1000000000000'},
   reference:{...reference,eligible:true,proof:profileProof,reasons:[]},
   costs:{status:'provisional',profileIds:[],open:{expectedValue:'10',boundValue:'12',
    expectedWei:'100',boundWei:'120'}},candidate,allocation,
   candidateHash:'c'.repeat(64)};
 // Candidate identity is recomputed by downstream consumers from frozen model
 // bytes; this fixture exercises the canonical accounting journals only.
 const openingInventory=buildRangeKeeperPaperConfirmedOpenInventory({model,allocation,decimals0,decimals1}),
  openingProvenance={classification:'rangekeeper_paper_open_v1',source:openAt,reference:markReference,
   modelHash:contentHash(model),confirmedOpen:{model},poolState:model.poolState,epoch:0},
  sequence=(await admin.query(`SELECT pg_get_serial_sequence('deployment_marks','id') AS seq`)).rows[0].seq;
 await admin.query('SELECT setval($1::regclass,998,true)',[sequence]);
 const insertMark=async({source,inventory,provenance})=>(await admin.query(`INSERT INTO deployment_marks
  (campaign_id,revision,source_block,source_hash,inventory,economics,calibration_profile_ids,provenance)
  VALUES($1,1,$2,$3,$4,NULL,'{}'::uuid[],$5) RETURNING id::text AS id`,[draft.id,source.block,
   source.hash,JSON.stringify(inventory),JSON.stringify(provenance)])).rows[0].id;
 const openId=await insertMark({source:openAt,inventory:openingInventory,provenance:openingProvenance});
 assert.equal(openId,'999','opening fixture crosses the decimal mark-id boundary');
 const makePosition=(range,mint)=>({tickLower:range.tickLower,tickUpper:range.tickUpper,
  liquidity:String(mint.liquidity),amount0Minted:String(mint.amount0),amount1Minted:String(mint.amount1)}),
  commonProv=(source,sqrt,epoch,position)=>({source,epoch,poolState:{tick:sqrt===sqrt0?0:60,
   sqrtPriceX96:String(sqrt),poolLiquidity:String(10n**12n)},reference:markReference,
   kernelSnapshot:{nativeWei:allocation.nativeWei},
  costs:{},operationId:randomUUID()}),
  positionInventory=(position,idle={token0:'0',token1:'0'})=>({position,idle});
 const preRecenterId=await insertMark({source:beforeRecenterAt,
  inventory:positionInventory(makePosition(range0,mint0)),
  provenance:{classification:'rangekeeper_paper_mark_v1',...commonProv(beforeRecenterAt,sqrt0,0,
   makePosition(range0,mint0))}});
 assert.equal(preRecenterId,'1000','valuation before recenter crosses decimal mark-id boundary');
 const recenterId=await insertMark({source:recenterAt,
  inventory:positionInventory(makePosition(range1,mint1)),
  provenance:{classification:'rangekeeper_paper_recenter_v1',...commonProv(recenterAt,sqrt1,1,
   makePosition(range1,mint1)),modeledCosts:{boundValue:'4',boundWei:'40'}}});
 assert.equal(recenterId,'1001');
 const nextId=await insertMark({source:nextAt,
  inventory:positionInventory(makePosition(range1,mint1)),
  provenance:{classification:'rangekeeper_paper_mark_v1',...commonProv(nextAt,sqrt1,1,
   makePosition(range1,mint1))}});
 const secondRecenterId=await insertMark({source:secondRecenterAt,
  inventory:positionInventory(makePosition(range2,mint2)),
  provenance:{classification:'rangekeeper_paper_recenter_v1',...commonProv(secondRecenterAt,sqrt1,2,
   makePosition(range2,mint2)),modeledCosts:{boundValue:'6',boundWei:'60'}}});
 const closeId=await insertMark({source:closeAt,inventory:{position:null,idle:{token0:'0',token1:'0'}},
  provenance:{classification:'rangekeeper_paper_close_retain_v1',...commonProv(closeAt,sqrt1,2,null),
   modeledCosts:{boundValue:'8',boundWei:'80'},
   reference:{price0:null,price1:null,nativePrice:null,proofHash:referenceProofHash({missing:true}),
    eligible:false,proof:{missing:true}}}});
 await admin.query("UPDATE deployment_campaigns SET lifecycle='closed',closed_at=clock_timestamp() WHERE id=$1",
  [draft.id]);
 // Indexed pool/event fixture supplies two independently retained epoch
 // carries, with an unchanged valuation inside each sampled interval.
 const seedPrice=String(sqrtRatioAtTick(0)),seed={price:seedPrice,tick:0,
  liquidity:'1000000000000',global0:'0',global1:'0',protocol0:0,protocol1:0,fee:3000,spacing:60,
  ticks:[{tick:-180,gross:'1000000000000',net:'1000000000000'},
   {tick:180,gross:'1000000000000',net:'-1000000000000'}]},
  feeMarket=new ExperimentMarket(seed);
 await admin.query(`INSERT INTO v3_replay_cursors(stream_key,chain_id,target_set_hash,
  complete_through_block,complete_through_hash) VALUES($1,4663,$2,105,$3)`,
  [stream,targetSetHash,closeAt.hash]);
 await admin.query(`INSERT INTO v3_replay_pools(stream_key,pool_address,chain_id,rwa_symbol,fee,
  initialized,sqrt_price_x96,tick,liquidity,observation_cardinality_next)
  VALUES($1,$2,4663,'BASE',3000,true,$3,0,1000000000000,1)`,[stream,poolAddress,seedPrice]);
 await admin.query(`INSERT INTO v3_replay_ticks(stream_key,pool_address,tick,liquidity_gross,liquidity_net)
  VALUES($1,$2,-180,1000000000000,1000000000000),($1,$2,180,1000000000000,-1000000000000)`,
  [stream,poolAddress]);
 const growthAt=new Map([[100,'0']]);
 for(const [block,hash,paid1] of [[101,beforeRecenterAt.hash,'1000000000000'],
  [102,recenterAt.hash,'1000000000000'],[103,nextAt.hash,'100000000'],
  [104,secondRecenterAt.hash,'100000000'],[105,closeAt.hash,'10000000']]){
  const event={block:String(block),hash,tx:0,log:0,name:'Flash',args:{paid0:'0',paid1}};
  feeMarket.apply(event);
  growthAt.set(block,String(feeMarket.global1));
  await admin.query(`INSERT INTO v3_pool_events(stream_key,chain_id,pool_address,block_number,block_hash,
   transaction_hash,transaction_index,log_index,event_name,event_args,raw_topics,raw_data)
   VALUES($1,4663,$2,$3,$4,$5,0,0,'Flash',$6,'[]','0x')`,
   [stream,poolAddress,block,hash,`0x${Number(block).toString(16).padStart(64,'0')}`,
    JSON.stringify(event.args)]);
 }
 const anchorClient={getChainId:async()=>4663,getBlock:async({blockNumber})=>{
  const row=[openAt,beforeRecenterAt,recenterAt,nextAt,secondRecenterAt,closeAt]
   .find(item=>BigInt(item.block)===blockNumber);
  if(!row)throw Error('fixture_block_unavailable');return {hash:row.hash,timestamp:BigInt(row.timestamp)};}};
 const feeAt=source=>({source:{block:source.block,hash:source.hash},poolState:{tick:0,
  sqrtPriceX96:seedPrice,poolLiquidity:'1000000000000',feeGrowthGlobal0X128:'0',
  feeGrowthGlobal1X128:growthAt.get(Number(source.block))}});
 await admin.query(`UPDATE v3_replay_cursors SET complete_through_block=100,
  complete_through_hash=$2 WHERE stream_key=$1`,[stream,openAt.hash]);
 await assert.rejects(readIndexedPaperFeeInterval(indexer,stream,targetSetHash,market,
  feeAt(openAt),feeAt(recenterAt),range0,BigInt(mint0.liquidity)),/coverage unavailable|incomplete|not covered/,
  'an incomplete index cursor cannot create fee evidence');
 await admin.query(`UPDATE v3_replay_cursors SET complete_through_block=105,
  complete_through_hash=$2 WHERE stream_key=$1`,[stream,closeAt.hash]);
 const initialState=await store.rangeKeeperPaperFeeSamplingState(draft.id);
 assert.equal(initialState.fromMarkId,openId);assert.equal(initialState.toMarkId,recenterId);
 const project=()=>recordCanonicalNextRangeKeeperPaperAccounting(store,anchorClient,draft.id),
  first=await project();
 assert.equal(first.snapshot.markKind,'open');
 assert.equal(first.snapshot.economics.passiveQuote,
  String(10n**18n*BigInt(allocation.token0Raw)/10n**18n+
   10n**18n*BigInt(allocation.token1Raw)/10n**6n+
   10n**18n*BigInt(allocation.nativeWei)/10n**18n));
 assert.equal(first.snapshot.modeledCosts.paidCostsAvailable,false);
 assert.equal(first.snapshot.inventory.cumulativeGasWei,null);
 assert.equal(await project(),null,
  'an unproved endpoint fee interval cannot create an accounting snapshot');
 assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_paper_accounting
  WHERE campaign_id=$1 AND policy_version=$2`,[draft.id,RANGEKEEPER_PAPER_ACCOUNTING_POLICY])).rows[0].n,1);
 const sampleAndPersist=async()=>{
  const state=await store.rangeKeeperPaperFeeSamplingState(draft.id);
  assert(state,`expected adjacent fee interval after mark ${state?.fromMarkId??'none'}`);
  const after=[openAt,beforeRecenterAt,recenterAt,nextAt,secondRecenterAt,closeAt]
    .find(item=>item.block===state.after.source.block),
   before=[openAt,beforeRecenterAt,recenterAt,nextAt,secondRecenterAt,closeAt]
    .find(item=>item.block===state.before.source.block),
   proof=await readIndexedPaperFeeInterval(indexer,stream,targetSetHash,market,
    feeAt(before),feeAt(after),state.range,state.liquidity),
   _anchors=await Promise.all([before,after].map(async source=>{
    const block=await anchorClient.getBlock({blockNumber:BigInt(source.block)});
    assert.equal(block.hash.toLowerCase(),source.hash.toLowerCase());
    assert.equal(Number(block.timestamp),source.timestamp);
   })),
   saved=await store.recordTrustedRangeKeeperPaperFeeEvidence(draft.id,state.fromMarkId,state.toMarkId,
    {...proof,coverage:{...proof.coverage,chainAnchorRecheckRequired:false}}),
   replayed=await store.recordTrustedRangeKeeperPaperFeeEvidence(draft.id,state.fromMarkId,state.toMarkId,
    {...proof,coverage:{...proof.coverage,chainAnchorRecheckRequired:false}});
  assert.equal(saved.replayed,false);assert.equal(replayed.replayed,true);
  return {state,proof,projection:await project()};
 };
 const epoch0=await sampleAndPersist();
 assert.equal(epoch0.state.fromMarkId,openId);assert.equal(epoch0.state.toMarkId,recenterId);
 assert.equal(epoch0.state.ending,'recenter');
 assert.equal(epoch0.projection.snapshot.markKind,'recenter');
 assert(BigInt(epoch0.projection.snapshot.inventory.fee1Raw)>0n,
  'modeled fee carry should be retained as separate token cash');
 const principal0=principalAmounts({liquidity:mint1.liquidity,sqrtPriceX96:sqrt1,...range1});
 assert.equal(epoch0.projection.snapshot.inventory.principal1Raw,
  String(principal0.amount1),'fee cash is excluded from position principal');
 assert.equal(epoch0.projection.snapshot.modeledCosts.paidCostsAvailable,false);
 assert.equal(epoch0.projection.snapshot.inventory.cumulativeGasWei,null);
 assert.equal(epoch0.projection.snapshot.economics.cumulativeGasExpenseQuote,null);
 const feeRow1=(await admin.query(`SELECT proof,carry FROM deployment_paper_fee_evidence
  WHERE campaign_id=$1 AND to_mark_id=$2`,[draft.id,recenterId])).rows[0];
 assert.equal(feeRow1.carry.intervals,1);assert.equal(feeRow1.proof.from.block,openAt.block);
 assert.equal(feeRow1.carry.events,2,'first complete interval includes the skipped valuation block');
 const checkNav=snapshot=>{
  const inv=snapshot.inventory,nav=BigInt(inv.token0Raw)+BigInt(inv.token1Raw)*10n**12n+
   BigInt(inv.nativeWei);
  assert.equal(snapshot.economics.netNavQuote,String(nav));
  assert.equal(snapshot.economics.passiveQuote,first.snapshot.economics.passiveQuote,
   'passive comparator remains the original token and native inventory');
 };
 checkNav(epoch0.projection.snapshot);
 const epoch1=await sampleAndPersist();
 assert.equal(epoch1.state.fromMarkId,recenterId);assert.equal(epoch1.state.toMarkId,secondRecenterId);
 assert.equal(epoch1.state.ending,'recenter');
 assert.equal(epoch1.projection.snapshot.epoch,2);
 assert.equal(epoch1.projection.snapshot.markKind,'recenter');
 assert(BigInt(epoch1.projection.snapshot.inventory.fee1Raw)>
  BigInt(epoch0.projection.snapshot.inventory.fee1Raw),
  'a second recenter adds its smaller new epoch carry to previously retained fee cash');
 const secondPrincipal=principalAmounts({liquidity:mint2.liquidity,sqrtPriceX96:sqrt1,...range2});
 assert.equal(epoch1.projection.snapshot.inventory.principal1Raw,String(secondPrincipal.amount1));
 checkNav(epoch1.projection.snapshot);
 const feeRow2=(await admin.query(`SELECT proof,carry FROM deployment_paper_fee_evidence
  WHERE campaign_id=$1 AND to_mark_id=$2`,[draft.id,secondRecenterId])).rows[0];
 assert.equal(feeRow2.carry.intervals,1,'recenter starts a fresh epoch carry');
 assert.equal(feeRow2.proof.from.block,recenterAt.block);
 assert.equal(feeRow2.proof.to.block,secondRecenterAt.block);
 assert.equal(feeRow2.carry.events,2,'second complete interval includes its skipped valuation block');
 assert(BigInt(feeRow2.carry.token1.upperAmountRaw)<BigInt(feeRow1.carry.token1.upperAmountRaw),
  'second epoch carry is smaller than the first but does not erase retained fees');
 const terminal=await sampleAndPersist();
 assert.equal(terminal.state.fromMarkId,secondRecenterId);assert.equal(terminal.state.toMarkId,closeId);
 assert.equal(terminal.state.ending,'close_retain');
 assert.equal(terminal.projection.snapshot.epoch,2);
 assert.equal(terminal.projection.snapshot.markKind,'close_retain');
 assert(BigInt(terminal.projection.snapshot.inventory.fee1Raw)>
  BigInt(epoch1.projection.snapshot.inventory.fee1Raw));
 assert.equal(terminal.projection.snapshot.inventory.hasLiquidity,false);
 assert.equal(terminal.projection.snapshot.reference.eligible,false);
 assert.equal(terminal.projection.snapshot.economics.netNavQuote,null,
  'a close without eligible independent references cannot claim net NAV');
 assert(terminal.projection.snapshot.limitations.includes('independent_reference_unavailable'));
 const feeRow3=(await admin.query(`SELECT proof,carry FROM deployment_paper_fee_evidence
  WHERE campaign_id=$1 AND to_mark_id=$2`,[draft.id,closeId])).rows[0];
 assert.equal(feeRow3.carry.intervals,1);
 assert.equal(feeRow3.proof.from.block,secondRecenterAt.block);
 assert.equal(feeRow3.proof.to.block,closeAt.block);
 const projections=[first.snapshot,epoch0.projection.snapshot,epoch1.projection.snapshot,
  terminal.projection.snapshot];
 for(const snapshot of projections){
  assert.equal(snapshot.modeledCosts.paidCostsAvailable,false);
  assert.equal(snapshot.inventory.cumulativeGasWei,null);
  assert.equal(snapshot.economics.cumulativeGasExpenseQuote,null);
  assert.equal(snapshot.economics.markGasExpenseQuote,null);
 }
 const skippedRows=(await admin.query(`SELECT source_mark_id::text AS id FROM deployment_paper_accounting
  WHERE campaign_id=$1 AND policy_version=$2 ORDER BY source_mark_id`,
  [draft.id,RANGEKEEPER_PAPER_ACCOUNTING_POLICY])).rows.map(row=>row.id);
 assert.deepEqual(skippedRows,[openId,recenterId,secondRecenterId,closeId],
  'unchanged valuations remain unprojected when no endpoint interval is sampled');
 const accountedRows=(await admin.query(`SELECT count(*)::int AS n FROM deployment_paper_accounting
  WHERE campaign_id=$1 AND policy_version=$2`,[draft.id,RANGEKEEPER_PAPER_ACCOUNTING_POLICY])).rows[0].n;
 assert.equal(await project(),null,'caught-up accounting worker returns no repeated snapshot');
 assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_paper_accounting
  WHERE campaign_id=$1 AND policy_version=$2`,[draft.id,RANGEKEEPER_PAPER_ACCOUNTING_POLICY])).rows[0].n,
  accountedRows,'caught-up replay does not duplicate terminal snapshot');
 const badAnchorClient={...anchorClient,getBlock:async({blockNumber})=>{
  const block=await anchorClient.getBlock({blockNumber});return {...block,hash:blockHash('e')};}};
 let auditReads=0;
 const unstableAnchorClient={...anchorClient,getBlock:async({blockNumber})=>{
  const block=await anchorClient.getBlock({blockNumber});
  return auditReads++<accountedRows?block:{...block,hash:blockHash('e')};
 }};
 await assert.rejects(auditCanonicalRangeKeeperPaperAccounting(store,unstableAnchorClient,draft.id),
  /source changed during audit/);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_paper_accounting_invalidations WHERE campaign_id=$1',[draft.id])).rows[0].n,0,
  'an unstable provider response must not permanently revoke valid history');
 const audited=await auditCanonicalRangeKeeperPaperAccounting(store,badAnchorClient,draft.id);
 assert(audited.invalidated.length>0,'reorged projected endpoint is persistently invalidated');
 await assert.rejects(project(),/rangekeeper_paper_accounting_history_invalidated/);
 await assert.rejects(readIndexedPaperFeeInterval(indexer,stream,'0x'+'9'.repeat(64),market,
  feeAt(nextAt),feeAt(closeAt),range0,BigInt(mint1.liquidity)),/coverage unavailable/);
 process.stdout.write(JSON.stringify({status:'v11_range_keeper_accounting_fixture',schema,
  policy:RANGEKEEPER_PAPER_ACCOUNTING_POLICY,
  markIds:[openId,preRecenterId,recenterId,nextId,secondRecenterId,closeId],
  projections,
  skippedValuationIds:[preRecenterId,nextId],recenterCarryReset:true,feeReplayIdempotent:true,
  terminalReplay:true,paidCostsAvailable:false})+'\n');
}catch(error){
 process.stderr.write(`${error instanceof Error?error.stack??error.message:'RangeKeeper accounting integration failed'}\n`);
 process.exitCode=1;
}finally{
 await store?.close();await indexer?.end();
 await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
 admin.release();await pool.end();
}
