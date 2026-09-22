import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore,DeploymentConflict} from '../../src/deployments/store.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {marketProfileSchema,referenceProofHash} from '../../src/deployments/market-profile.ts';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {buildIndicativePaperOpenPreview} from '../../src/deployments/paper-preview.ts';
import {sqrtRatioAtTick} from '../../src/backtest/principal.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('Set TEST_DATABASE_URL to a database where isolated schemas may be created');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});
const admin=await pool.connect();
const schema=`deployment_test_${randomUUID().replaceAll('-','')}`;
let store;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);
 await admin.query(`SET search_path=${schema}`);
 assert.deepEqual(await migrateDatabase(admin),[1,2,3,4]);
 const url=new URL(process.env.TEST_DATABASE_URL);
 url.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 store=new DeploymentStore(url.toString());
 await store.assertReady();
 const wallet='0x1111111111111111111111111111111111111111';
 const poolAddress='0x'+'a'.repeat(40),token0='0x'+'b'.repeat(40),token1='0x'+'c'.repeat(40);
 const codeHash='0x'+'a'.repeat(64),sourceHash='0x'+'2'.repeat(64);
 const market=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,pool:poolAddress,token0,token1,
  quoteToken:1,decimals0:18,decimals1:6,fee:3000,tickSpacing:60,
  positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
  poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
  managerCodeHash:codeHash,quoterCodeHash:codeHash,
  reference0:'BASE/USD',reference1:'USDG/USD',nativeReference:'ETH/USD',numeraire:'USD'},
  referencePolicy:{token0:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
   token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
   nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
 await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
  created_block,target_set_hash,enabled) VALUES($1,$2,4663,'BASE',$3,3000,1,$4,true)`,
  ['test-stream',poolAddress,token0,'0x'+'f'.repeat(64)]);
 const proof={profile:market,profileHash:contentHash(market),streamKey:'test-stream',
  source:{block:'100',hash:sourceHash,timestamp:Math.floor(Date.now()/1000)},
  contractHashes:{poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
   managerCodeHash:codeHash,quoterCodeHash:codeHash},
  references:{price0:'1000000000000000000',price1:'1000000000000000000',
   nativePrice:'1000000000000000000',proofHash:referenceProofHash({fixture:true})},
  referenceProof:{fixture:true},verifiedAt:new Date().toISOString()};
 await assert.rejects(store.registerVerifiedMarketProfile({...proof,profileHash:'b'.repeat(64)}),
  error=>error instanceof DeploymentConflict&&error.code==='profile_hash_mismatch');
 await assert.rejects(store.registerVerifiedMarketProfile({...proof,references:{...proof.references,proofHash:'b'.repeat(64)}}),
  error=>error instanceof DeploymentConflict&&error.code==='profile_reference_proof_mismatch');
 const registered=await store.registerVerifiedMarketProfile(proof);
 assert.equal(registered.created,true);
 assert.deepEqual(await store.registerVerifiedMarketProfile(proof),{id:registered.id,created:false});
 const profile=registered.id;
 const catalog=await store.listMarketProfiles();
 assert.equal(catalog.length,1);
 assert.equal(catalog[0].id,profile);
 assert.equal(catalog[0].draftAvailable,true);
 assert.equal(catalog[0].deploymentAvailable,false);
 assert.equal(catalog[0].pool.toLowerCase(),poolAddress);
 const draftInput={mode:'live',chainId:4663,wallet,marketProfileId:profile,
  strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
  allocation:{token0Raw:'0',token1Raw:'250000000',nativeWei:'10000000000000000'},config:{tickLower:10,tickUpper:20}};
 await assert.rejects(store.createDraft({...draftInput,strategyId:'adaptive_v1'}));
 await admin.query("UPDATE indexer_pools SET enabled=false WHERE stream_key='test-stream'");
 assert.equal((await store.listMarketProfiles())[0].draftAvailable,false);
 assert.equal((await store.listMarketProfiles())[0].reason,'indexer_identity_changed');
 await assert.rejects(store.createDraft(draftInput),
  error=>error instanceof DeploymentConflict&&error.code==='market_profile_indexer_changed');
 await admin.query("UPDATE indexer_pools SET enabled=true WHERE stream_key='test-stream'");
 await assert.rejects(store.createDraft({...draftInput,config:{...draftInput.config,spender:'0x'+'d'.repeat(40)}}));
 await assert.rejects(store.createDraft({...draftInput,config:{...draftInput.config,calldata:'0xdeadbeef'}}));
 const paperLimits={maxDeploymentValue:String(250n*10n**18n),minDeploymentValue:'1',
  maxExposurePpm:1000000,maxLossValue:String(250n*10n**18n),maxDrawdownPpm:1000000,
  maxActionCost:String(10n**18n),maxRollingCost:String(10n**18n),maxCampaignCost:String(10n**18n),
  exitReserveWei:'1000000000000000'};
 const paperDraft=await store.createDraft({...draftInput,mode:'paper',
  allocation:{token0Raw:'1000000000000000000',token1Raw:'250000000',nativeWei:'10000000000000000'},
  config:{tickLower:-276400,tickUpper:-276250,limits:paperLimits}});
 const paperInput=await store.paperDraft(paperDraft.id);
 assert.equal(paperInput.strategyId,'static_manual_v1');
 assert.equal(paperInput.profile.pool.fee,3000);
 assert.equal(paperInput.allocation.token1Raw,'250000000');
 const frame={source:{block:'100',hash:sourceHash,timestamp:Math.floor(Date.now()/1000)},
  tick:-276325,sqrtPriceX96:sqrtRatioAtTick(-276325),poolLiquidity:10n**24n,
  price0:10n**18n,price1:10n**18n,nativePrice:10n**18n,
  referenceEligible:true,referenceReasons:[],referenceProofHash:referenceProofHash({fixture:true})};
 const indicative=buildIndicativePaperOpenPreview(paperInput,frame);
 assert.equal(indicative.status,'indicative');assert.equal(indicative.actionAvailable,false);
 assert.equal(indicative.economics,null);assert.equal(indicative.candidate.range.fullWidthTicks,180);
 const detached=buildIndicativePaperOpenPreview(paperInput,{...frame,sqrtPriceX96:sqrtRatioAtTick(0)});
 assert.equal(detached.status,'unavailable');assert.equal(detached.reason,'independent_price_band');
 const stale=buildIndicativePaperOpenPreview(paperInput,{...frame,source:{...frame.source,timestamp:frame.source.timestamp-181}});
 assert.equal(stale.status,'unavailable');assert.equal(stale.reason,'source_stale');
 const noReference=buildIndicativePaperOpenPreview(paperInput,{...frame,price0:null,referenceEligible:false,
  referenceReasons:['token0_oracle_missing']});
 assert.equal(noReference.status,'unavailable');assert.match(noReference.reason,/independent_reference_unavailable/);
 const draft=await store.createDraft(draftInput);
 await assert.rejects(store.recordPreview({campaignId:draft.id,expectedRevision:1,kind:'open',
  request:{kind:'open'},proposal:{sourceBlock:'1'},evidence:{blockHash:'0x'+'2'.repeat(64)},
  expiresAt:new Date(Date.now()+10*60*1000)}),
  error=>error instanceof DeploymentConflict&&error.code==='preview_expiry_too_distant');
 const preview=await store.recordPreview({campaignId:draft.id,expectedRevision:1,kind:'open',
  request:{kind:'open'},proposal:{sourceBlock:'1',token0Raw:'0'},
  evidence:{blockHash:'0x'+'2'.repeat(64)},expiresAt:new Date(Date.now()+60000)});
 await assert.rejects(admin.query('UPDATE deployment_revisions SET config=$2 WHERE campaign_id=$1',
  [draft.id,'{}']),/append-only/);
 await assert.rejects(admin.query('DELETE FROM deployment_previews WHERE id=$1',[preview.id]),/append-only/);
 const command={previewId:preview.id,contentDigest:preview.contentDigest,expectedRevision:1,
  idempotencyKey:'deployment-open-unique-1'};
 const blocker=await pool.connect();
 try{
  await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`conc-liq-live:4663:${wallet.toLowerCase()}`]);
  await assert.rejects(store.acceptOperation(draft.id,command,'operator'),
   error=>error instanceof DeploymentConflict&&error.code==='predecessor_wallet_locked');
 }finally{
  await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`conc-liq-live:4663:${wallet.toLowerCase()}`]);
  blocker.release();
 }
 const first=await store.acceptOperation(draft.id,command,'operator');
 assert.equal(first.status,'queued');assert.equal(first.replayed,false);
 assert.equal((await store.operation(first.id)).status,'queued');
 const replay=await store.acceptOperation(draft.id,command,'operator');
 assert.equal(replay.id,first.id);assert.equal(replay.replayed,true);
 await assert.rejects(store.acceptOperation(draft.id,{...command,contentDigest:'f'.repeat(64)},'operator'),
  error=>error instanceof DeploymentConflict&&error.code==='idempotency_conflict');
 assert.equal(await store.claimNext('paper-worker',30,'paper'),null);
 const claimed=await Promise.all([store.claimNext('worker-one',30,'live'),store.claimNext('worker-two',30,'live')]);
 assert.equal(claimed.filter(Boolean).length,1);
 const owner=claimed[0]?'worker-one':'worker-two';
 assert.equal(claimed.find(Boolean).id,first.id);
 await assert.rejects(store.advanceClaim(first.id,owner==='worker-one'?'worker-two':'worker-one',
  'preflight','executing',null),error=>error instanceof DeploymentConflict&&error.code==='claim_lost_or_transition_disallowed');
 await store.advanceClaim(first.id,owner,'source_checked','executing',null);
 await store.renewClaim(first.id,owner,30);
 await assert.rejects(store.advanceClaim(first.id,owner,'backwards','preflighting',null),
  error=>error instanceof DeploymentConflict&&error.code==='claim_lost_or_transition_disallowed');
 await assert.rejects(store.advanceClaim(first.id,owner,'unproven','succeeded',null),
  error=>error instanceof DeploymentConflict&&error.code==='invalid_claim_transition');
 await admin.query(`UPDATE deployment_operations SET claim_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[first.id]);
 const recovered=await store.claimNext('worker-restart',30,'live');
 assert.equal(recovered.id,first.id);assert.equal(recovered.stage,'source_checked');
 assert.equal(recovered.status,'executing');
 const second=await store.createDraft(draftInput);
 const secondPreview=await store.recordPreview({campaignId:second.id,expectedRevision:1,kind:'open',
  request:{kind:'open'},proposal:{sourceBlock:'2'},evidence:{blockHash:'0x'+'3'.repeat(64)},
  expiresAt:new Date(Date.now()+60000)});
 await assert.rejects(store.acceptOperation(second.id,{previewId:secondPreview.id,
  contentDigest:secondPreview.contentDigest,expectedRevision:1,idempotencyKey:'deployment-open-unique-2'},'operator'),
  error=>error instanceof DeploymentConflict&&error.code==='wallet_reserved');
 const rows=(await admin.query('SELECT id,status FROM deployment_operations')).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].id,first.id);
 const reservations=(await admin.query('SELECT campaign_id FROM deployment_wallet_reservations WHERE released_at IS NULL')).rows;
 assert.deepEqual(reservations.map(row=>row.campaign_id),[draft.id]);
 console.log(JSON.stringify({passed:['explicit migration','indexed verified profile','profile integrity and idempotency','strategy allowlist','draft and trusted preview','immutable evidence','predecessor lock','idempotent operation','conflicting retry','single worker claim','restart resumes stage','wallet exclusivity','atomic failure']}));
}finally{
 if(store)await store.close();
 await admin.query('SET search_path=public');
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 admin.release();await pool.end();
}
