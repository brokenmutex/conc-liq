import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {referenceProofHash} from '../src/deployments/market-profile.js';
import {bindRangeKeeperPaperConfirmationFrame} from
 '../src/deployments/rangekeeper-paper-confirmation-frame.js';
import type {PaperOpenFrame} from '../src/deployments/paper-preview.js';

const source={block:'71253961',hash:`0x${'a'.repeat(64)}`,timestamp:1790241220};
const proof=(fetchedAt:string,overrides:Record<string,unknown>={})=>({
 token0:{oracle:{state:{roundId:'901',answer:'100000000',updatedAt:'1790241000'}}},
 token1:{oracle:{state:{roundId:'902',answer:'200000000',updatedAt:'1790241001'}}},
 native:{state:{roundId:'903',answer:'300000000',updatedAt:'1790241002'}},
 registry:{fetchedAt,sha256:`sha256:${'b'.repeat(64)}`,url:'https://fixture.test/registry'},
 feedDirectory:{fetchedAt,sha256:`sha256:${'c'.repeat(64)}`,url:'https://fixture.test/feeds'},
 ...overrides,
});
const frame=(referenceProof:Record<string,unknown>):PaperOpenFrame=>({source,tick:-276320,
 sqrtPriceX96:123n,poolLiquidity:456n,price0:100n,price1:200n,nativePrice:300n,
 referenceEligible:true,referenceReasons:[],referenceProofHash:referenceProofHash(referenceProof),referenceProof});

describe('RangeKeeper confirmation frame recheck',()=>{
 it('accepts only fetchedAt drift and preserves the original complete proof hash',()=>{
  const saved=frame(proof('2026-09-24T10:00:00.000Z')),
   actual=frame(proof('2026-09-24T10:00:03.000Z')),
   bound=bindRangeKeeperPaperConfirmationFrame(actual,saved);
  assert.equal(bound.referenceProofHash,saved.referenceProofHash);
  assert.equal(contentHash(bound.referenceProof),contentHash(saved.referenceProof));
  assert.notEqual(actual.referenceProofHash,saved.referenceProofHash);
 });

 it('rejects changed response bytes, feed selection, oracle round, prices, or pool state',()=>{
  const saved=frame(proof('2026-09-24T10:00:00.000Z'));
  const changedProofs=[
   proof('2026-09-24T10:00:03.000Z',{registry:{fetchedAt:'2026-09-24T10:00:03.000Z',
    sha256:`sha256:${'d'.repeat(64)}`,url:'https://fixture.test/registry'}}),
   proof('2026-09-24T10:00:03.000Z',{feedDirectory:{fetchedAt:'2026-09-24T10:00:03.000Z',
    sha256:`sha256:${'d'.repeat(64)}`,url:'https://fixture.test/feeds'}}),
   proof('2026-09-24T10:00:03.000Z',{token1:{oracle:{state:{roundId:'999',answer:'200000000',
    updatedAt:'1790241001'}}}}),
  ];
  for(const referenceProof of changedProofs)
   assert.throws(()=>bindRangeKeeperPaperConfirmationFrame(frame(referenceProof),saved));
  assert.throws(()=>bindRangeKeeperPaperConfirmationFrame({...frame(proof('2026-09-24T10:00:03.000Z')),
   price1:201n},saved));
  assert.throws(()=>bindRangeKeeperPaperConfirmationFrame({...frame(proof('2026-09-24T10:00:03.000Z')),
   tick:-276310},saved));
 });
});
