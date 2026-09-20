# Conditional $250 hybrid LP canary checklist

Status: inactive checklist only. It does not authorize funding, approvals,
signing, service activation, state migration, or transaction broadcast.

Use this checklist only after the research report identifies one frozen candidate
that passes independent validation and the prospective paper period. A mechanics
replay, pool-marked result, or inactive configuration cannot satisfy those gates.

## Evidence gate

- [ ] One candidate was frozen before validation; QQQ and every declared holdout
  remained excluded from selection and tuning.
- [ ] Complete validation data shows positive net P&L and independently valued
  alpha, within the preregistered drawdown and inventory limits.
- [ ] The candidate passes double-gas/half-fees, delayed-stage, and adverse-price
  stress without adding capital or weakening the strict economic buffer.
- [ ] Prospective paper evidence covers at least three weeks and two weekends
  under one immutable config, build, state provenance, and benchmark contract.
- [ ] Every material source gap, unavailable mark, rejected action, downtime
  interval, and policy change is present in the report. A policy change restarts
  the affected validation window.

## Cost and market gate

- [ ] Entry, approval if required, withdrawal/collection, swap, mint, failed-stage
  gas, exit, and allowance cleanup are measured for the exact pool and $240
  strategy size. Borrowed or assumed stage splits have been replaced.
- [ ] Swap fee and historical/quoted price impact are counted once; adverse
  selection remains separate. Actual approval requirements and allowance state
  are verified from chain state.
- [ ] An executable full exit, including residual wallet inventory, fits inside
  the reserved 10 USDG gas allowance under the approved stress case.
- [ ] The independent reference is current under the existing oracle, deviation,
  asset-health, corporate-action, calendar, and held-reference rules.

## Runtime and custody gate

- [ ] A separately reviewed, sealed release pins the candidate config, source
  commit, Node version, database schema, and isolated new state path.
- [ ] The exact total account cap is 250 USDG-equivalent: 240 USDG strategy
  inventory plus one 10 USDG gas reserve. Refill and future-sale borrowing are
  disabled.
- [ ] Actual balances, NFT ownership/liquidity, owed tokens, nonce, native gas,
  approvals, and spenders reconcile before activation.
- [ ] `executionEligible=false` and `broadcastsEnabled=false` remain set until a
  separate activation approval names the candidate, release, config hash, wallet,
  cap, and start time.
- [ ] One pending action is allowed. Frozen range, direction, raw input, minima,
  TTL, source block/hash, canonicality, cost evidence, and decision reason persist.
- [ ] Restart tests prove completed withdrawal and swap stages are never replayed;
  a mint failure resumes at mint with the resulting wallet inventory.

## Stop and recovery gate

- [ ] Loss, drawdown, inventory, source-age, canonicality, reference, gas-reserve,
  quote-expiry, and corporate-action stop rules are configured and rehearsed.
- [ ] Cancellation before withdrawal preserves the old NFT. Cancellation after
  withdrawal leaves valued wallet inventory. A submitted revert charges gas.
- [ ] The custody-safe stop uses the sealed controller unwind, waits for canonical
  receipt reconciliation, confirms no pending action and zero active liquidity,
  values or exits residual inventory, revokes cleanup allowances, and only then
  stops the service.
- [ ] Recovery retains signed hashes, receipts, completed-stage identifiers,
  balances, nonces, NFT state, allowance state, exact config bytes, and build ID.

## Explicit activation record

Record the approved candidate ID, result-manifest hash, release build ID, config
hash, state path, wallet, measured-cost evidence hashes, capital cap, stop limits,
approver, and approved start time. Without that record, the checklist remains
inactive.
