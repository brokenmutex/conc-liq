import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionResult, type Address } from "viem";
import { evaluateCanaryEntryReadiness, regularEquitySession } from "../src/canary-plan/entry-readiness.js";
import { buildCanaryExit, canaryExitAbi, decodeCanaryExit } from "../src/canary-plan/exit.js";
import { USDG } from "../src/constants.js";
import { Q96 } from "../src/backtest/principal.js";
import type { RpcHealthEvaluation, RpcEndpointProbe } from "../src/rpc-health/domain.js";

const now = "2026-09-08T14:00:00.000Z";
const hash = `0x${"11".repeat(32)}`;
function healthySamples() {
  return Array.from({ length: 31 }, (_, index) => {
    const observed = Date.parse(now) - (30 - index) * 10_000;
    const head = BigInt(1000 + index * 100);
    const probe = (role: "private" | "reference", name: string): RpcEndpointProbe => ({ role, name, chainId: 4663, error: null, anchorError: null,
      anchorBlock: head - 64n, anchorHash: hash, headBlock: head, headHash: hash, headTimestamp: BigInt(observed / 1000), latencyMs: 10, syncing: false, syncingError: null });
    const snapshot = { observedAt: new Date(observed).toISOString(), state: "healthy", allowBulk: true, reasons: [], privateSyncing: false,
      anchorBlock: head - 64n, anchorHash: hash, privateAnchorHash: hash, privateHead: head, privateHeadTimestamp: BigInt(observed / 1000),
      probes: [probe("private", "private"), probe("reference", "reference_1"), probe("reference", "reference_2")] } as unknown as RpcHealthEvaluation;
    return { id: String(index), snapshot };
  });
}

describe("canary entry recovery and session", () => {
  it("requires a full continuous recovery window with two agreeing references", () => {
    const samples = healthySamples();
    const good = evaluateCanaryEntryReadiness({ now, sourceBlock: 3900n, samples });
    assert.equal(good.chainEligible, true); assert.deepEqual(good.reasons, []);
    const bad = samples.map((row, index) => index === 10 ? { ...row, snapshot: { ...row.snapshot, state: "degraded" as const } } : row);
    assert.equal(evaluateCanaryEntryReadiness({ now, sourceBlock: 3900n, samples: bad }).chainEligible, false);
    const disagreement = samples.map((row, index) => index === 20 ? { ...row, snapshot: { ...row.snapshot, probes: row.snapshot.probes.slice(0, 2) } } : row);
    assert(evaluateCanaryEntryReadiness({ now, sourceBlock: 3900n, samples: disagreement }).reasons.includes("chain_anchor_quorum_unproven"));
  });
  it("rejects missing coverage, sampling gaps, stale samples, and unconfirmed source blocks", () => {
    for (const input of [
      { now, sourceBlock: 3900n, samples: healthySamples().slice(1) },
      { now, sourceBlock: 3900n, samples: healthySamples().filter((_, index) => index !== 10 && index !== 11) },
      { now: "2026-09-08T14:00:21Z", sourceBlock: 3900n, samples: healthySamples() },
      { now, sourceBlock: 3937n, samples: healthySamples() },
    ]) assert.equal(evaluateCanaryEntryReadiness(input).chainEligible, false);
  });
  it("blocks weekends, holidays, early closes, and unsupported calendar years", () => {
    assert.equal(regularEquitySession(now), "regular_session");
    for (const at of ["2026-09-06T14:00:00Z", "2026-09-07T14:00:00Z", "2026-11-27T18:00:00Z", "2026-09-08T13:34:59Z"]) {
      assert.equal(regularEquitySession(at), "closed");
    }
    assert.equal(regularEquitySession("2026-11-27T17:30:00Z"), "regular_session");
    assert.equal(regularEquitySession("2027-09-08T14:00:00Z"), "calendar_unavailable");
  });
});

const operator = "0x1111111111111111111111111111111111111111" as Address;
const rwa = "0x2222222222222222222222222222222222222222" as Address;
const exitInput = { operator, owner: operator, tokenId: 123n,
  source: { rwaSymbol: "NVDA", rwaAddress: rwa, fee: 500, token0: rwa, token1: USDG },
  position: { token0: rwa, token1: USDG, fee: 500, tickLower: -200, tickUpper: 200, liquidity: 1_000_000n },
  sqrtPriceX96: Q96, blockTimestamp: 1000n, slippageBps: 50, ttlSeconds: 300 };
describe("single-position exit", () => {
  it("atomically removes all liquidity and collects to the owner with exact minimums", () => {
    const exit = buildCanaryExit(exitInput);
    const outer = decodeFunctionData({ abi: canaryExitAbi, data: exit.calldata });
    assert.equal(outer.functionName, "multicall");
    if (outer.functionName !== "multicall") throw new Error();
    assert.equal(outer.args[0].length, 2);
    const decrease = decodeFunctionData({ abi: canaryExitAbi, data: outer.args[0][0]! });
    const collect = decodeFunctionData({ abi: canaryExitAbi, data: outer.args[0][1]! });
    assert.equal(decrease.functionName, "decreaseLiquidity"); assert.equal(collect.functionName, "collect");
    if (decrease.functionName !== "decreaseLiquidity" || collect.functionName !== "collect") throw new Error();
    assert.equal(decrease.args[0].liquidity, exitInput.position.liquidity);
    assert.equal(decrease.args[0].amount0Min, exit.expectedPrincipal0 * 9950n / 10000n);
    assert.equal(decrease.args[0].deadline, 1300n);
    assert.equal(collect.args[0].recipient.toLowerCase(), operator.toLowerCase());
  });
  it("rejects another owner, wrong pool, empty positions, and invalid minimums", () => {
    assert.throws(() => buildCanaryExit({ ...exitInput, owner: rwa }), /ownership/);
    assert.throws(() => buildCanaryExit({ ...exitInput, position: { ...exitInput.position, fee: 3000 } }), /selected NVDA/);
    assert.throws(() => buildCanaryExit({ ...exitInput, position: { ...exitInput.position, liquidity: 0n } }), /nonempty/);
    assert.throws(() => buildCanaryExit({ ...exitInput, slippageBps: 10000 }), /slippage/);
  });
  it("checks that the exit collects the principal released by the decrease", () => {
    const result = (collected: bigint) => encodeFunctionResult({ abi: canaryExitAbi, functionName: "multicall", result: [
      encodeFunctionResult({ abi: canaryExitAbi, functionName: "decreaseLiquidity", result: [10n, 20n] }),
      encodeFunctionResult({ abi: canaryExitAbi, functionName: "collect", result: [collected, 21n] }),
    ] });
    assert.equal(decodeCanaryExit(result(11n)).collected0, 11n);
    assert.throws(() => decodeCanaryExit(result(9n)), /did not collect/);
  });
});
