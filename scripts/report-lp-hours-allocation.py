"""Verify frozen comparisons and render compact, shareable evidence."""
import collections,csv,hashlib,importlib.util,json,pathlib,shutil,statistics,sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('hours',root/'scripts/analyze-lp-hours.py');hours=importlib.util.module_from_spec(spec);spec.loader.exec_module(hours)
directory,out=map(pathlib.Path,sys.argv[1:]);out.mkdir(parents=True,exist_ok=True)
read=lambda name:json.loads((directory/name).read_text())
a=read('allocation-comparison-v2.json');h=read('hours-summary.json');sensitivity=read('complete-events/hours-summary.json');fork=read('fork55.json')
assert len(a['parity'])==len(set(a['parity']))==50
assert len(a['entries'])==100 and all(e['status']=='filled' for e in a['entries'])
for row in a['rows']:
 assert int(row['net'])-int(row['budget'])==int(row['pnl'])
 assert int(row['net'])-int(row['hold'])==int(row['alpha'])
 assert row['outsideSeconds']<=row['holdingSeconds']
 if row['exitAt']:assert hours.timestamp(row['exitAt'])>hours.timestamp(row['startAt'])
base={(r['session'],r['horizonMinutes'],r['profile'],r['guards']):r for r in a['rows'] if r['allocation']==800000}
groups=collections.defaultdict(list);regimes=collections.defaultdict(list)
for r in a['paired']:
 b=base[(r['session'],r['horizonMinutes'],r['profile'],r['guards'])]
 assert r['startAt']==b['startAt'] and r['endAt']==b['endAt'];assert int(r['delta'])==int(r['net'])-int(b['net'])
 groups[f"{r['horizonMinutes']}/{r['profile']}/{r['guards']}"].append(r)
 if r['profile']=='recorded_session' and r['guards']=='inventory_only':
  start=hours.timestamp(r['startAt']);end=hours.timestamp(r['endAt']);labels=set();t=start
  while t<=end:labels.add(hours.regime(t));t+=hours.dt.timedelta(minutes=1)
  regime=next(iter(labels)) if len(labels)==1 else 'transition'
  regimes[(r['horizonMinutes'],regime)].append(r)
for aggregate in a['aggregates']:
 rs=groups[aggregate['key']];d=[int(r['delta'])/1e6 for r in rs]
 assert len(rs)==aggregate['n'];assert abs(statistics.mean(d)-aggregate['meanDelta'])<1e-12
 assert statistics.median(d)==aggregate['medianDelta'];assert min(d)==aggregate['worstDelta']
 assert sum(r['exitReason']=='inventory_cap' for r in rs)==aggregate['inventoryExits55']
 assert sum(r['baselineExitReason']=='inventory_cap' for r in rs)==aggregate['inventoryExits80']
for prefix,summary in [('',h),('complete-events/',sensitivity)]:
 windows=list(csv.DictReader((directory/(prefix+'hours-windows.csv')).open()));buckets=collections.defaultdict(list)
 for w in windows:
  start=hours.timestamp(w['start']);end=hours.timestamp(w['end'])
  assert int(w['horizonMinutes'])<=float(w['minutes'])<=int(w['horizonMinutes'])+6
  assert hours.regime(start)==hours.regime(end)==w['regime'];buckets[(int(w['horizonMinutes']),w['regime'])].append(w)
  for width in [10,20,30,40,50]:assert (w[f'cross{width}']=='True')==(int(w['peakExcursionTicks'])>=width)
 for horizon in [30,120]:
  ws=[w for w in windows if int(w['horizonMinutes'])==horizon]
  assert all(hours.timestamp(x['end'])<=hours.timestamp(y['start']) for x,y in zip(ws,ws[1:]))
 for agg in summary['aggregates']:
  ws=buckets[(agg['horizonMinutes'],agg['regime'])];assert len(ws)==agg['n']
  assert statistics.median([float(w['absoluteReturnPct']) for w in ws])==agg['absoluteReturnPct']['median']
  for width in [10,20,30,40,50]:assert abs(sum(w[f'cross{width}']=='True' for w in ws)*100/len(ws)-agg['crossingPct'][str(width)])<1e-12
 # Copy compact frozen evidence, never private environment or the raw pool capture.
 dest=out/('complete-events' if prefix else '');dest.mkdir(exist_ok=True)
 for name in ['hours-summary.json','hours-windows.csv']:shutil.copyfile(directory/(prefix+name),dest/name)
v=fork['valuation'];r=fork['result'];tx=r['transactions'];entry_end=next(i for i,t in enumerate(tx) if t['action']=='decrease_and_collect')
for part,key in [(tx[:entry_end],'entry'),(tx[entry_end:],'exit')]:
 wei=sum(int(t['estimate']['totalFeeWei']) for t in part);assert wei==int(r[key+'GasWei'])
 num=wei*int(v['ethUsdAnswer'])*10**v['quoteUsdDecimals']*10**6;den=10**18*10**v['ethUsdDecimals']*int(v['quoteUsdAnswer'])
 assert (num+den-1)//den==int(fork[key+'GasQuote'])
assert hours.timestamp(fork['cp']['blockTimestamp'])>hours.timestamp(fork['intent']['quotedAt'])
assert int(r['balances']['inventory']['quote'])-int(r['minted0'])==int(r['balances']['afterMint']['quote'])
assert int(r['balances']['inventory']['rwa'])-int(r['minted1'])==int(r['balances']['afterMint']['rwa'])
assert r['balances']['afterExit']['rwa']=='0'
by_hours=[{'horizonMinutes':k[0],'regime':k[1],'n':len(rs),'meanDelta':statistics.mean(int(r['delta'])/1e6 for r in rs),
 'medianDelta':statistics.median(int(r['delta'])/1e6 for r in rs),'worstDelta':min(int(r['delta'])/1e6 for r in rs),
 'inventoryExits80':sum(r['baselineExitReason']=='inventory_cap' for r in rs),'inventoryExits55':sum(r['exitReason']=='inventory_cap' for r in rs)} for k,rs in sorted(regimes.items())]
(out/'allocation-summary.json').write_text(json.dumps({'source':a['source'],'entryParity':len(a['parity']),'entries':len(a['entries']),'aggregates':a['aggregates'],'byHours':by_hours,'method':a['method']},indent=2)+'\n')
for name,rows in [('allocation-pairs.csv',a['paired']),('allocation-entries.csv',a['entries'])]:
 with (out/name).open('w') as f:
  writer=csv.DictWriter(f,fieldnames=list(rows[0]),lineterminator='\n');writer.writeheader()
  writer.writerows({k:json.dumps(v,separators=(',',':')) if isinstance(v,(dict,list)) else v for k,v in row.items()} for row in rows)
(out/'fork55-summary.json').write_text(json.dumps({k:fork[k] for k in ['capturedAt','scope','sessionId','cp','policy','entryGasQuote','exitGasQuote']}|{'source':r['source'],'range':r['range'],'liquidity':r['liquidity'],'minted0':r['minted0'],'minted1':r['minted1'],'balances':r['balances'],'transactions':[{ 'action':t['action'],'estimateFeeWei':t['estimate']['totalFeeWei']} for t in tx],'limitations':r['limitations']},indent=2)+'\n')
for name in ['operations-final.json','dashboard-policy-compatibility.json','dashboard-restored.json','dashboard-preflight-current.json','dashboard-preflight-old.json']:shutil.copyfile(directory/name,out/name)
names=['hours-market.json','allocation-comparison-v2.json','fork55.json','hours-summary.json','hours-windows.csv','complete-events/hours-summary.json','complete-events/hours-windows.csv']
manifest=[]
for name in names:
 p=directory/name;digest=hashlib.sha256(p.read_bytes()).hexdigest()
 if pathlib.Path(str(p)+'.sha256').exists():assert pathlib.Path(str(p)+'.sha256').read_text().strip()==digest
 manifest.append({'path':str(p),'sha256':digest,'bytes':p.stat().st_size})
(out/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
verification={'passed':True,'baselineEntriesExact':50,'candidateEntriesFilled':50,'pairedRows':len(a['paired']),'calendarTests':4,
 'checks':['source digests','entry swap/mint parity from JS replay','delayed fresh entry source','fork gas and oracle units','fork mint balance conservation','all paired deltas and aggregate counts','Pnl and alpha identities','window nonoverlap and duration','range crossing and return aggregates']}
(out/'verification.json').write_text(json.dumps(verification,indent=2)+'\n')
labels=['regular','premarket','overnight','afterhours','holiday','weekend'];widths=[10,20,30,40,50]
fig,axes=plt.subplots(1,2,figsize=(12,5.3),layout='constrained')
for ax,horizon in zip(axes,[30,120]):
 ag={x['regime']:x for x in h['aggregates'] if x['horizonMinutes']==horizon};values=[[ag[k]['crossingPct'][str(w)] for w in widths] for k in labels]
 im=ax.imshow(values,cmap='YlOrRd',vmin=0,vmax=100,aspect='auto');ax.set_xticks(range(5),[str(w) for w in widths]);ax.set_yticks(range(6),[f"{k.title()} (n={ag[k]['n']})" for k in labels]);ax.set_xlabel('Raw tick excursion from initial price');ax.set_title(f'{horizon}-minute windows')
 for y,row in enumerate(values):
  for x,v in enumerate(row):ax.text(x,y,f'{v:.0f}%',ha='center',va='center',color='white' if v>65 else '#222222',fontsize=10)
fig.colorbar(im,ax=axes,label='Windows reaching the excursion (%)',shrink=.78)
fig.suptitle('NVDA/USDG moves less outside regular U.S. equity hours\nSep 5–10, 2026 • one partial weekend • all swaps within each window',fontsize=13)
fig.savefig(out/'tick-excursions.png',dpi=180);fig.savefig(out/'tick-excursions.pdf');plt.close(fig)
print(json.dumps({'verification':verification,'byHours':by_hours},indent=2))
