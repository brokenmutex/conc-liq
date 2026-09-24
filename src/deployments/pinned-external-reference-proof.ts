import {assertSameRangeKeeperPinnedReferenceProof} from './rangekeeper-paper-gas-sampler.js';

/** Compares the external registry/feed-directory evidence common to paper
 * source proofs. Only fetchedAt may differ; response URL and bytes plus all
 * other proof fields remain exact. */
export function assertSamePinnedExternalReferenceProof(expected:unknown,actual:unknown){
 return assertSameRangeKeeperPinnedReferenceProof(expected,actual);
}
