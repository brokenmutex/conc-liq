import assert from 'node:assert/strict';
import type {RobinhoodClient} from '../client.js';
import {contentHash} from './contracts.js';
import {marketProfileSchema,referenceProofHash,type MarketProfile} from './market-profile.js';
import {readCanonicalPaperOpenFrame,type PaperOpenFrame} from './paper-preview.js';
import {assertSamePinnedExternalReferenceProof} from './pinned-external-reference-proof.js';

/** Reconciles a fresh pinned read to the exact frame saved in the confirmation.
 * Only registry/feed-directory fetchedAt metadata may differ, and only when
 * URL plus raw response hash match. The returned frame retains the original
 * full proof and hash used by the candidate/envelope. */
export function bindRangeKeeperPaperConfirmationFrame(actual:PaperOpenFrame,
 saved:PaperOpenFrame):PaperOpenFrame{
 assert(saved.referenceEligible&&saved.referenceProof&&
  referenceProofHash(saved.referenceProof)===saved.referenceProofHash,
  'Saved RangeKeeper confirmation reference proof is invalid');
 assert(actual.referenceEligible&&actual.referenceProof&&
  referenceProofHash(actual.referenceProof)===actual.referenceProofHash,
  'Current RangeKeeper confirmation reference proof is invalid');
 assert.equal(contentHash(actual.source),contentHash(saved.source),
  'RangeKeeper confirmation source changed');
 assert.equal(actual.tick,saved.tick,'RangeKeeper confirmation tick changed');
 assert.equal(String(actual.sqrtPriceX96),String(saved.sqrtPriceX96),
  'RangeKeeper confirmation square-root price changed');
 assert.equal(String(actual.poolLiquidity),String(saved.poolLiquidity),
  'RangeKeeper confirmation pool liquidity changed');
 assert.equal(String(actual.price0),String(saved.price0),'RangeKeeper confirmation token0 price changed');
 assert.equal(String(actual.price1),String(saved.price1),'RangeKeeper confirmation token1 price changed');
 assert.equal(String(actual.nativePrice),String(saved.nativePrice),'RangeKeeper confirmation native price changed');
 assertSamePinnedExternalReferenceProof(saved.referenceProof,actual.referenceProof);
 return {...actual,referenceProof:saved.referenceProof,referenceProofHash:saved.referenceProofHash};
}

/** Reads the exact saved chain source and binds the fresh independent reference
 * facts back to the immutable confirmation proof before replay. */
export async function readRangeKeeperPaperConfirmationFrame(input:{client:RobinhoodClient;
 profile:MarketProfile;saved:PaperOpenFrame}):Promise<PaperOpenFrame>{
 const profile=marketProfileSchema.parse(input.profile),actual=await readCanonicalPaperOpenFrame(
  input.client,profile,input.saved.source);
 return bindRangeKeeperPaperConfirmationFrame(actual,input.saved);
}
