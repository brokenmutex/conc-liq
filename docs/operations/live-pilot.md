# Live-pilot custody and recovery runbook

This runbook describes the invariant. It does not authorize a new live launch.
The last retained status reports the prior pilot closed with no position or
strategy-token inventory; verify chain, database, wallet and service state again
before relying on that dated record.

## Runtime boundary

- Use a verified sealed release and its pinned Node binary.
- Use the dedicated mode-600 runtime environment; never the working-tree
  `.env` as a systemd environment file.
- Confirm the release build ID, environment-config hash, Node version, database
  schema and persisted campaign identity before any controller command.
- The dashboard is read-only and is not proof of custody reconciliation.

## Safe stop

Stopping systemd only stops the worker. It does not exit an NFT position,
liquidate inventory, revoke allowances or close campaign accounting.

For a requested live stop:

1. Read the persisted controller phase, desired state, pending action, nonce,
   wallet balances, NFT ownership/liquidity and allowances.
2. If custody or exposure exists, invoke the sealed controller's `stop` (or the
   explicitly selected `exit`) command. This disables re-entry and performs the
   guarded unwind.
3. Wait for every signed hash to receive a canonical reconciled receipt. Never
   advance the nonce, delete a journal row or repeat a completed swap to bypass
   an ambiguous action.
4. Confirm phase `closed`, no pending action, zero active NFT liquidity, zero
   owed tokens on retired positions, no strategy-token inventory and the
   expected allowances.
5. Reconcile wallet deltas, receipt gas and nonces to the ledger.
6. Only then stop/disable the controller and any bootstrap unit.

If an NFT or inventory remains, the stop is incomplete even when the service is
inactive.

## Recovery

- A lost RPC acknowledgement recovers from the persisted signed hash.
- A receipt timeout does not authorize a new nonce or replacement economic
  action.
- `recover-exit` is valid only for a canonical reconciled revert, unchanged
  custody and no pending transaction. It must preserve any already completed
  swap and continue only the missing withdrawal, sale or cleanup step.
- A receipt/block-hash mismatch, unresolved signed transaction, reorg,
  unexplained transfer or custody mismatch remains blocked for explicit
  investigation.
- Missing gas/reference valuation remains unavailable rather than estimated.

## Postcondition record

Retain the sealed release manifest, exact private configuration bytes in secure
storage, their hashes, the controller state, transaction intents, signed hashes,
canonical receipts, nonces, balances, NFT state, allowances and final accounting
summary. A release retained for audit is not automatically safe to roll back to
the current database or campaign state.
