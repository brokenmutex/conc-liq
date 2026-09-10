"""Clock-matched DEX path analysis. No oracle price is used as a volatility proxy."""
import collections,csv,datetime as dt,hashlib,json,math,pathlib,statistics,sys
from zoneinfo import ZoneInfo

NY=ZoneInfo('America/New_York')
HOLIDAYS={'2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25'}
EARLY_CLOSE={'2026-11-27','2026-12-24'}
def timestamp(s):return dt.datetime.fromisoformat(s.replace('Z','+00:00'))
def regime(t):
 d=t.astimezone(NY);day=d.date().isoformat();minute=d.hour*60+d.minute
 assert d.year==2026,'Calendar must be updated for a different year'
 if d.weekday()>=5:return 'weekend'
 if day in HOLIDAYS:return 'holiday'
 close=780 if day in EARLY_CLOSE else 960
 if 570<=minute<close:return 'regular'
 if 240<=minute<570:return 'premarket'
 if close<=minute<1200:return 'afterhours'
 return 'overnight'
def quantile(xs,p):
 xs=sorted(xs);i=(len(xs)-1)*p;lo=math.floor(i);hi=math.ceil(i)
 return xs[lo]+(xs[hi]-xs[lo])*(i-lo)
def describe(xs):return {'n':len(xs),'mean':statistics.mean(xs),'median':statistics.median(xs),'p90':quantile(xs,.9),'p95':quantile(xs,.95),'max':max(xs)} if xs else None
def check_calendar():
 for time,expected in [('2026-09-05T14:00:00Z','weekend'),('2026-09-07T14:00:00Z','holiday'),('2026-09-08T13:29:59Z','premarket'),('2026-09-08T13:30:00Z','regular'),('2026-09-08T20:00:00Z','afterhours'),('2026-09-09T00:00:00Z','overnight'),('2026-09-09T08:00:00Z','premarket'),('2026-11-27T18:00:00Z','afterhours'),('2026-12-01T14:30:00Z','regular')]:assert regime(timestamp(time))==expected

def analyze(source,paper_path,outdir,allow_internal_gaps=False):
 raw=source.read_bytes();digest=hashlib.sha256(raw).hexdigest();assert digest==pathlib.Path(str(source)+'.sha256').read_text().strip()
 data=json.loads(raw);del raw
 frames=[]
 for f in data['frames']:
  swaps=[e for e in f.pop('events') if e['name']=='Swap'];ticks=[int(e['args']['tick']) for e in swaps]+[f['tick']]
  f.update(time=timestamp(f['sourceAt']),minTick=min(ticks),maxTick=max(ticks),swaps=len(swaps),volume=sum(abs(int(e['args']['amount0'])) for e in swaps)/1e6)
  f['regime']=regime(f['time']);f['day']=f['time'].astimezone(NY).date().isoformat();frames.append(f)
 del data['frames']
 coverage=collections.defaultdict(lambda:{'seconds':0,'intervals':0,'swaps':0,'volume':0,'days':set(),'gaps':[]})
 for a,b in zip(frames,frames[1:]):
  gap=(b['time']-a['time']).total_seconds()
  same_regime=all(regime(a['time']+dt.timedelta(minutes=i))==a['regime'] for i in range(math.ceil(gap/60))) and a['regime']==b['regime']
  if same_regime and gap>0 and (allow_internal_gaps or gap<=600):
   x=coverage[a['regime']];x['seconds']+=gap;x['intervals']+=1;x['swaps']+=b['swaps'];x['volume']+=b['volume'];x['days'].update([a['day'],b['day']]);x['gaps'].append(gap)
 windows=[];rejected=collections.Counter()
 for horizon in [30,120]:
  start=0
  while start<len(frames)-1:
   a=frames[start];end=start+1
   while end<len(frames) and (frames[end]['time']-a['time']).total_seconds()<horizon*60:end+=1
   if end==len(frames):break
   b=frames[end];part=frames[start:end+1];gaps=[(y['time']-x['time']).total_seconds() for x,y in zip(part,part[1:])]
   duration=(b['time']-a['time']).total_seconds()
   same_regime=all(regime(a['time']+dt.timedelta(minutes=i))==a['regime'] for i in range(math.ceil(duration/60))) and b['regime']==a['regime']
   reason='transition' if not same_regime else 'gap' if (max(gaps)>600 and not allow_internal_gaps) or duration>horizon*60+360 else None
   if reason:rejected[f'{horizon}/{reason}']+=1;start+=1;continue
   lo=min([a['tick']]+[f['minTick'] for f in part[1:]]);hi=max([a['tick']]+[f['maxTick'] for f in part[1:]])
   # token0 is USDG and token1 NVDA, so a higher v3 tick means a LOWER NVDA price.
   move=(int(a['price'])/int(b['price']))**2-1
   peak=max(hi-a['tick'],a['tick']-lo)
   row={'horizonMinutes':horizon,'regime':a['regime'],'start':a['sourceAt'],'end':b['sourceAt'],'day':a['day'],
    'startCheckpoint':a['id'],'endCheckpoint':b['id'],'minutes':duration/60,'maxCheckpointGapSeconds':max(gaps),
    'startTick':a['tick'],'endTick':b['tick'],'minTick':lo,'maxTick':hi,'absoluteReturnPct':abs(move)*100,
    'returnPct':move*100,'endpointTicks':abs(b['tick']-a['tick']),'peakExcursionTicks':peak,
    'downPriceTicks':hi-a['tick'],'upPriceTicks':a['tick']-lo,'swaps':sum(f['swaps'] for f in part[1:]),
    'volumeUsdg':sum(f['volume'] for f in part[1:])}
   for width in [10,20,30,40,50]:row[f'cross{width}']=peak>=width
   windows.append(row);start=end
 groups=collections.defaultdict(list)
 for row in windows:groups[(row['horizonMinutes'],row['regime'])].append(row)
 aggregates=[]
 for (h,r),rs in sorted(groups.items()):
  aggregates.append({'horizonMinutes':h,'regime':r,'n':len(rs),'days':sorted(set(x['day'] for x in rs)),
   'durationMinutes':describe([x['minutes'] for x in rs]),'absoluteReturnPct':describe([x['absoluteReturnPct'] for x in rs]),
   'peakExcursionTicks':describe([x['peakExcursionTicks'] for x in rs]),'downPriceTicks':describe([x['downPriceTicks'] for x in rs]),
   'crossingPct':{str(w):100*sum(x[f'cross{w}'] for x in rs)/len(rs) for w in [10,20,30,40,50]},
   'volumePerHour':sum(x['volumeUsdg'] for x in rs)/sum(x['minutes']/60 for x in rs),
   'swapsPerHour':sum(x['swaps'] for x in rs)/sum(x['minutes']/60 for x in rs)})
 paper=json.loads(paper_path.read_text());sessions=[];exposure=collections.defaultdict(float);exits=collections.Counter();inventory_exits=collections.Counter()
 for s in paper['sessions']:
  if s['id'] not in paper['selectedIds']:continue
  obs=[o for o in paper['observations'] if o['session_id']==s['id']];entry=next((o for o in obs if o['action']=='enter'),None);signal=next((o for o in obs if o['action']=='signal_exit'),None)
  if not entry:continue
  end=next((o for o in obs if o['action']=='exit'),obs[-1]);t=timestamp(entry['source_at']);finish=timestamp(end['source_at']);seconds=collections.defaultdict(float)
  while t<finish:
   nxt=min(t+dt.timedelta(seconds=60),finish);seconds[regime(t)]+=(nxt-t).total_seconds();t=nxt
  for r,n in seconds.items():exposure[r]+=n
  reason=signal['state']['reasons'] if signal else [];sr=regime(timestamp(signal['source_at'])) if signal else None
  if signal:exits[sr]+=1
  if any('inventory' in x for x in reason):inventory_exits[sr]+=1
  sessions.append({'session':s['id'],'entry':entry['source_at'],'end':end['source_at'],'signalRegime':sr,'reasons':reason,'holdingSecondsByRegime':dict(seconds)})
 cov=[]
 for r,x in sorted(coverage.items()):cov.append({'regime':r,'hours':x['seconds']/3600,'days':sorted(x['days']),'intervals':x['intervals'],'checkpointGapSeconds':describe(x['gaps']),'swapsPerHour':x['swaps']/(x['seconds']/3600),'volumePerHour':x['volume']/(x['seconds']/3600)})
 result={'sourceSha256':digest,'manifest':data['manifest'],'first':frames[0]['sourceAt'],'last':frames[-1]['sourceAt'],
  'calendar':{'zone':'America/New_York','holidays':sorted(HOLIDAYS),'earlyClose':sorted(EARLY_CLOSE),'source':'https://www.nasdaq.com/market-activity/stock-market-holiday-schedule'},
  'coverage':cov,'aggregates':aggregates,'rejectedAnchors':dict(rejected),'allowInternalCheckpointGaps':allow_internal_gaps,
  'paperRegimes':[{'regime':r,'holdingHours':seconds/3600,'exitSignals':exits[r],'inventoryExitSignals':inventory_exits[r],'inventoryExitsPerHoldingHour':inventory_exits[r]/(seconds/3600)} for r,seconds in sorted(exposure.items())],
  'sessions':sessions,'method':{'windows':'Consecutive nonoverlapping source-clock windows within each horizon, ending at the first checkpoint at least 30 or 120 minutes later; at most 6 minutes overshoot; transitions checked every minute and excluded',
   'checkpointGaps':'Internal gaps allowed because complete canonical swap events span each interval' if allow_internal_gaps else 'Exclude windows with checkpoint gaps over 10 minutes; complete-events sensitivity includes these intervals',
   'path':'All recorded Swap endpoints between the start and end blocks plus checkpoint endpoints; captures reversals missed by checkpoint-only returns; sub-swap path is monotonic',
   'widths':'Excursions from the initial raw tick, before tick-spacing rounding or execution; diagnostic range crossings, not strategy results',
   'sample':'One partial weekend and one holiday, overlapping 30 and 120 minute analyses; no independent holdout',
   'paper':'Frozen completed-session cohort from prior audit, since Sep 8; exposure split into at-most-one-minute bins; signal regime is not entry regime; legacy infrastructure guards are confounders'}}
 outdir.mkdir(parents=True,exist_ok=True)
 (outdir/'hours-summary.json').write_text(json.dumps(result,indent=2)+'\n')
 with (outdir/'hours-windows.csv').open('w') as f:
  writer=csv.DictWriter(f,fieldnames=list(windows[0]) if windows else ['horizonMinutes','regime','start','end'],lineterminator='\n');writer.writeheader();writer.writerows(windows)
 print(json.dumps({'coverage':cov,'aggregates':aggregates,'paperRegimes':result['paperRegimes']},indent=2))

if __name__=='__main__':
 check_calendar()
 if sys.argv[1:]!=['--test-calendar']:
  args=sys.argv[1:];allow='--complete-events' in args
  if allow:args.remove('--complete-events')
  analyze(*(pathlib.Path(x) for x in args),allow_internal_gaps=allow)
