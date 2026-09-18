#!/usr/bin/env python3
"""Compare arms from adaptive-forecast-sweep.mjs.

Primary metric is alpha (terminal executable cash minus the passive
stock/cash benchmark), not NAV. The residence-cap sweep showed raw NAV is
dominated by the directional term, which is common to every arm and hides
the estimator effect being measured here.
"""
import json, sys, collections

SYMS = ['NVDA', 'AAPL', 'GOOGL']
u = lambda x: int(x) / 1e6 if x is not None else float('nan')


def main(path):
    d = json.load(open(path))
    print(f"window {d['start']} -> {d['end']}   horizon {d['horizonMs']//60000}m   "
          f"intersect={d['intersect']}   widths={d['halfWidthsTicks']}")
    names = [a['name'] for a in d['arms']]

    alpha = collections.defaultdict(dict)
    for sym in SYMS:
        a = d['assets'].get(sym)
        if not a or 'error' in a:
            print(f"\n{sym}: {a.get('error') if a else 'absent'}")
            continue
        print(f"\n{sym}  rows={a['rows']} observations={a['observations']} "
              f"warmup={a['warmupMinutes']}m  {a['firstAt']} -> {a['lastAt']}")
        print('  %-16s %9s %9s %8s %7s %6s %6s %8s %7s %7s  %s' % (
            'arm', 'alpha', 'terminal', 'nav', 'fees', 'gas', 'recen',
            'inRange%', 'maxDD%', 'exp%', 'widths'))
        for n in names:
            r = a['arms'].get(n)
            if not r:
                continue
            s = r['summary']
            inr = 100 * (1 - s['outsideMs'] / s['holdingMs']) if s['holdingMs'] else 0.0
            exp = int(s['averageRiskyExposurePpm']) / 1e4 if s['averageRiskyExposurePpm'] else 0.0
            hist = collections.Counter(r['widths'])
            alpha[n][sym] = u(s['alphaQuote'])
            print('  %-16s %9.2f %9.2f %8.2f %7.2f %6.2f %6d %8.1f %7.2f %7.1f  %s' % (
                n, u(s['alphaQuote']), u(s['terminalCashQuote']), u(s['markedNavQuote']),
                u(s['feesQuote']), u(s['gasPaidQuote']), s['recenters'], inr,
                int(s['drawdownPpm']) / 1e4, exp,
                {k: hist[k] for k in sorted(hist)}))
            if r['unavailable'] or r['skipped']:
                print('  %-16s   forecast unavailable %d, skipped %d, gate %d/%d' % (
                    '', r['unavailable'], r['skipped'], r['accepted'], r['scored']))

    print('\ncombined alpha (sum over books present):')
    base = alpha.get('live_60m', {})
    rows = []
    for n in names:
        if n not in alpha:
            continue
        common = [s for s in SYMS if s in alpha[n] and s in base]
        tot = sum(alpha[n][s] for s in common)
        delta = tot - sum(base[s] for s in common)
        wins = sum(1 for s in common if alpha[n][s] > base[s])
        rows.append((n, tot, delta, wins, len(common)))
    for n, tot, delta, wins, cnt in rows:
        print('  %-16s %9.2f   vs live_60m %+8.2f   books better %d/%d' % (n, tot, delta, wins, cnt))

    # 2-D view: the whole point of the sweep is whether the two timescales
    # separate, so lay them out as a grid rather than a ranked list.
    vols = [n.split('_')[0] for n in names if '_fee' in n]
    vols = list(dict.fromkeys(vols))
    fees = list(dict.fromkeys('fee' + n.split('_fee')[1] for n in names if '_fee' in n))
    if vols and fees:
        print('\ncombined alpha grid (rows = volatility timescale, cols = fee timescale):')
        print('  %-10s' % '' + ''.join('%11s' % f for f in fees))
        for v in vols:
            cells = []
            for f in fees:
                n = f'{v}_{f}'
                cells.append('%11.2f' % sum(alpha[n].values()) if n in alpha else '%11s' % '-')
            print('  %-10s' % v + ''.join(cells))

    print('\nspread within grid = %s' % (
        '%.2f' % (max(sum(alpha[n].values()) for n in alpha if '_fee' in n)
                  - min(sum(alpha[n].values()) for n in alpha if '_fee' in n))
        if any('_fee' in n for n in alpha) else 'n/a'))
    print('Interpret against one price path and a short sample: differences '
          'smaller than one day of directional swing on one book are not real.')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'sweep.json')
