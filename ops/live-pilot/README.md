# Live pilot units

Use a sealed release (`scripts/build-release.mjs`), never the dirty checkout or `.env` as a systemd EnvironmentFile. The deployed commands and release identities are recorded in `notes/live-pilot-controller-2026-09-12.md` and the private `data/live-pilot-deployment-2026-09-12/` bundle.

`conc-liq-live-pilot.service` runs the controller continuously. Its CLI `exit` or `stop` unwinds custody; systemctl stop alone stops the worker.

A one-time `conc-liq-live-pilot-bootstrap.timer` may run the guarded `retry-approval` CLI once per minute for the existing nonce-0 approval. Successful retry (or an already-present receipt) starts the continuous service and disables the bootstrap timer. A failed retry remains in cash and reports its blocking reason on the dashboard. It creates no new signature, nonce, gas ceiling or capital allocation. The controller's dedicated approval recovery rejects swaps, mints, withdrawals and inventory exposure. Stop both bootstrap and controller when cancelling a launch.
