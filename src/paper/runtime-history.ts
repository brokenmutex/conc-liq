import assert from 'node:assert/strict';
import {assertRuntimeMatches,type RuntimeIdentity} from '../runtime/identity.js';
import type {PaperPolicy} from './engine.js';
export interface PaperRuntimeTransition {
 policyChange?:{from:PaperPolicy;to:PaperPolicy};
 from:RuntimeIdentity;to:RuntimeIdentity;throughRunId:string;throughObservationId:string;at:string;stateSha256:string;
}
export function executionRuntime(current:RuntimeIdentity|null,history:readonly PaperRuntimeTransition[]=[],runId?:string):RuntimeIdentity|null {
 let last:RuntimeIdentity|null=null,cutoff=-1n,observation=-1n,at=-Infinity;
 for(const h of history){
  for(const id of [h.from,h.to])assert(/^[a-f0-9]{64}$/.test(id.buildId)&&/^[a-f0-9]{64}$/.test(id.configHash)&&id.nodeVersion);
  assert(/^\d+$/.test(h.throughRunId)&&/^\d+$/.test(h.throughObservationId)&&/^[a-f0-9]{64}$/.test(h.stateSha256));
  assert(BigInt(h.throughRunId)>=cutoff&&BigInt(h.throughObservationId)>=observation&&Date.parse(h.at)>=at);
  assert(h.from.buildId!==h.to.buildId&&h.from.configHash===h.to.configHash&&h.from.nodeVersion===h.to.nodeVersion);
  if(last)assertRuntimeMatches(last,h.from);
  last=h.to;cutoff=BigInt(h.throughRunId);observation=BigInt(h.throughObservationId);at=Date.parse(h.at);
 }
 if(last)assertRuntimeMatches(last,current??undefined);
 if(runId)for(const h of history)if(BigInt(runId)<=BigInt(h.throughRunId))return h.from;
 return current;
}
