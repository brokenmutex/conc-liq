#!/usr/bin/env python3
"""Compare session-schedule arms.

Ranks on net fees (fees - gas), the metric that reproduced across windows in
the forecast sweep, and reports the session split the schedule targets: fees
and inventory P&L inside 13:30-15:00 UTC against the rest of the day.
"""
import json, sys, collections
u = lambda x: (int(x) / 1e6) if x is not None else float('nan')
SYMS = ['NVDA', 'AAPL', 'GOOGL']


def main(*paths):
    for path in paths:
        d = json.load(open(path))
        print(f"\n=== {path}")
        print(f"window {d['start']} -> {d['end']}   feePpm {d['feePpm']}")
        names = [a['name'] for a in d['arms']]
        tot = collections.defaultdict(lambda: collections.defaultdict(float))
        for sym in SYMS:
            a = d['assets'].get(sym)
            if not a or 'error' in a:
                print(f"\n{sym}: {a.get('error') if a else 'absent'}")
                continue
            print(f"\n{sym}  obs={a['observations']} warmup={a['warmupMinutes']}m")
            print('  %-34s %8s %8s %6s %7s | %s' % (
                'arm', 'netfee', 'alpha', 'recen', 'skipped', 'open fees / open inv / rest fees / rest inv'))
            for n in names:
                r = a['arms'].get(n)
                if not r:
                    continue
                s, se = r['summary'], r['session']
                tot[n]['netfee'] += u(r['netFeesQuote']); tot[n]['alpha'] += u(s['alphaQuote'])
                tot[n]['openfee'] += u(se['open']['feesQuote']); tot[n]['openinv'] += u(se['open']['inventoryQuote'])
                tot[n]['restfee'] += u(se['rest']['feesQuote']); tot[n]['restinv'] += u(se['rest']['inventoryQuote'])
                print('  %-34s %8.2f %8.2f %6d %7d | %7.2f %8.2f %8.2f %8.2f' % (
                    n, u(r['netFeesQuote']), u(s['alphaQuote']), s['recenters'], r['blackoutSkipped'],
                    u(se['open']['feesQuote']), u(se['open']['inventoryQuote']),
                    u(se['rest']['feesQuote']), u(se['rest']['inventoryQuote'])))
        print('\n  combined over the books present:')
        print('  %-34s %8s %8s | %8s %8s %8s %8s %8s' % (
            'arm', 'netfee', 'alpha', 'openFee', 'openInv', 'restFee', 'restInv', 'openFee%'))
        for n in names:
            t = tot[n]
            share = 100 * t['openfee'] / (t['openfee'] + t['restfee']) if (t['openfee'] + t['restfee']) else 0
            print('  %-34s %8.2f %8.2f | %8.2f %8.2f %8.2f %8.2f %7.1f%%' % (
                n, t['netfee'], t['alpha'], t['openfee'], t['openinv'], t['restfee'], t['restinv'], share))
        print("\n  'open' is 13:30-15:00 UTC on non-holiday weekdays, 1.5 of every 24 hours (6.25%).")


if __name__ == '__main__':
    main(*(sys.argv[1:] or ['session-warmed.json']))
