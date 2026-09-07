import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { advancePaper, initialPaperState, policyHash, type PaperInput, type PaperPolicy, type PaperState } from "../src/paper/engine.js";

import { paperPolicySchema } from "../src/paper/config.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/paper-session-4.json", import.meta.url), "utf8")) as {
  provenance: { policyHash: string }; policy: PaperPolicy;
  steps: { previous: PaperState | null; input: PaperInput; expected: Partial<PaperState> }[];
};

it("preserves all 81 recorded session-4 transitions and closed net economics", () => {
  fixture.policy = paperPolicySchema.parse(fixture.policy);
  assert.equal(policyHash(fixture.policy), fixture.provenance.policyHash);
  assert.equal(fixture.steps.length, 81);
  for (const step of fixture.steps) {
    const actual = advancePaper(step.previous ?? initialPaperState(), fixture.policy, step.input);
    for (const key of Object.keys(step.expected) as (keyof PaperState)[]) {
      assert.deepEqual(actual[key], step.expected[key], `checkpoint ${step.input.checkpoint.id}: ${key}`);
    }
  }
  const signal = fixture.steps.at(-2)!;
  assert.deepEqual(signal.expected.reasons, ["paper_current_risk_evidence_unavailable"]);
  assert.equal(signal.expected.status, "exit_pending");
  assert.equal(fixture.steps.at(-1)!.expected.pnlQuote, "-3419983");
  assert.equal(fixture.steps.at(-1)!.expected.alphaQuote, "-1290882");
});
