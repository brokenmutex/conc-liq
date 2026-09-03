import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateRetryDelay, calculateSafeHead, waitForDelay } from "../src/tail/runner.js";

describe("continuous tail helpers", () => {
  it("pins work behind the configured confirmation depth", () => {
    assert.equal(calculateSafeHead(10_000n, 64), 9_936n);
    assert.throws(() => calculateSafeHead(63n, 64), /below confirmation depth/);
  });

  it("backs retries off exponentially with a one-minute ceiling", () => {
    assert.equal(calculateRetryDelay(5_000, 1), 5_000);
    assert.equal(calculateRetryDelay(5_000, 2), 10_000);
    assert.equal(calculateRetryDelay(5_000, 8), 60_000);
  });

  it("interrupts a pending delay on shutdown", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 10);
    await waitForDelay(10_000, controller.signal);
    assert.ok(Date.now() - startedAt < 1_000);
  });
});
