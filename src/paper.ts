import { loadRuntimeIdentity } from "./runtime/identity.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { paperPolicy } from "./paper/config.js";
import { PaperStore } from "./paper/store.js";
import { log } from "./logger.js";
import { NitroPaperExecutor } from "./paper/executor.js";
const env = z.object({ DATABASE_URL: z.string().min(1), INDEXER_STREAM_KEY: z.string().default("robinhood-v3-rwa-usdg-v1") });
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") {
    console.log(`Usage: npm run paper -- start [--policy FILE] | tick | stop

Create one immutable, forward-only NVDA/USDG paper session, then process new
stored live checkpoints. Uses bounded read-only RPC for prospective paper actions.
Default: guarded 24/7 entry, 1000 paper USDG, fixed ±20 tick spacings, six-hour hold.
Published equity reference within ±3%; held off-hours reference at most 96 hours
old and updated during the most recent equity session. Gas feeds use heartbeats.
No fixed gas charges or slippage haircuts. Orders freeze an executable swap quote,
then simulate swaps and LP transactions at a later fresh checkpoint. Gas uses
Nitro estimates with paper prestate. No wallet keys or mainnet broadcasts.
A policy JSON file can override defaults; existing sessions cannot be retuned.`);
    return;
  }
  if (!["start", "tick", "stop"].includes(command)) throw new Error("Unknown paper command");
  if (args.length && !(command === "start" && args.length === 2 && args[0] === "--policy")) throw new Error("Unknown paper arguments");
  const config = env.parse(process.env);
  const executor = command === "tick" ? new NitroPaperExecutor(config.DATABASE_URL) : undefined;
  const store = new PaperStore(config.DATABASE_URL, executor, loadRuntimeIdentity());
  try {
    await store.assertReady();
    if (command === "start") {
      const policy = paperPolicy(args[1] ? JSON.parse(await readFile(args[1], "utf8")) : {});
      log("info", "paper_session_started", { id: await store.start(config.INDEXER_STREAM_KEY, policy), policy, executionEligible: false });
    } else if (command === "tick") {
      log("info", "paper_session_tick", { result: await store.tick(config.INDEXER_STREAM_KEY) });
    } else if (command === "stop") {
      log("info", "paper_stop_requested", { id: await store.stop(config.INDEXER_STREAM_KEY) });
    }
  } finally { await store.close(); await executor?.close(); }
}
main().catch(error => { log("error", "paper_session_failed", { message: error instanceof Error ? error.message : "Unknown failure" }); process.exitCode = 1; });
