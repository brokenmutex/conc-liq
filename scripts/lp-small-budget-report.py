"""Package the completed small-budget experiment without publishing raw runtime state."""
import csv, hashlib, json, shutil, sys
from pathlib import Path
from datetime import datetime, timezone
root=Path(sys.argv[1]);out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
read=lambda p:json.loads(p.read_text())
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert digest(root/'plan.json')=='fbc024440c0655fc8d01fa3fca56ef9fe347a66214ead1b4e9b972061a118e85', 'Narrative is bound to the frozen September 13 plan; review it for a new experiment.'
plan=read(root/'plan.json');screen=read(root/'screen.json');refs=read(root/'references.json');cal=read(root/'calibration.json');receipts=read(root/'receipt-verification.json')
assert receipts['receiptBlocksCanonical'] and receipts['receiptGasMatches']
assert receipts['ledgerSha256']==cal['sourceSha256']
raw=[]
for s in plan['symbols']:
    run=read(root/'runs'/f'{s}.json')
    for row in run['rows']:
        # Detailed action/score evidence stays in the hashed runtime artifact.
        row.pop('actions',None);row.pop('economicScores',None)
    raw.append(run)
for r in raw:
    assert r['planSha256']==digest(root/'plan.json')
    assert all(r['verification'][k] for k in ['canonicalEnd','allActionBalances','allStageGas','allFeeTokens'])
rows=[row for r in raw for row in r['rows']]
fields=['symbol','budget','scenario','name','allInInitialQuote','allInTerminalQuote','netPnlQuote','alphaQuote','feesQuote','gasPaidQuote','totalGasWithExitQuote','entries','recenters','recenterAttempts','partialFailures','gasBudgetStop','closedAt','outsideMs','holdingMs','averageRiskyExposurePpm','feesAbove10PercentExistingQuote','unavailableMarks','invalid','terminalExecutable']
def csv_write(path,fields,rows):
    with path.open('w') as f:
        w=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore');w.writeheader();w.writerows(rows)
csv_write(out/'results.csv',fields,rows)
refmap={r['pool']:r['reference'] for r in refs['rows']}
screenrows=[]
for r in screen['rows']:
    p=next((p for p in r['probes'] if p['budgetQuote']=='240000000'),{})
    ref=refmap.get(r['pool'],{})
    screenrows.append(dict(symbol=r['symbol'],pool=r['pool'],fee=r['fee'],spacing=r['spacing'],capacityPass=r['capacityPass'],replayCompatible=r['originalReplayCompatible'],referenceEligible=ref.get('eligible'),reasons=';'.join(r['reasons']),referenceReasons=';'.join(ref.get('reasons',[])),buyShortfallPpm=p.get('buyShortfallPpm'),sellShortfallPpm=p.get('sellShortfallPpm'),testedHalfWidths=';'.join(str(w['width']) for w in r['widths'])))
csv_write(out/'universe.csv',list(screenrows[0]),screenrows)
for name in ['plan.json','screen.json','references.json','calibration.json','receipt-verification.json','prepared.json']:
    shutil.copyfile(root/name,out/name)
verification=dict(portfolios=len(rows),actions=sum(r['verification']['actionCount'] for r in raw),canonicalEnds=True,actionInventoryReconstructed=True,feeTokensReconstructed=True,gasReconciled=True,liveReceiptsVerified=len(receipts['rows']),runs=[dict(symbol=r['symbol'],firstAvailableAt=r['firstAvailableAt'],lastSourceAt=r['lastSourceAt'],emptyLiquidityBlocks=r['emptyLiquidityBlocks'],sha256=digest(root/'runs'/f"{r['symbol']}.json")) for r in raw])
(out/'verification.json').write_text(json.dumps(verification,indent=2)+'\n')
lookup={(r['symbol'],r['budget'],r['scenario'],r['name']):r for r in rows}
money=lambda v:'N/A' if v is None else f'{int(v)/1e6:+.2f}'
table=[]
for s in plan['symbols']:
    for n in ['fixed_20','fixed_80','fixed_160','adaptive_economic']:
        a=lookup[s,'all_in_250','receipt_median',n];b=lookup[s,'all_in_250','double_gas_half_fees',n];c=lookup[s,'all_in_250','receipt_p90_delay',n]
        table.append(f"| {s} | {n} | {money(a['netPnlQuote'])} | {money(a['alphaQuote'])} | {money(b['netPnlQuote'])} | {money(c['netPnlQuote'])} | {a['recenters']} | {int(a['totalGasWithExitQuote'])/1e6:.2f} | {'Yes' if a['gasBudgetStop'] else 'No'} |")
passed=[r for r in screenrows if r['capacityPass']];referencepassed=[r for r in passed if r['referenceEligible']]
stamp=datetime.fromtimestamp(int(screen['anchor']['timestamp']),timezone.utc).isoformat()
behavior=[]
for s in plan['symbols']:
    for n in ['fixed_80','adaptive_economic']:
        r=lookup[s,'all_in_250','receipt_median',n]
        outside=100*int(r['outsideMs'])/max(1,int(r['holdingMs']))
        participation=100*int(r['feesAbove10PercentExistingQuote'])/max(1,int(r['feesQuote']))
        behavior.append(f"| {s} | {n} | {outside:.2f}% | {int(r['averageRiskyExposurePpm'])/10000:.2f}% | {participation:.2f}% |")
body=f'''# Small-budget asset comparison — 13 September 2026

This is a bounded follow-up to the twelve-asset study: screen at our actual size, compare the previously named AAPL/QQQ shortlist with NVDA on identical dates, and replace the original atomic action with staged withdrawal/swap/mint sensitivities calibrated to live receipts. It does not choose a deployable winner from every pool that passes the screen. The live campaign and deployed policy were not changed.

**The matched evidence prioritizes AAPL for the next small-budget prospective validation.** At fixed ±80, its all-in-250 modeled P&L is +38.32 USDG versus NVDA's +3.81; under double gas and half fees it is +0.42 versus −7.19. At ±160, AAPL is +20.21 base / +1.78 stressed, versus NVDA +4.56 / −5.11. QQQ is stronger at ±80 (+50.49 / +16.88), but its current reference check fails. These are conditional model outcomes, not a recommendation to move the live wallet immediately.

The same-date comparison changes the explanation: AAPL ±80 recenters **35 times versus NVDA's 33**, and pays **7.95 versus 7.12 USDG** gas. Its advantage comes from modeled fees and inventory evolution, not fewer interventions. This corrects the impression from comparing different available historical periods in the earlier study.

AAPL's fixed-width stressed gains are thin and both ±80/±160 trail passive holding in that scenario. Its economic-gate candidate retains +8.24 absolute P&L and +3.87 versus holding under stress, but makes no recenter then; at base it spends 85.72% of its invested time outside range. NVDA's gate never recenters in any all-in scenario and spends 87.58% outside at base. Those outcomes do not validate the continuously managed LP behavior the project seeks.

The next candidate comparison should therefore use AAPL at the actual remaining capital, keep ±80/±160 and the gate as separate prospective controls, and retain the explicit gas allowance. Asset-specific execution validation and forward observed fees remain necessary before changing the live asset or choosing a width. QQQ should be reconsidered only after a fresh reference passes the existing rule. No capital increase, live configuration change or transaction was made by this experiment.

## Capacity and reference screen

At block {screen['anchor']['block']} ({stamp}), **{len(passed)} pools across {len({r['symbol'] for r in passed})} symbols** pass independent half-budget buy and sell probes within 50 bps. All 306 V3/USDG pools in the retained September 13 catalogue were checked at that new pinned block. No ±20-width requirement is imposed. The 12 fee-500 pools from the original study remain the only compatible pools passing; 55 passing pools use fee 3000 and tick spacing 60. Their tested half-widths are rounded to 120/180 ticks. They need different fee-tier replay validation and asset-specific lifecycle evidence, and are not assigned invented returns.

The refreshed token/reference evaluation passes **{len(referencepassed)} pool rows across {len({r['symbol'] for r in referencepassed})} symbols**. AAPL and NVDA pass; QQQ still fails `paper_equity_reference_age_unacceptable`. Current reference eligibility is not historical eligibility or complete live admission. BABA, MU and TTWO fee-500 pools still fail at the smaller size. Higher fee-tier pools for those names are separate markets.

The buy and sell quotes use half the allocation at the same canonical state. They are independent capacity probes, not a sequential round trip or an exact future position exit. The pinned prices, raw amounts, width/share diagnostics and all exclusions are preserved in [screen.json](screen.json), [universe.csv](universe.csv) and [references.json](references.json). The catalogue is not refreshed for pools created after its earlier September 13 anchor; current-state selection retains retrospective availability bias.

## Receipt calibration and mechanics

Fresh canonical reads verify **{len(receipts['rows'])} live NVDA receipts**, their log arrays, gas-used × effective-price, and recorded USDG conversions. Their total is **{int(receipts['gasQuote'])/1e6:.6f} USDG**, including reverted transactions. Conversion arithmetic is independently recomputed from retained receipt-block oracle proofs; this check does not independently refetch every historical oracle answer.

There are seven completed entry episodes, eight completed recenter episodes and seven closed exit phases. Median recenter cost is **{cal['groups']['recenter']['gasQuote']['median']/1e6:.6f} USDG** and median time from phase entry through controller completion is **{cal['groups']['recenter']['durationMs']['median']/1000:.2f} seconds**. The longest completed recenter, including a halted mint recovery, took **{cal['groups']['recenter']['durationMs']['max']/1000:.2f} seconds**. Interrupted episodes are retained separately in [calibration.json](calibration.json). Receipt inclusion times drive modeled stages; controller-completion durations are reported separately.

A post-calibration scope check finds that only five of those seven exit phases include a withdrawal; two start from already released inventory. The frozen mixed-phase median exit cost is 0.137496 USDG, versus 0.160402 for the five withdrawal-containing exits. The p90 exit cost is 0.313017 in either group. The base exit allowance is therefore an approximate, somewhat lower cost scenario, not a full-exit-only empirical median. Results are retained without outcome-driven retuning; changing that allowance can change both terminal cost and the gas-budget stop boundary. The higher-cost scenarios are sensitivities, not a proof that every possible exit cost is covered.

Fresh isolated forks complete 240-USDG, ±80-tick entry, restored exit and recenter for AAPL, QQQ and NVDA. The observed NVDA receipt-cost distribution sets the cost level. Each other asset is scaled by its same-block fork gas ratio to NVDA; passive buy/sell costs use the corresponding fork stage ratio. This is an explicit transfer assumption, not observed live AAPL/QQQ gas. Widths and the 250-USDG comparison reuse those 240-USDG measurements.

## Matched comparison

All 72 portfolios use **August 30 00:00–September 11 19:30 UTC**, six hours of warmup and identical forecast-availability requirements. Initial capital and inventory do not reset during the window. The three entry boundaries and last source times are in [verification.json](verification.json). There were {sum(r['emptyLiquidityBlocks'] for r in raw)} empty-liquidity event-block marks in the evaluated three-asset window.

The primary budget is **240 USDG of deployable inventory plus 10 USDG of gas purchasing power**. Before beginning another entry/recenter, the model reserves the full bundle and a full exit. If that exceeds the remaining gas allowance, it attempts liquidation and stops further entry. Missing exit capacity stays unavailable. Gas charges are deducted from NAV and the initial reserve is added back only once; it is not extra spending capital. A separate `250_plus_gas` comparison retains the old budget convention and is not a feasible all-in-250 campaign when gas exceeds the additional allowance.

The base uses median live cost estimates and a representative median-ranked episode's staged delays. The p90 scenario uses p90 gas estimates and a representative p90-ranked episode's delays, including the observed long mint recovery. The third scenario doubles median gas and halves modeled fee credits. These are sensitivity assumptions, not probability-weighted forecasts.

**All-in-250 modeled results, USDG:**

| Asset | Policy | Base P&L | Base vs holding | 2× gas / ½ fees P&L | P90 cost/delay P&L | Base recenters | Base gas incl. exit | Gas-budget stop |
|---|---|---:|---:|---:|---:|---:|---:|---|
{chr(10).join(table)}

`fixed_80` and `fixed_160` mean approximately ±0.8% and ±1.6%; `adaptive_economic` selects among ±20/40/80/160 with the economic gate. P&L is after modeled costs versus initial capital; alpha compares with a half-stock/half-USDG passive allocation plus the same gas reserve. Cash waiting, changed inventory exposure and early gas-budget stops can change alpha independently of width-selection skill. These are unannualized conditional historical outcomes, not executable return promises.

Full results for both budget conventions, every scenario, fees, gas, failed mint attempts, liquidity participation and exit status are in [results.csv](results.csv). Parameters and selection were fixed before inspecting these new matched-window results; the period itself was already used in earlier research and is not an untouched holdout.

The base-case behavior matters when interpreting an economic-gate win:

| Asset | Policy | Time outside range while invested | Average stock / net LP component | Fees earned while ours >10% of existing liquidity |
|---|---|---:|---:|---:|
{chr(10).join(behavior)}

The stock ratio uses the replay's deployed-inventory component after gas, excluding the separate initial gas reserve. Time outside range excludes intervals without a position. A gate can save costs by leaving a one-sided position inactive for long periods; that is not evidence of continuously productive LP management. A low liquidity-participation ratio reduces one concern about the fixed-flow assumption but is not an error bound or proof of achievable fees.

## What the revised replay fixes, and what it still assumes

- Withdrawal removes the position before the following swap and mint delays. Fees stop accruing during that interval. The swap spends actual withdrawn inventory; a failed mint preserves the resulting tokens through a ten-minute cooldown. Recovery never replays an already completed balancing swap within that attempt.
- Economic-gate decisions are rechecked before withdrawal. Every policy uses the same forecast-availability requirement. Empty canonical liquidity suppresses decisions and valuation rather than declaring capital exhausted from a boundary price; no independent historical price series is invented.
- The original ten-minute width forecast is retained and does not explicitly price in the staged completion delay. The replay subtracts the resulting missed fees from actual modeled earnings. The long p90 mint delay can outlast the forecast horizon, so this is a test of the existing decision rule under latency rather than a latency-optimized policy.
- Stage gas is charged even on rejected swap/mint preflight as an adverse attempt-cost scenario. This is not a literal count of broadcasts. Mint uses a fresh quote from current held inventory and the previously chosen range; a further quote-to-inclusion delay and real mint-minimum reverts are not fully simulated.
- Gas-budget exits and terminal exits are priced at their decision source. Their wall-clock execution delay, approval sequence and infrastructure outages are not staged. The empirical exit sample contains a long halt; this model does not claim to reproduce it.
- Native gas is modeled as fixed USDG purchasing power. ETH price changes, initial conversion to ETH and funding transactions are outside this comparison. A real next run must size from reconciled remaining capital, not assume a fresh 250 after prior losses.
- Recorded trading flow, prices and competing liquidity remain unchanged after our hypothetical position and swaps. Fee dilution is modeled, but price/routing/volume responses are not. Historical issuer, reference and infrastructure admission are unavailable. QQQ is a research-only comparison while its current reference fails.

## Verification and reproduction

Canonical reconstruction matches the saved ending state for every asset. A second action-driven replay independently checks **{verification['actions']} stage actions** without rerunning width decisions: starting and ending token balances, withdrawal inventory, exact swap outputs, minted liquidity, fees and gas. This audit shares the underlying integer swap/position/fee primitives, so it checks ledger integration rather than providing an independent economic model. The new tests exercise loss of fee accrual during recentering, post-swap mint failure, gas-reserve liquidation, unavailable marks, common forecast availability and a changed economic forecast before withdrawal. The final working-tree suite passes 485 tests, and TypeScript checking passes.

Runtime evidence lives in `{root}`. Raw ledger exports, full fork proofs and projected canonical event pages are retained there and are not all committed. [artifacts.json](artifacts.json) hashes the required evidence and owned code. Upstream operations are read-only; only isolated local forks receive transactions.

```bash
.tools/node/bin/node --import tsx scripts/lp-small-budget-capture.mjs data/live-pilot-runtime.env NEW_DIRECTORY
.tools/node/bin/node --import tsx scripts/lp-small-budget-reference.mjs data/live-pilot-runtime.env NEW_DIRECTORY
python3 scripts/lp-small-budget-calibrate.py NEW_DIRECTORY
.tools/node/bin/node --import tsx scripts/lp-small-budget-verify-receipts.mjs data/live-pilot-runtime.env NEW_DIRECTORY
# The capture also writes the pinned universe.json consumed by the fork runner.
.tools/node/bin/node --import tsx scripts/lp-small-budget-fork.mjs data/live-pilot-runtime.env NEW_DIRECTORY
.tools/node/bin/node --import tsx --import ./scripts/lp-tick-memo-hook.mjs --import ./scripts/lp-empty-quote-hook.mjs scripts/lp-small-budget-prepare.mjs NEW_DIRECTORY
# Repeat the following command for AAPL, QQQ and NVDA.
.tools/node/bin/node --import tsx --import ./scripts/lp-tick-memo-hook.mjs --import ./scripts/lp-empty-quote-hook.mjs scripts/lp-small-budget-replay.mjs NEW_DIRECTORY AAPL
python3 scripts/lp-small-budget-report.py NEW_DIRECTORY NEW_REPORT_DIRECTORY
.tools/node/bin/node --import tsx --test test/small-budget-lp.test.ts test/adaptive-lp.test.ts
```

The report narrative is hash-bound to this frozen plan; fresh captures constitute a new experiment and require a reviewed interpretation before packaging. Reproducing this report uses copies of the retained frozen inputs. The memoization hooks are the previously certified pure-integer optimizations; they do not alter strategy rules. Use new output directories, retain raw evidence, and do not overwrite frozen completed results. `executionEligible=false` and `promotionEligible=false` throughout.
'''
(out/'README.md').write_text(body)
owned=list(Path('scripts').glob('lp-small-budget-*'))+[Path(p) for p in ['src/research/small-budget-lp.ts','test/small-budget-lp.test.ts','src/research/adaptive-lp.ts','src/research/adaptive-forecast.ts','src/research/portfolio-math.ts','src/research/virtual-fees.ts','src/research/management-audit.ts','src/research/swap.ts','src/experiment/market.ts','src/backtest/principal.ts','scripts/lp-tick-memo-hook.mjs','scripts/lp-empty-quote-hook.mjs']]
evidence=[root/n for n in ['live-ledger.json','screen.json','references.json','risk-snapshot.json','calibration.json','receipt-verification.json','plan.json','prepared.json','universe.json']]+[root/f'fork-{s}.json'for s in plan['symbols']]+[root/'runs'/f'{s}.json'for s in plan['symbols']]+[Path('data/adaptive-lp-universe-study-2026-09-13/memo-validation/certificate.json')]
(out/'artifacts.json').write_text(json.dumps(dict(code={str(p):digest(p) for p in owned},evidence={str(p):digest(p) for p in evidence},report={str(p):digest(p) for p in out.iterdir() if p.is_file() and p.name!='artifacts.json'}),indent=2)+'\n')
print(json.dumps(dict(portfolios=len(rows),screenPasses=len(passed),verification=verification),indent=2))
