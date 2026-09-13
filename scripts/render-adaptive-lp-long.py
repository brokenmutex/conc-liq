"""Render frozen continuous results without selecting candidates."""
import csv
import json
from pathlib import Path
import sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime, timezone

root = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
d = json.loads((root / 'summary.json').read_text())
rows = d['rows']
names = ['fixed_20', 'fixed_40', 'fixed_80', 'fixed_160', 'adaptive_width', 'adaptive_economic']
labels = ['Fixed ±20', 'Fixed ±40', 'Fixed ±80', 'Fixed ±160', 'Adaptive width', 'Adaptive + gate']
colors = ['#2875a7', '#729b39', '#7957a5', '#777777', '#db8b31', '#b64b68']
fig, axes = plt.subplots(1, 2, figsize=(12, 4.8))
for ax, symbol in zip(axes, ['AAPL', 'GOOGL']):
    for name, label, color in zip(names, labels, colors):
        r = next(r for r in rows if r['symbol'] == symbol and r['budgetQuote'] == '5000000000' and r['scenario'] == 'pinned_fork_costs' and r['name'] == name)
        total = 0
        xs, ys = [], []
        for w in r['weekly']:
            total += int(w['alphaQuote'])
            xs.append(datetime.fromtimestamp(w['toAt'] / 1000, timezone.utc))
            ys.append(total / 1e6)
        ax.plot(xs, ys, marker='o', ms=3, label=label, color=color)
    ax.set_title(symbol + ' / USDG — 5,000 USDG')
    ax.axhline(0, color='#666666', lw=.7)
    ax.set_ylabel('Cumulative alpha versus passive (USDG)')
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%b %d'))
    ax.grid(alpha=.2)
axes[0].legend(fontsize=8, ncol=2)
fig.suptitle('Continuous inventory across weeks — conditional historical replay')
fig.text(.5, .01, 'July 28–September 11, 2026 · Cash until common entry is executable · Final point includes liquidation · No execution eligibility', ha='center', fontsize=8)
fig.tight_layout(rect=(0, .04, 1, .94))
for extension in ['png', 'pdf']:
    fig.savefig(out / ('weekly-alpha.' + extension), dpi=180)
plt.close(fig)
scenarios = [('pinned_fork_costs', 'Base costs'), ('double_gas_half_fees', 'Double gas / half fees'), ('partial_mint_failure', 'Every fifth recenter mint fails')]
fig, axes = plt.subplots(2, 3, figsize=(16, 7.5))
for i, symbol in enumerate(['AAPL', 'GOOGL']):
    for j, (scenario, title) in enumerate(scenarios):
        ax = axes[i, j]
        invalid = []
        for k, (budget, color) in enumerate(zip(['250000000', '1000000000', '5000000000'], ['#2875a7', '#db8b31', '#b64b68'])):
            values = []
            for name in names:
                r = next(r for r in rows if r['symbol'] == symbol and r['budgetQuote'] == budget and r['scenario'] == scenario and r['name'] == name)
                if r['invalid'] is not None:
                    invalid.append(f"{int(budget)/1e6:,.0f} USDG {labels[names.index(name)]}: {r['invalid']}")
                values.append(100 * int(r['alphaQuote']) / int(budget) if r['alphaQuote'] is not None and r['invalid'] is None else float('nan'))
            ax.bar([n + (k-1)*.25 for n in range(len(names))], values, width=.24, color=color, label=f'{int(budget)/1e6:,.0f} USDG')
        ax.set_xticks(range(6), ['±20', '±40', '±80', '±160', 'Adaptive\nwidth', 'Adaptive\n+ gate'], fontsize=8)
        ax.axhline(0, color='#666666', lw=.7)
        ax.set_title(symbol + ' — ' + title)
        ax.set_ylabel('Net alpha / initial capital (%)')
        ax.grid(axis='y', alpha=.2)
        ax.set_axisbelow(True)
        if invalid:
            ax.text(.02, .98, '\n'.join(invalid), transform=ax.transAxes, va='top', fontsize=7, bbox=dict(facecolor='white', alpha=.85, edgecolor='none'))
axes[0, 0].legend(fontsize=8)
fig.suptitle('Capacity and cost sensitivity — same availability boundary across sizes')
fig.text(.5, .01, 'Retrospective modeled returns · Historical prices and market flow held fixed · No policy promotion', ha='center', fontsize=9)
fig.tight_layout(rect=(0, .035, 1, .95))
for extension in ['png', 'pdf']:
    fig.savefig(out / ('capacity-alpha.' + extension), dpi=180)
plt.close(fig)
fields = ['symbol', 'budgetQuote', 'scenario', 'name', 'fromAt', 'toAt', 'preBenchmarkCashWaitMs', 'netPnlQuote', 'alphaQuote', 'feesQuote', 'totalGasWithExitQuote', 'entries', 'recenters', 'partialFailures', 'outsideMs', 'holdingMs', 'fullWindowMs', 'drawdownPpm', 'maximumLiquidityToExistingPpm', 'sourceGapMs', 'invalid']
with (out / 'results.csv').open('w', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore', lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
with (out / 'weekly.csv').open('w', newline='') as f:
    fields = ['symbol', 'budgetQuote', 'scenario', 'name', 'key', 'fromAt', 'toAt', 'navChangeQuote', 'holdChangeQuote', 'alphaQuote', 'feesQuote', 'gasQuote', 'actions', 'marks', 'holdingMs', 'outsideMs']
    writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore', lineterminator='\n')
    writer.writeheader()
    for r in rows:
        for w in r['weekly']:
            writer.writerow(dict(w, **{k: r[k] for k in ['symbol', 'budgetQuote', 'scenario', 'name']}))
print(json.dumps({'rows': len(rows), 'output': str(out)}))
