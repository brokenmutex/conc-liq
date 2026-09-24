import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {describe,it} from 'node:test';
import {assertRangeKeeperPaperOpenCompletionReplay,planRangeKeeperPaperOpenCompletion}
 from '../src/deployments/rangekeeper-paper-open-completion-plan.js';
import type {RangeKeeperPaperConfirmedContext} from
 '../src/deployments/rangekeeper-paper-confirmation-context.js';

const hash=(n:string)=>n.repeat(64);

function context():RangeKeeperPaperConfirmedContext{
 const campaignId=randomUUID(),operationId=randomUUID(),source={block:'400',hash:`0x${'a'.repeat(64)}`,timestamp:1_800_000_000},
  candidateHash=hash('b'),envelopeHash=hash('c'),proofHash=hash('d');
 const envelope={schemaVersion:1 as const,kind:'rangekeeper_paper_open_confirmation_v1' as const,
  status:'confirmed' as const,campaignId,revision:2,draftConfigHash:hash('e'),profileHash:hash('f'),
  firstObservation:{source:{block:'399',hash:`0x${'9'.repeat(64)}`,timestamp:1_799_999_970},
   modelHash:hash('1'),candidateHash:hash('2')},
  confirmationObservation:{source,candidateHash,candidate:{kind:'entry' as const,
   range:{tickLower:-60,tickUpper:60},sourceBlock:'400',sourceHash:source.hash},
   poolState:{tick:0,sqrtPriceX96:'79228162514264337593543950336',poolLiquidity:'1000'},
   reference:{price0:'2000000000000000000',price1:'1000000000000000000',
    nativePrice:'3000000000000000000000',proofHash,proof:{fixture:true}}},
  decision:{action:'execute' as const,reason:'two_confirmations' as const,gasSequenceHash:`0x${hash('3')}`,
   simulation:{status:'success' as const,sourceBlock:'400',sourceHash:source.hash,candidateHash,
    simulationHash:`0x${hash('4')}`}},
  simulationEvidence:{},costs:{status:'provisional' as const,profileIds:[{stage:'mint',id:randomUUID(),version:1}]},
  strategyState:{},inventory:{position:{tickLower:-60,tickUpper:60,liquidity:'50'},
   idle:{token0:'40',token1:'30'}},selectedGasProfileIds:[],
  executionEvidence:'source_bound_caller_simulation_evidence_unverified' as const,
  openingBooked:false as const,actionAvailable:false as const,envelopeHash};
 const parsedCandidate={kind:'entry' as const,range:{tickLower:-60,tickUpper:60},swap:null,
  amount0Desired:20n,amount1Desired:170n,amount0Min:19n,amount1Min:169n,liquidity:50n,
  deployedValue:190n,sourceBlock:400n,sourceHash:source.hash as `0x${string}`,
  expiresAt:1_800_000_090};
 return {status:'available',campaignId,revision:2,
  draft:{id:campaignId,revision:2,allocation:{token0Raw:'100',token1Raw:'200',nativeWei:'300'},
   profile:{pool:{token0:'0x0000000000000000000000000000000000000001',
    token1:'0x0000000000000000000000000000000000000002',decimals0:18,decimals1:6}},
   profileHash:hash('f'),configHash:hash('e')} as never,
  openModel:{} as never,envelope:envelope as never,candidate:parsedCandidate as never,state:{} as never,
  costs:{} as never,scope:{} as never,inventory:{kind:'modeled_after_confirmation',
   position:{tickLower:-60,tickUpper:60,liquidity:'50'},idle:{token0:'80',token1:'30'}},
  evidence:{gas:'fork_estimated_provisional',simulation:'source_bound_caller_evidence_unverified',
   openingBooked:false,actionAvailable:false},snapshotHash:hash('8')};
}

describe('RangeKeeper hypothetical open completion projection',()=>{
 it('builds exact mark and capital ledger rows and replays idempotently without booking',()=>{
  const ctx=context(),operationId=randomUUID(),first=planRangeKeeperPaperOpenCompletion({context:ctx,operationId}),
   retry=planRangeKeeperPaperOpenCompletion({context:ctx,operationId});
  assertRangeKeeperPaperOpenCompletionReplay(first,retry);
  assert.equal(first.mark.inventory.position.liquidity,'50');
  assert.equal(first.mark.inventory.idle.token0,'80');
  assert.deepEqual(first.ledger.map(row=>row.entryKey),[
   `rangekeeper_paper_open:${operationId}:capital_in:token0`,
   `rangekeeper_paper_open:${operationId}:capital_in:token1`,
   `rangekeeper_paper_open:${operationId}:capital_in:native`]);
  assert.deepEqual(first.ledger.map(row=>row.valueRaw),['200','200000000000000','900000']);
  assert.equal(first.openingBooked,false);assert.equal(first.bookingAvailable,false);
  assert.equal(first.actionAvailable,false);assert.equal(first.mark.economics,null);
 });
 it('rejects a different operation replay and any context claiming booking is enabled',()=>{
  const ctx=context(),first=planRangeKeeperPaperOpenCompletion({context:ctx,operationId:randomUUID()});
  const other=planRangeKeeperPaperOpenCompletion({context:ctx,operationId:randomUUID()});
  assert.throws(()=>assertRangeKeeperPaperOpenCompletionReplay(first,other),
   /rangekeeper_paper_open_completion_replay_conflict/);
  const forged={...ctx,evidence:{...ctx.evidence,openingBooked:true}} as unknown as RangeKeeperPaperConfirmedContext;
  assert.throws(()=>planRangeKeeperPaperOpenCompletion({context:forged,operationId:randomUUID()}),
   /rangekeeper_paper_open_completion_context_unavailable/);
 });
});
