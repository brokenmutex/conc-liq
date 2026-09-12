import assert from 'node:assert/strict';
import { test } from 'node:test';
import { samePersistedPaperState,pausedPaperSourceWait } from '../src/paper/preflight.js';
import {initialPaperState,DEFAULT_PAPER_POLICY,type PaperState,type PaperCheckpoint} from '../src/paper/engine.js';

test('jsonb reordering of nested holding evidence does not discard a completed exit', () => {
 const before={status:'exit_pending',position:{idle0:'200000000',liquidity:'123'},holding:{checkedAt:'now',riskEvidence:{eligible:true,reasons:[]}},optional:undefined};
 const persisted={holding:{riskEvidence:{reasons:[],eligible:true},checkedAt:'now'},position:{liquidity:'123',idle0:'200000000'},status:'exit_pending'};
 assert.notEqual(JSON.stringify(before),JSON.stringify(persisted));
 assert(samePersistedPaperState(before,persisted));
});

test('recorded chain pause waits for fresh recovery data without backfilling or extending the gap',()=>{
 const at=(seconds:number)=>new Date(Date.parse('2026-09-12T15:33:17Z')+seconds*1000).toISOString();
 const state:PaperState={...initialPaperState(),position:{} as never,last:{blockTimestamp:at(0)} as never,
  holding:{resumeFromPause:true,exitReasons:['private_block_lag_hard']} as never};
 const policy={...DEFAULT_PAPER_POLICY,maxGapSeconds:900,maxSourceAgeSeconds:180};
 const cp={blockTimestamp:at(10),capturedAt:at(18)} as PaperCheckpoint;
 assert.equal(pausedPaperSourceWait(state,policy,cp,at(249)),'wait');
 assert.equal(pausedPaperSourceWait(state,policy,{...cp,blockTimestamp:at(240),capturedAt:at(245)},at(249)),null);
 assert.equal(pausedPaperSourceWait(state,policy,cp,at(901)),'gap_exceeded');
 assert.equal(pausedPaperSourceWait({...state,holding:undefined},policy,cp,at(249)),null,'Unexplained missed decisions retain ordinary invalidation');
 assert.deepEqual(state.holding!.exitReasons,['private_block_lag_hard'],'Waiting cannot erase the exit signal');
});
test('operator stop, financial mutations, changed guards, and array order still reject a stale preflight', () => {
 const before={status:'exit_pending',position:{idle0:'200000000'},holding:{exitReasons:['a','b']}};
 for(const after of [
  {...before,reentryStoppedAt:'now'}, {...before,status:'invalid'},
  {...before,position:{idle0:'200000001'}}, {...before,holding:{exitReasons:['b','a']}},
  {...before,holding:{exitReasons:['a','b','new_fault']}},
 ])assert(!samePersistedPaperState(before,after));
});
