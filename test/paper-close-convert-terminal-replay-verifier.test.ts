import assert from 'node:assert/strict';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {PAPER_STATIC_CONVERT_GAS_STAGES_V2} from
 '../src/deployments/paper-close-convert-model.js';
import {verifyPaperCloseConvertTerminalGasReplay} from
 '../src/deployments/paper-close-convert-terminal-replay-verifier.js';

test('terminal gas replay requires all seven source and profile bindings in order',()=>{
 const source={block:'120',hash:'0x'+'1'.repeat(64),timestamp:1_800_000_000},
  estimatedSource={block:source.block,hash:source.hash,
   estimatedAt:new Date(source.timestamp*1000).toISOString(),
   callHash:'0x'+'2'.repeat(64),method:'owned_fork_nitro_exact_call_v1' as const},
  scopeHash='a'.repeat(64),sequenceHash='b'.repeat(64),
  stages=PAPER_STATIC_CONVERT_GAS_STAGES_V2.map((stage,stageIndex)=>({stage,
   profileId:`00000000-0000-4000-8000-${String(stageIndex+1).padStart(12,'0')}`,
   version:1,evidenceClass:'fork_estimated' as const,allowanceState:'zero',
   expectedGasUnits:'100',boundGasUnits:'130',scopeHash,sequenceHash,stageIndex,
   stageCount:PAPER_STATIC_CONVERT_GAS_STAGES_V2.length,source:estimatedSource})),
  costs={scopeHash,sequenceHash,stages} as never,
  replay={reportHash:'c'.repeat(64),scopeHash,sequenceHash,source,stages:stages.map(stage=>({
   ...stage,callHash:stage.source.callHash,sourceHash:contentHash(stage.source)}))};
 assert.equal(verifyPaperCloseConvertTerminalGasReplay({costs,source,replay}),replay.reportHash);
 assert.throws(()=>verifyPaperCloseConvertTerminalGasReplay({costs,source,
  replay:{...replay,stages:replay.stages.slice(1)}}),
  /paper_close_convert_terminal_gas_replay_binding_invalid/);
 assert.throws(()=>verifyPaperCloseConvertTerminalGasReplay({costs,source,
  replay:{...replay,stages:replay.stages.map((stage,index)=>index===3?{...stage,
   profileId:'00000000-0000-4000-8000-000000000099'}:stage)}}),
  /paper_close_convert_terminal_gas_stage_replay_mismatch/);
 assert.throws(()=>verifyPaperCloseConvertTerminalGasReplay({costs,source,
  replay:{...replay,stages:replay.stages.map((stage,index)=>index===0?{...stage,
   sourceHash:'d'.repeat(64)}:stage)}}),
  /paper_close_convert_terminal_gas_stage_replay_mismatch/);
});
