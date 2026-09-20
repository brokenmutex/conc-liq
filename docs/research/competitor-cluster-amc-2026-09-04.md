# AMC two-wallet operator: transaction-complete day audit

Audited September 20, 2026. Research only; no live configuration, signing,
funding, or service changes. This is a different operator from `0x88a0641…`.

## Conclusion

The supplied artifact identifies a real, fee-earning LP cohort, but its central
claim of zero swaps does not survive a complete sender-transaction census.
Do not use it as evidence that composition-matched range shifts eliminate
inventory-rebalancing costs or establish wallet-wide profitability.

| September 4 claim | Receipt/state reconstruction |
| --- | --- |
| 47 AMC positions minted | Confirmed: all 47 were minted to MIN |
| No swaps between LP actions | False: MIN sent 93 transactions containing decoded V3 swaps, 52 touching this AMC pool, with 56 AMC Swap events |
| LP-action receipts contain no swaps | Confirmed for the 137 distinct cohort-action receipts through September 5; this subset omits intervening trades |
| 47 closed positions | At September 5 end, 35 were fully settled and 12 retained on-chain liquidity |
| A sequential drain/remint loop | Multiple positions overlap; peak 13 NFTs with nonzero liquidity, including small residuals; this is not 13 simultaneously in-range positions |
| $2.26m capital cycled | Approximately 2,257,807.60 USDG in deposits marked at each action's pool price, including top-ups; not unique capital or a return denominator |
| $18,034 earned on September 4 | Not a consistent day boundary: the final NFT spans into September 5; the artifact's own chart and lifetime table differ |

MIN: `0xc0051f40abf4b7f9aa1e81d38558d38d4d1ad130`.
RCV: `0xa7b474644912d08210c8962564e2f53fd0a7d5cf`.
Pool: `0xaa34fea710a1a737840329051d81d3b0b7c564d5`.
Manager: `0x73991a25c818bf1f1128deaab1492d45638de0d3`.
Verified pool fee: 3000 (0.30%); spacing: 60.
Token0 is AMC (18 decimals); token1 is USDG (6 decimals).

## Direct swap counterexamples

On September 4 at 04:20:08 UTC, MIN transaction
`0xcadd5f54d4e0215c3cae76212014d29f3563cc62401598e60a3c95da7fa8a303`
contains an AMC-pool swap paying 1,000 USDG and receiving 299.235630348… AMC.

At 04:27:25 UTC, between the first and second NFT mints, MIN transaction
`0xf7894c69d10511080de684785ecb1e7b06bfbf67a51ab5465ccc2ff987a30bf9`
contains an AMC-pool swap paying 4,702.154266 USDG and receiving
1,448.048302782… AMC. Its complete receipt logs independently matched the
official public Robinhood RPC on September 20. Both transactions call
`0x6131b5fae19ea4f9d964eac0408e4408b66337b5`, not the NFT manager.

These pool amounts establish executed trades, not their private purpose or
net profitability. Some gross fees can return to the operator's own LPs;
gross LP fees therefore must not be counted as wholly external earnings without
attributing the operator's own swaps. No wash-trading intent is inferred.

## Partial withdrawals and inventory

There are 73 liquidity additions and 61 nonzero/recorded Burn actions across
the 47 NFTs in the two-day window. Seven NFTs retain exactly 1% of all liquidity
added; five retain other fractions. All 12 remaining-liquidity balances match
archival manager state. Whether retaining these small positions is intentional
or incidental is unknown.

For example, NFT 1019791's first withdrawal is at 15:06:43 on September 4,
but another much larger withdrawal occurs at 15:45:28 and residual liquidity
still remains at the audit boundary. A first withdrawal is not a full close.
Of the 35 fully settled NFTs, ten final withdrawals were in range. Across all
47 NFTs, 14 first withdrawals were in range under exact pre-event ticks.
These different denominators should not be collapsed into an inferred trigger.

NFT 1027499 was minted September 4 at 23:37:34 and fully withdrawn September 5
at 12:16:03. It had four additions. Its lifetime fees, marked at range center,
are 2,662.79 USDG, but only 359.14 of that center-marked accrual belongs before
September 5 midnight. Do not attribute its full lifetime fees to September 4.

Four USDG transfers directly connect the wallets on September 4: MIN sends
50,000 and 30,000; RCV returns 40,000 and 39,000. Another 3,000 goes MIN to RCV
on September 5. This supports treating the wallets jointly for accounting,
without proving common beneficial ownership. RCV has no mint in this AMC cohort,
but has a different NFT mint and other transactions; it is not simply inert.

## What the fee numbers establish

Fees are reconstructed as actual core-pool collections minus withdrawn
principal, plus boundary tokens owed and uncheckpointed fee growth. Remaining
principal is separate. Every nonzero collection is matched to an actual ERC-20
payment; manager-requested amounts are not substituted for actual transfers.

For these 47 September 4 births:

| Accrual boundary | Marking convention | Gross fee value, USDG |
| --- | --- | ---: |
| September 4 end | Each NFT's fixed tick-center price | 15,614.74 |
| September 4 end | Common midnight pool price | 15,140.01 |
| September 5 end | Each NFT's fixed tick-center price | 17,923.25 |
| September 5 end | Common boundary pool price | 17,159.70 |

These are alternative valuations of token fees, not four different cash earnings
and not independent-reference net P&L. The artifact was extracted September 19;
residual positions can accrue after this audit's September 5 cutoff. Consequently
its fee discrepancy cannot all be attributed to arithmetic error.

The fully settled 35-NFT subset has +5,793.86 USDG of contemporaneous pool-marked
deposit/collection cashflow P&L before gas. It excludes the 12 residual positions,
wallet swaps, other pools/assets, and external funding. It is a selected subset,
not cluster net profit, independent alpha, or a prediction for a $250 account.

## Coverage and reproducibility

The census covers both wallets over September 4–5 UTC: all 498 MIN originating
transactions (nonces 734–1231) and all ten RCV transactions (nonces 0–9).
Missing nonces from LP/token event discovery were located by archival nonce
bisection and full block lookup. Both addresses are EOAs at the window boundaries.
There are 513 captured receipts and 700 relevant AMC/USDG transfers. Both wallets'
opening balances plus transfers reconcile exactly to both subsequent boundaries.

Boundary blocks, immediately before the respective midnight:

- September 4: 53,821,288.
- September 5: 54,675,543.
- September 6: 55,532,249.

Exact hashes are pinned in the compact evidence file. Boundary hashes are checked
fresh before and after capture, and receipt block hashes match captured headers.
This census does not establish complete coverage of transactions initiated by
third parties on behalf of the wallets, off-chain hedges, or other assets' NAV.

Reproduce from repository root with Node 24 and an archival RPC environment:

```sh
.tools/node/bin/node --import tsx scripts/research/competitor-cluster-day.mjs \
  data/runtime-refactor.env data/competitor-cluster-amc-2026-09-04
```

The environment path is a local example; never publish its contents. Cached RPC
payloads contain public method/parameters/results, not endpoint URLs. Public raw
capture, per-position evidence, and RPC cache are in that ignored output directory.
The tracked compact evidence records capture and code hashes:
[`competitor-cluster-amc-2026-09-04.json`](../../research/evidence/competitor-cluster-amc-2026-09-04.json).
Ignored raw captures remain dependent on local storage; hashes alone are not an
off-host archive. This is a bounded single-case audit, not generalized tooling.

## Consequences for our $250 research

Keep the previously implemented inventory-preserving challenger as an independent
hypothesis, not a replica of this operator. Do not promote it based on this artifact.
This audit changes the next comparison, not live execution settings:

1. Compare keep-position, inventory-only remint, and remint with an optional
   minimal inventory swap. Fixed and adaptive widths should face the same costs,
   forecast inputs, inventory constraints, latency, and passive benchmark.
2. Require the incremental benefit over keeping to exceed gas, swap fees,
   slippage/adverse-selection allowance, and the safety buffer. No mandatory
   50/50 reset; retain idle tokens and price every remaining position.
3. Separate allocation from range choice: top-ups, partial removals, concurrent
   ranges, and portfolio reserves are observable here. Do not imitate 47 mints
   with $250 or assume the operator's much larger inventory is available to us.
4. Evaluate off-hours and market hours separately on held-out dates. Quiet prices
   alone do not establish profitability: fee-paying flow can also disappear.
   Keep independent-price, freshness, inventory and loss-limit gates intact.
5. Before considering a live candidate, require prospective shadow results with
   complete terminal NAV, passive alpha, drawdown, residual inventory, gas,
   swap costs, and downtime. Exact swap cost attribution and independent-reference
   whole-cluster P&L remain unfinished for this competitor.

The artifact's LP-direction explanation is also reversed. With AMC as token0,
a rise in USDG per AMC sells AMC out of the LP; a fall accumulates AMC. Removing
liquidity early preserves the composition at withdrawal, not the entry mix,
and does not erase existing divergence loss. See the primary
[Uniswap v3 whitepaper, sections 2 and 6](https://app.uniswap.org/whitepaper-v3.pdf).
