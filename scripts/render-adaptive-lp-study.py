"""Render the frozen retrospective comparison; never selects a policy."""
import csv
import json
import pathlib
import sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
data = json.loads((root / 'summary.json').read_text())
rows = data['rows']
names = ['fixed_20', 'fixed_40', 'fixed_80', 'fixed_160', 'adaptive_width', 'adaptive_economic']
labels = ['±20', '±40', '±80', '±160', 'Adaptive\nwidth', 'Adaptive\n+ gate']
scenarios = [('pinned_fork_costs', 'Pinned fork costs', '#2875a7'),
             ('double_gas_half_fees', 'Double gas / half fees', '#db8b31'),
             ('partial_mint_failure', 'Every fifth recenter mint fails', '#b64b68')]
fig, axes = plt.subplots(1, 2, figsize=(12, 4.8))
for axis, symbol in zip(axes, ['AAPL', 'GOOGL']):
    for j, (scenario, label, color) in enumerate(scenarios):
        values = []
        for name in names:
            row = next(r for r in rows if r['phase'] == 'retrospective_test' and r['symbol'] == symbol and r['scenario'] == scenario and r['name'] == name)
            values.append(float(row['alphaQuote']) / 1e6 if row['alphaQuote'] is not None else float('nan'))
        axis.bar([i + (j-1)*.25 for i in range(len(names))], values, width=.24, label=label, color=color)
    axis.axhline(0, color='#666666', lw=.7)
    axis.set_title(symbol + ' / USDG')
    axis.set_xticks(range(len(names)), labels)
    axis.set_ylabel('Net alpha versus liquidated passive holdings (USDG)')
    axis.grid(axis='y', alpha=.2)
    axis.set_axisbelow(True)
axes[0].legend(fontsize=8)
fig.suptitle('Conditional historical replay — 5,000 USDG per candidate', fontsize=13)
fig.text(.5, .01, 'September 9–11, 2026 · Retrospective evidence · Estimated costs and fixed recorded market path · No execution eligibility', ha='center', fontsize=8)
fig.tight_layout(rect=(0, .04, 1, .95))
fig.savefig(output / 'net-alpha.png', dpi=180)
fig.savefig(output / 'net-alpha.pdf')
plt.close(fig)
fields = ['symbol', 'phase', 'scenario', 'name', 'netPnlQuote', 'alphaQuote', 'feesQuote', 'totalGasWithExitQuote', 'entries', 'recenters', 'partialFailures', 'outsideMs', 'holdingMs', 'drawdownPpm', 'averageDeploymentPpm', 'maximumRiskyExposurePpm', 'partialFeeSegments', 'feeApportionmentGapQuote', 'sourceGapMs', 'invalid']
with (output / 'results.csv').open('w', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore', lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
print(json.dumps({'rows': len(rows), 'output': str(output)}))
