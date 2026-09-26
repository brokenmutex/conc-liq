import {assertSameRangeKeeperPinnedReferenceProof} from './rangekeeper-paper-gas-sampler.js';
import {contentHash} from './contracts.js';

/** Compares the external registry/feed-directory evidence common to paper
 * source proofs. Only fetchedAt may differ; response URL and bytes plus all
 * other proof fields remain exact. */
export function assertSamePinnedExternalReferenceProof(expected:unknown,actual:unknown){
 return assertSameRangeKeeperPinnedReferenceProof(expected,actual);
}

/** Stable identity for review/admission binding. It removes only the HTTP
 * fetchedAt transport timestamp that the pinned proof comparator explicitly
 * allows to change; response URL/hash and every feed, oracle, price and source
 * fact remain part of the hash. The full referenceProofHash stays provenance. */
export function pinnedExternalReferenceProofIdentityHash(proof:unknown){
 assertSamePinnedExternalReferenceProof(proof,proof);
 const normalized=JSON.parse(JSON.stringify(proof)) as Record<string,unknown>;
 for(const key of ['registry','feedDirectory'] as const){
  const value=normalized[key] as Record<string,unknown>;
  delete value.fetchedAt;
 }
 return contentHash(normalized);
}
