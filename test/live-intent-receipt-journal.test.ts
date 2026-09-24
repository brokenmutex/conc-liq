import assert from 'node:assert/strict';
import test from 'node:test';
import {readLiveIntentReceiptJournalEvidence} from '../src/deployments/live-intent-receipt-journal.js';

const operator='0x1111111111111111111111111111111111111111';
const hash=`0x${'a'.repeat(64)}`;
const row=(overrides:Record<string,unknown>={})=>({campaignId:'campaign-1',phase:'holding',desired:'running',
 heartbeatAt:new Date('2026-09-24T10:00:00.000Z'),actionId:'action-1',nonce:'7',intentOperator:operator,
 chainId:'4663',action:'mint',actionStatus:'confirmed',transactionHash:hash,receiptHash:hash,...overrides});
const dbReturning=(rows:unknown[])=>({query:async(sql:string,values?:unknown[])=>({rows,sql,values})});

test('empty legacy journal is not found and never implies target-strategy readiness',async()=>{
 let sql='';const db={query:async(statement:string)=>{sql=statement;return {rows:[]};}};
 const result=await readLiveIntentReceiptJournalEvidence(db,operator,'static_manual_v1');
 assert.equal(result.status,'unavailable');assert.equal(result.journalStatus,'not_found');
 assert.equal(result.targetStrategyId,'static_manual_v1');assert.equal(result.campaign,null);assert.deepEqual(result.actions,[]);
 assert.equal(result.actionAvailable,false);assert.equal(result.executionEligible,false);
 assert(result.unavailableReasons.includes('canonical_wallet_nonce_not_observed'));
 assert(result.unavailableReasons.includes('legacy_live_pilot_journal_not_bound_to_target_strategy_or_campaign'));
 assert(sql.includes('FROM live_pilot_v1.campaigns')&&sql.includes('LEFT JOIN live_pilot_v1.actions'));
 assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i);
 assert.doesNotMatch(sql,/a\.raw\b|before_state|a\.plan/);
});

test('prepared and signed intents remain unresolved for either supported strategy',async()=>{
 const result=await readLiveIntentReceiptJournalEvidence(dbReturning([
  row({actionId:'prepared-action',actionStatus:'prepared',transactionHash:null,receiptHash:null}),
  row({actionId:'signed-action',nonce:'8',actionStatus:'signed',transactionHash:hash,receiptHash:null}),
 ]) as never,operator,'rangekeeper_v1');
 assert.equal(result.status,'unavailable');assert.equal(result.journalStatus,'unresolved');
 assert.equal(result.targetStrategyId,'rangekeeper_v1');
 assert.deepEqual(result.journalBlockers,['unresolved_prepared_intent','unresolved_signed_intent']);
 assert.equal(result.actions.length,2);assert.equal(result.actionAvailable,false);
 assert.equal(JSON.stringify(result).includes('raw_transaction'),false);
 assert.equal(JSON.stringify(result).includes('before_state'),false);
});

test('terminal receipt hashes may be coherent without proving current custody',async()=>{
 const rows=[row(),row({actionId:'reverted-action',nonce:'8',actionStatus:'reverted',
  transactionHash:`0x${'b'.repeat(64)}`,receiptHash:`0x${'b'.repeat(64)}`}),
  row({actionId:'cancelled-action',nonce:'9',actionStatus:'cancelled',transactionHash:null,receiptHash:null})];
 const result=await readLiveIntentReceiptJournalEvidence(dbReturning(rows) as never,operator,'static_manual_v1');
 assert.equal(result.status,'unavailable');assert.equal(result.journalStatus,'coherent');assert.equal(result.actions.length,3);
 assert.equal(result.actions[0]?.receiptHashBound,true);assert.equal(result.actions[1]?.receiptHashBound,true);
 assert.equal(result.actions[2]?.receiptHashBound,false);assert.equal(result.actionAvailable,false);
});

test('multiple campaigns and duplicate campaign nonces are ambiguous journal evidence',async()=>{
 const multiple=await readLiveIntentReceiptJournalEvidence(dbReturning([
  row(),row({campaignId:'campaign-2',nonce:'8',actionId:'action-2'}),
 ]) as never,operator,'rangekeeper_v1');
 assert.equal(multiple.journalStatus,'ambiguous');assert(multiple.journalBlockers.includes('multiple_legacy_campaigns_for_operator'));
 assert.equal(multiple.campaign,null);
 const duplicate=await readLiveIntentReceiptJournalEvidence(dbReturning([
  row(),row({actionId:'action-2'}),
 ]) as never,operator,'static_manual_v1');
 assert.equal(duplicate.journalStatus,'ambiguous');assert(duplicate.journalBlockers.includes('duplicate_campaign_nonce_records'));
});

test('malformed intent identity or mismatched terminal receipt fails closed',async()=>{
 const identity=await readLiveIntentReceiptJournalEvidence(dbReturning([row({intentOperator:'not-an-address'})]) as never,operator,'static_manual_v1');
 assert.equal(identity.status,'unavailable');assert.equal(identity.journalStatus,'invalid');
 assert(identity.journalBlockers.includes('live_intent_journal_row_invalid'));
 const receipt=await readLiveIntentReceiptJournalEvidence(dbReturning([row({receiptHash:`0x${'f'.repeat(64)}`})]) as never,operator,'static_manual_v1');
 assert.equal(receipt.status,'unavailable');assert.equal(receipt.journalStatus,'invalid');
 assert(receipt.journalBlockers.includes('terminal_receipt_hash_mismatch'));
});

test('missing journal and invalid address are explicit unavailable results',async()=>{
 const failed=await readLiveIntentReceiptJournalEvidence({query:async()=>{throw Error('missing table');}},operator,'rangekeeper_v1');
 assert.equal(failed.status,'unavailable');assert.equal(failed.journalStatus,'unavailable');
 assert(failed.unavailableReasons.includes('live_intent_receipt_journal_unavailable'));
 let queried=false;const invalid=await readLiveIntentReceiptJournalEvidence({query:async()=>{queried=true;return {rows:[]};}},'bad','static_manual_v1');
 assert.equal(invalid.status,'unavailable');assert(invalid.unavailableReasons.includes('operator_address_invalid'));
 assert.equal(queried,false);
});

test('journal scan is bounded and unsupported legacy strategies are never queried',async()=>{
 const rows=Array.from({length:101},(_,index)=>row({actionId:`action-${index}`,nonce:String(index)}));
 const result=await readLiveIntentReceiptJournalEvidence(dbReturning(rows) as never,operator,'static_manual_v1');
 assert.equal(result.status,'unavailable');assert.equal(result.journalStatus,'unavailable');
 assert(result.unavailableReasons.includes('live_intent_journal_bound_exceeded'));assert.deepEqual(result.actions,[]);
 let queried=false;
 const unsupported=await readLiveIntentReceiptJournalEvidence({query:async()=>{queried=true;return {rows:[]};}},operator,'adaptive_width_v1');
 assert.equal(unsupported.status,'unavailable');assert.equal(unsupported.targetStrategyId,null);
 assert(unsupported.unavailableReasons.includes('target_strategy_unsupported'));assert.equal(queried,false);
});
