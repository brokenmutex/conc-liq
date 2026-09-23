# RangeKeeper withdrawal gas bound — 2026-09-23

## Diagnosis

Campaign `31802d63-9ec8-423c-bc1b-f781f8b44f92` remained in `phase=recenter`
with NFT `1274982` active in `[217940,217980)` while the pool tick was above
the range. The controller repeatedly failed before signing its withdraw plus
collect action with `rangekeeper_withdrawCollect_gas_bound`. The service used
`Restart=on-failure` and restarted every 15 seconds, so each retry reached the
same deterministic check. The campaign had no prepared or signed action.

A read-only replay of the exact call at a confirmed source succeeded. Its live
gas estimate was about 264,200 units; the controller's 20% submission margin
raised the required stage limit to about 317,100. The prior 300,000 limit came
from the pinned fork lifecycle. Earlier canonical withdrawals in this campaign
used 204,804 and 204,517 units. This incident exposed a withdrawal whose live
estimate exceeded that fork-derived envelope.

## Correction

Raise only the withdrawal and collect ceiling to 330,000 units. The controller
still re-estimates each exact call and applies the 20% margin; any estimate
whose padded value exceeds 330,000 remains fail-closed. Other stage ceilings,
fees, slippage, action budgets, campaign identity, and strategy configuration
are unchanged.

The new `withdraw-gas-preflight` / `migrate-withdraw-gas` path is restricted to
the same active pre-withdraw recenter, exact campaign and prior build, unchanged
stored config, empty pending outbox, closed former pilot, and canonical matching
custody. It replays the current withdrawal call under the new limit. Migration
updates only the sealed build identity and appends its proof; it does not sign,
broadcast, alter the candidate, or change custody.

## Recovery record

Deployment and receipt reconciliation details are appended here after the
sealed migration and guarded stage progress complete.
