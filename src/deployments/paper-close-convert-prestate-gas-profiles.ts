import assert from 'node:assert/strict';
import {PAPER_STATIC_CONVERT_GAS_PATH_V2,PAPER_STATIC_CONVERT_GAS_STAGES_V2} from './paper-close-convert-model.js';
import {paperCloseConvertGasAllowanceStateV2} from './paper-gas-evidence.js';
import {verifyPaperCloseConvertPrestateReport} from './paper-close-convert-prestate-sampler.js';

export const PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1=
 'paper_static_manual_close_convert_prestate_v1' as const;

/**
 * Converts a verified prestate sampler envelope into seven provisional,
 * source/candidate-specific calibration rows. This is deliberately a distinct
 * path version from terminal-close calibration; callers must persist it under
 * this path and must never feed it to the terminal selector.
 */
export function buildProspectivePaperCloseConvertPrestateGasProfiles(raw:unknown){
 const report=verifyPaperCloseConvertPrestateReport(raw),scopeHash=report.gasScopeHash,
  sizeBand=`prestate_exact_${scopeHash.slice(0,32)}`;
 assert.equal(report.gasStages.length,PAPER_STATIC_CONVERT_GAS_STAGES_V2.length);
 const profiles=report.gasStages.map((stage,index)=>{
  const expectedStage=PAPER_STATIC_CONVERT_GAS_STAGES_V2[index]!;
  assert.equal(stage.stage,expectedStage);
  const source={...stage.source},model={schemaVersion:1,kind:'paper_close_convert_prestate_gas_stage_v1',
   stage:stage.stage,source,gasUnitsExpected:stage.gasUnitsExpected,gasUnitsBound:stage.gasUnitsBound,
   sizeMinValue:report.openModel.candidate.deployedValue,
   sizeMaxValue:report.openModel.candidate.deployedValue,
   shareMinPpm:report.openModel.candidate.dilutedSharePpm,
   shareMaxPpm:report.openModel.candidate.dilutedSharePpm,
   tickLower:report.openModel.candidate.range.tickLower,
   tickUpper:report.openModel.candidate.range.tickUpper,
   scopeHash,sequenceHash:report.gasSequenceHash,stageIndex:index,
   stageCount:PAPER_STATIC_CONVERT_GAS_STAGES_V2.length,
   feeCarryHash:report.feeCarryHash,feeReplayHash:report.feeReplay.replayHash,
   latestMarkId:report.previousMarkId,latestMarkSource:report.previousSource,
   routeHash:report.route.routeHash,quoteHash:report.quote.quoteHash,
   inventoryHash:report.sourceReplayHash,allowancesBefore:stage.allowancesBefore,
   allowancesAfter:stage.allowancesAfter,balancesBefore:stage.balancesBefore,
   balancesAfter:stage.balancesAfter},
   validation={validationPolicy:'paper_close_convert_prestate_gas_v1',
    evidenceClass:'fork_estimated',statusReason:'owned_fork_prestate_stage_replay',
    reportHash:report.reportHash,campaignId:report.campaignId,revision:report.revision,
    openMarkId:report.openMarkId,latestMarkId:report.previousMarkId,
    profileHash:report.profileHash,openModelHash:report.openModelHash,
    feeCarryHash:report.feeCarryHash,feeReplay:report.feeReplay,
    sampleSource:report.frame.source,routeHash:report.route.routeHash,
    quoteHash:report.quote.quoteHash,scopeHash,sequenceHash:report.gasSequenceHash,
    stageEvidence:stage};
  return {chainId:report.profile.pool.chainId,poolAddress:report.profile.pool.pool.toLowerCase(),
   pathVersion:PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1,stage:stage.stage,
   allowanceState:paperCloseConvertGasAllowanceStateV2(stage.stage,stage.allowancesBefore),sizeBand,
   component:'gas_units' as const,status:'provisional' as const,evidenceClass:'fork_estimated' as const,
   model,validation,sourceHash:stage.sourceHash,observedUntil:new Date(stage.source.estimatedAt)};
 });
 return {pathVersion:PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1,evidenceClass:'fork_estimated' as const,
  classification:'prestate_prospective_only' as const,actionAvailable:false as const,
  reportHash:report.reportHash,scopeHash,sizeBand,profiles};
}
