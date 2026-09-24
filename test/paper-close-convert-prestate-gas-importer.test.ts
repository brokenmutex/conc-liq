import assert from 'node:assert/strict';
import {test} from 'node:test';
import {registerProspectivePaperCloseConvertPrestateGasProfiles}
 from '../src/deployments/paper-close-convert-prestate-gas-importer.js';
import {PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1} from
 '../src/deployments/paper-close-convert-prestate-gas-profiles.js';
import {validReport} from './paper-close-convert-prestate-sampler.test.js';
import {marketProfileEvidenceSchema,marketProfileSchema,referenceProofHash} from
 '../src/deployments/market-profile.js';
import {paperOpenModelSchema} from '../src/deployments/paper-open-model.js';

test('prestate importer records only seven provisional distinct-path profiles idempotently',async()=>{
 const report=validReport(),rows:{id:string;stage:string;allowance_state:string;version:number;
  validation:Record<string,unknown>;model:unknown;source_hash:string}[]=[],inserts:unknown[][]=[];
 const contractHashes={poolCodeHash:'0x'+'a'.repeat(64),token0CodeHash:'0x'+'a'.repeat(64),
  token1CodeHash:'0x'+'a'.repeat(64),managerCodeHash:'0x'+'a'.repeat(64),quoterCodeHash:'0x'+'a'.repeat(64)},
  evidence={verificationClass:'canonical_chain_and_independent_reference_v1',
   source:report.openModel.source,streamKey:report.feeReplay.stream,
   indexerTargetSetHash:report.feeReplay.targetSetHash,contractHashes,
   references:{price0:'100',price1:'100',nativePrice:'100',proofHash:report.profileHash},
   referenceProof:report.openModel.referenceProof};
 evidence.references.proofHash=report.openModel.referenceProofHash;
 const campaign={mode:'paper',lifecycle:'active',current_revision:1,strategy_id:'static_manual_v1',
  strategy_version:'1.0.0',state_schema_version:1,config:{value:'static'},
  config_hash:'config-hash',profile:report.profile,profile_hash:report.profileHash,evidence,
  open_mark_id:report.openMarkId,latest_mark_id:report.previousMarkId,
  latest_source_block:report.previousSource.block,latest_source_hash:report.previousSource.hash,
  open_provenance:{modelHash:report.openModelHash},open_proposal:{paperOpenModel:report.openModel}};
 campaign.config_hash=(await import('../src/deployments/contracts.js')).contentHash(campaign.config);
 // Keep the saved open model bound to the campaign config hash.
 report.openModel.configHash=campaign.config_hash;
 report.openModel.candidateHash=(await import('../src/deployments/contracts.js')).contentHash({
  campaignId:report.openModel.campaignId,revision:report.openModel.revision,
  profileHash:report.openModel.profileHash,configHash:report.openModel.configHash,
  source:report.openModel.source,referenceProofHash:report.openModel.referenceProofHash,
  candidate:report.openModel.candidate});
 report.openModelHash=(await import('../src/deployments/contracts.js')).contentHash(report.openModel);
 campaign.open_provenance.modelHash=report.openModelHash;
 campaign.open_proposal.paperOpenModel=report.openModel;
 assert.equal(marketProfileSchema.safeParse(campaign.profile).success,true);
 assert.equal(marketProfileEvidenceSchema.safeParse(campaign.evidence).success,true);
 assert.equal(paperOpenModelSchema.safeParse(campaign.open_proposal.paperOpenModel).success,true);
 assert.equal(referenceProofHash(campaign.evidence.referenceProof),campaign.evidence.references.proofHash);
 report.gasScopeHash=(await import('../src/deployments/contracts.js')).contentHash({
  campaignId:report.campaignId,revision:report.revision,openMarkId:report.openMarkId,
  latestMarkId:report.previousMarkId,openModelHash:report.openModelHash,profileHash:report.profileHash,
  feeCarryHash:report.feeCarryHash,feeReplayHash:report.feeReplay.replayHash,source:report.frame.source,
  routeHash:report.route.routeHash,inventory:report.inventory,quoteHash:report.quote.quoteHash,
  initialAllowances:report.gasStages[0]!.allowancesBefore});
 for(const stage of report.gasStages)stage.scopeHash=report.gasScopeHash;
 for(const stage of report.gasStages)stage.sequenceHash='';
 report.gasSequenceHash=(await import('../src/deployments/contracts.js')).contentHash(report.gasStages.map(stage=>({
  stage:stage.stage,callHash:stage.callHash,sourceHash:stage.sourceHash,
  allowancesBefore:stage.allowancesBefore,allowancesAfter:stage.allowancesAfter,
  balancesBefore:stage.balancesBefore,balancesAfter:stage.balancesAfter})));
 for(const stage of report.gasStages)stage.sequenceHash=report.gasSequenceHash;
 report.reportHash=(await import('../src/deployments/contracts.js')).contentHash((({reportHash:_r,
  postWithdraw:_p,sourceReplayHash:_s,...body})=>body)(report));
 report.postWithdraw.reportHash=report.reportHash;
 report.sourceReplayHash=(await import('../src/deployments/contracts.js')).contentHash({
  kind:'paper_close_convert_prestate_source_replay_v1',reportHash:report.reportHash,
  source:report.frame.source,openModelHash:report.openModelHash,feeCarryHash:report.feeCarryHash,
  postWithdrawReplayHash:report.postWithdrawReplay.replayHash,quoteHash:report.quote.quoteHash});
 const client={query:async(sql:string,params:unknown[]=[])=>{
  if(sql.includes('SELECT c.mode,c.lifecycle'))return {rows:[campaign]};
  if(sql.includes('SELECT id::text,to_mark_id::text,carry_hash'))return {rows:[{
   id:report.feeReplay.previousFeeEvidenceId,to_mark_id:report.previousMarkId,
   carry_hash:report.feeReplay.previousFeeCarryHash}]};
  if(sql.includes('AS found'))return {rows:[{found:false}]};
  if(sql.includes('FROM deployment_calibration_profiles'))return {rows};
  if(sql.includes('INSERT INTO deployment_calibration_profiles')){
   inserts.push(params);
   rows.push({id:String(params[0]),version:Number(params[1]),stage:String(params[5]),
    allowance_state:String(params[6]),model:JSON.parse(String(params[8])),
    validation:JSON.parse(String(params[9])),source_hash:String(params[10])});
   return {rows:[]};
  }
  return {rows:[]};
 },release:()=>{}};
 const pool={connect:async()=>client} as never;
 let anchorChecks=0;
 const verifyAnchors=async(chainId:number,sources:readonly {block:string;hash:string;timestamp:number}[])=>{
  anchorChecks++;assert.equal(chainId,report.profile.pool.chainId);
  assert.deepEqual(sources,[report.openModel.source,report.previousSource,report.frame.source]);
 };
 const verifyFeeReplay=async()=>({replayHash:report.feeReplay.replayHash,
  intervalHash:report.feeReplay.intervalHash,previousFeeCarryHash:report.feeReplay.previousFeeCarryHash,
  feeCarryHash:report.feeReplay.feeCarryHash,previousFeeEvidenceId:report.feeReplay.previousFeeEvidenceId,
  from:report.feeReplay.from,to:report.feeReplay.to,stream:report.feeReplay.stream,
  targetSetHash:report.feeReplay.targetSetHash} as never);
 const first=await registerProspectivePaperCloseConvertPrestateGasProfiles({pool,report,
  verifyAnchors,verifyFeeReplay,now:1020000});
 assert.equal(first.created,true);assert.equal(first.profileIds.length,7);assert.equal(inserts.length,7);
 assert.equal(anchorChecks,2);
 assert(rows.every(row=>row.validation.importPolicy==='prospective_fork_estimate_only'));
 assert(rows.every(row=>row.validation.actionAvailable===false));
 assert(rows.every(row=>row.validation.terminalMarkId===null));
 const second=await registerProspectivePaperCloseConvertPrestateGasProfiles({pool,report,
  verifyAnchors,verifyFeeReplay,now:1020000});
 assert.equal(second.created,false);assert.deepEqual(second.profileIds,first.profileIds);
 assert.equal(inserts.length,7);assert.equal(anchorChecks,4);
 assert(rows.every(row=>row.version===1));
 assert.equal(first.pathVersion,PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1);
});
