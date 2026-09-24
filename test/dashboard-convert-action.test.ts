import assert from 'node:assert/strict';
import {test} from 'node:test';
// Browser module is intentionally plain JavaScript and has no TypeScript declarations.
// @ts-expect-error JavaScript browser module has no declaration file.
import {convertAcceptPayload,convertPreviewCanBeAccepted} from '../dashboard/deployment-actions.js';

const now=Date.now();
const preview={id:'18a77044-72c3-471d-91cf-099324233830',kind:'close_convert',
 terminalModelVersion:3,status:'indicative',trustedPreviewSaved:true,
 actionAvailable:true,operationAcceptanceAvailable:true,
 contentDigest:'a'.repeat(64),modelHash:'b'.repeat(64),expectedRevision:2,
 expiresAt:new Date(now+60_000).toISOString(),paidCostsAvailable:false,
 feeAccrualAvailable:false,costs:{status:'provisional',scope:'candidate_prestate_gas_only',
  pathVersion:'paper_static_manual_close_convert_prestate_v1',paidGasAvailable:false}};

test('convert browser acceptance requires an actionable saved V3 provisional preview',()=>{
 assert.equal(convertPreviewCanBeAccepted(preview,now),true);
 assert.deepEqual(convertAcceptPayload(preview,'fe37ef4b-2717-46a1-ac77-56ac8cfe4fdc'),{
  previewId:preview.id,contentDigest:preview.contentDigest,expectedRevision:2,
  idempotencyKey:'fe37ef4b-2717-46a1-ac77-56ac8cfe4fdc'});
 for(const changed of [
  {actionAvailable:false},{operationAcceptanceAvailable:false},{terminalModelVersion:2},
  {trustedPreviewSaved:false},{paidCostsAvailable:true},{feeAccrualAvailable:true},
  {costs:{...preview.costs,paidGasAvailable:true}},
  {costs:{...preview.costs,scope:'legacy_cumulative'}},
  {expiresAt:new Date(now-1).toISOString()},
 ]) assert.equal(convertPreviewCanBeAccepted({...preview,...changed},now),false);
 assert.equal(convertAcceptPayload(preview,'new-key'),null);
});
