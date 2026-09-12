import assert from 'node:assert/strict';
import {paperPolicySchema} from './config.js';
import {policyHash,type PaperPolicy} from './engine.js';
import type {PaperRuntimeTransition} from './runtime-history.js';
/** One authorized migration, not arbitrary retuning of an open position. */
export function feeSharePolicyChange(from:PaperPolicy,to:PaperPolicy) {
 const a=paperPolicySchema.parse(from),b=paperPolicySchema.parse(to);
 assert('executionBasis' in a && a.executionBasis==='nitro_fork_v1' && a.recenter && a.feeAccounting==='initialized_boundaries_v1' && !a.liquidityShareMode,
  'Policy upgrade requires the original boundary-fee recenter policy');
 const expected=paperPolicySchema.parse({...a,feeAccounting:'diluted_segments_v1',liquidityShareMode:'warn_v1'});
 assert.equal(policyHash(b),policyHash(expected),'Only diluted fees and a liquidity-share warning may change');
 return {from:a,to:b};
}
export function executionPolicyHash(currentHash:string,current:PaperPolicy|undefined,history:readonly PaperRuntimeTransition[]=[],runId?:string) {
 const changes=history.filter(h=>h.policyChange);
 if(!changes.length)return currentHash;
 assert(current && policyHash(paperPolicySchema.parse(current))===currentHash,'Current policy does not match its hash');
 let last:string|null=null;
 for(const h of changes){
  const {from,to}=feeSharePolicyChange(h.policyChange!.from,h.policyChange!.to);
  if(last)assert.equal(policyHash(from),last,'Discontinuous policy history');
  last=policyHash(to);
 }
 assert.equal(last,currentHash,'Current policy does not match history');
 if(runId)for(const h of changes)if(BigInt(runId)<=BigInt(h.throughRunId))return policyHash(paperPolicySchema.parse(h.policyChange!.from));
 return currentHash;
}
