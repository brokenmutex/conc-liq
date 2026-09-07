import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRobinhoodClient } from "./client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { PostgresRpcHealthGate } from "./rpc-health/store.js";
import { sanitizeRiskError } from "./risk/evaluate.js";
import { openPaperFork } from "./paper/fork.js";
import { simulatePaperRoundTrip } from "./paper/execution.js";
import { DEFAULT_PAPER_POLICY } from "./paper/engine.js";
import type { PaperTransaction } from "./paper/execution-gas.js";

const json = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => typeof v === "bigint" ? String(v) : v, 2);
async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: npm run paper:simulate\nSimulates USDG -> NVDA -> mint -> decrease/collect -> USDG on a bounded owned fork.\nPrices exact calls on Nitro with paper prestate overrides. No signing or mainnet broadcasts.\nWrites data/paper-execution.json. Requires DATABASE_URL, RH_INDEXER_RPC_URL and Anvil.");
    return;
  }
  assert(process.argv.length === 2, "Unknown paper simulation arguments");
  assert(process.env.DATABASE_URL, "DATABASE_URL is required");
  const config = loadIndexerConfig();
  const gate = new PostgresRpcHealthGate({ connectionString: process.env.DATABASE_URL, enabled: true, cacheMs: 2000, maxSampleAgeSeconds: 30 });
  let fork: Awaited<ReturnType<typeof openPaperFork>> | undefined;
  const startedAt = new Date().toISOString();
  const transactions: PaperTransaction[] = [];
  try {
    const beforeRead = () => gate.assertBulkAllowed().then(() => {});
    const live = createRobinhoodClient(config.rpcUrl, config.rpcTimeoutMs, { beforeRequest: beforeRead, retryCount: 0 });
    assert.equal(await live.getChainId(), 4663);
    const source = await live.getBlock({ blockTag: "latest" });
    fork = await openPaperFork({ source: { number: source.number, hash: source.hash, timestamp: source.timestamp }, rpcUrl: config.rpcUrl, beforeRead });
    const result = await simulatePaperRoundTrip(fork, { budgetQuote: DEFAULT_PAPER_POLICY.budgetQuote,
      halfWidthSpacings: DEFAULT_PAPER_POLICY.halfWidthSpacings, maxLiquiditySharePpm: DEFAULT_PAPER_POLICY.maxLiquiditySharePpm,
      maxSlippageBps: 50, transactionTtlSeconds: 300 }, tx => {
      transactions.push(tx);
      console.log(JSON.stringify({ event: "paper_call_simulated", action: tx.action, estimatedFeeWei: tx.estimate.totalFeeWei, localGasUsed: tx.localGasUsed }));
    });
    await mkdir("data", { recursive: true });
    await writeFile("data/paper-execution.json", json({ startedAt, ...result }) + "\n");
    console.log(json({ event: "paper_round_trip_simulated", source: result.source, cashDeltaQuote: result.cashDeltaQuote,
      entryGasWei: result.entryGasWei, exitGasWei: result.exitGasWei, transactions: result.transactions.length,
      requests: fork.budget.requests, path: "data/paper-execution.json", executionEligible: false }));
  } catch (error) {
    await mkdir("data", { recursive: true });
    await writeFile("data/paper-execution-attempt.json", json({ startedAt, completedAt: new Date().toISOString(),
      error: sanitizeRiskError(error), source: fork?.source, upstream: fork?.budget, transactions, executionEligible: false }) + "\n");
    throw error;
  } finally { await fork?.close(); await gate.close(); }
}
main().catch(error => { console.error(sanitizeRiskError(error)); process.exitCode = 1; });
