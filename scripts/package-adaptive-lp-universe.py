"""Collect compact, verified research evidence; leave raw captures under data/."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

root, out = map(Path, sys.argv[1:3])
read = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
write = lambda name, value: (out / name).write_text(json.dumps(value, indent=2) + '\n')
verification = read(root / 'verification.json')
inclusion = read(root / 'inclusion.json')
symbols = [a['symbol'] for a in inclusion['included']]
budgets = read(root / 'capture.json')['plan']['budgetsQuote']
assert verification['ledgerChecks'] == 'passed'
assert verification['rows'] == len(symbols) * len(budgets) * 18
assert (out / 'headline.json').exists(), 'Render the verified results first'
for name in ['summary.json', 'verification.json', 'coverage.json', 'capture.json',
             'inclusion.json', 'source-verification.json']:
    shutil.copyfile(root / name, out / name)
marks = read(root / 'mark-diagnostics.json')
assert marks['captureSha256'] == inclusion['captureSha256']
assert marks['inclusionSha256'] == sha(root / 'inclusion.json')
assert marks['diagnosticCodeSha256'] == sha(Path('scripts/diagnose-adaptive-lp-universe-marks.py'))
assert marks['principalCodeSha256'] == sha(Path('src/backtest/principal.ts'))
assert {r['symbol'] for r in marks['rows']} == set(symbols)
assert all(r['endingPriceTickLiquidityVerified'] for r in marks['rows'])
shutil.copyfile(root / 'mark-diagnostics.json', out / 'mark-diagnostics.json')
for path in root.glob('passive-exit-*.json'):
    diagnostic = read(path)
    assert diagnostic['canonicalEndVerified'] and diagnostic['allReportedPassiveTerminalCashVerified']
    assert diagnostic['captureSha256'] == inclusion['captureSha256']
    assert diagnostic['inclusionSha256'] == sha(root / 'inclusion.json')
    assert diagnostic['diagnosticCodeSha256'] == sha(Path('scripts/diagnose-adaptive-lp-universe-exits.mjs'))
    assert all(sha(Path(p)) == digest for p, digest in diagnostic['resultHashes'].items())
    shutil.copyfile(path, out / path.name)
shutil.copyfile(root / 'completed.json', out / 'capture-completed.json')
for source, target in [('certificate.json', 'optimization-certificate.json'),
                       ('exhaustive.json', 'tick-conformance.json'),
                       ('quote-conformance.json', 'quote-conformance.json')]:
    shutil.copyfile(root / 'memo-validation' / source, out / target)
audits = {s: read(root / f'reconstruction-{s}.json') for s in symbols}
write('reconstruction.json', {
    'rows': [r for a in audits.values() for r in a['rows']],
    'events': sum(a['events'] for a in audits.values()),
    'byAsset': {s: {k: v for k, v in a.items() if k != 'rows'} for s, a in audits.items()},
    'scope': 'Independent frozen-action reconstruction; shared exact position, swap and fee math.'})
manifests = {}
for symbol in symbols:
    for budget in budgets:
        key = f'{symbol}-{budget}'
        path = root / 'runs' / key
        manifests[key] = {name: read(path / f'{name}.json')
                          for name in ['manifest', 'completed', 'reuse']
                          if (path / f'{name}.json').exists()}
write('run-manifests.json', manifests)
write('execution-manifests.json', {
    p.name: read(p) for p in sorted((root / 'logs').glob('*.execution.json'))})
scripts = sorted({*Path('scripts').glob('*adaptive-lp-universe*'),
                  *Path('scripts').glob('verify-lp-*memo.mjs'),
                  Path('scripts/verify-lp-empty-quote.mjs'),
                  Path('scripts/lp-tick-memo-hook.mjs'),
                  Path('scripts/lp-empty-quote-hook.mjs'),
                  Path('scripts/certify-lp-optimizations.mjs'),
                  Path('scripts/lp-asset-fork-check.mjs')})
write('artifact-hashes.json', {
    'artifacts': {str(p.relative_to(out)): sha(p) for p in sorted(out.iterdir())
                  if p.is_file() and p.name != 'artifact-hashes.json'},
    'scripts': {str(p): sha(p) for p in scripts},
    'frozenCore': next(iter(manifests.values()))['manifest']['code'],
    'rawEvidenceRoot': str(root),
    'scope': 'Review artifacts and generating code; raw event/action evidence remains under data.'})
print(json.dumps({'packagedAssets': len(symbols), 'rows': verification['rows'], 'output': str(out)}))
