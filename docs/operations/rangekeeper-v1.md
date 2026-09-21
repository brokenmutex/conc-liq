# RangeKeeper v1.0.0: bounded AAPL/USDG launch

RangeKeeper is a fixed-width, inventory-funded V3 LP controller. Its machine identity is `rangekeeper_v1`, strategy version `1.0.0`, and state schema 1. The first profile is Robinhood Chain 4663 AAPL/USDG, fee 500, tick spacing 10, pool `0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D`. The selected operator is the former pilot wallet `0xdCC9348Ade9cA0A13249a44a63Db5411A8e72D52`. Its 43 former pilot NFTs must remain owned, empty, and owed zero. The [AAPL profile](../../config/rangekeeper-v1-aapl-disabled.json) is broadcast-disabled. [NVDA](../../config/rangekeeper-v1-nvda-disabled.json) is a second read-only identity check; its gas envelope is not admitted.

## Decision and custody rule

The controller reconciles a signed receipt at 64 confirmations before reading new custody or using another nonce. It verifies token, native, allowance, and NFT deltas against that receipt, including a core-pool Collect on withdrawal. Unsigned prepared intents can be cancelled after a crash. A signed intent remains pending until its exact hash resolves; an unknown broadcast acknowledgement may only resend the same bytes. A reverted mint halts until an operator checks the canonical receipt and chooses `recover-mint` or `recover-exit`. Mint recovery cannot repeat a completed swap.

On entry, exact no-swap sizing is checked first. If it misses the deployment floor, the planner finds the minimum feasible direct swap of idle inventory. The proposal needs two distinct eligible canonical observations within 90 seconds. Once minted, the range is held while the pool tick is inside `[lower,upper)`. An outside observation starts a five-minute timer; a return, gap, reorg, or NFT change clears it. Rejected economic proposals do not clear a continuing outside timer. Safety exits bypass that timer. Every submission is simulated, estimated, bounded by fork-derived stage gas, and checked against a fresh fee cap and native complete-exit reserve. A delayed approval triggers a fresh canonical quote for the same swap amount and range. A later mint reprices that range from actual inventory; infeasibility stops the stage instead of inventing an extra swap.

Inventory and fees are valued with independent USDG, AAPL, and ETH references. The ledger records gross fees by token, gas, direct-swap fee and shortfall, net P&L after gas, exposure, drawdown, active/outside time, recenter count, decision reasons, and receipt-level custody. Missing valuation blocks a new economic action; no pool-spot fallback is used. The campaign has no automatic refill. A later transfer into the wallet is an unexplained custody change and blocks new transactions until reconciled.

## Capital and limits

The campaign cap is $310 equivalent: at most $300 of strategy inventory and $10 of native gas. At activation, all then-available USDG and verified AAPL in the wallet are frozen as raw strategy amounts if their independent value fits $300. This supersedes the earlier $250/$240 proposal. The cap does not promise that all USDG enters the LP: the minimum deployment is 90% of the $300 cap, or $270; the rest remains strategy inventory in the wallet. The entry swap is capped at $150 and 50% of available input, with at most $2 reference shortfall. Full width is 20 spacings (200 ticks), slippage cap 50 bps, and LP share cap 20,000 ppm. Action, rolling, and campaign cost ceilings are $5, $10, and $15. Maximum risky-token exposure is 95%, loss limit $20, drawdown 10%, and the first scope is 12 hours with at most two economic actions (entry and one recenter) plus complete exit. The config's four-recenter ceiling is subordinate to that scope.

The 0.001 ETH exit floor exceeds the complete-exit amount measured on the pinned fork; it is not a live gas guarantee. Admission budgets entry, one recenter, complete exit, and 20% native margin using a fee cap 25% above the higher of fresh market gas price and base fee. Stage gas limits are 80k approval, 240k swap, 650k mint, 300k withdrawal/Collect, and 70k cleanup approval. Only AAPL/USDG has the pinned-fork evidence supporting those limits.

## Evidence and current blockers

The full-wallet AAPL fork rehearsal at block 68,644,757 exercised the direct swap, approvals, mint, withdrawal with core Collect, risky-token sale, and allowance cleanup. Its separate forced-mint-revert case charged gas once and completed without a second entry swap. Fork gas is an estimate at the fork's roughly 1-gwei price, not a canonical live cost. No RangeKeeper live receipt or net-alpha claim exists yet. The first bounded funded lifecycle will itself measure canonical costs; an unexpected cost or custody failure blocks progression.

Read-only preflight at confirmed block 68,772,886, hash `0xeb5883587ba6135524b1905afcb50beae76a133cb79aad995466d5bbdba830c2` on September 21, 2026 checked all 43 legacy NFTs and relevant allowances. It allocated 295170862 raw USDG (295.170862 USDG), zero AAPL, and 1113588596335004 wei native ETH. Independent USDG value was about $295.1683. The candidate deployed about $270.0000 in range and used 142826815 raw USDG in its minimum feasible swap; these are quote and integer-math results, not a live fill. The conservative native requirement was 1185963520000000 wei, leaving a shortfall of 72374923664996 wei (0.000072374923664996 ETH) against that observed balance. The old pilot service was inactive but **enabled**. Both conditions block initialization. Recheck funding and fee prices at cutover; topping up only the stale shortfall leaves no margin for drift.

The checked-in disabled profile hashes to `0x1295b4c9005e86ac20fa12a2087436fd74781ded70630dc4a15662bfeeda3bbf` with the current parser. The prepared private broadcast-enabled copy hashes to `0x27ba4886882de035e53eb1e4d5f2fe1ae47a0f992f65a02c53118cd3b221ae97`; the signer resolves to the selected operator. Record the sealed build ID alongside that hash after release preparation. The key reference is `/root/conc-liq/.env`, variable `WALLET_PRIVATE_KEY`; never copy key bytes into this document or the runtime environment file.

## Prepare and operate a sealed package

Build from a clean reviewed commit with `npm run release:build -- /root/conc-liq-releases` and verify its pinned `bin/node launch.mjs --verify`. The [service template](../../ops/rangekeeper/conc-liq-rangekeeper.service.template) and [runtime template](../../ops/rangekeeper/runtime.env.template) provide an isolated service. A private copy of the AAPL config is prepared at `/root/conc-liq/data/rangekeeper-v1-aapl-live.json` with `broadcastEnabled: true` and mode 0600; it preserves the operator, signer reference, pool identity, 43 legacy IDs, and limits. A private runtime file at `/root/conc-liq/data/rangekeeper-v1-runtime.env` carries `DATABASE_URL`, `RH_ARCHIVE_RPC_URL`, and `RH_BROADCAST_RPC_URL`, also mode 0600. The signing key remains separate and private. Recheck both private files and their hashes before activation.

With `RK_RELEASE` set to the exact sealed path and `RK_CONFIG` to the private config, run these in order. Preflight is read-only and supports `--fork` for the exact current candidate. `init` creates the isolated `rangekeeper_v1` ledger after all gates pass; it does not broadcast. The service runs the same sealed controller every 30 seconds.

```sh
RK_RELEASE=/root/conc-liq-releases/BUILD_ID
RK_CONFIG=/root/conc-liq/data/rangekeeper-v1-aapl-live.json
RK_RUNTIME=/root/conc-liq/data/rangekeeper-v1-runtime.env
"$RK_RELEASE/bin/node" "$RK_RELEASE/launch.mjs" "$RK_RUNTIME" rangekeeper-live preflight "$RK_CONFIG" --fork
"$RK_RELEASE/bin/node" "$RK_RELEASE/launch.mjs" "$RK_RUNTIME" rangekeeper-live init "$RK_CONFIG"
"$RK_RELEASE/bin/node" "$RK_RELEASE/launch.mjs" "$RK_RUNTIME" rangekeeper-live status "$RK_CONFIG"
"$RK_RELEASE/bin/node" "$RK_RELEASE/launch.mjs" "$RK_RUNTIME" rangekeeper-live tick "$RK_CONFIG"
```

Before `init`, confirm `conc-liq-live-pilot.service` is inactive **and disabled**, its saved state is closed/stopped with no pending action, and all 43 NFTs are still retired. Disable the old service only in an authorized cutover. `init` also requires fresh full-wallet allocation, independent references, no pre-existing AAPL/USDG allowances, no pending nonce, passing fork simulation, enough native for the bounded scope and exit, and a matching private signer.

For a requested stop, issue `stop` and keep ticking until `closed`. At expiry the controller requests the same guarded exit. Exit must reconcile withdrawal/Collect, sale of the risky token, allowance revocation, every signed nonce, all retired NFTs, and wallet balances. A halted reverted action needs operator inspection and one explicit recovery choice.

```sh
"$RK_RELEASE/bin/node" "$RK_RELEASE/launch.mjs" "$RK_RUNTIME" rangekeeper-live stop "$RK_CONFIG"
"$RK_RELEASE/bin/node" "$RK_RELEASE/launch.mjs" "$RK_RUNTIME" rangekeeper-live recover-exit "$RK_CONFIG"
"$RK_RELEASE/bin/node" "$RK_RELEASE/launch.mjs" "$RK_RUNTIME" rangekeeper-live recover-mint "$RK_CONFIG"
"$RK_RELEASE/bin/node" "$RK_RELEASE/launch.mjs" "$RK_RUNTIME" rangekeeper-live status "$RK_CONFIG"
```

The scope covers the first bounded cost-probe entry, any one admitted recenter, and a complete exit. Record canonical transaction hashes, receipt costs, balances, LP NFT identity, allowances, remaining limits, and net P&L versus frozen initial strategy inventory before calling it closed. A signed pending intent, missing independent valuation, unknown transfer, or incomplete Collect is a custody block, never a reason to force a fresh nonce or mark an exit complete.
