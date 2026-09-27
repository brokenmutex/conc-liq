import assert from 'node:assert/strict';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {PAPER_STATIC_CONVERT_GAS_STAGES_V2} from
 '../src/deployments/paper-close-convert-model.js';
import {verifyPaperCloseConvertTerminalGasReplay} from
 '../src/deployments/paper-close-convert-terminal-replay-verifier.js';
import {safePaperCloseConvertTerminalReplayFailure,
 type PaperCloseConvertTerminalReplayStage,
 verifyPaperStaticCloseConvertTerminalForWorker} from
 '../src/deployments/paper-close-convert-terminal-replay-verifier.js';

test('terminal verifier diagnostics retain only safe machine codes or error classes',()=>{
 assert.equal(safePaperCloseConvertTerminalReplayFailure(
  Error('paper_close_convert_terminal_quote_replay_mismatch')),
  'paper_close_convert_terminal_quote_replay_mismatch');
 assert.equal(safePaperCloseConvertTerminalReplayFailure(
  Error('request failed https://rpc.example/key?secret=abc\nresponse body')), 'Error');
 assert.equal(safePaperCloseConvertTerminalReplayFailure(new TypeError('private detail')), 'TypeError');
 assert.equal(safePaperCloseConvertTerminalReplayFailure('private detail'), 'unknown');
});

test('terminal verifier reports parse stage without allowing diagnostics to mask failure',async()=>{
 const stages:string[]=[];
 await assert.rejects(verifyPaperStaticCloseConvertTerminalForWorker({
  store:{} as never,campaignId:'campaign',revision:1,rawModel:{},client:{} as never,
  indexer:{} as never,verifyAnchors:async()=>{},replayGasStages:async()=>({} as never),
  onVerifierStage:(stage:PaperCloseConvertTerminalReplayStage)=>{
   stages.push(stage);throw Error('diagnostic callback failed');}
 } as never));
 assert.deepEqual(stages,['terminal_model_parse']);
});

test('terminal gas replay requires all seven source and profile bindings in order',()=>{
 const source={block:'120',hash:'0x'+'1'.repeat(64),timestamp:1_800_000_000},
  estimatedSource={block:source.block,hash:source.hash,
   estimatedAt:new Date(source.timestamp*1000).toISOString(),
   callHash:'0x'+'2'.repeat(64),method:'owned_fork_nitro_exact_call_v1' as const},
  scopeHash='c'.repeat(64),sequenceHash='b'.repeat(64),
  profileStages=PAPER_STATIC_CONVERT_GAS_STAGES_V2.map((stage,stageIndex)=>({stage,
   profileId:`00000000-0000-4000-8000-${String(stageIndex+1).padStart(12,'0')}`,
   version:1,evidenceClass:'fork_estimated' as const,allowanceState:'zero',
   expectedGasUnits:'100',boundGasUnits:'130',scopeHash,sequenceHash,stageIndex,
   stageCount:PAPER_STATIC_CONVERT_GAS_STAGES_V2.length,source:estimatedSource})),
  gasReport={reportHash:'e'.repeat(64),scopeHash,sequenceHash,source,
   stages:profileStages.map(stage=>({stage:stage.stage,source:stage.source,sourceHash:contentHash(stage.source),
    callHash:stage.source.callHash,gasUnitsExpected:stage.expectedGasUnits,
    gasUnitsBound:stage.boundGasUnits}))},
  costs={schemaVersion:1,kind:'paper_close_convert_prestate_costs_v1',status:'provisional',
   scope:'candidate_prestate_gas_only',pathVersion:'paper_static_manual_close_convert_prestate_v1',
   reportHash:gasReport.reportHash,scopeHash,sequenceHash,sizeBand:'fixture',gasPriceWei:'1',
   boundGasPriceWei:'2',gasPriceObservedAt:new Date(source.timestamp*1000).toISOString(),
   nativeReferencePrice:'1',stages:profileStages.map(stage=>({...stage,sourceHash:contentHash(stage.source)})),
   expectedGasUnits:'700',boundGasUnits:'910',expectedWei:'700',boundWei:'1820',
   expectedValue:'1',boundValue:'1',paidGasAvailable:false} as never,
  replay={reportHash:'c'.repeat(64),scopeHash,sequenceHash,source,costs,stages:profileStages.map(stage=>({
   ...stage,callHash:stage.source.callHash,sourceHash:contentHash(stage.source)}))};
 replay.reportHash=gasReport.reportHash;
 assert.equal(verifyPaperCloseConvertTerminalGasReplay({costs,gasReport,source,replay}),replay.reportHash);
 assert.throws(()=>verifyPaperCloseConvertTerminalGasReplay({costs,gasReport,source,
  replay:{...replay,stages:replay.stages.slice(1)}}),
  /paper_close_convert_terminal_gas_replay_binding_invalid/);
 assert.throws(()=>verifyPaperCloseConvertTerminalGasReplay({costs,gasReport,source,
  replay:{...replay,stages:replay.stages.map((stage,index)=>index===3?{...stage,
   profileId:'00000000-0000-4000-8000-000000000099'}:stage)}}),
  /paper_close_convert_terminal_gas_stage_replay_mismatch/);
 assert.throws(()=>verifyPaperCloseConvertTerminalGasReplay({costs,gasReport,source,
  replay:{...replay,stages:replay.stages.map((stage,index)=>index===0?{...stage,
   sourceHash:'d'.repeat(64)}:stage)}}),
  /paper_close_convert_terminal_gas_stage_replay_mismatch/);
});
