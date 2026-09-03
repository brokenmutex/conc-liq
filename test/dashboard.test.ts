import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadDashboardConfig } from "../src/dashboard/config.js";

describe("dashboard config", () => {
  it("binds to loopback and loads bounded defaults", () => {
    const config = loadDashboardConfig({ DATABASE_URL: "postgresql://test/db" });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 4_173);
    assert.equal(config.activityBucketBlocks, 500);
    assert.equal(config.activityWindowBlocks, 20_000);
    assert.equal(config.riskGateMaxSnapshotAgeSeconds, 180);
    assert.equal(config.riskGateMaxCanonicalityAgeSeconds, 30);
  });

  it("rejects unauthenticated remote binding", () => {
    assert.throws(
      () => loadDashboardConfig({
        DASHBOARD_HOST: "0.0.0.0",
        DATABASE_URL: "postgresql://test/db",
      }),
      /DASHBOARD_HOST|Invalid option/i,
    );
  });
});
