# Live-pilot units

Use a verified sealed release and the dedicated private runtime environment.
Never run the production controller from the dirty source checkout or use the
working-tree `.env` as a systemd environment file.

The maintained custody, stop and recovery procedure is
[`docs/operations/live-pilot.md`](../../docs/operations/live-pilot.md).

The essential invariant is that stopping systemd only stops the worker. A
requested live stop must use the sealed controller's guarded `stop` or `exit`
flow, reconcile every signed transaction, prove closed custody and allowance
postconditions, and only then stop the service. Never replay a completed swap
or bypass an unresolved signed nonce.

Checked-in pilot configuration remains broadcast-disabled. Any future live
launch requires a separately reviewed private configuration and explicit
authorization.
