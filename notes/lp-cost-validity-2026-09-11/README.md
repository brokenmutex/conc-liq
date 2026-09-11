# Are LP income and cost estimates correct? — September 11, 2026

**The checked arithmetic is consistent; the gas calibration is the largest weakness.** Fee income and swap balances reconcile to the implemented model, without a detected double deduction of swap fees or parent-chain gas. But the recenter cost probes came from much more expensive gas conditions than the median saved campaign operation. They should be treated as historical scenarios, not representative prices for every off-hours decision.

This audit reruns the original nine-policy comparison with separate fee/swap diagnostics and then tests common gas-price regimes. It changes no paper setting, frozen weekend plan, or production service.

## Earned fees

The research model reconstructs canonical swap steps, charges the configured 500-pip pool fee, subtracts any protocol share, allocates LP fees only where the position overlaps the step, and divides by historical liquidity **plus our added liquidity**. Integer Q128 remainders are retained. No income is accrued while flat or entirely outside the range. This follows the mechanics described in the [Uniswap fee documentation](https://developers.uniswap.org/docs/get-started/concepts/fees); this pool's fee-500 setting means **0.05%**, not 0.5%.

The audit replay produced **exactly the same original accounting fields and actions**. Its separate accrued-fee calculation exactly matched reported fees for every replayed window and candidate. None of the three qualifying windows required an approximate clipped fee segment: all checked fee segments had complete boundary coverage.

The running paper convention uses the observed inside fee-growth increment without dilution for the hypothetical extra LP. Research uses dilution. On the same actions in the three complete windows:

| 80% cap policy | Diluted research income | Undiluted convention | Difference |
|---|---:|---:|---:|
| Hold range | 6.610951 | 6.620786 | 0.009835 |
| Preserve tokens | 7.640101 | 7.650399 | 0.010298 |
| Net swap | 10.899553 | 10.916167 | 0.016614 |

Values are USDG, marked as fees accrue. Undiluted income is roughly 0.13–0.15% higher here. The maximum added LP liquidity divided by historical active liquidity across the complete audited candidates was about **0.2545%**. The dilution difference is therefore small in this sample; it is not a universal bound after liquidity changes.

Earlier repository evidence also reconciles observed global/tick/position accounting and recorded paper ledgers: [management accounting audit](../lp-management-audit-2026-09-09/README.md). Agreement with recorded paper values checks accounting consistency, not realized strategy returns.

**Counterfactual limitation:** inserting an LP can change prices, routing and future trade flow. The model retains the recorded path and trade flow. It has not proven that a real added position would earn precisely these fees. The exit/recenter fork restores estimated fee claims into a hypothetical NFT, so successful collection proves the restoration/collection arithmetic, not that the fees were independently earned by that NFT. Fee estimates are also marked income, not necessarily immediately collected USDG.

## Swap fee, impact and slippage

Every successful modeled buy/sell uses integer v3 swap-step math against historical depth. The returned output already incorporates the pool fee and own-trade price impact. These lower outputs feed inventory and final cash, so **subtracting swap fees again from P&L would double count them**.

The configured **50 basis points / 0.5%** is a slippage acceptance bound, not an additional 0.5% charge. The model does not automatically deduct that tolerance. Frozen quote minimums and delayed fills remain separate constraints. Previously executed buy and sell fork cases reproduce swap output, mint amounts and residual balances.

The new diagnostic [swap ledger](swap-ledger.csv) itemizes costs already embedded in balances. Across the three complete windows at the 80% cap:

| Policy | Swap fees paid | Additional own-trade impact versus spot |
|---|---:|---:|
| Hold range | 1.852108 | 0.008002 |
| Preserve tokens | 2.743527 | 0.014484 |
| Net swap | 4.171325 | 0.015687 |

USDG totals, valued at each source's pool price. Preserve still pays for full exits and new entries; only its range moves avoid swaps. The impact diagnostic subtracts the input-fee value from output shortfall and clips rounding noise at zero. It measures depth impact at the fill source, not all quote-to-fill price movement or adverse selection.

Fees earned, gas, swap fees and price impact do **not** by themselves explain all P&L. Changing inventory values, price exposure and entry/exit timing remain part of portfolio performance. The aggregate fee display values earnings as they accrue, while final NAV values residual tokens at its endpoint or liquidation.

## Gas formula versus calibration

The saved estimate is `eth_estimateGas × NodeInterface baseFee`, converted from native ETH into USDG using the recorded ETH/USD and USDG/USD oracle answers. Parent gas is already included in the total; it is not added twice. [Arbitrum's gas-estimation documentation](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas) describes this combined fee and explicitly distinguishes estimates from actual fees.

For **52 campaign entries and 52 exits**, plus four recenter/exit probes, the audit checked:

- Total gas times quoted price equals the recorded native estimate.
- Parent plus execution components equal the total exactly.
- Entry accounting includes only entry transactions, not the exit preview also stored in the round-trip result.
- Transaction sums equal the charged entry/exit estimate.
- ETH/USDG unit conversion agrees with an independent integer expression.
- Per-component rounding differs from conversion of the whole bundle by less than one micro-USDG per transaction.

Parent estimates are zero in those selected samples. Stored actual third-party receipts can have nonzero parent costs; the audit does not assume parent fees stay zero.

| Saved campaign estimate | Minimum | Median | Maximum |
|---|---:|---:|---:|
| Entry cost, USDG | 0.237331 | 0.415126 | 1.874838 |
| Exit cost, USDG | 0.162201 | 0.281354 | 0.635029 |
| Entry quoted gas price, gwei | 0.117536 | 0.199992 | 0.915438 |
| Exit quoted gas price, gwei | 0.117610 | 0.198373 | 0.465256 |

These are successful saved paper estimates across the campaign, not a distribution of costs paid by our strategy or an off-hours-only forecast. The original comparison's 0.868343 entry and 0.182625 exit were individual snapshots.

The recenter probes were much more expensive:

| Probe | Quoted gwei | Node estimate, USDG | Anvil gas units priced at the same quoted rate |
|---|---:|---:|---:|
| Net buy move | 0.757854 | 1.838572 | 1.744207 |
| Net sell move | 0.821944 | 2.032078 | 1.929163 |
| No-swap move | 0.821944 | 1.469617 | 1.386557 |

Node-estimated gas units exceed local execution gas by about 5–6% in those recenter probes. Campaign median differences are about 2.3% for entry and 11.7% for exit. **Anvil receipts are not live Nitro gas receipts**, so those differences are diagnostics, not a justified automatic discount. The much larger issue is using roughly 0.8-gwei snapshots across a campaign whose median quoted gas price was about 0.2 gwei.

A fresh read of three pinned sources verified their hashes. NodeInterface's quoted fee matched the **next block's** header fee in all three cases, rather than the source block's already-used fee. The source-to-next differences were about 0.06–0.41%. These small differences are consistent with pricing the next execution; they do not explain the fourfold difference between gas regimes. Raw header checks are in [summary.json](summary.json).

The database also has 511 third-party `rebalance_bundle` receipt observations, with median total gas of 747,806. Their calldata, approvals, inventory, token mix, prices and batching differ from our separate-call workflow. They are a sanity-check population, not interchangeable costs for our action bundle. [Receipt summary](receipt-summary.json).

## Repricing every action at a common gas price

The prior comparison included high historical recenter costs, double-gas stress and a shared-component control, but it had not tested the lower observed gas regime. This audit now does.

It retains recorded node-estimated action gas units, uses one common ETH/USDG valuation, and prices **entry, exit, approvals, swaps and mint operations at the same gas price within each scenario**. All strategy decisions are replayed; it does not merely refund gas after the fact. Fee income remains at the full modeled level. Parent estimates were zero for the selected basis; future nonzero posting costs would need separate treatment.

Mean net P&L per complete window at the **80% cap**, USDG:

| Common gas price | Hold range | Preserve tokens | Net-swap recenter | Net-swap difference versus hold |
|---|---:|---:|---:|---:|
| 0.12 gwei | −1.157289 | −2.137154 | −1.497100 | −0.339810 |
| 0.20 gwei | −1.512033 | −3.532051 | −2.740670 | −1.228638 |
| 0.82 gwei | −4.261298 | −12.268099 | −12.378325 | −8.117027 |

The original mixed-snapshot profile had shown −2.025651 versus −9.052077 for hold and net-swap at 80%. Thus **the magnitude of the estimated recenter loss was strongly gas-regime dependent**. The trigger still underperforms on average at the lower common prices tested, but the difference is much smaller. This is a sensitivity check, not proof that every historical action could have executed at 0.12 or 0.20 gwei. There are still only three complete correlated windows and no complete weekend here.

The full [gas-regime sensitivity](gas-regime-sensitivity.json) includes all nine policies at all three prices. Inventory-cap ranking is also cost dependent; no optimal cap or universal rejection of recentering follows from this sample.

## What remains to calibrate

1. **Decision-time gas:** obtain node gas units, quoted native gas price and parent component for the proposed action at the decision source. Keep those components separate, with same-source valuation and bundle shape, instead of reusing a single USDG charge across dates.
2. **Estimate versus receipt:** calibrate matched transaction shapes against observed Nitro receipts. Local gas, third-party class medians and node estimates must remain distinguishable. Bundling or different allowance handling can change costs and needs its own executable proof.
3. **Failure paths:** no submitted transaction means no chain fee, so a preflight rejection correctly costs zero chain gas. A partially executed or reverted submitted bundle can incur costs; the atomic recenter model currently omits those fees and residual exposure. This is optimistic for recentering.
4. **Fee economics:** retain canonical fee reconciliation and dilution, and test added-liquidity effects on trades and execution. Counterfactual fee income cannot be promoted to realized income by collecting an injected fee claim on a restored fork NFT.

The immediate research priority is calibration at the action source, before further parameter optimization. No signer/broadcast behavior, paper policy or frozen prospective comparison was changed by this audit.

## Artifacts and verification

[Summary](summary.json), [gas audit](gas-audit.json), [swap ledger](swap-ledger.csv), and [gas sensitivity](gas-regime-sensitivity.json) preserve the evidence. Raw paper execution captures, full diagnostic replay and sensitivity replay remain under `/root/conc-liq/data/lp-cost-validity-2026-09-11/`, with hashes referenced in the summary. The three scripts added for this audit reproduce gas arithmetic, fee/swap decomposition and gas-price sensitivity without mutating the frozen model.

The original replay's fields and actions matched exactly. Fee totals, swap diagnostics, gas conservation and repriced aggregate arithmetic were checked. **28 focused tests passed**, covering gas components, fee remainders, outside-range handling, fee restoration, swap/mint fork matches, no double counting, delayed fills and recenter cap priority. Source hashes and next-block gas prices were checked with bounded read-only RPC calls. Typecheck and Git whitespace checks passed.
