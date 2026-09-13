"""Independent integer ledger/selection audit; does not import replay code."""
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
read = lambda name: json.loads((root / name).read_text())
manifest = read('manifest.json')
for path, digest in manifest['code'].items():
    assert hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() == digest, path
completed = read('completed.json')
assert completed['planSha256'] == manifest['planSha256']
assert completed['canonicalEndsVerified']
selection = read('selection.json')
training = read('development-validation.json')
testing = read('retrospective-test.json')
actions = failures = rows = scores = 0
validation = {}
for source in training + testing:
    assert source['canonicalEndVerified']
    for phase in source['results']:
        assert phase['sourceFrom'] < phase['sourceTo']
        comparators = {}
        for model in phase['models']:
            rows += 1
            key = model['scenario']
            hold = model['holdTerminalCashQuote']
            if key in comparators:
                assert comparators[key] == hold
            comparators[key] = hold
            paid = 0
            count = {'entry': 0, 'recenter': 0, 'partial_mint_failure': 0}
            previous_at = None
            for action in model['actions']:
                actions += 1
                kind = action['kind']
                count[kind] += 1
                assert action['quoteAt'] < action['at']
                assert int(action['quoteBlock']) < int(action['block'])
                assert action['at'] - action['quoteAt'] <= 90000
                if previous_at is not None:
                    assert action['at'] > previous_at
                previous_at = action['at']
                before = [int(action['before'][f'amount{i}']) for i in (0, 1)]
                after = [int(action['afterSwap'][f'amount{i}']) for i in (0, 1)]
                idle = [int(action['idle'][f'amount{i}']) for i in (0, 1)]
                token = action['token']
                expected = before.copy()
                if token is not None:
                    expected[token] -= int(action['amountIn'])
                    expected[1-token] += int(action['amountOut'])
                assert expected == after
                assert min(before + after + idle) >= 0
                minted = [int(action[f'minted{i}']) for i in (0, 1)]
                assert [idle[i] + minted[i] for i in (0, 1)] == after
                if kind == 'partial_mint_failure':
                    failures += 1
                    assert action['liquidity'] == '0' and idle == after
                else:
                    assert int(action['liquidity']) > 0
                paid += int(action['gasQuote'])
            assert paid == int(model['gasPaidQuote'])
            assert count['entry'] == model['entries']
            assert count['recenter'] == model['recenters']
            assert count['partial_mint_failure'] == model['partialFailures']
            assert model['recenterAttempts'] == model['recenters'] + model['partialFailures']
            assert paid + int(model['terminalExitCostQuote']) == int(model['totalGasWithExitQuote'])
            if model['terminalCashQuote'] is not None:
                assert int(model['netPnlQuote']) == int(model['terminalCashQuote']) - int(manifest['plan']['budgetQuote'])
                if hold is not None:
                    assert int(model['alphaQuote']) == int(model['terminalCashQuote']) - int(hold)
            assert 0 <= model['outsideMs'] <= model['holdingMs'] <= model['totalMs']
            assert model['totalMs'] == model['toAt'] - model['fromAt']
            for score in model['economicScores']:
                scores += 1
                assert score['asOf'] <= score['at']
                assert score['accepted'] == (int(score['benefitQuote']) > int(score['bufferQuote']))
            if phase['phase'] == 'validation' and key == 'pinned_fork_costs' and model['name'] in ('fixed_40', 'fixed_80', 'fixed_160'):
                assert model['alphaQuote'] is not None and model['invalid'] is None
                width = int(model['name'].split('_')[1])
                validation[width] = validation.get(width, 0) + int(model['alphaQuote'])
best = max(validation, key=lambda width: (validation[width], width))
assert best == selection['selectedFixedHalfWidthTicks']
assert rows == completed['rows']
result = {'rows': rows, 'actions': actions, 'partialFailures': failures, 'economicScores': scores,
          'selectedFixedHalfWidthTicks': best, 'ledgerAndSelectionChecks': 'passed',
          'scope': 'Independent arithmetic, time ordering, cost sums, token conservation at actions and validation-only selection. Not an independent reconstruction of all swap events or forecasts.'}
path = root / 'verification.json'
assert not path.exists()
path.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
