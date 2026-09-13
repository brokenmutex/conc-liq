"""Summarize immutable live receipts and completed management episodes."""
import json, sys, hashlib, statistics
from pathlib import Path
from datetime import datetime
root = Path(sys.argv[1])
p = json.loads((root / 'live-ledger.json').read_text())
ts = sorted(p['transitions'], key=lambda t: int(t['id']))
ms = lambda s: int(datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()*1000)
actions = p['actions']
episodes = []
active = None
last_phase = None
for t in ts:
    phase = t['state']['phase']
    if phase in ('entry','recenter','exit') and phase != last_phase:
        # A halted mint recovery belongs to the original recenter episode.
        if not (active and active['kind'] == phase and last_phase == 'halted'):
            if active:
                active.update(end=t['at'], outcome='interrupted_'+phase)
                episodes.append(active)
            active = dict(kind=phase,start=t['at'],initialGasQuote=t['state']['gasSpentQuote'])
    if active and phase in ('holding','closed'):
        active.update(end=t['at'],outcome='complete',finalGasQuote=t['state']['gasSpentQuote'])
        episodes.append(active); active=None
    last_phase=phase
if active:
    active.update(end=p['at'],outcome='open');episodes.append(active)
for ep in episodes:
    aa=[a for a in actions if ms(ep['start'])<=ms(a['created_at'])<ms(ep['end'])]
    rr=[a for a in aa if a['status'] in ('confirmed','reverted')]
    ep['durationMs']=ms(ep['end'])-ms(ep['start'])
    ep['actions']=[dict(id=a['id'],action=a['action'],status=a['status'],hash=a['hash'],createdAt=a['created_at'],receiptAtMs=int(a['receipt']['after']['timestamp'])*1000 if a['receipt'] else None,gasQuote=a['receipt']['gasValuation']['quote'] if a['receipt'] and a['receipt']['gasValuation'] else None) for a in aa]
    ep['gasQuote']=sum(int(a['receipt']['gasValuation']['quote']) for a in rr)
    if ep['outcome']=='complete':
        assert ep['gasQuote']==int(ep['finalGasQuote'])-int(ep['initialGasQuote'])
    ep['reverts']=sum(a['status']=='reverted' for a in aa)
    successful=[a for a in ep['actions'] if a['status']=='confirmed']
    def stage(name):
        rows=[a for a in successful if a['action']==name]
        return rows[-1]['receiptAtMs']-ms(ep['start']) if rows else None
    ep['withdrawMs']=stage('withdraw');ep['swapMs']=stage('swap');ep['mintMs']=stage('mint')
    # Delays include observed approvals and reconciliations. Gas stages partition
    # actual receipts, including a failed mint when present.
    cut1=ms(ep['start'])+(ep['withdrawMs'] or 0)
    cut2=ms(ep['start'])+(ep['swapMs'] or ep['withdrawMs'] or 0)
    gas=[0,0,0]
    for a in ep['actions']:
        if a['gasQuote'] is not None:
            gas[0 if a['receiptAtMs']<=cut1 else 1 if a['receiptAtMs']<=cut2 else 2]+=int(a['gasQuote'])
    ep['stageGasQuote']=gas;assert sum(gas)==ep['gasQuote']
def distribution(xs):
    xs=sorted(xs)
    return dict(n=len(xs),min=xs[0],median=statistics.median(xs),p90=xs[(len(xs)*9+9)//10-1],max=xs[-1]) if xs else None
groups={}
for kind in ('entry','recenter','exit'):
    good=[ep for ep in episodes if ep['kind']==kind and ep['outcome']=='complete']
    profiles=sorted(good,key=lambda ep:ep['durationMs'])
    groups[kind]=dict(count=len(good),gasQuote=distribution([ep['gasQuote'] for ep in good]),durationMs=distribution([ep['durationMs'] for ep in good]),profiles={name:profiles[i] for name,i in [('median',(len(profiles)-1)//2),('p90',(len(profiles)*9+9)//10-1)]})
total=sum(int(a['receipt']['facts']['gasWei']) for a in actions if a['receipt'])
quote=sum(int(a['receipt']['gasValuation']['quote']) for a in actions if a['receipt'])
assert total==int(p['campaign']['state']['gasSpentWei']);assert quote==int(p['campaign']['state']['gasSpentQuote'])
out=dict(sourceSha256=hashlib.sha256((root/'live-ledger.json').read_bytes()).hexdigest(),capturedAt=p['at'],groups=groups,episodes=episodes,receiptCount=sum(bool(a['receipt']) for a in actions),gasWei=str(total),gasQuote=quote,checks=dict(receiptGasMatchesCampaign=True,episodeGasMatchesTransitions=True),limitations=['Only one NVDA wallet over about two days; cross-asset transfer is an assumption.','Completed episodes include recovery delays and reverted transactions; interrupted episodes remain separately visible.','Receipt inclusion time and controller completion time differ.'])
(root/'calibration.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({k:{a:b for a,b in v.items() if a!='profiles'} for k,v in groups.items()},indent=2))
