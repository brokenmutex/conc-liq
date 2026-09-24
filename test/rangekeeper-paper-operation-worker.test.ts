import assert from 'node:assert/strict';
import {it} from 'node:test';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../src/client.js';
import {processOnePaperOperation} from '../src/deployments/paper-operation-worker.js';
import type {DeploymentStore} from '../src/deployments/store.js';

it('blocks a RangeKeeper open before snapshot loading when fork RPC is unavailable',async()=>{
 const advances:unknown[][]=[],claims:string[]=[];let snapshotReads=0,completions=0;
 const claim={id:'operation-1',campaign_id:'campaign-1',status:'preflighting',stage:'accepted',attempts:1};
 const store={
  claimNext:async(_worker:string,_lease:number,_mode:'paper'|'live',strategy?:string)=>{
   claims.push(strategy??'all');return strategy==='rangekeeper_v1'?claim:null;
  },
  advanceClaim:async(...args:unknown[])=>{advances.push(args);},
  rangeKeeperPaperConfirmationOperationSnapshot:async()=>{
   snapshotReads++;return {simulationEvidenceStatus:'source_bound_caller_simulation_evidence_unverified',
    bookingAvailable:false,actionAvailable:false};
  },
  completeTrustedPaperOpen:async()=>{completions++;},
  renewClaim:async()=>{},
 } as unknown as DeploymentStore;
 const indexer={query:async()=>({rows:[{
  id:claim.id,campaign_id:claim.campaign_id,kind:'open',status:claim.status,
  claimed_by:'rangekeeper-worker',claim_valid:true,created_at:new Date(),mode:'paper',
  lifecycle:'opening',strategy_id:'rangekeeper_v1',expires_at:new Date(Date.now()+60_000),
  proposal:{},request:{},current_revision:1,expected_revision:1,preview_kind:'open',
 }]})} as unknown as Pool;
 const result=await processOnePaperOperation(store,{} as RobinhoodClient,indexer,'rangekeeper-worker');
 assert.deepEqual(claims,['static_manual_v1','rangekeeper_v1']);
 assert.deepEqual(result,{status:'blocked',operationId:claim.id,
  reason:'rangekeeper_paper_confirmation_fork_rpc_unavailable'});
 assert.equal(advances.length,1);
 assert.deepEqual(advances[0],['operation-1','rangekeeper-worker',
  'paper_recovery_required','blocked','rangekeeper_paper_confirmation_fork_rpc_unavailable']);
 assert.equal(snapshotReads,0);assert.equal(completions,0);
});
