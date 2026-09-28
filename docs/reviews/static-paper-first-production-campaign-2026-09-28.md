# First production static paper campaign — September 28

The operator's “go” continued the [sealed release follow-up](static-paper-freshness-followup-2026-09-27.md)
into a production paper browser demonstration. One campaign completed setup,
open, later canonical valuation, pause/resume and retain-close. The assistant
operated the real public browser UI under that instruction; this is not a
claim that a human independently completed a usability session.

The run also exposed a default gas-allocation weakness. The first draft stayed
unopened; a replacement completed with an explicitly entered simulated native
allocation. This demonstrates the supported workflow with that adjustment,
not reliable completion using every suggested default.

## Runtime and scope

Command, paper worker and dashboard remained on source `cfc8043`, sealed
`bf4dcea90d07aa70acb3757b7efc6aa161a5c3ce4b945699891f2c399affcb54`.
The shared command/worker file and config hashes still match the September 27
record; executable, working directory, arguments, unit hashes and the worker
readiness lease were rechecked. Tail remained on `cda961d0…`. All four services
were active with zero recorded restarts. No service, configuration or schema
change was made during the campaign.

The browser used `https://dear-foxhound.tail106f9e.ts.net/operator`, existing
AAPL/USDG profile `a8e7096f-17c3-452c-a72f-8fa962e586d2`, 250 USDG simulated token
capital and a centered half-width of 40 ticks. The synthetic paper wallet
identity was `0x1111111111111111111111111111111111111111`; no key or wallet funding
was supplied. All suggested risk/cost limits stayed unchanged. The production
store was observed through a connection forced read-only; all setup, draft and
operation requests went through browser controls and the deployed command API.
No signing, broadcast, manual model import, campaign SQL mutation or manually
seeded draft was used. Normal server-owned fork calibration did persist its
provisional profiles.

## Default allocation failure

Draft `966580a8-28dd-4ae9-ad4c-c1a23fa02937` saved at **06:37:09 UTC**. Its suggested
native allocation was **0.001018983684235**, exactly the 0.001 exit reserve plus
18,983,684,235,000 wei of reviewed opening gas bound. Setup gas price was
20,036,000 wei. The subsequent open preview returned HTTP 409
`paper_open_model_unavailable`; no operation was accepted.

A later read-only probe using the deployed model builder, this saved draft and
an imported profile's canonical source reproduced the more specific
`paper_open_cost_or_reserve_limit`. At gas price 20,316,000 wei, the required
opening bound was 19,267,262,685,000 wei: **283,578,450,000 wei** more than the
saved allocation allowed after preserving the exit reserve. This is a fresh
read-only reproduction of the gas sensitivity, not an exact replay of the
first failure's uncaptured gas-price response.

A normal browser refresh produced one valid saved preview at **06:41:28 UTC**
with gas price 20,002,000 wei and opening bound 18,969,471,757,500 wei. It arrived
after the initial browser runner's existing preview wait expired at 06:41:10;
no acceptance followed. A new browser session loaded the same saved draft and
requested another preview at 06:43:23; that returned the same generic 409.
The original draft remains revision 1, with zero operations, marks or wallet
reservations. There is no supported allocation-edit control on its saved-draft
card. Its history was retained rather than altered.

The isolated canonical fixture's 10-native allocation had substantial reserve
headroom. Its success therefore did not exercise the default suggestion at
this exact boundary.

## Completed production campaign

The replacement used the same normal setup UI, capital, range, wallet identity
and policy limits, with **0.0011 simulated native units** entered in the editable
gas-allocation field. Its automatic suggestion was 0.0010191722335. No acceptance
predicate, source freshness limit or cost bound was relaxed.

Campaign: **`9d340398-e5fa-4aff-adf1-e47b46f85b13`**.

| Event | Persisted result |
| --- | --- |
| Draft saved | 06:45:28 UTC, revision 1 |
| Open | `c4863e5a-4303-4ed2-83c4-6e1e98e19216`; `paper_open_recorded` at 06:45:34 UTC; source 74592656 |
| Later valuation | Mark 2, source 74593516, `paper_model_principal_valuation` |
| Pause | `99e099cc-a6f2-478f-93fd-90a97e9fc83a`; `paper_paused` |
| Resume | `44ccdcb7-5b8c-4bd6-974f-5f86f2050617`; `paper_resumed` |
| Retain-close | `eb98df74-27d7-4528-b551-0f9d8841aab2`; `paper_close_retain_recorded` at 06:47:06 UTC; source 74593582 |

All four operations succeeded on their first worker attempt. Exactly one open
mark, one later valuation and one terminal mark were present. The six gas
profiles were provisional `fork_estimated` evidence with one report identity.
There were no `gas_paid` rows. The three capital-in and three capital-out rows
preserve the accounting boundary; unavailable exit values are null.

The first-session API baseline was **252.899985 reference USD**, matching the
persisted capital-in ledger after its display-unit conversion. It includes
the initial tokens plus allocated native gas; it is not just the 250 USDG token
budget. Closed retained principal lower bounds were:

- USDG: **123.565814**.
- AAPL: **0.371370420484973499**.

Both exactly match the terminal mark and the local/public Positions APIs.
Full token balances, native balance, fee capture, paid costs and net economics
remain unavailable. The lower-bound value is not settled NAV or a net-loss
claim. The dashboard explicitly preserves those gaps.

Desktop 1440px and mobile 390px closed history displayed the same operation
stages, three marks, retained lower bounds and unavailable labels. No browser
JavaScript exception or required JS/CSS asset failure occurred; the previously
recorded optional favicon 404 remained. Local dashboard and public Funnel
position-detail endpoints both returned HTTP 200 with the same terminal
operation, inventory and five activity events.

Final production counts: **one closed campaign, one unopened draft, four
successful operations, three marks, zero wallet reservations and zero paid-gas
rows**. No active/paused campaign remains. Browser child processes were cleaned
up; production journals and both drafts/campaign records were retained.

## Next bounded work

Before calling the default setup repeatable, improve the native allocation
suggestion to include clearly labeled headroom for repricing between setup and
open. Keep the exit reserve and fresh acceptance checks unchanged. Surface a
specific safe insufficient-reserve reason instead of the generic model error.
Add a focused regression for gas rising between review and open and a browser
case using a realistic suggested native allocation instead of the fixture's
10 native units. Capture success and fail-closed behavior beyond the chosen
headroom. Reuse existing setup and open flows; do not add a generalized draft
management system or relax policy limits for this repair.

RangeKeeper paper and live capabilities remain disabled. This run is a short
production workflow demonstration, not a fee, profitability or strategy-quality
experiment; independent human usability assessment remains separate.

Private evidence: `data/static-paper-first-campaign-2026-09-28/`, including
initial/resumed failure records, `profile-frame-probe.json`,
`buffered-result.json`, `summary.json`, `runtime-inputs.json`,
`closed-api-parity.json` and setup/active/closed screenshots. The successful
browser runner used only normal UI mutations and read-only database assertions;
its records are persistent production paper evidence, not disposable fixtures.
