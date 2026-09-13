"""Cross-asset comparisons with explicit paired denominators and no candidate reselection."""
import csv
import json
from pathlib import Path
from datetime import datetime, timezone
import sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

root, out = map(Path, sys.argv[1:3])
out.mkdir(parents=True, exist_ok=True)
read = lambda p: json.loads(p.read_text())
d = read(root / 'summary.json')
inclusion = read(root / 'inclusion.json')
rows = d['rows']
assets = [a['symbol'] for a in inclusion['included']]
mark_diagnostics = {r['symbol']: r for r in read(root / 'mark-diagnostics.json')['rows']}
boundary_assets = {s for s, r in mark_diagnostics.items() if r['counts']['empty_boundary']}
asset_labels = [a + ('*' if a in boundary_assets else '') for a in assets]
names = ['fixed_20', 'fixed_40', 'fixed_80', 'fixed_160', 'adaptive_width', 'adaptive_economic']
labels = ['Fixed ±20', 'Fixed ±40', 'Fixed ±80', 'Fixed ±160', 'Adaptive width', 'Adaptive + gate']
scenarios = ['pinned_fork_costs', 'double_gas_half_fees', 'partial_mint_failure']
budgets = ['250000000', '1000000000', '5000000000']
lookup = {(r['symbol'], r['budgetQuote'], r['scenario'], r['name']): r for r in rows}
valid = lambda r: r['invalid'] is None and r['alphaQuote'] is not None
reconstruction = { (r['symbol'], r['budgetQuote'], r['scenario'], r['name']): r for a in assets for r in read(root / f'reconstruction-{a}.json')['rows'] }
comparisons = []
for scope, symbols in [('all_assets', assets), ('added_assets', [a for a in assets if a not in ['AAPL', 'GOOGL']])]:
    for budget in budgets:
        for scenario in scenarios:
            for control in ['fixed_20', 'fixed_40', 'fixed_80', 'fixed_160', 'adaptive_economic']:
                pairs = [(lookup[a, budget, scenario, 'adaptive_width'], lookup[a, budget, scenario, control]) for a in symbols]
                available = [(a,b) for a,b in pairs if valid(a) and valid(b)]
                differences = [int(a['alphaQuote']) - int(b['alphaQuote']) for a,b in available]
                comparisons.append(dict(scope=scope, budgetQuote=budget, scenario=scenario, control=control,
                    universeAssets=len(symbols), comparableAssets=len(available), adaptiveWins=sum(x>0 for x in differences), ties=sum(x==0 for x in differences),
                    medianAlphaDifferenceQuote=float(np.median(differences)) if differences else None,
                    meanAlphaDifferenceQuote=float(np.mean(differences)) if differences else None,
                    summedAlphaDifferenceQuote=str(sum(differences)),
                    emptyBoundaryMarkAssets=sorted(set(symbols) & boundary_assets),
                    comparableEmptyBoundaryMarkAssets=sorted({a['symbol'] for a,b in available} & boundary_assets),
                    omitted=[a['symbol'] for a,b in pairs if not (valid(a) and valid(b))]))
(out / 'comparisons.json').write_text(json.dumps(comparisons, indent=2)+'\n')
headline=[]
for symbol in assets:
    base=lookup[symbol,'5000000000','pinned_fork_costs','adaptive_width']
    raw=read(root/'runs'/f'{symbol}-5000000000'/'results.json')
    detailed=next(r for r in raw['results'] if r['scenario']=='pinned_fork_costs' and r['name']=='adaptive_width')
    audit=reconstruction[symbol,'5000000000','pinned_fork_costs','adaptive_width']
    item=dict(symbol=symbol, commonEntryAt=base['fromAt'], lastSourceAt=base['toAt'], adaptiveInvalid=base['invalid'], adaptiveTerminalExecutable=base['terminalExecutable'], adaptiveBasePnlQuote=base['netPnlQuote'], adaptiveMarkedNavQuote=base['markedNavQuote'], adaptiveDrawdownPpm=base['drawdownPpm'], adaptiveFirstActionAt=detailed['actions'][0]['at'] if detailed['actions'] else None, adaptiveActionCount=len(detailed['actions']), adaptiveFeesQuote=base['feesQuote'], adaptiveGasQuote=base['totalGasWithExitQuote'],
        adaptiveOutsideFraction=base['outsideMs']/base['holdingMs'] if base['holdingMs'] else None,
        adaptiveForecastUnavailable=base['rejected'].get('forecast_unavailable',0),
        adaptiveFeesAbove10PercentExistingFraction=int(audit['modeledFeesAbove10PercentExistingQuote'])/int(base['feesQuote']) if int(base['feesQuote']) else None,
        adaptiveFeesAbove100PercentExistingFraction=int(audit['modeledFeesAbove100PercentExistingQuote'])/int(base['feesQuote']) if int(base['feesQuote']) else None,
        postAvailabilityMarkDiagnostics=dict(counts=mark_diagnostics[symbol]['counts'],intervalMs=mark_diagnostics[symbol]['intervalMs']),
        alphaAt5000={scenario:{name:lookup[symbol,'5000000000',scenario,name]['alphaQuote'] if valid(lookup[symbol,'5000000000',scenario,name]) else None for name in names} for scenario in scenarios})
    headline.append(item)
(out/'headline.json').write_text(json.dumps(headline,indent=2)+'\n')

fields = ['symbol','budgetQuote','scenario','name','fromAt','toAt','preBenchmarkCashWaitMs','netPnlQuote','alphaQuote','markedNavQuote','terminalCashQuote','holdTerminalCashQuote','terminalExecutable','feesQuote','gasPaidQuote','terminalExitCostQuote','totalGasWithExitQuote','entries','recenters','partialFailures','outsideMs','holdingMs','fullWindowMs','drawdownPpm','averageRiskyExposurePpm','maximumRiskyExposurePpm','averageDeploymentPpm','maximumLiquidityToExistingPpm','sourceGapMs','emptyLiquidityMarks','emptyBoundaryMarks','invalid']
with (out / 'results.csv').open('w', newline='') as f:
    writer = csv.DictWriter(f, fields, extrasaction='ignore', lineterminator='\n'); writer.writeheader()
    writer.writerows(dict(r,emptyLiquidityMarks=mark_diagnostics[r['symbol']]['counts']['empty'],emptyBoundaryMarks=mark_diagnostics[r['symbol']]['counts']['empty_boundary']) for r in rows)
with (out / 'weekly.csv').open('w', newline='') as f:
    fields = ['symbol','budgetQuote','scenario','name','key','fromAt','toAt','navChangeQuote','holdChangeQuote','alphaQuote','feesQuote','gasQuote','actions','marks','holdingMs','outsideMs']
    writer = csv.DictWriter(f, fields, extrasaction='ignore', lineterminator='\n'); writer.writeheader()
    for r in rows:
        for w in r['weekly']:
            writer.writerow(dict(w, **{k:r[k] for k in ['symbol','budgetQuote','scenario','name']}))
with (out / 'forecast.csv').open('w', newline='') as f:
    fields = ['symbol','budgetQuote','width','count','emptyBoundaryMarks','meanAbsoluteErrorQuote','baselineMeanAbsoluteErrorQuote','relativeErrorReduction','meanPredictedQuote','meanActualQuote']
    writer=csv.DictWriter(f, fields, lineterminator='\n');writer.writeheader()
    forecasts={(r['symbol'],r['budgetQuote'],r['width']):r for r in d['forecastMetrics']}
    for symbol in assets:
        for budget in budgets:
            for width in [20,40,80,160]:
                r=forecasts.get((symbol,budget,width))
                if r is None:
                    writer.writerow(dict(symbol=symbol,budgetQuote=budget,width=width,count=0,emptyBoundaryMarks=mark_diagnostics[symbol]['counts']['empty_boundary']))
                    continue
                count=r['count']; error=int(r['absoluteError']); baseline=int(r['trailingAbsoluteError'])
                assert count > 0
                writer.writerow(dict(symbol=symbol, budgetQuote=budget, width=width, count=count,emptyBoundaryMarks=mark_diagnostics[symbol]['counts']['empty_boundary'],
                    meanAbsoluteErrorQuote=error/count, baselineMeanAbsoluteErrorQuote=baseline/count,
                    relativeErrorReduction=(baseline-error)/baseline if baseline else None,
                    meanPredictedQuote=int(r['predicted'])/count, meanActualQuote=int(r['actual'])/count))
with (out / 'universe.csv').open('w', newline='') as f:
    fields=['symbol','pool','fee','createdBlock','inStudy','reasons']; writer=csv.DictWriter(f, fields, lineterminator='\n'); writer.writeheader()
    writer.writerows(dict(a, reasons=';'.join(a['reasons'])) for a in inclusion['screeningUniverse'])
with (out / 'capacity.csv').open('w', newline='') as f:
    fields=list(next(iter(reconstruction.values())));writer=csv.DictWriter(f, fields, lineterminator='\n');writer.writeheader();writer.writerows(reconstruction.values())
fig, axes = plt.subplots(1, 2, figsize=(13, 8), sharey=True)
for ax, scenario, title in zip(axes, scenarios[:2], ['Base costs', 'Double gas / half fees']):
    values=np.array([[100*int(lookup[a,'5000000000',scenario,n]['alphaQuote'])/5e9 if valid(lookup[a,'5000000000',scenario,n]) else np.nan for n in names] for a in assets])
    limit=max(1,float(np.nanmax(np.abs(values))));im=ax.imshow(values, cmap='RdYlGn', vmin=-limit, vmax=limit, aspect='auto')
    for i in range(len(assets)):
        for j in range(len(names)):
            x=values[i,j];ax.text(j,i,'N/A' if np.isnan(x) else f'{x:+.1f}',ha='center',va='center',fontsize=8,color='white' if abs(x)>limit*.65 else 'black')
    ax.set_xticks(range(6), ['±20','±40','±80','±160','Adaptive','Adaptive\n+ gate'], fontsize=8)
    ax.set_yticks(range(len(assets)),asset_labels);ax.set_title(title)
    fig.colorbar(im,ax=ax,fraction=.046,pad=.04,label='Alpha / initial capital (%)')
fig.suptitle(f'{len(assets)}-pool universe: 5,000 USDG per asset — net alpha versus passive')
fig.text(.5,.015,'July 28–September 11 · Different histories · N/A: capital invalid or exit unavailable · *: empty-book boundary marks',ha='center',fontsize=8)
fig.tight_layout(rect=(0,.04,1,.96))
for ext in ['png','pdf']:fig.savefig(out/f'cross-asset-alpha.{ext}',dpi=170)
plt.close(fig)
fig, ax=plt.subplots(figsize=(12,8))
values=np.array([[100*(int(lookup[a,b,s,'adaptive_width']['alphaQuote'])-int(lookup[a,b,s,'fixed_40']['alphaQuote']))/int(b) if valid(lookup[a,b,s,'adaptive_width']) and valid(lookup[a,b,s,'fixed_40']) else np.nan for s in scenarios for b in budgets] for a in assets])
limit=max(1,float(np.nanmax(np.abs(values)))); im=ax.imshow(values,cmap='RdYlGn',vmin=-limit,vmax=limit,aspect='auto')
for i in range(len(assets)):
    for j in range(9):
        x=values[i,j];ax.text(j,i,'N/A' if np.isnan(x) else f'{x:+.1f}',ha='center',va='center',fontsize=8,color='white' if abs(x)>limit*.65 else 'black')
ax.set_xticks(range(9),[f'{label}\n{int(b)/1e6:,.0f}' for label in ['Base','Stress','Mint failure'] for b in budgets],fontsize=8)
ax.set_yticks(range(len(assets)),asset_labels);ax.set_title('Adaptive width minus fixed ±40: alpha difference / capital (%)')
for x in [2.5,5.5]:ax.axvline(x,color='white',lw=2)
fig.colorbar(im,ax=ax,label='Percentage points; positive favors adaptive width')
fig.text(.5,.015,'Parameters frozen · Different histories · N/A: capital invalid or exit unavailable · *: empty-book boundary marks',ha='center',fontsize=8)
fig.tight_layout(rect=(0,.04,1,1))
for ext in ['png','pdf']:fig.savefig(out/f'adaptive-vs-fixed40.{ext}',dpi=170)
plt.close(fig)
print(json.dumps({'assets':len(assets),'rows':len(rows),'comparisons':len(comparisons),'output':str(out)}))
