import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loadRpcHealthGateConfig,
  loadRpcHealthMonitorConfig,
  type RpcHealthPolicyConfig,
} from "../src/rpc-health/config.js";
import type {
  RpcEndpointProbe,
  RpcHealthPreviousStatus,
} from "../src/rpc-health/domain.js";
import { evaluateRpcHealth } from "../src/rpc-health/policy.js";
import { calculateReferenceAnchorBlock, calculateMonitorAnchorBlock } from "../src/rpc-health/probe.js";
import { evaluateCanaryEntryReadiness } from "../src/canary-plan/entry-readiness.js";

const now = "2026-09-04T12:00:00.000Z";
const nowSeconds = BigInt(Date.parse(now) / 1_000);
const anchorHash = `0x${"11".repeat(32)}`;

const config: RpcHealthPolicyConfig = {
  confirmationDepth: 64,
  expectedChainId: 4663,
  hardLagBlocks: 100n,
  hardLagSeconds: 30n,
  hardLatencyMs: 5_000,
  recoverySamples: 12,
  referenceQuorum: 2,
  softLagBlocks: 20n,
  softLagSeconds: 5n,
  softLatencyMs: 2_000,
  stallSeconds: 30,
};

function probe(input: {
  readonly head: bigint;
  readonly name: string;
  readonly role: "private" | "reference";
  readonly timestamp?: bigint;
}): RpcEndpointProbe {
  return {
    anchorBlock: 900n,
    anchorError: null,
    anchorHash,
    chainId: 4663,
    error: null,
    headBlock: input.head,
    headHash: `0x${"22".repeat(32)}`,
    headTimestamp: input.timestamp ?? nowSeconds,
    latencyMs: 100,
    name: input.name,
    role: input.role,
    syncing: input.role === "private" ? false : null,
    syncingError: null,
  };
}

function previous(overrides: Partial<RpcHealthPreviousStatus> = {}): RpcHealthPreviousStatus {
  return {
    consecutiveHealthy: 11,
    consecutiveUnhealthy: 0,
    observedAt: "2026-09-04T11:59:50.000Z",
    privateHead: 999n,
    privateHeadUnchangedSince: "2026-09-04T11:59:50.000Z",
    referenceHead: 1_000n,
    state: "half_open",
    ...overrides,
  };
}

function healthyProbes(privateHead = 1_000n): RpcEndpointProbe[] {
  return [
    probe({ head: privateHead, name: "private", role: "private" }),
    probe({ head: 1_000n, name: "reference_1", role: "reference" }),
    probe({ head: 999n, name: "reference_2", role: "reference" }),
  ];
}

describe("RPC health quorum policy", () => {
  it("opens immediately beyond the hard block threshold", () => {
    const result = evaluateRpcHealth({
      config,
      observedAt: now,
      previous: previous(),
      probes: healthyProbes(899n),
    });
    assert.equal(result.state, "open");
    assert.equal(result.allowBulk, false);
    assert.equal(result.lagBlocks, 101n);
    assert(result.reasons.includes("private_block_lag_hard"));
  });

  it("degrades before the hard cutoff", () => {
    const result = evaluateRpcHealth({
      config,
      observedAt: now,
      previous: previous(),
      probes: healthyProbes(975n),
    });
    assert.equal(result.state, "degraded");
    assert(result.reasons.includes("private_block_lag_soft"));
  });

  it("requires clean recovery hysteresis before allowing bulk work", () => {
    const almost = evaluateRpcHealth({
      config,
      observedAt: now,
      previous: previous({ consecutiveHealthy: 10 }),
      probes: healthyProbes(),
    });
    assert.equal(almost.state, "half_open");
    assert.equal(almost.allowBulk, false);
    const recovered = evaluateRpcHealth({
      config,
      observedAt: now,
      previous: previous({ consecutiveHealthy: 11 }),
      probes: healthyProbes(),
    });
    assert.equal(recovered.state, "healthy");
    assert.equal(recovered.allowBulk, true);
  });

  it("opens when the private confirmed hash disagrees with the reference quorum", () => {
    const probes = healthyProbes();
    probes[0] = {
      ...probes[0]!,
      anchorHash: `0x${"ff".repeat(32)}`,
    };
    const result = evaluateRpcHealth({ config, observedAt: now, previous: null, probes });
    assert.equal(result.state, "open");
    assert(result.reasons.includes("private_canonical_hash_mismatch"));
  });

  it("distinguishes an unavailable private anchor from a hash disagreement", () => {
    const probes = healthyProbes();
    probes[0] = {
      ...probes[0]!,
      anchorError: "RPC returned no block",
      anchorHash: null,
    };
    const result = evaluateRpcHealth({ config, observedAt: now, previous: null, probes });
    assert.equal(result.state, "open");
    assert(result.reasons.includes("private_confirmed_anchor_unavailable"));
    assert(!result.reasons.includes("private_canonical_hash_mismatch"));
  });

  it("uses a matching reference majority and tolerates one dissenting provider", () => {
    const probes = healthyProbes();
    probes.push({
      ...probe({ head: 1_010n, name: "reference_3", role: "reference" }),
      anchorHash: `0x${"ff".repeat(32)}`,
    });
    const result = evaluateRpcHealth({
      config,
      observedAt: now,
      previous: previous(),
      probes,
    });
    assert.equal(result.state, "healthy");
    assert.equal(result.referenceHead, 1_000n);
    assert(result.warnings.includes("reference_anchor_disagreed:reference_3"));
  });

  it("opens after the private head remains still while references advance", () => {
    const probes = healthyProbes();
    probes[1] = probe({ head: 1_010n, name: "reference_1", role: "reference" });
    probes[2] = probe({ head: 1_009n, name: "reference_2", role: "reference" });
    const result = evaluateRpcHealth({
      config,
      observedAt: now,
      previous: previous({
        observedAt: "2026-09-04T11:59:50.000Z",
        privateHead: 1_000n,
        privateHeadUnchangedSince: "2026-09-04T11:59:20.000Z",
        referenceHead: 990n,
        state: "healthy",
      }),
      probes,
    });
    assert.equal(result.state, "open");
    assert(result.reasons.includes("private_head_stalled"));
  });
});

describe("RPC health configuration", () => {
  it("loads independent default references and a private endpoint", () => {
    const result = loadRpcHealthMonitorConfig({
      RH_INDEXER_RPC_URL: "http://private-node:8547",
    });
    assert.equal(result.referenceUrls.length, 2);
    assert.equal(result.referenceQuorum, 2);
    assert.equal(result.hardLagBlocks, 100n);
  });

  it("rejects using the private endpoint as its own reference", () => {
    assert.throws(() => loadRpcHealthMonitorConfig({
      RH_INDEXER_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
    }), /must not also be/);
  });

  it("enables fail-closed worker gating by default", () => {
    assert.deepEqual(loadRpcHealthGateConfig({}), {
      cacheMs: 2_000,
      enabled: true,
      maxSampleAgeSeconds: 30,
    });
  });
});

describe("RPC health reference anchor", () => {
  it("preserves 64 confirmations on all nodes through ten blocks of private lag", () => {
    for (const lag of [0n, 1n, 5n, 10n]) {
      const samples = Array.from({ length: 31 }, (_, i) => {
        const at = new Date(Date.parse(now) - 300000 + i * 10000).toISOString();
        const head = 1000n + BigInt(i * 100);
        const anchor = calculateMonitorAnchorBlock([head, head - 1n], 64, head - lag)!;
        const probes = healthyProbes().map((p, j) => ({ ...p, anchorBlock: anchor,
          headBlock: j === 0 ? head - lag : j === 1 ? head : head - 1n,
          headTimestamp: BigInt(Date.parse(at) / 1000) }));
        const snapshot = evaluateRpcHealth({ config, observedAt: at, previous: previous({ state: 'healthy' }), probes });
        assert.equal(snapshot.state, 'healthy');
        return { id: String(i), snapshot };
      });
      const result = evaluateCanaryEntryReadiness({ now, sourceBlock: 3900n, samples });
      assert.equal(result.chainEligible, true, `lag=${lag}: ${result.reasons}`);
    }
  });

  it("bounds anchor adjustment and keeps unknown or larger lag on the reference policy", () => {
    assert.equal(calculateMonitorAnchorBlock([1000n, 1000n], 64, 990n), 926n);
    assert.equal(calculateMonitorAnchorBlock([1000n, 1000n], 64, 989n), 936n);
    assert.equal(calculateMonitorAnchorBlock([1000n, 1000n], 64, 1n), 936n);
    assert.equal(calculateMonitorAnchorBlock([1000n], 64, null), 936n);
    assert.equal(calculateMonitorAnchorBlock([], 64, 990n), null);
    assert.equal(calculateMonitorAnchorBlock([30n], 64, 20n), 0n);
  });

  it("retains time-lag, syncing and hash-disagreement gates at ten blocks", () => {
    const base = healthyProbes(990n).map(p => ({ ...p, anchorBlock: 926n }));
    for (const change of [ { syncing: true }, { headTimestamp: nowSeconds - 6n }, { anchorHash: `0x${'ff'.repeat(32)}` } ]) {
      const probes = base.map((p, i) => i === 0 ? { ...p, ...change } : p);
      const result = evaluateRpcHealth({ config, observedAt: now, previous: previous(), probes });
      assert.equal(result.allowBulk, false);
    }
  });

  it("uses a confirmation-depth anchor when reference heads are close", () => {
    assert.equal(calculateReferenceAnchorBlock([1_000n, 990n], 64), 926n);
  });

  it("keeps full depth on a slow reference even when another reference is far ahead", () => {
    assert.equal(calculateReferenceAnchorBlock([2_100n, 1_000n], 64), 936n);
    for(const spread of [63n,64n,67n,84n]) for(const lag of [0n,1n,10n]) {
      const samples=Array.from({length:31},(_,i)=>{
        const at=new Date(Date.parse(now)-300000+i*10000).toISOString(),head=10000n+BigInt(i*100);
        const anchor=calculateMonitorAnchorBlock([head-spread,head],64,head-lag)!;
        const probes=healthyProbes().map((p,j)=>({...p,anchorBlock:anchor,
          headBlock:j===0?head-lag:j===1?head-spread:head,headTimestamp:BigInt(Date.parse(at)/1000)}));
        const snapshot=evaluateRpcHealth({config,observedAt:at,previous:previous({state:'healthy'}),probes});
        assert.equal(snapshot.state,'healthy');assert(probes.every(p=>p.headBlock-anchor>=64n));
        return {id:String(i),snapshot};
      });
      const result=evaluateCanaryEntryReadiness({now,sourceBlock:12000n,samples});
      assert.equal(result.chainEligible,true,`spread=${spread}, lag=${lag}: ${result.reasons}`);
    }
  });

  it("does not use a latest-block hash when a reference cannot prove the older anchor",()=>{
    const probes=healthyProbes().map((p,i)=>i===1?{...p,anchorHash:null,anchorError:'Historical block unavailable'}:p);
    const result=evaluateRpcHealth({config,observedAt:now,previous:previous(),probes});
    assert.equal(result.allowBulk,false);assert(result.referenceQuorum<2||result.reasons.length>0);
  });

  it("returns no anchor without a usable reference", () => {
    assert.equal(calculateReferenceAnchorBlock([], 64), null);
  });
});
