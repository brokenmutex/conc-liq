# RangeKeeper paper recenter follow-up — October 1, 2026

Current status — October 1, 2026: recenter is not implemented. The full test
suite passes 1,051 tests, and the canonical
setup/open/observation/retained-close lifecycle passed against the verified
sealed release. The release is deployed to the command, dashboard, and paper
worker service units; one $250 AAPL paper campaign is active and recording
observations. See the
[production launch record](../reviews/rangekeeper-paper-production-2026-10-01.md) and
[lifecycle evidence record](../reviews/rangekeeper-paper-lifecycle-2026-10-01.md).
The existing 90-second freshness guard remains unchanged.

The dashboard command-browser integration passes 20 checks with zero browser
exceptions. Its RangeKeeper review/admission evidence uses a synthetic
source/cost fixture and proves UI/session/CSRF/route binding only, not canonical
chain behavior or economics. This document remains a recenter follow-up
proposal: the lifecycle proof does not make recenter available or claim
autonomous trading.

## Current boundary

The paper implementation has source paths for one confirmed opening,
source-pinned observations, and a retained-principal close. The sealed
canonical lifecycle proved setup admission, open, observation continuity across
worker restart,
retained close, and shared dashboard history. The opening mark is the
immutable capital-in baseline and remains the campaign's `open_mark_id`.
Observations currently
reconstruct the one active position from the original opening candidate.
`buildRangeKeeperPaperMarkPayload` rejects a kernel with `recenters !== 0`, and
the maintenance builder always writes `recenters: 0`. Exit context likewise
requires the latest mark to be `rangekeeper_paper_mark_v1` for the original
candidate. These are appropriate fail-closed guards: there is no durable
position lineage or recenter booking to replace them yet.

`operationKind` already names `change_range`, but it is not an implemented
paper path. The worker's allowed kinds and dispatch do not include it, and
accepted-operation replay's type excludes it. A schema enum alone is not
actionability. The live `RangeKeeperLiveController` has useful policy and
sequence references, but its authorization depends on signer/transaction
receipts and the live durable state machine; it cannot be reused as a paper
completion or accounting implementation.

## Minimal model: one campaign, append-only position epochs

Keep the existing campaign and original opening mark. Do not create a
successor campaign, rewrite `open_mark_id`, or reset `campaignStartValue`.
Represent each confirmed paper recenter as a new position epoch appended to the
same campaign:

1. A read-only observation uses the latest verified position epoch's exact
   position and idle inventory, plus the latest kernel snapshot. It advances
   the strategy timer and valuation without changing inventory.
2. A recenter preview freezes a `change_range` plan, including the epoch/mark
   it consumes, source block/hash, old position, withdrawn principal plus idle
   inventory, any explicitly modeled swap and its quote, the new candidate,
   replayable mint inputs, references, modeled costs, and the policy/kernel
   decision. Its digest binds all of those fields and the campaign revision.
3. Acceptance and worker replay re-read the same campaign and latest mark. The
   worker must prove source anchors canonical and deterministically replay the
   frozen policy/plan. A lost response is resolved by the same idempotency key;
   replay returns the original operation and never books a second epoch.
4. Completion atomically appends a recenter mark and ledger entries, advances
   the active-position pointer/epoch, updates the kernel snapshot and operation
   to succeeded, and leaves the original opening baseline untouched. The new
   mark records old-position retirement and new-position opening provenance.
5. A subsequent retained close consumes the latest epoch's position and idle
   inventory, while retaining the original opening reference for campaign
   performance. It must not interpret the original mint amounts as current
   principal.

Use a dedicated append-only transition payload (for example,
`rangekeeper_paper_recenter_v1`) rather than overloading the observation mark
classification. Its strict schema should bind `campaignId`, `revision`,
`operationId`, `previewId`, prior mark ID and hash, source, previous epoch,
withdrawal/collection evidence, swap evidence or explicit no-swap, new mint
replay, resulting inventory, kernel snapshot, and model hash. Store the
resulting active inventory in the mark itself. Derive every balance from the
prior persisted epoch plus independently replayed withdrawal/swap/mint
arithmetic; never reconstruct post-recenter inventory from the original
allocation. The mark and ledger append must share the existing completion
transaction. The original open mark remains the source of initial capital and
campaign start value; recenter costs and principal movement are separate
append-only evidence, not new capital-in.

Do not reuse live `costEvents` as paper paid costs. Recenter gas, swap fees,
shortfall, and impact remain modeled/provisional or unavailable under existing
paper evidence rules. Retained close continues to report its principal lower
bound and unavailable fee/NAV accounting honestly.

## Smallest implementation decomposition

1. **Epoch and model contract.** Extend
   `src/deployments/rangekeeper-paper-persistence.ts` with strict recenter
   event/mark validation and replay from the previous epoch. Keep initial-mark
   validation as a distinct branch. Extend
   `src/deployments/rangekeeper-paper-context.ts` so restart recovery accepts
   the latest verified recenter mark and verifies its prior-mark binding,
   operation/preview hashes, candidate mint replay, balances, kernel lineage,
   and canonical source. Do not weaken the current original-open lineage check.
2. **Pure decision/preview builder.** Replace the observation builder's fixed
   inventory assumption in `src/deployments/rangekeeper-paper-maintenance.ts`
   with a context that has both immutable opening baseline and current epoch.
   Reuse `planRangeKeeper` and exact V3 arithmetic from
   `src/strategy/rangekeeper/`; adapt only pure policy/decision inputs. Build a
   preview from an eligible outside-range decision and current balances. Keep
   it unavailable if source continuity, references, quote, reserve, cost,
   observation-gap, policy identity, or simulation evidence is incomplete.
3. **Admission and replay.** Add a RangeKeeper `change_range` acceptance route
   and its strategy-aware replay path in `src/deployments.ts`,
   `src/deployments/server.ts`, and
   `src/deployments/rangekeeper-paper-exit-acceptance.ts`'s neighboring
   operation module (do not make the exit route accept unrelated operations).
   Extend `DeploymentStore.acceptedOperationReplay` and worker dispatch in
   `src/deployments/store.ts` and `src/deployments/paper-operation-worker.ts`.
   Validate current campaign revision/lifecycle, exact latest epoch, no pending
   operation, preview digest, expiration, idempotency key, and anchored model
   before acceptance. Recovery through expiry must return an already accepted
   matching operation, while a fresh expired request remains rejected.
4. **Atomic completion and close parity.** Add a dedicated store completion
   method that rechecks operation claim, canonical anchors, source order,
   prior latest mark, model hash, epoch, inventory replay, and append uniqueness
   inside one transaction. Make the retain-exit context/completion path consume
   either the original opening plus a latest observation mark, or the latest
   recenter epoch plus later observations. The immutable opening remains the
   campaign capital reference in both cases.
5. **Dashboard honesty.** Show recenter as available only when a live,
   unexpired, actionable `change_range` preview is returned. Until all four
   server/storage gates above exist, keep automatic recenter disabled and say
   that paper support covers open, observations, and retained close only.
   Do not expose pause/resume/convert as supported RangeKeeper controls unless
   their own completion paths exist.

## Reference reuse and limits

Reuse the live controller only for policy semantics and tested pure helpers:
outside-range persistence, `planRangeKeeper`, exact principal/mint arithmetic,
range/tick validation, candidate constraints, and order of operations. The live
controller's withdrawal → collect → replan from post-withdraw balances →
optional swap → re-quote → mint ordering is a useful behavioral reference.
Paper must model this sequence without signing or broadcasting and must require
its own source-pinned replay. Do not copy live receipt finalization,
`activeTokenId` mutation, `retiredTokenIds`, or cost events as paper evidence.

The existing `change_range` kind and `maxRecenters` setting are configuration
vocabulary only. They must not cause an operation to be accepted until the
worker, persisted epoch contract, atomic completion, and exit parity are all
implemented.

## Acceptance tests

- After one recenter, a restart loader reconstructs the exact current position,
  idle balances, kernel counter, and baseline from append-only marks; a changed
  prior-mark ID/hash, candidate, swap, mint amount, source anchor, or balance
  fails closed.
- The original opening mark and campaign start value remain byte-identical
  through one or more recenter epochs; no second `capital_in` is booked.
- A recenter preview is rejected if its source is stale/noncanonical, outside
  persistence is insufficient, the prior mark is not latest, or any reference,
  quote, action-cost bound, reserve, or replay input is unavailable.
- Same-key acceptance replay before and after preview expiry returns the same
  operation when digest/preview/revision match; a different key or changed
  digest cannot create a second epoch.
- Worker retry at every stage before and after completion produces at most one
  epoch and one ledger append. Completion failure leaves the campaign and
  inventory epoch unchanged; completion success atomically advances both.
- A failed/reverted modeled action cannot silently produce a new active
  position; it becomes blocked/unavailable for explicit recovery, with no
  invented fills or paid costs.
- Retain close after recenter consumes the latest active position and idle
  inventory, records retained lower-bound amounts, and leaves fees, net NAV,
  and paid costs unavailable unless independently evidenced.
- Dashboard and API integration cover open → observation(s) → recenter →
  observation → retained close, including restart/lost-response recovery and
  history projection. Before recenter is implemented, assert the API and UI do
  not advertise it as available.
