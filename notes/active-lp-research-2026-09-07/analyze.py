"""Descriptive checkpoint statistics, not a strategy backtest or a forecast."""
import json, math, statistics
from pathlib import Path
from datetime import datetime
root=Path(__file__).parent
v=json.loads((root/'observations.json').read_text())
rows=[r for r in v['checkpoints'] if r['canonical']]
points=sorted({r['block_number']:r for r in rows}.values(),key=lambda r:int(r['block_number']))
ts=lambda r:datetime.fromisoformat(r['block_timestamp'].replace('Z','+00:00')).timestamp()
prices=[int(r['pool_price_x18'])/1e18 for r in points]
gaps=[(ts(b)-ts(a))/60 for a,b in zip(points,points[1:])]
hours={}
for r in points:
 key=r['block_timestamp'][:13];hours.setdefault(key,[]).append(int(r['pool_price_x18'])/1e18)
within=[(max(p)/min(p)-1)*100 for p in hours.values() if len(p)>=3]
s=v['session']['state'];ev=v['sessionEvents'];start=next(r for r in ev if r['action']=='enter');end=next(r for r in ev if r['action']=='exit')
holding=(datetime.fromisoformat(end['source_at'].replace('Z','+00:00'))-datetime.fromisoformat(start['source_at'].replace('Z','+00:00'))).total_seconds()/3600
fees=int(s['feeValueQuote'])/1e6;gas=int(s['costsPaidQuote'])/1e6
out={'scope':'Discrete checkpoints only; intrainterval extremes may be missed. No rebalance performance backtest.',
 'checkpoints':len(points),'noncanonicalExcluded':len(v['checkpoints'])-len(rows),
 'start':points[0]['block_timestamp'],'end':points[-1]['block_timestamp'],'hours':(ts(points[-1])-ts(points[0]))/3600,
 'priceMin':min(prices),'priceMax':max(prices),'sampledHighLowPercent':(max(prices)/min(prices)-1)*100,
 'medianCheckpointGapMinutes':statistics.median(gaps),'maxGapMinutes':max(gaps),'gapsOver15Minutes':sum(g>15 for g in gaps),
 'hourBucketsAtLeast3Checkpoints':len(within),'medianSampledHourlyHighLowPercent':statistics.median(within),'maxSampledHourlyHighLowPercent':max(within),
 'session4':{'holdingHours':holding,'estimatedFeesUSDG':fees,'estimatedGasUSDG':gas,'gasToFeeRatio':gas/fees,
 'observedFeeRateUSDGPerHour':fees/holding,'hoursAtSameFeeRateToRecoverOneUSDG':holding/fees,
 'warning':'This fee rate is one short closed-market position, not a forecast and not an own-rebalance cost quote.'},
 'rebalanceReceipts':next(r for r in v['costs'] if r['action_class']=='rebalance_bundle')}
(root/'summary.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out,indent=2))
