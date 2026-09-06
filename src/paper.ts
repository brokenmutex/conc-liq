import { readFile } from "node:fs/promises";
import { z } from "zod";
import { paperPolicy } from "./paper/config.js";
import { PaperStore } from "./paper/store.js";
import { log } from "./logger.js";
const env = z.object({ DATABASE_URL: z.string().min(1), INDEXER_STREAM_KEY: z.string().default("robinhood-v3-rwa-usdg-v1") });
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") {
    console.log(`Usage: npm run paper -- start [--policy FILE] | tick | stop | migrate

Create one immutable, forward-only NVDA/USDG paper session, then process new
stored live checkpoints. Uses PostgreSQL only; no wallet or RPC access.
Default: guarded entry, 1000 paper USDG, fixed ±20 tick spacings, six-hour hold,
1 USDG entry + 1 USDG exit cost assumptions and a 10 bps entry inventory haircut.
Signals fill only at a later fresh checkpoint. No automatic range recentering.
A policy JSON file can override defaults; existing sessions cannot be retuned.`);
    return;
  }
  if (!["start", "tick", "stop", "migrate"].includes(command)) throw new Error("Unknown paper command");
  if (args.length && !(command === "start" && args.length === 2 && args[0] === "--policy")) throw new Error("Unknown paper arguments");
  const config = env.parse(process.env);
  const store = new PaperStore(config.DATABASE_URL);
  try {
    if (command === "migrate" || command === "start") await store.migrate();
    if (command === "start") {
      const policy = paperPolicy(args[1] ? JSON.parse(await readFile(args[1], "utf8")) : {});
      log("info", "paper_session_started", { id: await store.start(config.INDEXER_STREAM_KEY, policy), policy, executionEligible: false });
    } else if (command === "tick") {
      log("info", "paper_session_tick", { result: await store.tick(config.INDEXER_STREAM_KEY) });
    } else if (command === "stop") {
      log("info", "paper_stop_requested", { id: await store.stop(config.INDEXER_STREAM_KEY) });
    } else log("info", "paper_schema_ready");
  } finally { await store.close(); }
}
main().catch(error => { log("error", "paper_session_failed", { message: error instanceof Error ? error.message : "Unknown failure" }); process.exitCode = 1; });
