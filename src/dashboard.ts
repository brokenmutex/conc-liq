import { once } from "node:events";
import { loadDashboardConfig } from "./dashboard/config.js";
import { DashboardRepository } from "./dashboard/repository.js";
import { createDashboardServer } from "./dashboard/server.js";
import { log } from "./logger.js";
import { sanitizeRiskError } from "./risk/evaluate.js";

async function main(): Promise<void> {
  const config = loadDashboardConfig();
  const repository = new DashboardRepository(config);
  try { await repository.assertReady(); } catch (error) { await repository.close(); throw error; }
  const server = createDashboardServer(repository, config);
  await once(server, "listening");
  log("info", "dashboard_started", {
    host: config.host,
    port: config.port,
    refreshMs: config.refreshMs,
    streamKey: config.streamKey,
  });

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log("info", "dashboard_stop_requested", { signal });
    server.close(() => {
      repository.close()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          log("error", "dashboard_close_failed", {
            error: sanitizeRiskError(error),
          });
          process.exit(1);
        });
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  log("error", "dashboard_failed", { error: sanitizeRiskError(error) });
  process.exitCode = 1;
});
