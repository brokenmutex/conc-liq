import pathlib,json,hashlib,shutil,csv,datetime
base=pathlib.Path('notes/lp-recenter-study-2026-09-11');art=pathlib.Path('data/lp-recenter-study-2026-09-11');r=json.loads((art/'replay-components.json').read_text());prior=json.loads((art/'replay.json').read_text());assert [a for a in r['aggregates'] if a['profile']!='common_components']==prior['aggregates'];old=json.load(open('notes/lp-offhours-cap-2026-09-11/results.json'))
manifest=json.loads((art/'validation-schedule.json').read_text());capsule=pathlib.Path(manifest['capsule'])
assert hashlib.sha256((capsule/'frozen-plan.json').read_bytes()).hexdigest()==r['planSha256']
for name,digest in r['plan']['codeHashes'].items():
 assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==digest
 assert hashlib.sha256((capsule/name).read_bytes()).hexdigest()==digest
parse=lambda s:datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
shutil.copy2(art/'replay-components.json',base/'results.json');shutil.copy2(art/'replay-components.json.sha256',base/'results.json.sha256')
for w in r['windows']:
 o=next(x for x in old['windows'] if x['startAt']==w['startAt'])
 for x in w['results']:
  if x['rangePolicy']=='hold_range' and x['profile']!='common_components':
   b=next(y for y in o['results'] if y['profile']==x['profile'] and y['cap']==x['cap'])
   for k,v in b.items():assert x[k]==v,(w['startAt'],x['cap'],k)
  p=next(p for p in r['plan']['profiles'] if p['id']==x['profile'])
  assert int(x['gas'])==x['entries']*int(p['entry'])+x['exits']*int(p['exit'])+int(x['recenterGas'])
  fills=[a for a in x['actions'] if a['kind']=='recenter'];assert len(fills)==x['recenters']
  assert sum(int(a['gas']) for a in fills)==int(x['recenterGas'])
  for a in fills:
   assert parse(a['sourceAt'])>parse(a['quotedAt'])
   assert int(a['exposurePpm'])<x['cap']
   if x['rangePolicy']=='preserve_tokens':assert a['tokenIn'] is None and a['amountIn']=='0'
   assert a['newRange']['tickUpper']-a['newRange']['tickLower']==40
  if x['available']:
   assert int(x['pnl'])==int(x['nav'])-int(r['plan']['budgetQuote']);assert int(x['alpha'])==int(x['nav'])-int(x['hold'])
   assert x['entries']==x['exits'] and not x['positionOpen']
for a in r['aggregates']:
 xs=[x for w in r['windows'] for x in w['results'] if x['profile']==a['profile'] and x['cap']==a['cap'] and x['rangePolicy']==a['rangePolicy'] and x['available']]
 assert len(xs)==a['available'];assert abs(sum(int(x['pnl']) for x in xs)/1e6/len(xs)-a['meanPnl'])<1e-12
with (base/'windows.csv').open('w') as f:
 fields=['startAt','excludedAt','profile','capPercent','rangePolicy','available','pnlUSDG','alphaUSDG','deltaSameCapUSDG','entries','exits','recenters','recenterSwaps','gasUSDG','feesUSDG','meanDeployedPercent','outsideMinutes','lateExitSeconds','invalid'];out=csv.DictWriter(f,fieldnames=fields,lineterminator='\n');out.writeheader()
 for w in r['windows']:
  for x in w['results']:
   row={k:w[k] for k in ['startAt','excludedAt']};row.update({k:x[k] for k in ['profile','rangePolicy','available','entries','exits','recenters','recenterSwaps','lateExitSeconds','invalid']});row.update(capPercent=x['cap']/10000,meanDeployedPercent=x['meanDeployedPpm']/10000 if x['meanDeployedPpm'] is not None else '',outsideMinutes=x['outsideSeconds']/60)
   for k,v in [('pnlUSDG','pnl'),('alphaUSDG','alpha'),('deltaSameCapUSDG','deltaSameCap'),('gasUSDG','gas'),('feesUSDG','fees')]:row[k]=int(x[v])/1e6 if x['available'] else ''
   out.writerow(row)
audit={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'resultsSha256':hashlib.sha256((base/'results.json').read_bytes()).hexdigest(),'baselineEveryFieldAndActionMatchesPrior':True,'gasConservedAcrossAllCycles':True,'allMovesRequireLaterSource':True,'noMoveBreachesCapAtFill':True,'noSwapPolicyContainsNoSwap':True,'everyRangeFortyRawTicksWide':True,'aggregatesIndependentlyChecked':True,'finalReplayCodeMatchesFrozenCapsule':True,'validationSchedule':json.loads((art/'validation-schedule.json').read_text())}
(base/'audit.json').write_text(json.dumps(audit,indent=2)+'\n');print('Independent report verification passed.')
