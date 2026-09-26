import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {referenceProofHash,marketProfileEvidenceSchema} from '../../src/deployments/market-profile.ts';
import {registerProspectivePaperCloseConvertPrestateGasProfiles} from
 '../../src/deployments/paper-close-convert-prestate-gas-importer.ts';
import {validReport} from '../paper-close-convert-prestate-sampler.test.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('Set TEST_DATABASE_URL to a database where isolated schemas may be created');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:2});
const admin=await pool.connect(),schema=`paper_prestate_import_${randomUUID().replaceAll('-','')}`;
let client;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
 assert.deepEqual(await migrateDatabase(admin),[1,2,3,4,5,6,7,8,9,10,11]);
 const url=new URL(process.env.TEST_DATABASE_URL);
 url.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 client=new pg.Pool({connectionString:url.toString(),max:2});
 const report=validReport(),campaignId=randomUUID(),profile=report.profile,
  profileHash=contentHash(profile),config={tickLower:-60,tickUpper:60,limits:{maxLossValue:'1000'}},
  configHash=contentHash(config),openModel=report.openModel,
  candidateHash=contentHash({campaignId,revision:1,profileHash,configHash,
   source:openModel.source,referenceProofHash:openModel.referenceProofHash,
   candidate:openModel.candidate});
 openModel.campaignId=campaignId;openModel.profileHash=profileHash;openModel.configHash=configHash;
 openModel.candidateHash=candidateHash;
 report.campaignId=campaignId;report.profile=profile;report.profileHash=profileHash;
 report.openModel=openModel;report.openModelHash=contentHash(openModel);
 report.openMarkId='1';report.previousMarkId='2';
 report.previousSource={block:'110',hash:`0x${'3'.repeat(64)}`,timestamp:1010};
 report.feeReplay.previousFeeEvidenceId='1';report.feeReplay.from={block:'110',hash:report.previousSource.hash};
 report.openModelHash=contentHash(openModel);
 report.gasScopeHash=contentHash({campaignId,revision:1,openMarkId:report.openMarkId,
  latestMarkId:report.previousMarkId,openModelHash:report.openModelHash,profileHash,
  feeCarryHash:report.feeCarryHash,feeReplayHash:report.feeReplay.replayHash,
  source:report.frame.source,routeHash:report.route.routeHash,inventory:report.inventory,
  quoteHash:report.quote.quoteHash,initialAllowances:report.gasStages[0].allowancesBefore});
 for(const stage of report.gasStages)stage.scopeHash=report.gasScopeHash;
 report.gasSequenceHash=contentHash(report.gasStages.map(stage=>({stage:stage.stage,
  callHash:stage.callHash,sourceHash:stage.sourceHash,allowancesBefore:stage.allowancesBefore,
  allowancesAfter:stage.allowancesAfter,balancesBefore:stage.balancesBefore,
  balancesAfter:stage.balancesAfter})));
 for(const stage of report.gasStages)stage.sequenceHash=report.gasSequenceHash;
 report.reportHash=contentHash((({reportHash:_r,postWithdraw:_p,sourceReplayHash:_s,...body})=>body)(report));
 report.postWithdraw.reportHash=report.reportHash;
 report.sourceReplayHash=contentHash({kind:'paper_close_convert_prestate_source_replay_v1',
  reportHash:report.reportHash,source:report.frame.source,openModelHash:report.openModelHash,
  feeCarryHash:report.feeCarryHash,postWithdrawReplayHash:report.postWithdrawReplay.replayHash,
  quoteHash:report.quote.quoteHash});
 const evidence={verificationClass:'canonical_chain_and_independent_reference_v1',
  source:openModel.source,streamKey:report.feeReplay.stream,
  indexerTargetSetHash:report.feeReplay.targetSetHash,
  contractHashes:{poolCodeHash:profile.pool.poolCodeHash,token0CodeHash:profile.pool.token0CodeHash,
   token1CodeHash:profile.pool.token1CodeHash,managerCodeHash:profile.pool.managerCodeHash,
   quoterCodeHash:profile.pool.quoterCodeHash},
  references:{price0:'100',price1:'100',nativePrice:'100',proofHash:openModel.referenceProofHash},
  referenceProof:openModel.referenceProof};
 assert(marketProfileEvidenceSchema.safeParse(evidence).success);
 const profileId=randomUUID();
 await admin.query(`INSERT INTO deployment_market_profiles
  (id,chain_id,pool_address,token0_address,token1_address,token0_decimals,token1_decimals,
   quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp())`,
 [profileId,profile.pool.chainId,profile.pool.pool,profile.pool.token0,profile.pool.token1,
  profile.pool.decimals0,profile.pool.decimals1,profile.pool.quoteToken,profile.pool.fee,
  profile.pool.tickSpacing,JSON.stringify(profile),JSON.stringify(evidence),profileHash]);
 await admin.query(`INSERT INTO deployment_campaigns
  (id,mode,chain_id,wallet,market_profile_id,allocation,lifecycle,current_revision)
  VALUES($1,'paper',$2,$3,$4,'{}','active',1)`,
 [campaignId,profile.pool.chainId,'0x1111111111111111111111111111111111111111',profileId]);
 await admin.query(`INSERT INTO deployment_revisions
  (campaign_id,revision,strategy_id,strategy_version,state_schema_version,config,config_hash)
  VALUES($1,1,'static_manual_v1','1.0.0',1,$2,$3)`,
 [campaignId,JSON.stringify(config),configHash]);
 const previewId=randomUUID(),expiresAt=new Date(Date.now()+60_000),previewProposal={paperOpenModel:openModel};
 await admin.query(`INSERT INTO deployment_previews
  (id,campaign_id,expected_revision,kind,request,proposal,evidence,content_digest,expires_at)
  VALUES($1,$2,1,'open','{}',$3,'{}',$4,$5)`,
 [previewId,campaignId,JSON.stringify(previewProposal),contentHash(previewProposal),expiresAt]);
 const openMark=(await admin.query(`INSERT INTO deployment_marks
  (campaign_id,revision,source_block,source_hash,inventory,provenance)
  VALUES($1,1,$2,$3,'{}',$4) RETURNING id::text`,
 [campaignId,openModel.source.block,openModel.source.hash,JSON.stringify({
  classification:'paper_model_provisional',previewId,modelHash:report.openModelHash})])).rows[0].id;
 const latestMark=(await admin.query(`INSERT INTO deployment_marks
  (campaign_id,revision,source_block,source_hash,inventory,provenance)
  VALUES($1,1,$2,$3,'{}','{}') RETURNING id::text`,
 [campaignId,report.previousSource.block,report.previousSource.hash])).rows[0].id;
 report.openMarkId=openMark;report.previousMarkId=latestMark;
 report.feeReplay.previousFeeEvidenceId='1';
 report.gasScopeHash=contentHash({campaignId,revision:1,openMarkId:openMark,latestMarkId:latestMark,
  openModelHash:report.openModelHash,profileHash,feeCarryHash:report.feeCarryHash,
  feeReplayHash:report.feeReplay.replayHash,source:report.frame.source,
  routeHash:report.route.routeHash,inventory:report.inventory,quoteHash:report.quote.quoteHash,
  initialAllowances:report.gasStages[0].allowancesBefore});
 for(const stage of report.gasStages)stage.scopeHash=report.gasScopeHash;
 report.gasSequenceHash=contentHash(report.gasStages.map(stage=>({stage:stage.stage,
  callHash:stage.callHash,sourceHash:stage.sourceHash,allowancesBefore:stage.allowancesBefore,
  allowancesAfter:stage.allowancesAfter,balancesBefore:stage.balancesBefore,
  balancesAfter:stage.balancesAfter})));
 for(const stage of report.gasStages)stage.sequenceHash=report.gasSequenceHash;
 report.reportHash=contentHash((({reportHash:_r,postWithdraw:_p,sourceReplayHash:_s,...body})=>body)(report));
 report.postWithdraw.reportHash=report.reportHash;
 report.sourceReplayHash=contentHash({kind:'paper_close_convert_prestate_source_replay_v1',
  reportHash:report.reportHash,source:report.frame.source,openModelHash:report.openModelHash,
  feeCarryHash:report.feeCarryHash,postWithdrawReplayHash:report.postWithdrawReplay.replayHash,
  quoteHash:report.quote.quoteHash});
 await admin.query(`INSERT INTO deployment_paper_fee_evidence
  (campaign_id,from_mark_id,to_mark_id,proof,proof_hash,carry,carry_hash)
  VALUES($1,$2,$3,'{}',$4,'{}',$5)`,[campaignId,openMark,latestMark,
   'a'.repeat(64),report.feeReplay.previousFeeCarryHash]);
 const verifyAnchors=async()=>{},verifyFeeReplay=async()=>report.feeReplay;
 const input={pool:client,report,verifyAnchors,verifyFeeReplay,now:1020000};
 const first=await registerProspectivePaperCloseConvertPrestateGasProfiles(input);
 assert.equal(first.created,true);assert.equal(first.profileIds.length,7);
 assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_calibration_profiles
  WHERE validation->>'reportHash'=$1 AND validation->>'actionAvailable'='false'`,
 [report.reportHash])).rows[0].n,7);
 const second=await registerProspectivePaperCloseConvertPrestateGasProfiles(input);
 assert.equal(second.created,false);assert.deepEqual(second.profileIds,first.profileIds);
 const beforeRollback=(await admin.query(`SELECT count(*)::int AS n FROM deployment_calibration_profiles
  WHERE validation->>'reportHash'=$1`,[report.reportHash])).rows[0].n;
 await admin.query(`CREATE FUNCTION reject_prestate_import() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'forced importer rollback'; END $$`);
 await admin.query(`CREATE TRIGGER reject_prestate_import BEFORE INSERT ON deployment_calibration_profiles
  FOR EACH ROW WHEN (NEW.path_version='paper_static_manual_close_convert_prestate_v1')
  EXECUTE FUNCTION reject_prestate_import()`);
 const another=structuredClone(report);another.simulationPrestate.nativeBalanceWei='2000000000000000000';
 another.reportHash=contentHash((({reportHash:_r,postWithdraw:_p,sourceReplayHash:_s,...body})=>body)(another));
 another.postWithdraw.reportHash=another.reportHash;
 another.sourceReplayHash=contentHash({kind:'paper_close_convert_prestate_source_replay_v1',
  reportHash:another.reportHash,source:another.frame.source,openModelHash:another.openModelHash,
  feeCarryHash:another.feeCarryHash,postWithdrawReplayHash:another.postWithdrawReplay.replayHash,
  quoteHash:another.quote.quoteHash});
 await assert.rejects(registerProspectivePaperCloseConvertPrestateGasProfiles({...input,report:another}),
  /forced importer rollback/);
 await admin.query('DROP TRIGGER reject_prestate_import ON deployment_calibration_profiles');
 await admin.query('DROP FUNCTION reject_prestate_import()');
 assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_calibration_profiles
  WHERE validation->>'reportHash'=$1`,[report.reportHash])).rows[0].n,beforeRollback);
 console.log('paper close-convert prestate importer PostgreSQL integration passed');
}finally{
 if(client)await client.end();
 await admin.query(`SET search_path=public`);await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 admin.release();await pool.end();
}
