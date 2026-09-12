# $250 NVDA/USDG live pilot preparation

The deployment objective is to find execution and recovery defects with 250 USDG of initial capital while the independent 5,000 USDG paper campaign continues. The live pilot is not active. This milestone adds runnable deployment checks, fork rehearsals, receipt decoding and a durable transaction outbox; it does not yet provide a production executor.

## Agreed strategy and isolation

- NVDA/USDG, Uniswap v3 fee 500, Robinhood Chain 4663.
- Start with 250 USDG; allocate all available strategy inventory, apart from unavoidable integer dust. ETH gas is funded separately. No automatic capital top-ups.
- Same ±20 raw ticks as the current paper strategy: two tick spacings on each side of its selected center, 40 raw ticks total. The center is aligned to valid ticks using the existing strategy function.
- Run continuously, including market, premarket, overnight and weekends. Recenter when outside the range and swap only the net inventory needed for the new range.
- No inventory cap, routine holding timeout or hard 2% liquidity-share veto. Retain the ±5% reference band, 50 bps transaction slippage checks and existing bounded reference-age policy.
- Preserve the 30-block holding tolerance. New-entry admission still requires healthy source/quorum evidence. A transaction receipt timeout is a reconciliation condition, not an instruction to exit or resubmit at a fresh nonce.
- Use a dedicated wallet, independent live ledger, service and dashboard campaign. Do not convert paper balances or synthetic NFT IDs into live inventory.

The separate [configuration](../config/live-pilot-nvda-250.json) has `broadcastEnabled: false`. The operator is now `0xdCC9348Ade9cA0A13249a44a63Db5411A8e72D52`, using `WALLET_PRIVATE_KEY` from the private `.env` file. Configuration contains only the public address and env reference. Gas funding remains unset. A capital limit constrains initial funding, not the value of an appreciating position.

## Implemented and checked

[Preparation script](../scripts/live-pilot-prepare.mjs): reads a recent covered/canonical checkpoint and current chain/reference gates; pins contract code hashes; checks chain and deployment identity through the execution context; optionally reads a supplied public wallet's assets, allowances, NFT count and nonces. It solves the 250 USDG entry ratio including the quote's price impact, then runs a complete local buy/mint/withdraw/sell round trip and reconciles receipt token deltas and local gas. The upstream proxy only permits pinned reads. Simulated funding exists solely inside the owned Anvil instance.

[Recenter script](../scripts/live-pilot-recenter-check.mjs): independently tests approximately 250 USDG of synthetic one-sided inventory in each direction, with a quote at block N-1 and execution at N. It exercises withdrawal/collection, the bounded adaptive net swap, mint and a subsequent exit preview. This tests mechanics; the fixture is not a real observed $250 holding and the one-block delay does not establish pending-transaction robustness.

[Transaction journal](../src/live-pilot/journal.ts): persists an immutable unsigned intent before signing; verifies the signed chain, sender, destination, nonce, data, value and gas envelope; stores the exact signed bytes and hash before any possible broadcast. PostgreSQL uniqueness prevents a second outstanding intent for the wallet across processes. Restart reads return the same transaction. The journal deliberately has no broadcast or completion/unlock API yet: canonical receipt and position reconciliation must be implemented before it can permit a following transaction. Calldata policy authorization remains a separate required layer; envelope equality alone does not authorize a trade.

[Receipt decoder](../src/live-pilot/receipt.ts): extracts trusted-token wallet transfers, NFT ownership and liquidity events, and gas used times effective price. Malformed recognized events fail. Reverted transactions still incur gas. It leaves `reconciled: false` and `lpFeeIncome: null`: a collection may include principal, and event decoding alone cannot prove canonical wallet/NFT state.

[Local signer](../src/live-pilot/signer.ts): reads the selected private env file, verifies the derived operator, signs an ownership challenge and can sign the exact reserved transaction envelope. It exposes no key or RPC/broadcast method. The preparation scripts remove the selected key variable from their subprocess environment. The real operator has signed only an ownership message; transaction-signing tests use a public deterministic test key. This uses viem's [local private-key account](https://viem.sh/docs/accounts/local/privateKeyToAccount) and [EIP-191 message signing](https://viem.sh/docs/actions/wallet/signMessage).

The 17 focused unit tests and the disposable PostgreSQL integration test cover signature mismatches, forged/malformed token events, NFT versus token transfers, revert gas, immutable/concurrent intent reservation and restart recovery. TypeScript checking passes. Integration testing creates and drops only a uniquely named test schema; no live journal schema has been installed.

The wallet connection adds five signer tests and reruns the related paper/canary execution tests: **52 focused tests pass**, including error redaction, env isolation, operator matching and key-file handling. The shared fork executor now accepts an explicit operator while preserving its default paper account. These edits have not been deployed to the running sealed paper release.

## Configured wallet checkpoint

At **2026-09-12 12:39:47 UTC**, source block **61,112,945**, the configured wallet had **0 USDG, 0 ETH, 0 NVDA, no position NFTs, zero allowances and latest/pending nonce 0**. Its ownership signature verifies. This is the unfunded baseline; the later funded check is recorded below. Funds must be on [Robinhood Chain, chain ID 4663](https://docs.robinhood.com/chain/connecting/).

At block **61,114,977**, the nine-transaction round trip passed using this exact public address as sender, swap recipient and NFT owner. It returned **249.886204 USDG**, with **0.308713 USDG estimated gas**, for **0.422509 USDG estimated total immediate round-trip cost**. Token receipt deltas and local gas reconcile. Because the real wallet was empty, funding was synthetic on the owned fork; this does not verify a funded mainnet wallet.

A second test seeded **275 USDG** on the local fork and entered through the existing-balance mode. It preserved the starting balances and reserved **25 USDG**, deploying only the configured **250 USDG**. The [test script](../scripts/live-pilot-funded-fork-check.mjs) and [wallet evidence](live-pilot-wallet-2026-09-12.json) retain this distinction.

At **2026-09-12 13:24:38 UTC**, both latest and 64-block-deep reads showed **299.927111 USDG and 0.004907 ETH**, zero NVDA/NFTs and nonce 0. Funding is now present. The funded rehearsal at block **61,142,290** used these real pinned balances without injecting tokens or ETH. It allocated **250 USDG**, left **49.927111 USDG** idle after mint, and completed ten local transactions through withdrawal, sale and allowance cleanup. Receipt token deltas and gas reconcile. The immediate cash shortfall was **0.122000 USDG**, plus **0.316264 USDG estimated Nitro gas**, for **0.438264 USDG estimated total cost**. Only the owned fork received transactions.

This exposed and fixed a local gas-affordability defect: the fixed 8-million gas limit and Anvil's default suggested price reserved **0.008639912008 ETH**, exceeding the real **0.004907 ETH** balance even though the measured transaction was affordable. The operator fork now uses the larger local/Nitro gas estimate with 30% headroom and an explicit checked base-fee price. The first corrected transaction reserved **76,442 gas at 0.09174 gwei**, with no balance injection. Default paper-fixture execution is unchanged. Three regression cases cover the false rejection, rounding and real insufficiency; **39 focused tests and type checking pass**.

The [funded evidence](live-pilot-funded-2026-09-12.json) records one remaining admission caveat: the retry's five-minute chain-recovery check failed continuity/quorum at 13:30:28 UTC, although its source was fresh and the reference gate passed. Mechanical fork checks can run in that state; a real new entry must wait for fresh healthy admission evidence. The legacy `equity_session_closed` diagnostic is not a veto for this continuous strategy. This checkpoint does not mark the live controller or broadcaster ready.

## Rehearsal evidence

See [the compact evidence](live-pilot-250-2026-09-12.json). Full local artifacts, transaction calldata, estimates and hashes are in `data/live-pilot-250-2026-09-12/`. Outputs are timestamped evidence, not reusable live transaction plans.

The first successful current-state rehearsal used block 60,969,727. Its nine transactions returned 249.905781 USDG from 250 USDG. The 0.094219 USDG swap shortfall is already in that cash difference. Pinned Nitro gas estimates totaled 0.000124655520736 ETH, or 0.315029 USDG at the checked ETH/USDG reference. The estimated total immediate round-trip cost was 0.409248 USDG. No holding interval or fee earnings were simulated. Local EVM receipts were reconciled separately from Nitro estimates.

A second source at block 60,973,388 also passed all nine transactions and receipt reconciliation: 249.854299 USDG returned, 0.145701 USDG swap shortfall and 0.321952 USDG estimated gas, for 0.467653 USDG estimated total cost. Costs therefore already vary between these two snapshots; neither is a fixed fee promise. This second run saves the exact preparation config and raw local receipts as well as decoded facts.

Both approximately $250 recenter directions passed at source blocks 60,969,726 → 60,969,727, each using six execution transactions. Their pinned gas estimates were 0.000086129445376 ETH for buying NVDA and 0.000092742066432 ETH for selling NVDA, plus a separately measured potential exit reserve of 0.0000494735288 ETH. The exit preview is not charged as an executed recenter cost.

Actual live transaction receipts and wallet deltas must replace these estimates. Nitro's full gas estimate includes the parent-chain posting component; adding that component again would double count it. [Arbitrum gas-estimation documentation](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas).

Canonical factory, manager, quoter and router addresses match the [official Uniswap Robinhood deployment list](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments). The pilot uses the already rehearsed SwapRouter02 path. Contract identity alone does not prove signing, custody or future execution success.

## Remaining implementation, in order

1. **Persistent live position controller.** Store wallet/NFT snapshots, source and receipt hashes, all old and new NFT IDs, accrued versus collected fees and campaign/session boundaries. Verify receipt block canonicality and the configured 64-block operational confirmation depth before completing each action. This depth is an RPC/quorum convention, not a claim of L1 finality. Reconcile before/after token balances, ETH charges, NFT owner, range, liquidity and tokens owed. Never infer a filled trade from an RPC acknowledgement.
2. **Calldata authorization and broadcast adapter.** The local `.env` signer is connected. Next validate allowed contracts, selectors, recipients, exact approvals, budget, deadlines and slippage independently of signature matching. Reserve nonce against chain and journal state; persist signed bytes first; submit one transaction at a time. Unknown acknowledgement, receipt timeout or process restart must recover the same hash. Do not automatically replace, double-submit a new order, or widen its price limits. A reverted step pauses for reconciliation and consumes its recorded gas budget.
3. **Interrupted-lifecycle recovery.** Inject shutdowns before signing, after signed persistence, after broadcast and after each approval/swap/mint/decrease/collect step. Include dropped acknowledgement, revert, reorg, stale quote, delayed node and unrelated wallet transfer cases. If stopped after withdrawal, retain real withdrawn tokens; after a swap, recompute the mint from real balances; after mint, recover the owned NFT before considering another entry. Recovery must avoid replaying a completed withdrawal or swap. A new recenter supersedes stale plans only after the prior transaction is resolved.
4. **Deployment and fresh launch checks.** Operator identity, funding and the funded-wallet rehearsal are verified. Recheck current balances, allowance inventory, NFT state, pending nonces and healthy chain/reference admission immediately before launch. Reserve enough ETH for entry and a fully costed withdrawal/sell/revoke recovery, using fresh buffered estimates. Install a separate live service and receipt-backed dashboard panel; keep the paper release and scheduled comparison checkpoints intact.
5. **Observed first live lifecycle, then continuous pilot.** Start with the agreed 250 USDG. Verify the real entry/NFT, a natural recenter when its trigger occurs and a complete exit/recovery path before unattended continuation. Keep every transaction, receipt, inventory transition and session-boundary mark. Increase capital only after these checks succeed and observed costs agree with the accounting; a profitable short run is not sufficient execution evidence.

For the live ledger, actual NFT fee growth and collections replace paper fee credits. The real pool already contains the pilot's liquidity, so do not apply the paper dilution adjustment again. Report absolute NAV, alpha versus holding, actual gas, swap shortfall, out-of-range time, recenter latency and errors separately. At $250, fixed gas costs are proportionally larger; execution correctness is the learning objective.

## Reproduce this preparation

```bash
.tools/node/bin/node --import tsx scripts/live-pilot-prepare.mjs data/runtime-refactor.env data/live-pilot-250-new
.tools/node/bin/node --import tsx scripts/live-pilot-recenter-check.mjs data/runtime-refactor.env data/live-pilot-250-new/readiness.json data/live-pilot-250-new/recenter-buy.json buy
.tools/node/bin/node --import tsx scripts/live-pilot-recenter-check.mjs data/runtime-refactor.env data/live-pilot-250-new/readiness.json data/live-pilot-250-new/recenter-sell.json sell
.tools/node/bin/node --import tsx --test test/live-pilot.test.ts
.tools/node/bin/node node_modules/typescript/bin/tsc --noEmit
```

Use a new output directory each time; evidence files are not overwritten. `test/integration/live-pilot-journal.mjs` additionally requires `TEST_DATABASE_URL`; supply it through the private environment without printing credentials. These commands do not start live trading.
