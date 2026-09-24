import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {contentHash} from './contracts.js';
import type {PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import {marketProfileEvidenceSchema,marketProfileSchema,referenceProofHash} from './market-profile.js';
import {paperOpenModelSchema} from './paper-open-model.js';
import {verifyPaperCloseConvertPrestateReport} from './paper-close-convert-prestate-sampler.js';
import {buildProspectivePaperCloseConvertPrestateGasProfiles,
 PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1} from './paper-close-convert-prestate-gas-profiles.js';
import type {EphemeralStaticPaperCloseConvertFeeReplay} from './paper-close-convert-ephemeral-fees.js';

/** Persist only explicitly provisional prestate samples. This path is not read
 * by terminal close-convert selectors and does not attest paid economics. */
export async function registerProspectivePaperCloseConvertPrestateGasProfiles(input:{
 pool:Pool;report:unknown;verifyAnchors:(chainId:number,
  sources:readonly PaperCanonicalAnchor[])=>Promise<void>;
 verifyFeeReplay:(report:ReturnType<typeof verifyPaperCloseConvertPrestateReport>)=>
  Promise<EphemeralStaticPaperCloseConvertFeeReplay>;now?:number;
}){
 const report=verifyPaperCloseConvertPrestateReport(input.report),prospective=
  buildProspectivePaperCloseConvertPrestateGasProfiles(report),now=input.now??Date.now(),
  sampledAt=Date.parse(report.gasStages[0]!.source.estimatedAt);
 if(!Number.isFinite(sampledAt)||now-sampledAt<0||now-sampledAt>300_000||
  sampledAt-report.frame.source.timestamp*1000<0||sampledAt-report.frame.source.timestamp*1000>180_000)
  throw Error('paper_close_convert_prestate_gas_sample_stale');
 const anchors=[report.openModel.source,report.previousSource,report.frame.source];
 const feeReplay=await input.verifyFeeReplay(report);
 if(feeReplay.replayHash!==report.feeReplay.replayHash||
  feeReplay.intervalHash!==report.feeReplay.intervalHash||
  feeReplay.previousFeeCarryHash!==report.feeReplay.previousFeeCarryHash||
  feeReplay.feeCarryHash!==report.feeReplay.feeCarryHash||
  feeReplay.previousFeeEvidenceId!==report.feeReplay.previousFeeEvidenceId||
  contentHash(feeReplay.to)!==contentHash(report.feeReplay.to)||
  contentHash(feeReplay.from)!==contentHash(report.feeReplay.from)||
  feeReplay.stream!==report.feeReplay.stream||feeReplay.targetSetHash!==report.feeReplay.targetSetHash)
  throw Error('paper_close_convert_prestate_gas_fee_replay_mismatch');
 await input.verifyAnchors(report.profile.pool.chainId,anchors);
 const db=await input.pool.connect();
 try{
  await db.query('BEGIN');
  try{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`paper-close-convert-prestate:${report.campaignId}:${report.gasScopeHash}`]);
   const campaign=(await db.query<{mode:string;lifecycle:string;current_revision:number;
    strategy_id:string;strategy_version:string;state_schema_version:number;config:unknown;
    config_hash:string;profile:unknown;profile_hash:string;evidence:unknown;open_mark_id:string;
    latest_mark_id:string;latest_source_block:string|null;latest_source_hash:string|null;
    open_provenance:Record<string,unknown>;open_proposal:Record<string,unknown>}>(`
    SELECT c.mode,c.lifecycle,c.current_revision,r.strategy_id,r.strategy_version,
     r.state_schema_version,r.config,r.config_hash,p.profile,p.profile_hash,p.evidence,
     o.id::text AS open_mark_id,o.provenance AS open_provenance,v.proposal AS open_proposal,
     latest.id::text AS latest_mark_id,latest.source_block::text AS latest_source_block,
     latest.source_hash AS latest_source_hash
    FROM deployment_campaigns c JOIN deployment_revisions r
     ON r.campaign_id=c.id AND r.revision=c.current_revision
    JOIN deployment_market_profiles p ON p.id=c.market_profile_id
    JOIN LATERAL (SELECT id,provenance FROM deployment_marks WHERE campaign_id=c.id
     AND provenance->>'classification'='paper_model_provisional' ORDER BY id LIMIT 1) o ON TRUE
    JOIN deployment_previews v ON v.id=(o.provenance->>'previewId')::uuid
    JOIN LATERAL (SELECT id,source_block,source_hash FROM deployment_marks
     WHERE campaign_id=c.id ORDER BY id DESC LIMIT 1) latest ON TRUE
    WHERE c.id=$1 FOR UPDATE OF c`,[report.campaignId])).rows[0];
   const profile=marketProfileSchema.safeParse(campaign?.profile),
    evidence=marketProfileEvidenceSchema.safeParse(campaign?.evidence),
    open=paperOpenModelSchema.safeParse(campaign?.open_proposal.paperOpenModel);
   if(!campaign||campaign.mode!=='paper'||!['active','paused'].includes(campaign.lifecycle)||
    campaign.current_revision!==report.revision||campaign.strategy_id!=='static_manual_v1'||
    campaign.strategy_version!=='1.0.0'||campaign.state_schema_version!==1||
    !campaign.config||contentHash(campaign.config)!==campaign.config_hash||!profile.success||
    !evidence.success||!open.success||contentHash(profile.data)!==campaign.profile_hash||
    campaign.profile_hash!==report.profileHash||referenceProofHash(evidence.data.referenceProof)!==
     evidence.data.references.proofHash||evidence.data.streamKey!==report.feeReplay.stream||
   evidence.data.indexerTargetSetHash!==report.feeReplay.targetSetHash||
    open.data.campaignId!==report.campaignId||open.data.revision!==report.revision||
    open.data.profileHash!==campaign.profile_hash||open.data.configHash!==campaign.config_hash||
    open.data.candidateHash!==contentHash({campaignId:open.data.campaignId,revision:open.data.revision,
     profileHash:open.data.profileHash,configHash:open.data.configHash,source:open.data.source,
     referenceProofHash:open.data.referenceProofHash,candidate:open.data.candidate})||
    contentHash(open.data)!==report.openModelHash||campaign.open_mark_id!==report.openMarkId||
    campaign.open_provenance.modelHash!==report.openModelHash)
    throw Error('paper_close_convert_prestate_gas_campaign_binding_invalid');
   for(const key of ['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash',
    'quoterCodeHash'] as const)
    if(profile.data.pool[key].toLowerCase()!==evidence.data.contractHashes[key].toLowerCase())
     throw Error('paper_close_convert_prestate_gas_profile_integrity');
   if(campaign.latest_mark_id!==report.previousMarkId||
    campaign.latest_source_block!==report.previousSource.block||
    campaign.latest_source_hash?.toLowerCase()!==report.previousSource.hash.toLowerCase())
    throw Error('paper_close_convert_prestate_gas_latest_mark_changed');
   const fee=(await db.query<{id:string;to_mark_id:string;carry_hash:string}>(`
    SELECT id::text,to_mark_id::text,carry_hash FROM deployment_paper_fee_evidence
    WHERE id=$1 AND campaign_id=$2`,[report.feeReplay.previousFeeEvidenceId,report.campaignId])).rows[0];
   if(!fee||fee.to_mark_id!==report.previousMarkId||
    fee.carry_hash!==report.feeReplay.previousFeeCarryHash)
    throw Error('paper_close_convert_prestate_gas_fee_anchor_changed');
   const pending=(await db.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM deployment_operations
    WHERE campaign_id=$1 AND status IN ('queued','preflighting','executing','confirming',
     'reconciling')) AS found`,[report.campaignId])).rows[0]?.found;
   if(pending)throw Error('paper_close_convert_prestate_gas_operation_pending');
   const existing=(await db.query<{id:string;stage:string;allowance_state:string;version:number;
    validation:Record<string,unknown>;model:unknown;source_hash:string}>(`
    SELECT id::text,stage,allowance_state,version,validation,model,source_hash
    FROM deployment_calibration_profiles WHERE chain_id=$1 AND lower(pool_address)=lower($2)
     AND path_version=$3 AND size_band=$4 AND component='gas_units'
    ORDER BY stage,version DESC`,[profile.data.pool.chainId,profile.data.pool.pool,
     prospective.pathVersion,prospective.sizeBand])).rows,
   matching=existing.filter(row=>row.validation?.reportHash===report.reportHash);
   if(matching.length){
    if(matching.length!==prospective.profiles.length||
     new Set(matching.map(row=>row.stage)).size!==prospective.profiles.length||
     matching.some(row=>{
      const expected=prospective.profiles.find(item=>item.stage===row.stage);
      return !expected||row.version!==matching[0]!.version||
       row.allowance_state!==expected.allowanceState||row.source_hash!==expected.sourceHash||
       contentHash(row.model)!==contentHash(expected.model)||
       row.validation.scopeHash!==report.gasScopeHash||
       row.validation.sequenceHash!==report.gasSequenceHash||
       row.validation.actionAvailable!==false;
     }))
     throw Error('paper_close_convert_prestate_gas_partial_import');
    await input.verifyAnchors(report.profile.pool.chainId,anchors);
    await db.query('COMMIT');
    return {created:false,version:matching[0]!.version,
     profileIds:prospective.profiles.map(profileRow=>matching.find(row=>row.stage===profileRow.stage)!.id),
     reportHash:report.reportHash,sizeBand:prospective.sizeBand,pathVersion:prospective.pathVersion};
   }
   const version=existing.reduce((max,row)=>Math.max(max,row.version),0)+1,profileIds:string[]=[];
   for(const row of prospective.profiles){
    const id=randomUUID(),validation={...row.validation,importPolicy:'prospective_fork_estimate_only',
     actionAvailable:false,terminalMarkId:null,independentlyValidated:false,
     importedAt:new Date(now).toISOString()};
    await db.query(`INSERT INTO deployment_calibration_profiles
     (id,version,chain_id,pool_address,path_version,stage,allowance_state,size_band,
      component,status,evidence_class,model,validation,source_hash,observed_until)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'gas_units','provisional','fork_estimated',
      $9,$10,$11,$12)`,[id,version,row.chainId,row.poolAddress,
       PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1,row.stage,row.allowanceState,row.sizeBand,
       JSON.stringify(row.model),JSON.stringify(validation),row.sourceHash,row.observedUntil]);
    profileIds.push(id);
   }
   await input.verifyAnchors(report.profile.pool.chainId,anchors);
   await db.query('COMMIT');
   return {created:true,version,profileIds,
    reportHash:report.reportHash,sizeBand:prospective.sizeBand,pathVersion:prospective.pathVersion};
  }catch(error){await db.query('ROLLBACK');throw error;}
 }finally{db.release();}
}
