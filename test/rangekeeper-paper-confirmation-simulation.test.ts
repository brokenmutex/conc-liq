import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {buildRangeKeeperPaperOwnedForkConfirmationEvidence} from
 '../src/deployments/rangekeeper-paper-confirmation-simulation.js';
import {consumeTrustedRangeKeeperSimulation} from
 '../src/deployments/rangekeeper-paper-confirmation-simulation.js';
import {verifyRangeKeeperPaperOwnedForkConfirmationEvidence} from
 '../src/deployments/rangekeeper-paper-confirmation-simulation.js';
import {rangeKeeperPaperCandidateHash,RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP,
 RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES} from '../src/deployments/rangekeeper-paper-cost.js';
import {referenceProofHash} from '../src/deployments/market-profile.js';
import type {RangeKeeperPaperConfirmationProbe} from '../src/deployments/rangekeeper-paper-confirmation.js';
import type {RangeKeeperPaperGasStageSample} from '../src/deployments/rangekeeper-paper-gas-evidence.js';
import type {PaperOpenFrame} from '../src/deployments/paper-preview.js';

const hash=(n:string)=>`0x${n.repeat(64)}`;
const source={block:'200',hash:hash('1'),timestamp:1_800_000_000};
const referenceProof={fixture:'independent-reference'};
const frame:PaperOpenFrame={source,tick:0,sqrtPriceX96:1n<<96n,poolLiquidity:1000n,
 price0:1n,price1:1n,nativePrice:1n,referenceEligible:true,referenceReasons:[],
 referenceProofHash:referenceProofHash(referenceProof),referenceProof};
const campaignId='a07d7ca2-1098-4e21-8a4d-c2732218d73a',configHash='f'.repeat(64),profileHash='e'.repeat(64),
 candidate={kind:'entry' as const,
 range:{tickLower:-10,tickUpper:10},swap:null,amount0Desired:10n,amount1Desired:10n,
 amount0Min:9n,amount1Min:9n,liquidity:10n,deployedValue:20n,sourceBlock:200n,
 sourceHash:source.hash as `0x${string}`,expiresAt:1_800_000_060},
 candidateHash=rangeKeeperPaperCandidateHash({campaignId,revision:1,profileHash,configHash,
  source,referenceProofHash:frame.referenceProofHash,candidate});
const probe={status:'candidate',campaignId,revision:1,
 firstModelHash:'b'.repeat(64),firstCandidateHash:'c'.repeat(64),source,candidate,candidateHash,scope:{
 poolAddress:'0x0000000000000000000000000000000000000001',profileHash,
 candidateHash,deployedValue:20n,sharePpm:100n,
 range:{tickLower:-10,tickUpper:10},swapKind:'none'},pathVersion:'paper_rangekeeper_v1_no_swap_v1',
 sizeBand:'rk_0123456789abcdef0123456789abcdef',actionAvailable:false} as RangeKeeperPaperConfirmationProbe;

function samples():RangeKeeperPaperGasStageSample[]{
 return [...RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP,...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES].map((action,i)=>({
  action,to:'0x0000000000000000000000000000000000000002',calldata:'0x1234',returnData:'0x',
  localHash:hash(String((i%8)+2)),localGasUsed:'21000',localEffectiveGasPriceWei:'1',
  sourceBlock:source.block,sourceHash:source.hash,estimate:{gas:'25000',parentGas:'21000',
   baseFeeWei:'1',parentBaseFeeWei:'1',totalFeeWei:'1',parentFeeWei:'1',executionFeeWei:'0',
   basis:'node_estimateGas_with_paper_prestate_and_parent_component'},
  stateOverrideHash:'f'.repeat(64),stateOverrides:{}}));
}

describe('RangeKeeper owned-fork confirmation simulation evidence',()=>{
 it('binds the complete local entry and retain sequence to the exact candidate source',()=>{
  const evidence=buildRangeKeeperPaperOwnedForkConfirmationEvidence({probe,frame,configHash,samples:samples()});
  assert.equal(evidence.status,'success');assert.equal(evidence.evidenceClass,'caller_claimed_owned_anvil_fork');
  assert.equal(evidence.candidateHash,probe.candidateHash);assert.equal(evidence.source.hash,source.hash);
  assert.equal(evidence.stages.length,8);assert.equal(evidence.admissionAvailable,false);
  assert.equal(evidence.openingBooked,false);assert.match(evidence.sequenceHash,/^0x[0-9a-f]{64}$/);
 });
 it('rejects a changed source or stage ordering instead of hashing it as proof',()=>{
  const changed=samples();changed[0]={...changed[0]!,sourceHash:hash('9')};
  assert.throws(()=>buildRangeKeeperPaperOwnedForkConfirmationEvidence({probe,frame,configHash,samples:changed}));
  const reordered=samples();reordered[0]={...reordered[0]!,action:'open_mint'};
  assert.throws(()=>buildRangeKeeperPaperOwnedForkConfirmationEvidence({probe,frame,configHash,samples:reordered}));
 });
 it('rejects tampered persisted stage data and a different campaign binding',()=>{
  const evidence=buildRangeKeeperPaperOwnedForkConfirmationEvidence({probe,frame,configHash,samples:samples()});
  const expected={campaignId,revision:1,configHash,profileHash,source,
   referenceProofHash:frame.referenceProofHash,candidate,candidateHash,simulationHash:evidence.sequenceHash};
  assert.deepEqual(verifyRangeKeeperPaperOwnedForkConfirmationEvidence(evidence,expected),evidence);
  const tampered=structuredClone(evidence) as any;tampered.stages[0].calldata='0xabcd';
  assert.throws(()=>verifyRangeKeeperPaperOwnedForkConfirmationEvidence(tampered,expected));
  assert.throws(()=>verifyRangeKeeperPaperOwnedForkConfirmationEvidence(evidence,
   {...expected,campaignId:'d7ee3ef7-f665-40d0-869e-a4e35ed4d907'}));
 });
 it('does not accept forged or serialized simulation evidence as an in-process capability',()=>{
  const fake={status:'success',sourceBlock:source.block,sourceHash:source.hash,
   candidateHash:probe.candidateHash,simulationHash:hash('2'),
   ownedForkEvidence:buildRangeKeeperPaperOwnedForkConfirmationEvidence({probe,frame,configHash,samples:samples()})};
  assert.equal(consumeTrustedRangeKeeperSimulation({simulation:fake as never,context:{} as never}),null);
  const clone=structuredClone(fake);
  assert.equal(consumeTrustedRangeKeeperSimulation({simulation:clone as never,context:{} as never}),null);
 });
});
