"""Post-hoc source-quality diagnostic; never filters or changes strategy results."""
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'data/adaptive-lp-universe-study-2026-09-13')
read = lambda p: json.loads(p.read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
meta, inclusion = read(root / 'capture.json'), read(root / 'inclusion.json')
assert sha(root / 'capture.json') == inclusion['captureSha256']
output = root / 'mark-diagnostics.json'
assert not output.exists()
principal = Path('src/backtest/principal.ts').read_text()
limits = [int(re.search(name + r'\s*=\s*([\d_]+)n', principal)[1].replace('_', '')) + adjustment
          for name, adjustment in [('MIN_SQRT_RATIO', 1), ('MAX_SQRT_RATIO', -1)]]
rows = []
for included in inclusion['included']:
    asset = dict(next(a for a in meta['assets'] if a['symbol'] == included['symbol']), **included)
    state = {k: int(asset['seed'][k]) for k in ['price', 'tick', 'liquidity']}
    previous, pending, marks = None, None, 0
    counts = dict(empty=0, empty_boundary=0)
    intervals = dict(empty=[], empty_boundary=[])
    opened = dict(empty=None, empty_boundary=None)

    def mark(event):
        global previous, marks
        if int(event['block']) < int(asset['availability']['block']):
            return
        marks += 1
        current = dict(at=event['at'], block=event['block'], blockHash=event['hash'],
                       transactionHash=event['transactionHash'], price=str(state['price']),
                       tick=state['tick'], liquidity=str(state['liquidity']))
        conditions = dict(empty=state['liquidity'] == 0,
                          empty_boundary=state['liquidity'] == 0 and state['price'] in limits)
        for key, condition in conditions.items():
            counts[key] += int(condition)
            if condition and opened[key] is None:
                opened[key] = current.copy()
            if not condition and opened[key] is not None:
                start = opened[key]
                intervals[key].append(dict(start, endAt=current['at'], endBlock=current['block'],
                                           durationMs=current['at']-start['at'], unresolvedAtEnd=False))
                opened[key] = None
        previous = current

    for page in asset['pages']:
        path = root / page['file']
        assert sha(path) == page['sha256']
        for event in json.loads(gzip.decompress(path.read_bytes()))['events']:
            assert event['symbol'] == asset['symbol']
            if pending is not None and pending['block'] != event['block']:
                mark(pending)
            args = event['args']
            if event['name'] == 'Swap':
                state = dict(price=int(args['sqrtPriceX96']), tick=int(args['tick']), liquidity=int(args['liquidity']))
            elif event['name'] in ['Mint', 'Burn']:
                if int(args['tickLower']) <= state['tick'] < int(args['tickUpper']):
                    state['liquidity'] += int(args['amount']) * (-1 if event['name'] == 'Burn' else 1)
            assert state['liquidity'] >= 0
            pending = event
    if pending is not None:
        mark(pending)
    assert previous is not None
    assert state == {k: int(asset['after'][k]) for k in state}
    for key, start in opened.items():
        if start is not None:
            intervals[key].append(dict(start, endAt=previous['at'], endBlock=previous['block'],
                                       durationMs=previous['at']-start['at'], unresolvedAtEnd=True))
    row = dict(symbol=asset['symbol'], availability=asset['availability'], postAvailabilityEventBlocks=marks,
               endingPriceTickLiquidityVerified=True, counts=counts, intervals=intervals,
               intervalMs={k: sum(x['durationMs'] for x in v) for k, v in intervals.items()})
    rows.append(row)
    print(json.dumps({k: row[k] for k in ['symbol', 'counts', 'intervalMs']}), flush=True)
output.write_text(json.dumps(dict(rows=rows, captureSha256=inclusion['captureSha256'],
    inclusionSha256=sha(root / 'inclusion.json'), diagnosticCodeSha256=sha(Path(__file__)),
    principalCodeSha256=sha(Path('src/backtest/principal.ts')), priceLimits=list(map(str, limits)),
    scope='Post-hoc diagnostic of end-of-event-block canonical spot marks after common availability. Uses event post-state and Mint/Burn liquidity deltas, reconciles terminal price/tick/liquidity. Empty-book boundary marks are not validated economic prices. No results or inclusion rules changed.'), indent=2)+'\n')
