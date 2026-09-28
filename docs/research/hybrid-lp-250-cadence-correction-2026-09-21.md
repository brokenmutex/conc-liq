# Hybrid LP decision cadence correction

The September 20 replay waited ten minutes after each rejected hybrid decision.
That wait skipped potential opportunities despite the experiment's declared
30-second decision interval. The corrected engine retries at the next eligible
30-second observation. Rejection still clears candidate confirmations.

The current inactive hybrid configuration now uses a single five-minute wait
starting at the first observed range exit (`exitCooldownMs: 300000`). It disables
the old post-move cooldown (`cooldownMs: 0`); the configuration and engine reject
stacking both cooldowns. Returning inside the range clears the exit timer. A
subsequent exit starts a fresh wait. The lower tick boundary is inside; the upper
boundary is outside. After five minutes outside, evaluations resume every 30
seconds and still require the economic gate and two candidate confirmations.
Rejected economics do not restart the wait. Initial entry has no exit wait.

The timer and last valid observation time persist in model snapshots and update
on marked observations even between decisions. Observations must be at most one
configured decision interval apart (30 seconds here). A longer gap or an
explicitly noncanonical/incomplete-coverage observation clears the timer and
candidate confirmations. The next valid out-of-range observation starts a full
new wait. A snapshot without the last-observation field also starts a fresh wait;
elapsed time while observations were missing never counts toward expiry.
Canonical source verification remains the caller's responsibility. Invalid
sources cannot advance decisions/stages, and direct invalid marks are rejected
before changing valuation state.

An exit or observation gap before a quoted recenter's first stage cancels that
quote without withdrawal or gas. Once stages have completed, custody recovery
continues. In-range hybrid decisions retain their existing economic gate.
Configurations without `exitCooldownMs` retain their post-move cooldown behavior.

A regression exercises rejection, an improved opportunity at 30 seconds, another
rejection resetting confirmations, staged entry, and the legacy completed-move
cooldown. Exit-timer tests cover expiry, repeated economic rejection, boundary
returns, snapshot reload, and cancellation before withdrawal. The September 28
review added regressions for both invalid-source flags, a 30-minute gap with and
without reload, older snapshots, the exact 30-second continuity boundary, and
preserving completed swap custody for mint recovery after an interruption.

The September 20 results describe the previous behavior. They have not been rerun
with this correction and do not establish the corrected policy's entry rate or
profitability. Reproduction of the original study requires checkout
`273b75b46f10419b557cfef5c6a7891bf9fd6393`; the study manifest retains the original
code, test, and configuration hashes with explicit Git pins. No original result
hashes changed. The old replay script still reads its frozen experiment's original
cooldown settings; a new comparison must explicitly select the five-minute exit
policy. This change does not update a running service or existing campaign state.

These corrections change rejection cadence and the inactive exit-wait policy.
The other review findings about
matched entry/timing, retained decision diagnostics, and duplicate reverted-receipt
gas accounting remain unresolved. New historical results need a separate versioned
run. Independent reference marks, validation data, and measured hybrid costs remain
required before promotion.

September 28 validation: `npm run check` passed repository integrity checks,
TypeScript, and all 920 tests, including 25 hybrid tests. Five new timer
regressions first reproduced the failures before the continuity fix; the final
suite also covers pre-withdrawal cancellation and post-swap recovery. Historical
replay outputs and deployed services were not changed by this correction.
