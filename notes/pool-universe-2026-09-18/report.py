#!/usr/bin/env python3
"""Render the pool universe screen. Ranks on fee income per unit of pool
liquidity per day, which is what a marginal unit of our capital earns."""
import json, sys
Q = 2 ** 96


def main(path):
    d = json.load(open(path))
    days = (_ts(d['until']) - _ts(d['since'])) / 86400.0
    rows = []
    for p in d['pools']:
        if 'error' in p:
            print(f"{p['symbol']}-{p['fee']}: {p['error']}")
            continue
        price = int(p['meanPrice'])
        t1to0 = lambda x: x * Q * Q // price // price
        t0to1 = lambda x: x * price // Q * price // Q
        fees, swaps, by = 0, 0, {}
        for s in p['sessions']:
            f0 = int(s['in0']) * p['fee'] // 1_000_000
            f1 = int(s['in1']) * p['fee'] // 1_000_000
            usd = f0 + t1to0(f1) if p['quoteIsToken0'] else f1 + t0to1(f0)
            fees += usd
            swaps += s['swaps']
            by[s['bucket']] = usd / 1e6
        liq = int(p['meanLiquidity'])
        rows.append(dict(sym=f"{p['symbol']}-{p['fee']}", fees=fees / 1e6, swaps=swaps, liq=liq,
                         per=(fees / 1e6) / (liq / 1e18) / days if liq else 0.0,
                         shares={(int(b['budgetQuote']), b['halfWidthTicks']): b['sharePpm'] / 10000
                                 for b in p['budgets']},
                         widths=sorted({b['halfWidthTicks'] for b in p['budgets']}),
                         spacing=p['tickSpacing'], by=by))
    rows.sort(key=lambda r: -r['per'])
    print(f"window {d['since']} -> {d['until']}  ({days:.2f} days, blocks {d['fromBlock']}..{d['toBlock']})")
    print(f"{'pool':<12}{'grossUSDG':>10}{'USDG/day':>9}{'swaps':>8}{'meanL/1e18':>11}"
          f"{'fee/L/day':>10}  {'halfW':<9}{'share@1k%':>12}{'@2.5k%':>13}{'@5k%':>13}")
    for r in rows:
        cells = []
        for budget in (1_000_000_000, 2_500_000_000, 5_000_000_000):
            vals = [f"{r['shares'][(budget, w)]:.2f}" for w in r['widths']]
            cells.append('/'.join(dict.fromkeys(vals)))
        print(f"{r['sym']:<12}{r['fees']:>10.1f}{r['fees']/days:>9.1f}{r['swaps']:>8}"
              f"{r['liq']/1e18:>11.3f}{r['per']:>10.3f}  w={'/'.join(str(w) for w in r['widths']):<7}"
              f"{cells[0]:>12}{cells[1]:>13}{cells[2]:>13}")
    print(f"\ngross USDG fees by UTC session (open = 13:30-15:00, overnight = 20:00-08:00)")
    print(f"{'pool':<12}{'open':>9}{'overnight':>10}{'other':>9}{'weekend':>9}{'open/day':>9}{'night/day':>10}")
    for r in rows:
        o, n = r['by'].get('open', 0.0), r['by'].get('overnight', 0.0)
        print(f"{r['sym']:<12}{o:>9.1f}{n:>10.1f}{r['by'].get('other',0.0):>9.1f}"
              f"{r['by'].get('weekend',0.0):>9.1f}{o/days*24/1.5:>9.2f}{n/days*24/12:>10.2f}")
    print("\nPer-hour columns divide each bucket by the hours it spans, so a pool that "
          "earns more overnight per hour than at the open is doing so on flow, not on clock time.")


def _ts(s):
    import datetime
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'universe.json')
