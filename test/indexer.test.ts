import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hash } from "viem";
import { loadIndexerConfig } from "../src/indexer/config.js";
import type { IndexerCursor } from "../src/indexer/domain.js";
import { toJsonValue } from "../src/indexer/json.js";
import { loadPoolManifest } from "../src/indexer/manifest.js";
import { calculateResumeStart } from "../src/indexer/runner.js";

const hash = `0x${"11".repeat(32)}` as Hash;

function cursor(overrides: Partial<IndexerCursor> = {}): IndexerCursor {
  return {
    chainId: 4663,
    lastScannedBlock: 2_999n,
    lastScannedHash: hash,
    nextBlock: 3_000n,
    streamKey: "test",
    targetSetHash: hash,
    ...overrides,
  };
}

describe("indexer configuration", () => {
  it("allows an independent private read endpoint", () => {
    const config = loadIndexerConfig({
      RH_INDEXER_RPC_URL: "http://private-node:8547",
      RH_RPC_URL: "https://public.invalid",
    });
    assert.equal(config.rpcUrl, "http://private-node:8547");
    assert.equal(config.confirmationDepth, 64);
  });

  it("rejects an inverted adaptive range", () => {
    assert.throws(
      () => loadIndexerConfig({
        INDEXER_INITIAL_CHUNK_SIZE: "50",
        INDEXER_MIN_CHUNK_SIZE: "100",
      }),
      /must not exceed/,
    );
  });
});

describe("pool target manifest", () => {
  it("loads all verified initial targets and computes a stable hash", async () => {
    const manifest = await loadPoolManifest("config/indexer-pools.json");
    assert.equal(manifest.chainId, 4663);
    assert.equal(manifest.pools.length, 15);
    assert.match(manifest.targetSetHash, /^0x[0-9a-f]{64}$/);
    assert.equal(
      manifest.pools.reduce(
        (minimum, pool) => pool.createdBlock < minimum ? pool.createdBlock : minimum,
        manifest.pools[0]!.createdBlock,
      ),
      1_672_833n,
    );
  });
});

describe("resume planning", () => {
  it("replays an overlap from a canonical cursor", () => {
    assert.equal(
      calculateResumeStart({
        canonicalAnchor: 2_999n,
        cursor: cursor(),
        manifestFromBlock: 1_000n,
        reorgOverlap: 256,
        targetSetChanged: false,
      }),
      2_744n,
    );
  });

  it("rewinds behind a non-canonical cursor", () => {
    assert.equal(
      calculateResumeStart({
        canonicalAnchor: 2_500n,
        cursor: cursor(),
        manifestFromBlock: 1_000n,
        reorgOverlap: 256,
        targetSetChanged: false,
      }),
      2_245n,
    );
  });

  it("fails closed after a target-set change without an explicit rewind", () => {
    assert.throws(
      () => calculateResumeStart({
        canonicalAnchor: 2_999n,
        cursor: cursor(),
        manifestFromBlock: 1_000n,
        reorgOverlap: 256,
        targetSetChanged: true,
      }),
      /target set changed/i,
    );
  });
});

describe("event JSON serialization", () => {
  it("preserves protocol-sized integers as decimal strings", () => {
    assert.deepEqual(
      toJsonValue({ amount0: -123n, sqrtPriceX96: 2n ** 96n }),
      { amount0: "-123", sqrtPriceX96: "79228162514264337593543950336" },
    );
  });
});
