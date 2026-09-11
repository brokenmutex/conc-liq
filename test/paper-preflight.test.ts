import assert from 'node:assert/strict';
import { test } from 'node:test';
import { samePersistedPaperState } from '../src/paper/preflight.js';

test('jsonb reordering of nested holding evidence does not discard a completed exit', () => {
 const before={status:'exit_pending',position:{idle0:'200000000',liquidity:'123'},holding:{checkedAt:'now',riskEvidence:{eligible:true,reasons:[]}},optional:undefined};
 const persisted={holding:{riskEvidence:{reasons:[],eligible:true},checkedAt:'now'},position:{liquidity:'123',idle0:'200000000'},status:'exit_pending'};
 assert.notEqual(JSON.stringify(before),JSON.stringify(persisted));
 assert(samePersistedPaperState(before,persisted));
});
test('operator stop, financial mutations, changed guards, and array order still reject a stale preflight', () => {
 const before={status:'exit_pending',position:{idle0:'200000000'},holding:{exitReasons:['a','b']}};
 for(const after of [
  {...before,reentryStoppedAt:'now'}, {...before,status:'invalid'},
  {...before,position:{idle0:'200000001'}}, {...before,holding:{exitReasons:['b','a']}},
  {...before,holding:{exitReasons:['a','b','new_fault']}},
 ])assert(!samePersistedPaperState(before,after));
});
