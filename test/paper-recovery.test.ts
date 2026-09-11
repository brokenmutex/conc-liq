import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { reconcileRecordedExit, evidenceHash } from '../src/paper/recovery.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/paper-saved-exit-recovery.json', import.meta.url), 'utf8'));
const recover = (f: typeof fixture) => reconcileRecordedExit(f.session, f.previous, f.run, f.input);
const stateFixture = JSON.parse(readFileSync(new URL('./fixtures/paper-state-rejected-exit-recovery.json', import.meta.url), 'utf8'));
describe('saved paper exit recovery', () => {
 it('reconciles the saved inventory, costs and loss without altering the original evidence', () => {
  const f = structuredClone(fixture), hash = evidenceHash(f);
  assert.deepEqual(recover(f), f.expected);
  assert.equal(f.expected.navQuote, '995136631');assert.equal(f.expected.pnlQuote, '-4830779');
  assert.equal(evidenceHash(f), hash);
 });
 it('rejects missed, unrequested, changed-source and unhealthy historical fills', () => {
  for (const mutate of [
   (f:any) => { f.input.now = '2026-09-08T15:00:00.000Z';f.run.observed_at=f.input.now; },
   (f:any) => { f.previous.pendingSince = f.input.checkpoint.blockTimestamp; },
   (f:any) => { f.input.checkpoint.hash = '0x'+'ff'.repeat(32); },
   (f:any) => { f.input.chainHealthy = false; },
   (f:any) => { f.input.boundaryContinuity = false; },
  ]) { const f=structuredClone(fixture);mutate(f);assert.throws(()=>recover(f)); }
 });
 it('rejects changed fees, costs, balances, runtime or failure provenance', () => {
  for (const mutate of [
   (f:any) => { f.run.snapshot.preflight.result.inventory.fee0 = '0'; },
   (f:any) => { f.run.snapshot.preflight.result.totalGasWei = '0'; },
   (f:any) => { f.session.state.position.idle0 = '1000000000'; },
   (f:any) => { f.run.runtime_identity.buildId = 'f'.repeat(64); },
   (f:any) => { f.run.snapshot.error = 'canonical_hash_mismatch'; },
   (f:any) => { f.run.snapshot.preflight.result.executionEligible = true; },
  ]) { const f=structuredClone(fixture);mutate(f);assert.throws(()=>recover(f)); }
 });
});
describe('recorded state-rejected exit followed by stale invalidation', () => {
 it('reconciles session 55 from the saved timely fork without erasing its loss', () => {
  const f=structuredClone(stateFixture),before=evidenceHash(f);
  assert.deepEqual(recover(f),f.expected);assert.equal(f.expected.navQuote,'939964887');
  assert.equal(f.expected.pnlQuote,'-6851637');assert.equal(evidenceHash(f),before);
 });
 it('rejects operator cancellation, ledger changes, source failures, and an unrelated invalidation', () => {
  for(const mutate of [
   (f:any)=>{f.session.state.reentryStoppedAt=f.run.observed_at;},
   (f:any)=>{f.previous.reentryStoppedAt=f.run.observed_at;},
   (f:any)=>{f.session.state.position.idle0='1';},
   (f:any)=>{f.session.state.last.block='1';},
   (f:any)=>{f.run.snapshot.checks.ancestryInvalid=true;},
   (f:any)=>{f.run.snapshot.checks.canonical=false;},
   (f:any)=>{f.run.snapshot.checks.covered=false;},
   (f:any)=>{f.session.state.reasons=['checkpoint_canonicality_unproven'];},
   (f:any)=>{f.session.state.invalidatedAt=f.previous.last.blockTimestamp;},
   (f:any)=>{f.run.snapshot.preflight.result.inventory.fee0='0';},
  ]){const f=structuredClone(stateFixture);mutate(f);assert.throws(()=>recover(f));}
 });
});
