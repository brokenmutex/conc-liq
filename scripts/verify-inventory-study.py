"""Independent checks for the frozen study's accounting comparisons and outputs."""
import collections,hashlib,json,pathlib,statistics,sys
p=pathlib.Path(sys.argv[1]);a=json.loads((p/'inventory-study-v2.json').read_text());metrics=json.loads((p/'session-metrics.json').read_text());parity=json.loads((p/'recorded-action-parity.json').read_text())
assert hashlib.sha256((p/'paper-source.json').read_bytes()).hexdigest()==a['source']['paperSha256']
assert hashlib.sha256((p/'market-source.json').read_bytes()).hexdigest()==a['source']['marketSha256']
assert len(a['sessionRows'])==50==len(parity['sessions'])
for field,total in [('pnl','pnl'),('fees','fees'),('gas','gas')]:assert sum(int(r[field]) for r in a['sessionRows'])==int(metrics['totals'][total])
keys=lambda r:(r['session'],r['trigger'],r['horizonMinutes'],r['profile'],r['feePpm'])
base={keys(r):r for r in a['rows'] if r['strategy']=='guard60'}
groups=collections.defaultdict(list)
for r in a['rows']:
 b=base[keys(r)];assert r['anchorCheckpoint']==b['anchorCheckpoint'] and r['endAt']==b['endAt']
 assert (r['delta'] is None)==(r['net'] is None or b['net'] is None)
 if r['delta'] is not None:assert int(r['delta'])==int(r['net'])-int(b['net'])
 assert r['recenters']==sum(x['kind']=='recenter' for x in r['actions'])
 assert r['trims']==sum(x['kind']=='trim' for x in r['actions'])
 assert r['recenters']+r['trims']<=1
 for action in r['actions']:
  if action['kind']!='exit':assert action['delaySeconds']>0
 group='/'.join(map(str,[r['trigger'],r['horizonMinutes'],r['profile'],r['feePpm'],r['cooldown'],r['strategy']]));groups[group].append(r)
for g in a['aggregates']:
 rs=groups[g['key']];ds=[int(r['delta'])/1e6 for r in rs if r['delta'] is not None]
 assert len(rs)==g['n'];assert len(ds)==g['available'];assert abs(statistics.mean(ds)-g['meanDelta'])<1e-12
 assert statistics.median(ds)==g['medianDelta'];assert min(ds)==g['worstDelta'];assert max(ds)==g['bestDelta'];assert sum(d>0 for d in ds)==g['wins']
for name in ['exit','recenter','preserve','trim']:
 x=json.loads((p/(name+'-54.json')).read_text());r=x['result'];v=x['valuation']
 assert x['paperSha256']==a['source']['paperSha256'];assert x['marketSha256']==a['source']['marketSha256']
 wei=sum(int(t['estimate']['totalFeeWei']) for t in r['transactions']);assert wei==int(r['totalGasWei'])
 numerator=wei*int(v['ethUsdAnswer'])*10**v['quoteUsdDecimals']*10**6;denominator=10**18*10**v['ethUsdDecimals']*int(v['quoteUsdAnswer'])
 assert (numerator+denominator-1)//denominator==int(x['gasQuote'])
print(json.dumps({'passed':True,'sessions':len(a['sessionRows']),'scenarioRows':len(a['rows']),'aggregates':len(groups),'forkActions':4,'checks':['input hashes','recorded money totals','common anchors and horizons','paired deltas','action timing and counts','aggregate statistics','fork gas units and oracle conversion']},indent=2))
