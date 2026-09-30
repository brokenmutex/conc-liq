import assert from 'node:assert/strict';
import test from 'node:test';
import {safePaperDiagnosticFailure} from '../src/deployments/paper-diagnostic.js';

const assertion=(message:string)=>{
 try{assert.equal('left','right',message);}
 catch(error){return error;}
 throw new Error('expected assertion failure');
};

test('paper diagnostics map exact fee replay assertion first lines to bounded codes',()=>{
 const cases:[string,string][]=[
  ['Paper fee source anchor invalid','paper_fee_source_anchor_invalid'],
  ['Paper fee source reorged','paper_fee_source_reorged'],
  ['Paper fee source timestamp changed','paper_fee_source_timestamp_changed'],
  ['Paper fee snapshot tick mismatch','paper_fee_snapshot_tick_mismatch'],
  ['Paper fee snapshot price mismatch','paper_fee_snapshot_price_mismatch'],
  ['Paper fee snapshot liquidity mismatch','paper_fee_snapshot_liquidity_mismatch'],
  ['Paper fee replay coverage unavailable','paper_fee_replay_coverage_unavailable'],
  ['Paper fee replay cursor has an incomplete later block',
   'paper_fee_replay_cursor_incomplete_later_block'],
  ['Paper fee replay cursor has not covered the interval end',
   'paper_fee_replay_cursor_interval_end_uncovered'],
  ['Paper fee replay cursor hash mismatch','paper_fee_replay_cursor_hash_mismatch'],
  ['Paper fee replay cursor settle timeout','paper_fee_replay_cursor_settle_timeout'],
  ['Paper fee interval coverage invalid','paper_fee_interval_coverage_invalid'],
  ['Paper fee chain anchors were not rechecked','paper_fee_chain_anchors_not_rechecked'],
 ];
 for(const [message,code] of cases){
  const error=assertion(message);
  assert(error instanceof Error);
  assert(error.message.startsWith(`${message}\n`));
  assert.equal(safePaperDiagnosticFailure(error),code);
 }
});

test('paper diagnostics preserve machine codes and never return arbitrary error text',()=>{
 assert.equal(safePaperDiagnosticFailure(new Error('paper_close_convert_ephemeral_fee_target_set_changed')),
  'paper_close_convert_ephemeral_fee_target_set_changed');
 assert.equal(safePaperDiagnosticFailure(assertion(
  'Paper fee snapshot tick mismatch https://rpc.example/key?secret=abc')),'AssertionError');
 const untrusted=Error('response https://rpc.example/key?secret=abc\nraw body');
 untrusted.name='https://rpc.example/private';
 assert.equal(safePaperDiagnosticFailure(untrusted),'Error');
 assert.equal(safePaperDiagnosticFailure('https://rpc.example/key?secret=abc'),'unknown');
 assert.equal(safePaperDiagnosticFailure({code:'paper_fee_cursor_settle_timeout'}),
  'paper_fee_cursor_settle_timeout');
});
