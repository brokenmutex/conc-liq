"""Independent continuous-ledger arithmetic and frozen-configuration checks."""
import hashlib
import gzip
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'data/adaptive-lp-long-study-2026-09-13')
read = lambda p: json.loads(Path(p).read_text())
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
capture = read(root / 'capture.json')
complete = read(root / 'completed.json')
plan = capture['plan']
assert sha('notes/adaptive-lp-long-study-2026-09-13/plan.json') == complete['planSha256']
assert sha(root / 'capture.json') == complete['captureSha256']
assert complete['canonicalEndsVerified'] and complete['dbLogsExactMatch']
coverage = {symbol: {'events': 0, 'blocks': 0, 'firstAt': None, 'lastAt': None, 'maximumEventGapMs': 0, 'gapsOver15Minutes': 0, 'days': {}} for symbol in plan['symbols']}
previous_block = {}
for page in complete['pages']:
    path = root / page['file']
    assert sha(path) == page['sha256']
    events = json.loads(gzip.decompress(path.read_bytes()))['events']
    assert len(events) == page['events']
    for event in events:
        c = coverage[event['symbol']]
        c['events'] += 1
        day = datetime.fromtimestamp(event['at'] / 1000, timezone.utc).date().isoformat()
        c['days'][day] = c['days'].get(day, 0) + 1
        if previous_block.get(event['symbol']) != event['block']:
            c['blocks'] += 1
            if c['lastAt'] is not None:
                gap = event['at'] - c['lastAt']
                assert gap >= 0
                c['maximumEventGapMs'] = max(c['maximumEventGapMs'], gap)
                c['gapsOver15Minutes'] += int(gap > 900000)
            if c['firstAt'] is None:
                c['firstAt'] = event['at']
            c['lastAt'] = event['at']
            previous_block[event['symbol']] = event['block']
assert sum(c['events'] for c in coverage.values()) == complete['events']
rows = actions = failures = scores = 0
availability = {}
all_rows = []
forecast = []
for symbol in plan['symbols']:
    for budget in plan['budgetsQuote']:
        out = root / 'runs' / f'{symbol}-{budget}'
        m = read(out / 'manifest.json')
        done = read(out / 'completed.json')
        assert sha(out / 'results.json') == done['resultsSha256']
        assert m['captureSha256'] == complete['captureSha256']
        assert m['planSha256'] == complete['planSha256']
        assert sha('scripts/adaptive-lp-long-study.mjs') == m['runnerSha256']
        assert sha('notes/adaptive-lp-long-study-2026-09-13/availability-amendment.json') == m['availabilityAmendmentSha256']
        for p, digest in m['code'].items():
            assert sha(p) == digest, p
        d = read(out / 'results.json')
        assert d['canonicalEndVerified'] and len(d['results']) == 18
        assert not d['executionEligible'] and not d['promotionEligible']
        if symbol in availability:
            assert availability[symbol] == d['fromAt']
        availability[symbol] = d['fromAt']
        holds = {}
        for r in d['results']:
            rows += 1
            assert r['budgetQuote'] == budget and not r['executionEligible']
            assert r['fullWindowMs'] == r['preBenchmarkCashWaitMs'] + r['totalMs']
            hold = r['holdTerminalCashQuote']
            scenario = r['scenario']
            if scenario in holds:
                assert holds[scenario] == hold
            holds[scenario] = hold
            paid = 0
            counts = {'entry': 0, 'recenter': 0, 'partial_mint_failure': 0}
            prev = None
            for a in r['actions']:
                actions += 1
                counts[a['kind']] += 1
                assert a['quoteAt'] < a['at'] <= a['quoteAt'] + 90000
                assert int(a['quoteBlock']) < int(a['block'])
                assert a['at'] >= d['fromAt'] and a['at'] <= d['toAt']
                if prev is not None:
                    assert prev < a['at']
                prev = a['at']
                b = [int(a['before'][f'amount{i}']) for i in (0, 1)]
                after = [int(a['afterSwap'][f'amount{i}']) for i in (0, 1)]
                idle = [int(a['idle'][f'amount{i}']) for i in (0, 1)]
                expected = b.copy()
                if a['token'] is not None:
                    expected[a['token']] -= int(a['amountIn'])
                    expected[1-a['token']] += int(a['amountOut'])
                assert expected == after and min(b + after + idle) >= 0
                assert [idle[i] + int(a[f'minted{i}']) for i in (0, 1)] == after
                if a['kind'] == 'partial_mint_failure':
                    failures += 1
                    assert a['liquidity'] == '0' and idle == after
                else:
                    assert int(a['liquidity']) > 0
                paid += int(a['gasQuote'])
            assert paid == int(r['gasPaidQuote'])
            assert counts['entry'] == r['entries']
            assert counts['recenter'] == r['recenters']
            assert counts['partial_mint_failure'] == r['partialFailures']
            assert r['recenterAttempts'] == r['recenters'] + r['partialFailures']
            assert paid + int(r['terminalExitCostQuote']) == int(r['totalGasWithExitQuote'])
            for score in r['economicScores']:
                scores += 1
                assert score['asOf'] <= score['at']
                assert score['accepted'] == (int(score['benefitQuote']) > int(score['bufferQuote']))
            for attribution in (r['weekly'], r['regimes']):
                assert len({x['key'] for x in attribution}) == len(attribution)
                assert sum(x['actions'] for x in attribution) == len(r['actions'])
                assert all(int(x['alphaQuote']) == int(x['navChangeQuote']) - int(x['holdChangeQuote']) for x in attribution)
                cash = r['terminalCashQuote'] or r['markedNavQuote']
                assert sum(int(x['navChangeQuote']) for x in attribution) == int(cash) - int(budget)
                if r['alphaQuote'] is not None:
                    assert sum(int(x['alphaQuote']) for x in attribution) == int(r['alphaQuote'])
                    assert sum(int(x['gasQuote']) for x in attribution) == int(r['totalGasWithExitQuote'])
            if r['terminalCashQuote'] is not None:
                assert int(r['netPnlQuote']) == int(r['terminalCashQuote']) - int(budget)
                if hold is not None:
                    assert int(r['alphaQuote']) == int(r['terminalCashQuote']) - int(hold)
            assert 0 <= r['outsideMs'] <= r['holdingMs'] <= r['totalMs']
            all_rows.append({k: v for k, v in r.items() if k not in ('actions', 'economicScores')})
        forecast.extend(dict(x, symbol=symbol, budgetQuote=budget) for x in d['forecastMetrics'])
assert rows == 108
summary = {'plan': plan, 'rows': all_rows, 'forecastMetrics': forecast, 'executionEligible': False, 'promotionEligible': False}
verification = {'rows': rows, 'actions': actions, 'partialFailures': failures, 'economicScores': scores,
                'validRows': sum(r['invalid'] is None for r in all_rows), 'invalidRows': [{k: r[k] for k in ('symbol', 'budgetQuote', 'scenario', 'name', 'invalid')} for r in all_rows if r['invalid'] is not None],
                'commonAvailabilityByAsset': availability, 'continuousWeeklyAndRegimeSums': 'passed',
                'ledgerChecks': 'passed', 'scope': 'Independent action arithmetic, quote chronology, common benchmarks and availability across sizes, attribution sums, frozen code and output hashes. Canonical swap replay is shared, not independently reimplemented.'}
for name, data in [('summary.json', summary), ('verification.json', verification), ('coverage.json', coverage)]:
    p = root / name
    assert not p.exists(), p
    p.write_text(json.dumps(data, indent=2) + '\n')
print(json.dumps(verification))
