import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { loadDashboardConfig } from "../src/dashboard/config.js";
import { summarizeRehearsal } from "../src/dashboard/focus.js";

describe("dashboard config", () => {
  it("binds to loopback and loads bounded defaults", () => {
    const config = loadDashboardConfig({ DATABASE_URL: "postgresql://test/db" });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 4_173);
    assert.equal(config.activityBucketBlocks, 500);
    assert.equal(config.activityWindowBlocks, 20_000);
    assert.equal(config.riskGateMaxSnapshotAgeSeconds, 180);
    assert.equal(config.riskGateMaxCanonicalityAgeSeconds, 30);
    assert.equal(config.fullAccountingEnabled, false);
    assert.equal(config.canaryMaxCheckpointAgeSeconds, 180);
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

  it("reports the configured history source and parses false without coercing it to true", () => {
    const config = loadDashboardConfig({ DATABASE_URL: "postgresql://test/db", HISTORY_SOURCE: "hypersync", ACCOUNTING_FULL_SNAPSHOT_ENABLED: "false" });
    assert.equal(config.historySource, "hypersync");
    assert.equal(config.fullAccountingEnabled, false);
  });
});

describe("dashboard evidence semantics", () => {
  const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
  const ui = runInNewContext(source.replace(/refresh\(\);\s*$/, "") +
    "\n({ cursorSummary, booleanStatus, focusRiskReasons, fresh });") as {
      cursorSummary(value: unknown): string;
      booleanStatus(value: boolean | null, yes: string, no: string): string;
      focusRiskReasons(value: unknown, now: string): string[];
      fresh(value: string, now: string, maxAge: number): boolean;
    };
  const now = "2026-09-06T15:00:00.000Z";

  it("does not present two stopped but matching cursors as fresh data", () => {
    const input = { serverTime: now, sync: { blockLag: "0", hashesMatch: true }, indexer: { updatedAt: "2026-09-06T14:00:00Z" }, replay: { updatedAt: "2026-09-06T14:00:00Z" } };
    assert.equal(ui.cursorSummary(input), "Stale or missing");
    assert.equal(ui.cursorSummary({ ...input, indexer: { updatedAt: now }, replay: { updatedAt: now } }), "Cursors aligned");
    assert.equal(ui.fresh("2026-09-06T15:01:00Z", now, 180), false);
  });

  it("keeps unknown pause and corporate action flags distinct from false", () => {
    assert.equal(ui.booleanStatus(null, "Paused", "No"), "Unknown");
    assert.equal(ui.booleanStatus(null, "Pending", "None"), "Unknown");
    assert.equal(ui.booleanStatus(false, "Paused", "No"), "No");
  });

  it("only removes the sequencer feed finding with fresh observed recovery", () => {
    const focus = { entryReadiness: { chainEligible: true, evaluatedAt: now }, riskGate: { executionEligible: false, reasons: ["sequencer_feed_unavailable", "oracle_price_stale", "risk_block_not_canonical"] } };
    assert.deepEqual(Array.from(ui.focusRiskReasons(focus, now)), ["oracle_price_stale", "risk_block_not_canonical"]);
    assert.equal(ui.focusRiskReasons(focus, "2026-09-06T15:00:21Z").length, 3);
    assert.equal(ui.focusRiskReasons({ ...focus, entryReadiness: { ...focus.entryReadiness, chainEligible: false } }, now).length, 3);
  });

  it("only summarizes completed local lifecycle evidence for this stream", () => {
    const evidence = JSON.parse(readFileSync(new URL("../notes/canary-evidence-2026-09-06/local-lifecycle.json", import.meta.url), "utf8"));
    const result = summarizeRehearsal(evidence, evidence.source.streamKey);
    assert.equal(result?.scope, "local_anvil_mint_observe_decrease_collect");
    assert.deepEqual(Object.keys(result ?? {}).sort(), ["completedAt", "scope", "sourceBlock"]);
    assert.equal(summarizeRehearsal({ ...evidence, broadcastAuthorized: true }, evidence.source.streamKey), null);
    assert.equal(summarizeRehearsal({ ...evidence, finalPosition: { ...evidence.finalPosition, liquidity: "1" } }, evidence.source.streamKey), null);
    assert.equal(summarizeRehearsal(evidence, "different-stream"), null);
    assert.equal(summarizeRehearsal({}, evidence.source.streamKey), null);
  });
});
