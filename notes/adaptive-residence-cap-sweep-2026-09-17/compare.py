import json,collections,datetime,sys
T=lambda ms: datetime.datetime.utcfromtimestamp(ms/1000).strftime('%m-%d %H:%M')
cfgs=[('10m no-cut','cap-10.json'),('60m','cap-60.json'),('120m','cap-120.json'),('240m','cap-240.json'),('120m no-cut','cap-120-nocut.json')]
runs={}
for label,f in cfgs:
    try: runs[label]=json.load(open(f))
    except Exception as e: print('missing',f,e)
first=next(iter(runs.values()))
print('window',first['start'],'->',first['end'])
def swapcost(sym,a):
    s=0.0
    for mk in a['marks']:
        if mk['action'] and mk['action']['token'] is not None:
            p=int(mk['price'])/1e18;tok=mk['action']['token'];ai=int(mk['action']['amountIn']);ao=int(mk['action']['amountOut']);q0=sym!='GOOGL'
            vin=ai/1e6 if (tok==0)==q0 else ai/1e18*p
            vout=ao/1e6 if (tok==1)==q0 else ao/1e18*p
            s+=max(0.0,vin-vout)
    return s
print()
print('%-6s %-12s %9s %9s %7s %6s %6s %5s %8s %6s %-28s'%('book','horizon','navMark','terminal','fees','gas','swapC','recen','inRange%','maxDD%','width histogram (entries+recenters)'))
tot=collections.defaultdict(float);totfees=collections.defaultdict(float);totcost=collections.defaultdict(float)
for sym in ['NVDA','AAPL','GOOGL']:
    for label in runs:
        a=runs[label]['assets'][sym]
        if 'error' in a: print('%-6s %-12s ERROR %s'%(sym,label,a['error']));continue
        s=a['summary'];nav=int(s['markedNavQuote'])/1e6;term=int(s['terminalCashQuote'])/1e6 if s['terminalCashQuote'] else float('nan')
        fees=int(s['feesQuote'])/1e6;gas=int(s['gasPaidQuote'])/1e6;sw=swapcost(sym,a)
        inr=100*(1-s['outsideMs']/s['holdingMs']) if s['holdingMs'] else 0
        hist=collections.Counter(x['width'] for x in (mk['action'] for mk in a['marks']) if x);hist={k:hist[k] for k in sorted(hist)}
        print('%-6s %-12s %9.2f %9.2f %7.2f %6.2f %6.2f %5d %8.0f %6.2f %-28s'%(sym,label,nav,term,fees,gas,sw,s['recenters'],inr,int(s['drawdownPpm'])/1e4,str(hist)))
        tot[label]+=nav;totfees[label]+=fees;totcost[label]+=gas+sw
    print()
print('combined (3 books, 3000 USDG start):')
for label in runs: print('  %-12s nav %8.2f  fees %6.2f  gas+swap %5.2f  => inventory effect %+6.2f'%(label,tot[label],totfees[label],totcost[label],tot[label]-3000-totfees[label]+totcost[label]))
print()
print('rejections:')
for sym in ['NVDA','AAPL','GOOGL']:
    for label in runs:
        a=runs[label]['assets'][sym]
        if 'error' in a: continue
        print('  %-5s %-12s'%(sym,label),a['summary']['rejected'],'gate accepted',a['accepted'],'/',a['scored'],'forecast unavailable',a['unavailable'])
print()
print('daily NAV change per book (UTC days), by horizon:')
days=sorted({datetime.datetime.utcfromtimestamp(mk['at']/1000).strftime('%m-%d') for a in first['assets'].values() if 'marks' in a for mk in a['marks']})
for sym in ['NVDA','AAPL','GOOGL']:
    print(' ',sym)
    print('   %-12s'%'horizon'+''.join('%8s'%d for d in days)+'   actions by day')
    for label in runs:
        a=runs[label]['assets'][sym]
        if 'error' in a: continue
        mks=a['marks'];byday=collections.OrderedDict()
        for mk in mks: byday.setdefault(datetime.datetime.utcfromtimestamp(mk['at']/1000).strftime('%m-%d'),[]).append(mk)
        prev=1000.0;cells=[];acts=[]
        for d in days:
            if d not in byday: cells.append('%8s'%'-');continue
            end=int(byday[d][-1]['nav'])/1e6;cells.append('%+8.2f'%(end-prev));prev=end
            n=sum(1 for mk in byday[d] if mk['action']);acts.append('%s:%d'%(d[3:],n) if n else '')
        print('   %-12s'%label+''.join(cells)+'   '+' '.join(x for x in acts if x))
print()
print('action timelines:')
for label in runs:
    print('==',label)
    for sym in ['NVDA','AAPL','GOOGL']:
        a=runs[label]['assets'][sym]
        if 'error' in a: continue
        acts=[(T(mk['at']),mk['action']['kind'][:3],mk['action']['width'],round(int(mk['nav'])/1e6,1),mk['horizonMin']) for mk in a['marks'] if mk['action']]
        print('  %-5s %2d:'%(sym,len(acts)),' '.join(f'{t}:{k}{w}(h{h:.0f})' for t,k,w,n,h in acts))
