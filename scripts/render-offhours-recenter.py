import json,pathlib,datetime
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as dates
base=pathlib.Path('notes/lp-recenter-study-2026-09-11');d=json.loads((base/'chart-data.json').read_text())
at=lambda s:datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
prices=lambda tick:10**12*1.0001**(-tick)
ts=[at(f['at']) for f in d['frames']];ys=[prices(f['tick']) for f in d['frames']]
fig,axs=plt.subplots(3,1,figsize=(12,8),sharex=True,sharey=True,layout='constrained')
names={'hold_range':'Hold range until exit','preserve_tokens':'Recenter using existing tokens','net_swap':'Recenter with net balancing swap'}
for ax,r in zip(axs,d['results']):
 ax.plot(ts,ys,color='#202b3c',lw=1.1,label='Market price',zorder=3)
 begin=None;band=None
 def draw(end):
  if begin is None:return
  lo,hi=prices(band['tickUpper']),prices(band['tickLower'])
  ax.fill_between([begin,end],[lo,lo],[hi,hi],color='#2389b4',alpha=.17)
  ax.hlines([lo,hi],begin,end,colors='#2389b4',linewidths=.8)
 for a in r['actions']:
  t=at(a['sourceAt'])
  if a['kind']=='entry':begin=t;band=a['range']
  elif a['kind']=='recenter':
   draw(t);begin=t;band=a['newRange'];ax.axvline(t,color='#e07a25',lw=.7,alpha=.65)
  elif a['kind']=='exit':draw(t);begin=None;band=None;ax.axvline(t,color='#aa3f49',lw=.9,ls='--')
 draw(at(d['end']))
 ax.set_title(f"{names[r['rangePolicy']]} · {r['recenters']} moves · window P&L {int(r['pnl'])/1e6:+.2f} USDG",loc='left',fontsize=10)
 ax.set_ylabel('USDG / NVDA');ax.grid(alpha=.2)
axs[-1].xaxis.set_major_formatter(dates.DateFormatter('%H:%M',tz=datetime.timezone.utc))
axs[-1].set_xlabel('September 9 20:00 through September 10 08:00 UTC')
fig.suptitle('Same market path and 80% inventory cap: what the range policies actually do',fontsize=13)
axs[0].plot([],[],color='#2389b4',lw=5,alpha=.3,label='LP range');axs[0].plot([],[],color='#e07a25',lw=1,label='Recenter fill');axs[0].plot([],[],color='#aa3f49',lw=1,ls='--',label='Cash exit');axs[0].legend(loc='lower left',fontsize=8,ncol=4)
fig.savefig(base/'range-moves.png',dpi=170);plt.close(fig)
