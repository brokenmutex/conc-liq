import assert from 'node:assert/strict';
import {z} from 'zod';import {getAddress,isAddress} from 'viem';
import {paperPolicySchema} from '../paper/config.js';import type {TransactionPaperPolicy} from '../paper/engine.js';
const address=z.string().refine(isAddress).transform(value=>getAddress(value));
export const livePilotSchema=z.object({
 version:z.literal(1),kind:z.literal('nvda_usdg_live_pilot_v1'),broadcastEnabled:z.literal(false),operator:address.nullable(),
 signer:z.union([
  z.object({kind:z.enum(['keystore','external']),reference:z.string().min(1)}).strict(),
  z.object({kind:z.literal('env_file'),reference:z.string().min(1),variable:z.string().regex(/^[A-Z][A-Z0-9_]*$/)}).strict(),
 ]).nullable(),
 initialCapitalQuote:z.literal('250000000'),maxAdditionalFundingQuote:z.literal('0'),gasFundingQuote:z.null(),
 strategy:paperPolicySchema,
 execution:z.object({maxPendingTransactions:z.literal(1),confirmationBlocks:z.literal(64),receiptTimeoutSeconds:z.literal(120),maxConsecutiveReverts:z.literal(1),gasLimitBufferBps:z.literal(3000)}).strict(),
 accounting:z.literal('wallet_nft_and_canonical_receipts_v1'),
}).strict();
export type LivePilotConfig=ReturnType<typeof livePilotConfig>;
/** Separate configuration: preparation never changes the running paper session. */
export function livePilotConfig(raw:unknown){
 const p=livePilotSchema.parse(raw),s=p.strategy;
 assert('executionBasis' in s&&s.executionBasis==='nitro_fork_v1');
 assert.equal(s.budgetQuote,p.initialCapitalQuote);assert.equal(s.halfWidthSpacings,2);assert.equal(s.lpAllocationPpm,1000000);
 assert.equal(s.tradingHours?.kind,'continuous_v1');assert.equal(s.recenter?.kind,'outside_range_v1');
 assert.equal(s.inventoryExitPpm,undefined);assert.equal(s.maxHoldingSeconds,null);
 assert.equal(s.referencePolicy?.maxDeviationPpm,50000);assert.equal(s.holdingPolicy?.maxLagBlocks,30);
 assert.equal(s.maxSlippageBps,50);assert.equal(s.liquidityShareMode,'warn_v1');
 return {...p,strategy:s as TransactionPaperPolicy};
}
