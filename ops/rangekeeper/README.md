# RangeKeeper service template

Install only after the sealed release and private config have been reviewed.
Replace `@BUILD_ID@` in the service template with the verified release build ID.
The prepared private runtime file under `data/` supplies PostgreSQL and two RPC endpoints; the
prepared private campaign config names the separate key file and must set
`broadcastEnabled: true`. The checked-in AAPL and NVDA profiles remain disabled.

The full preflight, start, stop, recovery, and closure procedure is in
[`docs/operations/rangekeeper-v1.md`](../../docs/operations/rangekeeper-v1.md).
Stopping systemd alone does not unwind an LP. Request `stop` through the sealed
controller, keep the service running until `closed`, and inspect custody and
receipts. A `halted` or pending-signed campaign requires reconciliation or the
documented recovery command before service retirement.
