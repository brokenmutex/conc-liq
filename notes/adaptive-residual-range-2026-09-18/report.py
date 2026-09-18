#!/usr/bin/env python3
"""Compare residual-range arms.

Primary metric is net fees (fees - gas), the term that reproduced across
windows in the forecast sweep. Alpha and the directional split are reported
beside it and are NOT selected on.
"""
import json, sys, collections
u = lambda x: (int(x) / 1e6) if x is not None else float('nan')
SYMS = ['NVDA', 'AAPL', 'GOOGL']


def main(*paths):
    totals = collections.defaultdict(lambda: collections.defaultdict(float))
    for path in paths:
        d = json.load(open(path))
        print(f"\n=== {path}")
        print(f"window {d['start']} -> {d['end']}   feePpm {d['feePpm']}   horizon {d['horizonMs']//60000}m")
        names = [a['name'] for a in d['arms']]
        for sym in SYMS:
            a = d['assets'].get(sym)
            if not a:
                continue
            if 'error' in a:
                print(f"\n{sym}: {a['error']}")
                continue
            print(f"\n{sym}  rows={a['rows']} obs={a['observations']}  {a['firstAt']} -> {a['lastAt']}")
            print('  %-28s %8s %8s %8s %8s %6s %6s %7s %7s %9s %6s %6s' % (
                'arm', 'netfee', 'netfee-', 'alpha', 'direct', 'recen', 'resid',
                'earnMin', 'strdMin', 'gate', 'recenW', 'residW'))
            print('  %-28s %8s %8s %8s %8s %6s %6s %7s %7s %9s %6s %6s' % (
                '', '', 'swap', '', 'ional', '', '', '', '', 'acc/scr', 'half', 'span'))
            base = a['arms'].get('baseline')
            for n in names:
                r = a['arms'].get(n)
                if not r:
                    continue
                s = r['summary']
                # Two-sided bands are labelled by half-width; a residual band's
                # whole span is its label, so report them in separate columns.
                two = collections.Counter((x['tickUpper'] - x['tickLower']) // 2
                                          for x in r['actions'] if x['kind'] in ('entry', 'recenter'))
                one = collections.Counter(x['width'] for x in r['actions'] if x['kind'] == 'residual')
                mode = max(two, key=lambda k: two[k]) if two else 0
                rmode = max(one, key=lambda k: one[k]) if one else 0
                totals[n][sym] = u(r['netFeesQuote'])
                print('  %-28s %8.2f %8.2f %8.2f %8.2f %6d %6d %7d %7d %9s %6s %6s' % (
                    n, u(r['netFeesQuote']), u(r['netFeesAfterSwapQuote']), u(s['alphaQuote']),
                    u(r.get('directionalQuote', '0')), s['recenters'], r['residuals'],
                    r['earningMinutes'], r['strandedMinutes'],
                    f"{r['residualAccepted']}/{r['residualScored']}", mode, rmode))
            if base:
                print('  stranded minutes recovered vs baseline:', ', '.join(
                    f"{n} {100*(1-a['arms'][n]['strandedMinutes']/base['strandedMinutes']):.0f}%"
                    for n in names if n in a['arms'] and base['strandedMinutes']))
        print('\n  combined net fees over the books present:')
        for n in names:
            common = [s for s in SYMS if s in totals[n]]
            if not common:
                continue
            print('    %-28s %8.2f   (%s)' % (n, sum(totals[n][s] for s in common), ', '.join(common)))
        totals.clear()


if __name__ == '__main__':
    main(*(sys.argv[1:] or ['residual-warmed.json']))
