import assert from 'node:assert/strict';
import test from 'node:test';
import {nextPaperMaintenanceAt} from '../src/deployments-paper-worker.js';

test('pending RangeKeeper confirmation runs before the ordinary maintenance interval',()=>{
 assert.equal(nextPaperMaintenanceAt(100_000,60_000,130_000),130_000);
 assert.equal(nextPaperMaintenanceAt(100_000,60_000,99_000),101_000,
  'finished preparation must not add another minute or busy-spin');
 assert.equal(nextPaperMaintenanceAt(100_000,60_000,180_000),160_000,
  'confirmation cannot postpone ordinary campaign maintenance');
});
test('ordinary maintenance cadence is preserved without a valid confirmation deadline',()=>{
 for(const due of [undefined,null,NaN,Infinity])
  assert.equal(nextPaperMaintenanceAt(100_000,60_000,due),160_000);
});
