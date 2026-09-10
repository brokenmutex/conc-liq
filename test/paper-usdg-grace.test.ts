import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { evaluateOracleRisk } from '../src/risk/evaluate.js';
import type { RiskSnapshot } from '../src/risk/domain.js';
import { evaluatePaperUsdgOracle } from '../src/paper/usdg-oracle.js';
import { evaluatePaperReference, type ContinuousPaperReferencePolicy } from '../src/paper/reference.js';
import { paperPolicySchema } from '../src/paper/config.js';
import { DEFAULT_PAPER_POLICY, policyHash, type PaperCheckpoint } from '../src/paper/engine.js';
import { paperGasQuote } from '../src/paper/transaction-engine.js';

const saved = JSON.parse(readFileSync(new URL('./fixtures/paper-usdg-session-37.json', import.meta.url), 'utf8')) as {
  snapshot: RiskSnapshot; checkpoint: PaperCheckpoint; policy: ContinuousPaperReferencePolicy; expectedReasons: string[];
};
const original = saved.snapshot.quoteOracle!;
const input = (age: number) => ({feed:original.feed,state:original.state,
  blockTimestamp:BigInt(original.state!.updatedAt)+BigInt(age),maxPriceAgeSeconds:86400});

describe('paper USDG heartbeat grace', () => {
  it('reproduces session 37 and accepts its four-second overrun only under the new policy', () => {
    const before = JSON.stringify(saved);
    const old = evaluatePaperReference(saved);
    assert.deepEqual(old.reasons, saved.expectedReasons);
    assert.equal(old.eligible, false);
    const next = evaluatePaperReference({...saved,policy:{...saved.policy,usdgHeartbeatGraceSeconds:1800}});
    assert.equal(next.eligible, true);
    assert.deepEqual(next.reasons, []);
    assert.equal(next.usdgFreshness?.basis, 'heartbeat_grace');
    assert.deepEqual(next.usdgFreshness?.warnings, ['paper_usdg_heartbeat_grace']);
    const equity = saved.snapshot.assets.find(a=>a.registry.symbol==='NVDA')!.oracle!.state!;
    assert.equal(next.referencePriceX18, String(BigInt(equity.answer)*10n**BigInt(original.state!.decimals)*10n**18n /
      (BigInt(original.state!.answer)*10n**BigInt(equity.decimals))));
    assert.equal(JSON.stringify(saved), before);
  });

  it('accepts through 88200 seconds, expires at 88201, and clears the warning after refresh', () => {
    for (const [age,eligible,basis] of [[86400,true,'heartbeat_valid'],[86401,true,'heartbeat_grace'],
      [88200,true,'heartbeat_grace'],[88201,false,'unavailable'],[15,true,'heartbeat_valid']] as const) {
      const r=evaluatePaperUsdgOracle(input(age),1800);
      assert.equal(r.executionEligible,eligible,String(age));
      assert.equal(r.freshness?.basis,basis);
      assert.equal(r.freshness?.acceptedMaxAgeSeconds,88200);
      assert.equal(r.flags?.priceFresh,age<=86400);
      assert.deepEqual(r.feed,original.feed);
      assert.deepEqual(r.state,original.state);
      assert.deepEqual(r.freshness?.warnings,basis==='heartbeat_grace'?['paper_usdg_heartbeat_grace']:[]);
    }
  });

  it('rejects missing, invalid, incomplete or future quotes even with grace', () => {
    const mutations = [null, {...original.state!,answer:'0'}, {...original.state!,answer:'-1'},
      {...original.state!,answeredInRound:'0'}, {...original.state!,decimals:7},
      {...original.state!,description:'ETH / USD'}, {...original.state!,updatedAt:'0'},
      {...original.state!,updatedAt:String(input(86404).blockTimestamp+1n)}];
    for (const state of mutations) assert.equal(evaluatePaperUsdgOracle({...input(86404),state},1800).executionEligible,false);
    assert.equal(evaluatePaperUsdgOracle({...input(0),state:{...original.state!,updatedAt:'0'},blockTimestamp:1n},1800).executionEligible,false);
  });

  it('preserves old policy hashes, strict limits and unrelated feed behavior', () => {
    assert.deepEqual(evaluatePaperUsdgOracle(input(86404)),evaluateOracleRisk(input(86404)));
    const old=structuredClone(DEFAULT_PAPER_POLICY);
    assert.equal(policyHash(paperPolicySchema.parse(old)),policyHash(old));
    const parsed=paperPolicySchema.parse(old);
    assert('referencePolicy' in parsed && parsed.referencePolicy);
    assert.equal('usdgHeartbeatGraceSeconds' in parsed.referencePolicy,false);
    assert.equal(evaluatePaperUsdgOracle({...input(301),maxPriceAgeSeconds:300},1800).executionEligible,false);
    const eth={...input(86404),feed:{...original.feed,baseAsset:'ETH',name:'ETH / USD'},state:{...original.state!,description:'ETH / USD'}};
    assert.equal(evaluateOracleRisk(eth).executionEligible,false);
    assert.throws(()=>evaluatePaperUsdgOracle(eth,1800),/USDG\/USD/);
    for(const grace of [-1,1801,1.5,NaN]) assert.throws(()=>evaluatePaperUsdgOracle(input(86404),grace));
    assert.throws(()=>paperPolicySchema.parse({...old,referencePolicy:{...old.referencePolicy,usdgHeartbeatGraceSeconds:1801}}));
  });

  it('keeps off-peg prices and the true-price band instead of substituting one dollar', () => {
    const snapshot=structuredClone(saved.snapshot);
    Object.assign(snapshot.quoteOracle!.state!,{answer:'90000000'});
    const r=evaluatePaperReference({...saved,snapshot,policy:{...saved.policy,usdgHeartbeatGraceSeconds:1800}});
    assert.equal(r.eligible,false);
    assert(r.reasons.includes('paper_reference_band_exceeded'));
    assert.equal(r.usdgFreshness?.basis,'heartbeat_grace');
  });

  it('values gas using the actual accepted USDG round without changing its answer', () => {
    const quote=evaluatePaperUsdgOracle(input(86404),1800);
    assert.equal(quote.executionEligible,true);
    const valuation={sourceBlock:'1',sourceHash:'0x1',computedAt:'2026-09-09T15:32:20Z',
      ethUsdAnswer:'247292000000',ethUsdDecimals:8,quoteUsdAnswer:quote.state!.answer,quoteUsdDecimals:quote.state!.decimals};
    const fee=149194322704000n;
    const expected=(fee*247292000000n*10n**6n + 10n**18n*99982823n-1n)/(10n**18n*99982823n);
    assert.equal(paperGasQuote(String(fee),valuation),expected);
  });
});
