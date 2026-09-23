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

The gas-bound correction was committed as `978338d7636b4582076e49575beed8fd60f5d80b`
and sealed as build
`47d8d7f8e4c8be3a6dfc2250e6ecd291979511f710e877ff1c7264ecab0be954`. The
guarded gas migration passed and the worker resumed. It submitted withdrawal
`0xbf513be7feecd4d37c76adc37f6df106a69a7b0f8abd340b0026d462bc733c12`,
confirmed at block `70082771`; canonical state then showed NFT `1274982`
fully withdrawn with zero liquidity and tokens owed, no active position, no
pending action, and zero allowances.

The post-withdraw replan then exposed a second liveness issue: each fresh swap
candidate took about 1m48s to construct, longer than the 90-second confirmation
window. The planner now evaluates nine parallel bracket points per quote round,
while retaining exact-minimum, predecessor, fresh-source, and simulation
checks. The change is commit `295ce917a0d7c870fcc435237d4ad3461571c2a5`, sealed
as build `17c46693608d69a8447c8b1cfe9cfcf57307becf66a00fef373e5811c11c1219`.
The complete suite passed (685/685) and TypeScript typecheck passed. A fresh
stale-recenter preflight proved canonical custody and an empty pending outbox;
the guarded migration preserved the campaign, retired NFT history, costs, and
the confirmed withdrawal without repeating it.

On the faster build, two fresh canonical observations confirmed the replacement
candidate in `[218020,218060)`. Approvals, swap
`0xeff8759aa16a6a15d051b79c48d79bd8b2d06fefe6b3752a1275aa81af9e2f0e`, and
mint `0x6175d673d8ce1ba7a48c6b315f381d3d65ea823c29777f09337eb0829afb4467`
were receipt-reconciled. The campaign returned to `phase=holding` with active
NFT `1280640`, liquidity `6785096357770074`, range `[218020,218060)`, tick
`218036`, and zero tokens owed. Both post-mint allowance revocations were also
confirmed; the latest canonical observation shows all tracked allowances at
zero and the pending-action count at zero. At verification the systemd worker
was active on build `17c466…1219` with `NRestarts=0`.
