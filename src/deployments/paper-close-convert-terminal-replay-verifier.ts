import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import {principalAmounts} from '../backtest/principal.js';
import {contentHash} from './contracts.js';
import type {PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import {readStaticPaperCloseConvertFeeContext} from './paper-close-convert-fee-reader.js';
import {replayEphemeralStaticPaperCloseConvertFees} from './paper-close-convert-ephemeral-fees.js';
import {parsePaperStaticCloseConvertTerminalV2,type PaperStaticCloseConvertTerminalModel,
 quotePaperCloseConvertAtSource} from './paper-close-convert-preflight.js';
import type {DeploymentStore} from './store.js';
import type {PaperOpenFrame} from './paper-preview.js';
import {PAPER_STATIC_CONVERT_GAS_STAGES_V2} from './paper-close-convert-model.js';
import {paperCloseConvertPrestateCostsV1Schema,type PaperCloseConvertPrestateCostsV1} from
 './paper-close-convert-prestate-costs.js';

export interface PaperCloseConvertTerminalGasReplay {
 reportHash:string;scopeHash:string;sequenceHash:string;source:PaperOpenFrame['source'];
 costs:PaperCloseConvertPrestateCostsV1;
 stages:readonly {stage:string;profileId:string;version:number;callHash:string;sourceHash:string;
  expectedGasUnits:string;boundGasUnits:string;scopeHash:string;sequenceHash:string;
  stageIndex:number;stageCount:number;source:PaperStaticCloseConvertTerminalModel['costs']['stages'][number]['source']}[];
}

export function verifyPaperCloseConvertTerminalGasReplay(input:{
 costs:PaperStaticCloseConvertTerminalModel['costs'];
 gasReport:PaperStaticCloseConvertTerminalModel['gasReport'];source:PaperOpenFrame['source'];
 replay:PaperCloseConvertTerminalGasReplay;
}):string{
 const {costs,gasReport,source,replay}=input,expectedStages=costs.stages;
 if(!/^[0-9a-f]{64}$/.test(replay.reportHash)||replay.reportHash!==gasReport.reportHash||
  costs.reportHash!==gasReport.reportHash||costs.scopeHash!==gasReport.scopeHash||
  costs.sequenceHash!==gasReport.sequenceHash||costs.paidGasAvailable!==false||
  paperCloseConvertPrestateCostsV1Schema.safeParse(costs).success===false||
  contentHash(replay.costs)!==contentHash(costs)||
  replay.scopeHash!==gasReport.scopeHash||replay.sequenceHash!==gasReport.sequenceHash||
  contentHash(replay.source)!==contentHash(source)||
  replay.stages.length!==PAPER_STATIC_CONVERT_GAS_STAGES_V2.length)
  throw Error('paper_close_convert_terminal_gas_replay_binding_invalid');
 for(let index=0;index<PAPER_STATIC_CONVERT_GAS_STAGES_V2.length;index++){
  const expected=expectedStages.find(stage=>stage.stage===PAPER_STATIC_CONVERT_GAS_STAGES_V2[index]),
   actual=replay.stages[index];
  const sampled=gasReport.stages[index];
  if(!expected||!actual||!sampled||actual.stage!==expected.stage||actual.stage!==sampled.stage||
   actual.sourceHash!==sampled.sourceHash||actual.callHash!==sampled.callHash||
   actual.expectedGasUnits!==sampled.gasUnitsExpected||actual.boundGasUnits!==sampled.gasUnitsBound||
   contentHash(actual.source)!==contentHash(sampled.source)||actual.profileId!==expected.profileId||
   actual.version!==expected.version||actual.callHash!==expected.source.callHash||
   actual.sourceHash!==contentHash(actual.source)||actual.expectedGasUnits!==expected.expectedGasUnits||
   actual.boundGasUnits!==expected.boundGasUnits||actual.scopeHash!==expected.scopeHash||
   actual.sequenceHash!==expected.sequenceHash||actual.stageIndex!==index||
   actual.stageCount!==PAPER_STATIC_CONVERT_GAS_STAGES_V2.length||
   contentHash(actual.source)!==contentHash(expected.source))
   throw Error('paper_close_convert_terminal_gas_stage_replay_mismatch');
 }
 return replay.reportHash;
}

/** Verifies the exact fee interval and seven terminal gas stages immediately
 * before the worker may use a saved terminal preview. This function does not
 * accept an operation, book a mark, or make the preview actionable. */
export async function verifyPaperStaticCloseConvertTerminalForWorker(input:{
 store:Pick<DeploymentStore,'readStaticPaperCloseConvertFeeCarry'>;campaignId:string;revision:number;
 rawModel:unknown;client:RobinhoodClient;indexer:Pool;
 verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>;
 replayGasStages:(input:{model:PaperStaticCloseConvertTerminalModel;frame:PaperOpenFrame})=>
  Promise<PaperCloseConvertTerminalGasReplay>;now?:number;
}){
 const model=parsePaperStaticCloseConvertTerminalV2(input.rawModel),now=input.now??Date.now();
 if(model.campaignId!==input.campaignId||model.revision!==input.revision||
  model.feeReplay.to.block!==model.source.block||
  model.feeReplay.to.hash.toLowerCase()!==model.source.hash.toLowerCase()||
  model.quote.source.block!==model.source.block||
  model.quote.source.hash.toLowerCase()!==model.source.hash.toLowerCase()||
  model.conversionRoute.routeHash!==contentHash((({routeHash:_h,...body})=>body)(model.conversionRoute))||
  model.quote.quoteHash!==contentHash((({quoteHash:_h,...body})=>body)(model.quote)))
  throw Error('paper_close_convert_terminal_candidate_binding_invalid');
 const context=await readStaticPaperCloseConvertFeeContext({store:input.store,
  campaignId:input.campaignId,revision:input.revision,verifyAnchors:input.verifyAnchors}),
  state=context.state,open=state.openModel,p=state.profile.pool;
 if(model.openMarkId!==state.openMarkId||model.previousMarkId!==state.previous.markId||
  model.openModelHash!==contentHash(open)||model.scope.profileHash!==state.profileHash||
  model.conversionRoute.routeHash!==contentHash((({routeHash:_h,...body})=>body)(model.conversionRoute))||
  model.feeReplay.previousFeeEvidenceId!==context.feeEvidence.id||
  model.feeReplay.previousFeeCarryHash!==context.feeEvidence.carryHash||
  model.feeReplay.feeCarryHash!==contentHash(model.feeReplay.feeCarry)||
  model.feeReplay.stream!==context.stream||model.feeReplay.targetSetHash!==context.targetSetHash||
  model.feeReplay.from.block!==state.previous.sourceBlock||
  model.feeReplay.from.hash.toLowerCase()!==state.previous.sourceHash.toLowerCase())
  throw Error('paper_close_convert_terminal_saved_context_changed');
 const frame:PaperOpenFrame={source:model.source,tick:model.poolState.tick,
  sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),poolLiquidity:BigInt(model.poolState.poolLiquidity),
  price0:BigInt(model.reference.price0),price1:BigInt(model.reference.price1),
  nativePrice:BigInt(model.reference.nativePrice),referenceEligible:true,referenceReasons:[],
  referenceProofHash:model.referenceProofHash,referenceProof:model.referenceProof};
 const replay=await replayEphemeralStaticPaperCloseConvertFees({context,client:input.client,
  indexer:input.indexer,frame});
 assert.equal(contentHash(replay),contentHash(model.feeReplay),
  'paper_close_convert_terminal_ephemeral_fee_replay_changed');
 const principal=principalAmounts({liquidity:BigInt(open.candidate.liquidity),
  tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
  sqrtPriceX96:frame.sqrtPriceX96}),fee0=BigInt(replay.feeCarry.token0.lowerAmountRaw),
  fee1=BigInt(replay.feeCarry.token1.lowerAmountRaw),idle0=BigInt(open.candidate.idle0),
  idle1=BigInt(open.candidate.idle1),expected0=principal.amount0+idle0+fee0,
  expected1=principal.amount1+idle1+fee1;
 if(model.inventory.principal0Raw!==String(principal.amount0)||
  model.inventory.principal1Raw!==String(principal.amount1)||
  model.inventory.idle0Raw!==String(idle0)||model.inventory.idle1Raw!==String(idle1)||
  model.inventory.fee0Raw!==String(fee0)||model.inventory.fee1Raw!==String(fee1)||
  model.inventory.token0Raw!==String(expected0)||model.inventory.token1Raw!==String(expected1)||
  model.inventory.inputAmountRaw!==String(model.inventory.inputAsset==='token0'?expected0:expected1))
  throw Error('paper_close_convert_terminal_inventory_replay_mismatch');
 const quote=await quotePaperCloseConvertAtSource(input.client,model.conversionRoute,model.source,
  model.inventory.inputAmountRaw);
 if(contentHash(quote)!==contentHash(model.quote))
  throw Error('paper_close_convert_terminal_quote_replay_mismatch');
 const gas=await input.replayGasStages({model,frame}),gasReportHash=
  verifyPaperCloseConvertTerminalGasReplay({costs:model.costs,gasReport:model.gasReport,
   source:model.source,replay:gas});
 await input.verifyAnchors(p.chainId,[open.source,state.previous.source,model.source]);
 if(now>model.source.timestamp*1000+180_000)
  throw Error('paper_close_convert_terminal_source_stale');
 return {status:'verified' as const,modelHash:model.modelHash,feeReplayHash:replay.replayHash,
  previousFeeEvidenceId:replay.previousFeeEvidenceId,intervalHash:replay.intervalHash,
  feeCarryHash:replay.feeCarryHash,gasReportHash,
  source:model.source,actionAvailable:false as const,bookingAvailable:false as const};
}
