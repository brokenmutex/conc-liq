"""Verify the completed agility artifacts and render the retrospective comparison."""
import csv
import hashlib
import json
import pathlib
import sys
from decimal import Decimal

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'data/adaptive-lp-agility-2026-09-14')
out = pathlib.Path('notes/adaptive-lp-agility-2026-09-14')
read = lambda p: json.loads(pathlib.Path(p).read_text())
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
plan = read(out / 'plan.json')
checks = read(out / 'checks.json')
assert checks['typecheckPassed'] and checks['passed'] == checks['tests'] == 526 and checks['failed'] == 0
for path, digest in checks['code'].items():
    assert sha(path) == digest, path
amendment = read(out / 'provenance/name-amendment.json')
original_runner = pathlib.Path(amendment['originalRunnerPath']).read_text()
assert sha(amendment['originalRunnerPath']) == amendment['originalRunnerSha256']
assert original_runner.count(amendment['before']) == 1
assert original_runner.replace(amendment['before'], amendment['after']) == pathlib.Path('scripts/agile-lp-study.mjs').read_text()
assert sha('scripts/agile-lp-study.mjs') == amendment['correctedRunnerSha256']
rows, inputs = [], {}
for symbol in plan['symbols']:
    folder = root / symbol
    done, manifest, result = [read(folder / p) for p in ['completed.json', 'manifest.json', 'results.json']]
    assert sha(folder / 'results.json') == done['resultsSha256']
    assert sha(folder / 'manifest.json') == done['manifestSha256']
    assert sha(out / 'plan.json') == manifest['planSha256'] == result['planSha256']
    assert sha(folder / 'source.json') == result['sourceSha256']
    for path, digest in {**manifest['code'], **manifest['sourceHashes']}.items():
        if path == 'scripts/agile-lp-study.mjs' and digest == amendment['originalRunnerSha256']:
            assert sha(amendment['originalRunnerPath']) == digest
        else:
            assert sha(path) == digest, path
    source = read(folder / 'source.json')
    for page in source['pages']:
        assert sha(folder / page['file']) == page['sha256']
    for key in ['canonicalEnd', 'actionBalances', 'swapOutputs', 'mintAmounts', 'feeTokens', 'gas', 'occupancy', 'terminalQuotes']:
        assert result['verification'][key] is True
    assert len(result['rows']) == len(plan['arms']) * len(plan['scenarios'])
    # Legacy runner preserved all scenarios/arms in the frozen nested-loop
    # order but scenario.name overwrote the presentation name. Repair only
    # that field, preserving raw results and their hashes unmodified.
    for index, r in enumerate(result['rows']):
        arm = plan['arms'][index % len(plan['arms'])]
        scenario = plan['scenarios'][index // len(plan['arms'])]
        assert r['scenario'] == scenario['name']
        if manifest['code']['scripts/agile-lp-study.mjs'] == amendment['originalRunnerSha256']:
            assert r['name'] == scenario['name']
            r['storedName'] = r['name']
            r['name'] = arm['name']
        else:
            assert r['name'] == arm['name']
    assert len({(r['name'], r['scenario']) for r in result['rows']}) == len(result['rows'])
    assert all(r['fromAt'] == result['firstAt'] and r['toAt'] == result['lastAt'] for r in result['rows'])
    assert result['executionEligible'] is False and result['promotionEligible'] is False
    for r in result['rows']:
        assert r['symbol'] == symbol and r['name'] in {a['name'] for a in plan['arms']}
        assert r['executionEligible'] is False
        assert sum(int(a['gasQuote']) for a in r['actions']) == int(r['gasPaidQuote'])
        assert int(r['totalGasWithExitQuote']) == int(r['gasPaidQuote']) + int(r['terminalExitCostQuote'])
        for score in r['economicScores']:
            assert score['asOf'] <= score['at']
            assert score['accepted'] == (int(score['benefitQuote']) > int(score['bufferQuote']))
        if r['alphaQuote'] is not None:
            assert int(r['alphaQuote']) == int(r['terminalCashQuote']) - int(r['holdTerminalCashQuote'])
            assert int(r['netPnlQuote']) == int(r['terminalCashQuote']) - int(plan['budgetQuote'])
            assert sum(int(d['alphaQuote']) for d in r['daily']) == int(r['alphaQuote'])
        if not r['name'].endswith('_early'):
            assert r['earlyRecenters'] == 0
        row = {k: v for k, v in r.items() if k not in ['actions', 'economicScores', 'daily']}
        row['outsidePercent'] = None if not r['holdingMs'] else 100 * r['outsideMs'] / r['holdingMs']
        row['drawdownPercent'] = int(r['drawdownPpm']) / 10000
        row['economicDecisions'] = len(r['economicScores'])
        row['economicAcceptances'] = sum(s['accepted'] for s in r['economicScores'])
        rows.append(row)
    inputs[symbol] = {'resultSha256': done['resultsSha256'], 'manifestSha256': done['manifestSha256'],
                      'firstAt': result['firstAt'], 'lastAt': result['lastAt'], 'availability': result['availability'],
                      'commonUnavailable': result['commonUnavailable'], 'verification': result['verification']}

by = {(r['symbol'], r['scenario'], r['name']): r for r in rows}
for r in rows:
    base = by[r['symbol'], r['scenario'], 'baseline_6h']
    r['deltaAlphaVs6hQuote'] = None if r['alphaQuote'] is None or base['alphaQuote'] is None else str(int(r['alphaQuote']) - int(base['alphaQuote']))
    r['deltaRecentersVs6h'] = r['recenters'] - base['recenters']

summary = {'planSha256': sha(out / 'plan.json'), 'inputs': inputs, 'rows': rows, 'nameAmendment': amendment,
           'executionEligible': False, 'promotionEligible': False}
(out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
fields = ['symbol', 'scenario', 'name', 'budgetQuote', 'netPnlQuote', 'alphaQuote', 'deltaAlphaVs6hQuote',
          'drawdownPercent', 'outsidePercent', 'recenters', 'earlyRecenters', 'deltaRecentersVs6h',
          'partialFailures', 'feesQuote', 'totalGasWithExitQuote', 'maximumLiquidityToExistingPpm',
          'economicDecisions', 'economicAcceptances', 'invalid', 'terminalExecutable']
with (out / 'results.csv').open('w') as handle:
    writer = csv.DictWriter(handle, fields, extrasaction='ignore', lineterminator='\n'); writer.writeheader(); writer.writerows(rows)

money = lambda v: 'unavailable' if v is None else f'{Decimal(v) / 1000000:,.2f}'
pct = lambda v: 'unavailable' if v is None else f'{v:.2f}%'
total = lambda rr, key: None if any(r[key] is None for r in rr) else sum(int(r[key]) for r in rr)
labels = {'baseline_6h': '6h baseline', 'rolling_30m': '30m rolling', 'rolling_60m': '60m rolling',
          'ewma_15m': '15m volatility half-life', 'ewma_30m': '30m volatility half-life',
          'ewma_30m_fee_blend': '30m volatility + fee blend', 'baseline_6h_early': '6h + early decisions',
          'ewma_30m_early': '30m volatility + early decisions'}
base_cells = lambda name: [by[s, 'pinned_fork_costs', name] for s in plan['symbols']]
base_wins = lambda name: sum(r['deltaAlphaVs6hQuote'] is not None and int(r['deltaAlphaVs6hQuote']) > 0 for r in base_cells(name))
lines = ['# Adaptive width: agility comparison, September 14, 2026', '',
         'Retrospective comparison of eight predeclared variants on AAPL, GOOGL, and NVDA, '
         'August 30–September 11 19:30 UTC, with 1,000 USDG per asset and three cost/failure scenarios. '
         'Each of the 72 portfolios retains inventory continuously. No deployment setting changed.', '',
         f"At base costs, the 30-minute rolling estimator improved alpha on {base_wins('rolling_30m')}/3 assets "
         f"and the 60-minute estimator on {base_wins('rolling_60m')}/3. Their combined changes versus the "
         f"six-hour baseline were {money(total(base_cells('rolling_30m'), 'deltaAlphaVs6hQuote'))} and "
         f"{money(total(base_cells('rolling_60m'), 'deltaAlphaVs6hQuote'))} USDG, respectively. "
         'These are historical sample outcomes, not evidence of a universally correct window. '
         'Compare the cost stresses and risk table before choosing a candidate for prospective evaluation.', '',
         '**Next research candidate: 60-minute rolling estimates, retaining the existing economic gate and '
         'out-of-range trigger.** It improved eight asset/scenario cells and tied the ninth. The 30-minute '
         'variant also improved eight cells, but in stressed NVDA it reduced alpha by 26.27 USDG and turned '
         'absolute P&L negative; the 60-minute variant matched the baseline with no recenters in that case. '
         'The 60-minute model still increased base-cost drawdown on AAPL and GOOGL, so it is a candidate for '
         'a newly frozen prospective comparison, not a production recommendation. Keep six hours as the '
         'control and 30 minutes as a challenger. Earlier in-range decisions had no outcome effect on '
         'AAPL or NVDA under these thresholds; gains from changing the estimator were more broadly observed.', '',
         '## What changed', '',
         '- **30m/60m rolling:** both variance and fee income use the shorter window.',
         '- **15m/30m volatility half-life:** recent squared tick changes receive exponentially more weight; '
         'fee income retains the six-hour trailing estimate. These half-lives specify weighting, not a hard cutoff.',
         '- **Fee blend:** the 30m volatility variant additionally blends 50% of a 60m-half-life fee estimate '
         'with 50% of the six-hour trailing fee rate.',
         '- **Early decisions:** separately added to the baseline and 30m volatility variant. '
         'Evaluate while inside the range after two eligible observations beyond 70% of the distance from '
         'center to boundary, with a ten-minute cooldown after a successful move. In-range narrowing also '
         'requires ten minutes of persistent proposed width. Wider proposals do not have that extra delay. '
         'The original out-of-range rule, economic gate and fill-time gate remain unchanged.', '',
         'All arms retain the same four candidate half-widths (20/40/80/160 ticks), 30-second minimum decision '
         'interval, ten-minute forecast horizon, 90-second quote TTL and 50-bps slippage check. '
         'Forecast weights are time-based; missing timestamps are never inserted as quiet observations.', '',
         '## Base-cost outcomes', '',
         'Net LP alpha is terminal executable cash minus the common passive stock/cash benchmark, '
         'after acquisition, rebalance and liquidation costs. Positive alpha does not imply positive absolute P&L. '
         'Amounts below are USDG. The combined column represents three separate 1,000-USDG portfolios.', '',
         '| Variant | AAPL alpha | GOOGL alpha | NVDA alpha | Combined alpha | Change vs 6h |',
         '| --- | ---: | ---: | ---: | ---: | ---: |']
for arm in plan['arms']:
    rr = [by[s, 'pinned_fork_costs', arm['name']] for s in plan['symbols']]
    lines.append('| ' + ' | '.join([labels[arm['name']], *(money(r['alphaQuote']) for r in rr),
                                   money(total(rr, 'alphaQuote')), money(total(rr, 'deltaAlphaVs6hQuote'))]) + ' |')
lines += ['', '## Cost and failure sensitivity', '',
          'Changes in combined net alpha relative to the corresponding six-hour baseline in each scenario. '
          'Wins count positive changes across the three assets; they are descriptive, not independent statistical trials.', '',
          '| Variant | Base delta | Double gas / half fees delta | Every fifth recenter mint fails delta | Positive asset/scenario cells |',
          '| --- | ---: | ---: | ---: | ---: |']
for arm in plan['arms']:
    groups = [[by[s, sc['name'], arm['name']] for s in plan['symbols']] for sc in plan['scenarios']]
    flat = sum(groups, [])
    eligible = [r for r in flat if r['deltaAlphaVs6hQuote'] is not None]
    lines.append('| ' + ' | '.join([labels[arm['name']], *(money(total(g, 'deltaAlphaVs6hQuote')) for g in groups),
                                   f"{sum(int(r['deltaAlphaVs6hQuote']) > 0 for r in eligible)}/{len(eligible)}"]) + ' |')
lines += ['', '## Risk and trading activity at base costs', '',
          'Drawdown is the largest observed decline from marked NAV peak, excluding final liquidation. '
          'Outside time is a share of time with an LP position. All transaction amounts are frozen fork-based '
          'cost estimates, not historical receipts.', '',
          '| Asset | Variant | Absolute P&L | Drawdown | Outside time | Recenters (early) | Gas including exit |',
          '| --- | --- | ---: | ---: | ---: | ---: | ---: |']
for symbol in plan['symbols']:
    for arm in plan['arms']:
        r = by[symbol, 'pinned_fork_costs', arm['name']]
        lines.append('| ' + ' | '.join([symbol, labels[arm['name']], money(r['netPnlQuote']), pct(r['drawdownPercent']),
                                       pct(r['outsidePercent']), f"{r['recenters']} ({r['earlyRecenters']})", money(r['totalGasWithExitQuote'])]) + ' |')
lines += ['', 'Peak modeled position liquidity relative to existing active liquidity, across all arms/scenarios: '
          + '; '.join(f"{symbol} {max(int(r['maximumLiquidityToExistingPpm']) / 10000 for r in rows if r['symbol'] == symbol):.2f}%"
                      for symbol in plan['symbols']) + '. The model adjusts fee dilution, but holds the historical '
          'market path and other participants’ behavior fixed. These shares limit how directly modeled earnings '
          'can be transferred to deployment.']
lines += ['', '## Availability and interpretation', '',
          'The main ablation requires the **intersection of all variants’ available forecasts at every observation**. '
          'This gives all arms the same data admission, first benchmark acquisition and starting budget, '
          'isolating estimate and trigger effects. The experiment therefore does not measure faster cold starts '
          'or recovery from missing data. The shorter estimators themselves permit 20/40 minutes and 20/40 '
          'observations, respectively; their independent availability counts are in summary.json.', '',
          'The six-hour baseline is the original frozen implementation. The new early-decision subclass delegates '
          'all out-of-range decisions, fills, partial failures and balance accounting to it. The earlier historical '
          'reports have different portfolio start boundaries; their monetary results are not reused as controls here.', '',
          'The three-scenario zero-drift forecast remains a hypothesis. A faster volatility response does not '
          'validate its fee predictions, terminal NAV forecast, or economic gate. This study does not reconstruct '
          'historical independent-reference eligibility, issuer state, actual execution receipts, staged transaction '
          'delays, future competing liquidity or flow response to our position. Capacity dilution and hypothetical '
          'swap price impact use the existing recorded-market-path model. See per-row maximum liquidity share '
          'before interpreting modeled income as deployable capacity. The 1,000 USDG is initial LP capital; '
          'gas is booked as a USDG-valued liability funded by separately modeled native balances. '
          'No finite live gas reserve or native-token price path is replayed.', '',
          'These dates and assets were previously inspected. Any preferred variant now needs newly frozen '
          'prospective shadow evaluation; none is execution-eligible or promotion-eligible.', '',
          '## Verification and reproduction', '',
          f"Verified {len(rows)} rows and {sum(i['verification']['actions'] for i in inputs.values())} actions. "
          'The action-driven audit does not rerun policy decisions: it reconstructs balances from canonical events, '
          'requotes swaps, remints exact token amounts, and reconciles fee tokens, gas, range occupancy and terminal '
          'liquidation. It shares the existing exact swap/position/fee primitives. The full source replay also '
          'reconciles the previously captured canonical ending state. Inputs, original and new code, plan and outputs '
          'are hash-bound. Integer tick memoization and empty-depth shortcuts use the existing conformance certificate.', '',
          'The initial runner allowed the scenario name to overwrite the arm label in the summary. '
          'The report restores arm labels from the frozen scenario-by-arm array order; original raw results and '
          'hashes remain intact. The [metadata amendment](provenance/name-amendment.json) binds the archived '
          'original runner and the one-field correction. `policy.name` is used only for the summary label in '
          'the hash-verified original replay; trading decisions and economics are unaffected. '
          'Reported rows retain `storedName` for traceability.', '',
          '[Typecheck and all 526 tests passed](checks.json), including estimator identity, shock response, '
          'missing-data rejection, early confirmation/cooldown, narrowing persistence and fill-time gate checks.', '',
          '```bash',
          'PATH="$PWD/.tools/node/bin:$PATH" node --import tsx --import ./scripts/lp-tick-memo-hook.mjs \\',
          '  --import ./scripts/lp-empty-quote-hook.mjs scripts/agile-lp-study.mjs AAPL data/agility-reproduction',
          '# Repeat with GOOGL and NVDA, using the same output root.',
          'python3 scripts/report-agile-lp.py data/agility-reproduction',
          '```', '',
          'Artifacts: [plan](plan.json), [summary and provenance](summary.json), [all 72 results](results.csv), '
          '[comparison chart](agility-comparison.png), [PDF chart](agility-comparison.pdf). '
          'CSV monetary fields ending in `Quote` are integer micro-USDG; percentage fields are in percent. '
          'Large canonical event slices and action ledgers remain under `data/adaptive-lp-agility-2026-09-14/`.']
(out / 'README.md').write_text('\n'.join(lines) + '\n')
print(json.dumps({'verifiedRows': len(rows), 'report': str(out / 'README.md'),
                  'aggregateBaseDelta': {a['name']: money(total([by[s, 'pinned_fork_costs', a['name']] for s in plan['symbols']], 'deltaAlphaVs6hQuote')) for a in plan['arms']}}))
