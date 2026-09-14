"""Standalone research chart, preserving all predeclared arms and scenarios."""
import json
import pathlib
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

root = pathlib.Path('notes/adaptive-lp-agility-2026-09-14')
data = json.loads((root / 'summary.json').read_text())
names = ['rolling_30m', 'rolling_60m', 'ewma_15m', 'ewma_30m', 'ewma_30m_fee_blend',
         'baseline_6h_early', 'ewma_30m_early']
labels = ['30m rolling', '60m rolling', '15m volatility half-life', '30m volatility half-life',
          '30m volatility + fee blend', '6h + early decisions', '30m volatility + early decisions']
scenarios = [('pinned_fork_costs', 'Base costs'), ('double_gas_half_fees', '2x gas, 0.5x fees'),
             ('partial_mint_failure', 'Partial mint failures')]
by = {(r['symbol'], r['scenario'], r['name']): r for r in data['rows']}
values = np.array([[float(by[s, sc, name]['deltaAlphaVs6hQuote']) / 1e6
                    if by[s, sc, name]['deltaAlphaVs6hQuote'] is not None else np.nan
                    for s in ['AAPL', 'GOOGL', 'NVDA'] for sc, _ in scenarios] for name in names])
limit = max(1, np.nanmax(np.abs(values)))
fig, ax = plt.subplots(figsize=(13, 6.5))
plot = ax.imshow(values, cmap='RdBu', vmin=-limit, vmax=limit, aspect='auto')
ax.set_yticks(range(len(labels)), labels)
ax.set_xticks(range(9), [label for _ in range(3) for _, label in scenarios], rotation=25, ha='right')
for i in range(7):
    for j in range(9):
        value = values[i, j]
        ax.text(j, i, 'N/A' if np.isnan(value) else f'{value:+.1f}', ha='center', va='center',
                color='white' if abs(value) > limit * .6 else '#202020', fontsize=9)
for boundary in [2.5, 5.5]:
    ax.axvline(boundary, color='white', lw=3)
for x, symbol in [(1, 'AAPL'), (4, 'GOOGL'), (7, 'NVDA')]:
    ax.text(x, -0.8, symbol, ha='center', va='bottom', fontweight='bold', fontsize=12)
fig.colorbar(plot, ax=ax, shrink=.8, label='Change in net LP alpha versus 6h baseline (USDG)')
fig.suptitle('Does greater agility pay after costs?', fontsize=16, y=.99)
fig.text(.5, .925, '1,000 USDG per asset | Aug 30–Sep 11, 2026 | Blue improves on baseline; red worsens',
         ha='center', fontsize=10)
fig.text(.5, .015, 'Retrospective conditional replay. Common data admission. Fork-based costs. No validated live policy.',
         ha='center', fontsize=9, color='#555555')
fig.subplots_adjust(left=.26, right=.94, bottom=.23, top=.82)
fig.savefig(root / 'agility-comparison.png', dpi=180)
fig.savefig(root / 'agility-comparison.pdf')
print(root / 'agility-comparison.png')
