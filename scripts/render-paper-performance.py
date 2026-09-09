"""Render frozen paper audit evidence; matplotlib is only needed for plotting."""
import json, sys, statistics
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
report_path, source_path, partial_path, out_dir = sys.argv[1:]
r=json.loads(Path(report_path).read_text()); src=json.loads(Path(source_path).read_text()); partial=json.loads(Path(partial_path).read_text())
out=Path(out_dir);out.mkdir(parents=True,exist_ok=True)
sessions=r['sessions'];closed=[s for s in sessions if s['status']=='closed'];tz=ZoneInfo('Europe/Vilnius')
def dt(s):return datetime.fromisoformat(s.replace('Z','+00:00'))
def local(s):return dt(s).astimezone(tz).strftime('%d %b %H:%M:%S') if s else '—'
def usd(v,n=6):return f'{int(v)/1e6:,.{n}f}' if v is not None else 'unavailable'
def group(s):
 if 'paper_inventory_threshold_exit_to_cash' in s['exitReasons']:return 'Inventory ≥60%'
 if any(x.startswith('chain_') for x in s['exitReasons']):return 'Chain readiness'
 if 'paper_usdg_oracle_price_stale' in s['exitReasons']:return 'USDG oracle stale'
 if 'paper_current_risk_evidence_unavailable' in s['exitReasons']:return 'Risk refresh unavailable'
 return 'Open'
def total(xs,k):return sum(int(x[k]) for x in xs)
notes={
'5':'Small positive absolute P&L, but holding earned more. A private syncing signal at 13:14:03 Vilnius reset recovery; the exit followed about five minutes after its signal. Considerable time was already outside the range, limiting fees. This precedes the small-lag fix.',
'6':'A 42-block / four-second private delay caused degradation and a confirmation-depth failure. Fees did not cover gas. The earlier ten-block anchor adjustment deliberately does not exempt a 42-block delay.',
'7':'Worst trade. NVDA exposure reached 69.81% at the signal and the market then moved beyond the upper tick boundary before the next-checkpoint exit. Price movement and LP inventory divergence both hurt. Its timely saved exit was recovered after the overlap-coverage race; the loss and full original failed execution row remain in evidence.',
'8':'Two entry simulations were deferred by overlap coverage. During the 164-second quote-to-entry interval the tick moved 18 ticks; only 39.21% of capital became LP, against an 80% target. It spent most observed time outside the range and earned only 0.055680 USDG. The eventual exit coincided with an in-flight risk refresh.',
'9':'One deferred entry and an 11-tick quote-to-entry move left only 52.43% deployed. It exited after nine minutes because the independent USDG oracle was stale. This is a published-price freshness gate, distinct from the risk-refresh race.',
'10':'One deferred entry; 65.23% initial deployment and 47.61% starting NVDA exposure. Inventory exceeded 60% after only a few minutes. Another round trip cost more than seven times the fees earned.',
'11':'Two deferred entries delayed deployment. Exposure later jumped from a 32.97% entry reading to 70.39% at the exit signal; the next-checkpoint close retained the loss. Fees covered much of gas, but not swap costs and inventory effects.',
'12':'Best trade and the only completed trade with positive session alpha. It stayed in range for roughly 115 minutes, earned 2.251946 USDG in fees and paid 0.821152 USDG in gas. A 22-block / two-second node delay ended it. It shows fee capture can work when the position survives long enough, but one case is not a calibrated optimum.',
'13':'The inventory signal occurred at 72.00% exposure. A subsequent health-recovery wait and an overlap-deferred exit extended signal-to-exit to 428 seconds. Price recovered during that delay; it is not valid to call the whole loss avoidable gas or the delay necessarily harmful.',
'14':'Two overlapping conditions: a private syncing signal in the recovery window and an unfinished risk refresh. Treat this as a mixed infrastructure exit; removing only the refresh race would not by itself eliminate the chain gate.',
'15':'A 27-block / three-second private delay reset readiness. The position earned only 0.114867 USDG before closing. No inventory or true-price exit was recorded.',
'16':'Shortest completed holding period: just over two minutes. Inventory reached 71.74% at the signal despite a 44.31% entry reading. This is an example of the inventory guard dominating a narrow position before fees can repay a round trip.',
'17':'The private node lagged only three blocks and the monitor was healthy. A reference endpoint lagged 84 blocks; the monitor selected that endpoint\'s latest block as anchor, leaving it zero confirmations where LP readiness requires 64. This reference-side mismatch remains after the private ten-block fix. One entry preflight also failed on risk evidence.',
'18':'A roughly 55-minute, in-range position exited during a risk refresh that completed 112 ms after the decision timestamp. Prior completed snapshot observation age was only about 17.6 seconds. Fees did not cover the round trip.',
'19':'Longest completed holding period, but unusually expensive entry. Entry gas was 1.874838 USDG at a recorded base fee of 0.915438 gwei, versus exit gas of 0.318946 USDG at 0.228250 gwei. A 30-block / three-second private delay later triggered the exit. Duration alone did not overcome the costly entry.',
'20':'A risk refresh completed 33 ms after the exit decision timestamp. The prior completed snapshot was about 15 seconds old. This in-range trade earned just 0.146833 USDG against 0.799487 USDG gas.',
'21':'One entry was deferred by overlap coverage. After roughly 76 minutes, an in-flight risk refresh triggered exit; that refresh completed 1.767 seconds after the decision timestamp. Fees came close to gas, making this one of the least negative sessions.',
'22':'Exited on a risk refresh that completed 115 ms after the decision timestamp; prior snapshot observation age was about 13 seconds. The 18-minute holding period generated too little fee income for the full round trip.',
'23':'The inventory signal was just above the limit, at 60.05%. One overlap-deferred exit extended the close to the following checkpoint, for 124 seconds signal-to-exit. Keep the measured delay separate from hypothetical immediate-exit economics.',
'24':'Entry and exit ticks were both 222106, yet the trade lost 0.814029 USDG. Exact sqrt prices changed slightly within that tick, but almost all the loss was execution cost net of fees. It exited during a risk refresh that completed 106 ms after the decision timestamp.',
'25':'Another reference-side confirmation mismatch: the private node lagged one block, while a reference lagged 67 blocks and had zero confirmations beyond the selected anchor. A 309-second recovery/exit interval followed. Fees were just 0.024794 USDG.',
'26':'Still open at the frozen cutoff. Its NAV includes estimated exit reserve as well as paid entry gas; fees and P&L are marks, not completed cash proceeds. Do not mix this row into closed-trade win rates or completed cost attribution.'}
# Plot identical holding inventory across the continuous campaign.
root=next(s for s in src['sessions'] if s['id']=='5');p=root['state']['position'];holdgas=int(root['state']['execution']['holdGasQuote'])
byid={s['id']:s for s in src['sessions']};points=[]
for o in sorted(src['observations'],key=lambda o:dt(o['source_at'])):
 st=o['state'];cp=st.get('last')
 if not cp or dt(o['source_at'])<dt(root['state']['position']['enteredAt']):continue
 nav=st['navQuote'] if st['navQuote'] is not None else (byid[o['session_id']]['policy']['budgetQuote'] if st['position'] is None else None)
 if nav is None:continue
 hold=int(p['hold0'])+int(p['hold1'])*(1<<192)//int(cp['sqrtPriceX96'])**2-holdgas
 points.append((dt(o['source_at']),int(nav)/1e6,hold/1e6))
plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False})
fig,(ax,bx)=plt.subplots(2,1,figsize=(12,8.5),gridspec_kw={'height_ratios':[1.2,1]},layout='constrained')
ax.plot([p[0] for p in points],[p[1] for p in points],label='Paper campaign NAV',color='#165DAD',lw=1.8)
ax.plot([p[0] for p in points],[p[2] for p in points],label='Hold initial acquired inventory',color='#777777',lw=1.5)
ax.axhline(1000,color='#aaa',lw=.6);ax.set_ylabel('USDG');ax.set_title('Paper campaign: costs and management underperform holding');ax.legend(loc='lower left');ax.grid(alpha=.15)
ax.xaxis.set_major_formatter(mdates.DateFormatter('%d %b %H:%M',tz=tz))
parts=r['totals']['decomposition'];labels=['Market move\nof acquired inventory','Entry swap\nmark drag','LP inventory\nvs holding','Fees\n(marginal value)','Exit swap\nmark drag','Estimated\ngas','Net P&L']
vals=[int(parts['benchmarkMarketMove']),-int(parts['entryExecutionDrag']),int(parts['lpInventoryVersusHolding']),int(parts['marginalFeeValue']),-int(parts['exitExecutionDrag']),-int(parts['gas']),int(r['totals']['pnl'])]
bx.bar(range(7),[v/1e6 for v in vals],color=['#218C74' if v>0 else '#C44F4F' for v in vals[:-1]]+['#165DAD'])
for i,v in enumerate(vals):bx.annotate(f'{v/1e6:+.2f}',(i,v/1e6),xytext=(0,5 if v>=0 else -14),textcoords='offset points',ha='center')
bx.set_ylim(-29,13);bx.set_xticks(range(7),labels);bx.axhline(0,color='#777',lw=.7);bx.set_ylabel('USDG');bx.set_title('Exact decomposition of 21 completed trades');bx.grid(axis='y',alpha=.15)
fig.suptitle('NVDA / USDG · 8–9 September 2026 · Local-fork paper estimates',fontsize=14)
fig.supxlabel('Times: Europe/Vilnius. Checkpoint marks joined for display; open trade excluded from lower chart. No mainnet trades.',fontsize=9)
fig.savefig(out/'performance.png',dpi=170,bbox_inches='tight');fig.savefig(out/'performance.svg',bbox_inches='tight');plt.close(fig)
svg=out/'performance.svg';svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines())+'\n')
lines=['# Paper-session performance audit — 9 September 2026','',f'Frozen database cutoff: **{local(r["asOf"])} Europe/Vilnius** ({r["asOf"]}). The last portfolio source is {local(r["campaign"]["sourceAt"])}. This audit covers every session created since midnight September 8 local time: **5–26**. Sessions 1–4 predate this campaign; 1–3 never entered and session 4 was a separate earlier trial, so their budgets and P&L are not added to this funded chain.','',
'All observations, execution runs, policy hashes, runtime identities, source hashes and carried cash were checked in one read-only repeatable-read database snapshot. No runtime policy or service was changed for this analysis.','',
'## Result','',f'21 completed trades turned **1,000.000000 into 975.438231 USDG**: **−24.561769 USDG (−2.4562%)**. Two made an absolute profit; only session 12 beat its own acquired-inventory holding comparator. Including open session 26, marked NAV is **{usd(r["campaign"]["navQuote"])} USDG**, P&L **{usd(r["campaign"]["pnlQuote"])}**, versus **{usd(r["campaign"]["holdQuote"])}** for holding the original campaign inventory: **{usd(r["campaign"]["alphaQuote"])} USDG alpha**.','',
'Closed trades earned **10.018826 USDG** in reported fee value, paid **18.381092 USDG** in estimated gas and lost **8.737653 USDG** to entry/exit execution relative to source pool-price marks. Only sessions 7 and 12 earned fees exceeding gas; session 7 still lost heavily to price and inventory effects. Median holding time was **23.68 minutes**.','',
'![Campaign NAV and completed-trade decomposition](performance.png)','',
'## Every session','', 'All monetary figures below are USDG. Entry/exit clocks are source-block times in Europe/Vilnius, not database write times. Alpha is per-session against its acquired inventory; these alphas **must not be summed as campaign alpha**.','',
'| Session | Entry local | Exit/last local | Hold min | P&L | Fees | Gas paid | Session alpha | First exit trigger |','|---|---|---|---:|---:|---:|---:|---:|---|']
for s in sessions:lines.append(f'| {s["id"]} | {local(s["entryAt"])} | {local(s["exitAt"] or s["sourceAt"])} | {s["holdingMinutes"]:.1f} | {usd(s["pnl"],4)} | {usd(s["fees"],4)} | {usd(s["costs"],4)} | {usd(s["alpha"],4)} | {group(s)} |')
lines += ['', '## Why positions closed', '', '| Primary group | Sessions | Count | P&L | Gas | Fees |','|---|---|---:|---:|---:|---:|']
for label,pred in [('Inventory threshold',lambda s:group(s)=='Inventory ≥60%'),('Chain readiness (includes mixed #14)',lambda s:group(s)=='Chain readiness'),('Risk/reference only',lambda s:group(s) in ['Risk refresh unavailable','USDG oracle stale'])]:
 xs=[s for s in closed if pred(s)];lines.append(f'| {label} | {", ".join(s["id"] for s in xs)} | {len(xs)} | {usd(total(xs,"pnl"))} | {usd(total(xs,"costs"))} | {usd(total(xs,"fees"))} |')
lines += ['', '**15 of 21 exits (71%) were triggered by infrastructure or reference availability, rather than the inventory limit.** These are associated losses, not a counterfactual estimate of avoidable losses. Ordinary fees, acquisition costs and market exposure would still exist under another policy.','',
'### Risk refresh race','', 'Sessions **8, 14, 18, 20, 21, 22 and 24** recorded `paper_current_risk_evidence_unavailable` while the latest risk refresh was in flight. Its completion timestamp followed the recorded decision timestamp by 4, 120, 112, 33, 1,767, 115 and 106 ms respectively. Prior completed snapshot observation ages were only 4.8–23.5 seconds. Six had no other first-exit reason; session 14 also had a genuine chain-recovery gate.','',
'The code selects the **latest attempt**, including `started`, rather than the latest completed valid snapshot. It then makes an open position request an exit when that attempt is unfinished. This explains the observed race. Historical `validated_at` rows are mutable, so the exact prior canonical-validation age is not recoverable from the current row alone; a future fix must still verify canonicality and all existing age limits before using the last completed snapshot. Do not treat a failed or stale refresh as healthy.','',
'### Chain readiness','', 'Private-node events: #5 and #14 had `private_reports_syncing`; #6, #12, #15 and #19 had 42, 22, 27 and 30 blocks of lag respectively (about 2–4 seconds). All exceed the requested ten-block tolerance except the syncing events, which are a separate gate. Recovery plus later-checkpoint scheduling commonly delayed exits by roughly five to seven minutes.','',
'Sessions **17 and 25** expose a separate reference-side mismatch: private lag was only 3 and 1 blocks, with monitor status healthy. Reference-head spread was 84 and 67 blocks. The anchor selector reused the slow reference head, giving that reference **zero** confirmations beyond the anchor, while LP readiness requires **64 on each participating node**. The private ten-block adjustment does not solve this.','',
'### Entry quality and cost','', 'Nine overlap-deferred simulations (seven entries and two exits) preserved capital and avoided invalidation. One additional entry failed on current risk evidence. These rejected local simulations charged no strategy gas. However, delaying the fill while retaining a narrow frozen range can materially alter deployment: #8 deployed 39.21% and #9 52.43% of initial capital despite the 80% target. Quote-to-entry movement was 18 and 11 ticks. A deployment target is not a guaranteed fill.','',
'Session #19 paid 1.874838 USDG entry gas during a 0.915438-gwei base-fee spike; its later exit cost only 0.318946 USDG. There is no demonstrated fee-payback admission rule that rejected that expensive entry. Its full trade lost 1.695832 USDG despite over two hours invested.','',
'## Exact completed-trade attribution','', '| Component | Contribution, USDG |','|---|---:|']
for label,k,sign in [('Price movement of each session’s acquired holding inventory','benchmarkMarketMove',1),('Entry execution drag versus source spot','entryExecutionDrag',-1),('LP principal/idle inventory versus that holding inventory','lpInventoryVersusHolding',1),('Marginal fee value at exit spot','marginalFeeValue',1),('Exit execution drag versus source spot','exitExecutionDrag',-1),('Estimated gas','gas',-1)]:lines.append(f'| {label} | {usd(sign*int(parts[k]))} |')
lines += [f'| **Net P&L** | **{usd(r["totals"]["pnl"])}** |','', 'These terms reconcile to the micro-USDG for every session. The LP-inventory term includes mint funding/mark effects and price-driven inventory divergence; it is not an isolated causal estimate of adverse selection. Marginal fee value differs from separately rounded reported fees by 0.000014 USDG in aggregate. All costs are fork estimates and simulated swap proceeds.','',
'## Individual session reviews','']
for s in sessions:
 lines += [f'### Session {s["id"]}: {group(s)}', '',notes[s['id']], '',
 f'- **Funding and result:** {usd(s["budget"])} → {usd(s["nav"])} USDG; P&L {usd(s["pnl"])}; session alpha {usd(s["alpha"])}. Parent: {s["parent"] or "campaign root"}.',
 f'- **Range and deployment:** ticks {s["entryRange"][0]}–{s["entryRange"][1]} (±20 raw ticks); entry/last ticks {s["entryTick"]}/{s["exitTick"]}; actual entry LP {s["entryLpAllocationPpm"]/1e4:.2f}% of capital. NVDA exposure at entry {s["entryExposurePpm"]/1e4:.2f}%; maximum observed {s["maxObservedExposurePpm"]/1e4:.2f}%.',
 f'- **Timing:** created {local(s["createdAt"])}; entry {local(s["entryAt"])}; signal {local(s["signalAt"])}; exit/last {local(s["exitAt"] or s["sourceAt"])}. Entry wait {s["entryWaitMinutes"]:.2f} min (includes cooldown where applicable), quote-to-entry {s["quoteToEntrySeconds"]:.2f} sec; signal-to-exit {s["exitDelaySeconds"] if s["exitDelaySeconds"] is not None else "pending"} sec.',
 f'- **Economics:** fees {usd(s["fees"])}; entry gas {usd(s["entryGas"])}; exit gas {usd(s["exitGas"])}; remaining exit reserve {usd(s["reserve"])}. Recorded maximum drawdown {int(s["drawdownPpm"])/1e4:.4f}%.',
 f'- **Price and path:** pool NVDA price {s["entryPrice"]:.6f} → {s["endPrice"]:.6f} USDG ({s["priceChangePpm"]/1e4:+.4f}%); {s["swapStats"]["n"]} observed swaps, tick extrema {s["swapStats"]["min_tick"]}–{s["swapStats"]["max_tick"]}. Checkpoint-weighted in-range/outside time {s["inRangeSecondsApprox"]/60:.1f}/{s["outsideSecondsApprox"]/60:.1f} min; intraminute crossings are not captured by that occupancy approximation.',
 f'- **Verification:** {s["verifiedFeeIntervals"]} fee intervals reproduced from saved boundary readings and canonical Mint/Burn events; cash, costs and P&L decomposition reconcile. Failed prospective attempts: {len(s["failed"])}. Saved-exit recovery: {"yes, full original failure retained" if s["recovered"] else "no"}.',
 f'- **Exact first-exit reasons:** {", ".join("`"+x+"`" for x in s["exitReasons"]) or "none; still open"}.','']
 if s.get('healthFindings'):
  for h in [h for h in s['healthFindings'] if h['state']!='half_open']:
   lines.append(f'  Health evidence {h["id"]}, {local(h["at"])}: state {h["state"]}, lag {h["lagBlocks"]} blocks / {h["lagSeconds"]} sec; {", ".join(h["reasons"]+h["issues"]) or "no reason"}.')
  lines.append('')
lines += ['## Four-strategy experiment: incomplete comparison','',f'The separate modeled comparison ran from {local(partial["createdAt"])} to last captured source **{local(partial["through"])} on September 8**. It stopped at **21:19:43 local** with `forward_source_unavailable`. The next checkpoint arrived at 21:19:47.969, just after the 180-second source-age rule stopped it. Its source-to-source gap was 184 seconds. The service exited normally on invalidation; it did not restart and did not collect overnight data. The state and losses remain preserved.','',
'Below are reconstructed **historical marks at the final captured source**, not current NAV and not valid overnight rankings. The last open position in each model has not been liquidated.','',
'| Candidate | Last partial NAV | Partial P&L | Alpha vs common holding | Fees | Charged costs | Entries/exits | Recenters |','|---|---:|---:|---:|---:|---:|---|---:|']
for c in partial['candidates']:lines.append(f'| {c["candidate"]["id"]} | {usd(c["nav"])} | {usd(c["pnl"])} | {usd(c["commonAlpha"])} | {usd(c["feesQuote"])} | {usd(c["costs"])} | {c["entries"]}/{c["exits"]} | {c["recenters"]} |')
lines += ['', 'All four made six entries and five inventory-triggered exits; none recentered. The recenter variant therefore did not create a distinct management experiment. The inventory exit takes priority over the persistent 70%-of-range recenter trigger. Test whether recentering can engage earlier while preserving the inventory limit, rather than assuming that variant has already been tested meaningfully. The smaller 250-USDG model bore the same absolute gas scenario on one quarter of the capital.','',
'These model paths have frozen cost scenarios and approximate timing; they do not reproduce every current-risk preflight used by the transaction-simulated paper worker. Their absence of infrastructure exits before stopping is not evidence that the paper worker’s infrastructure problem disappeared.','',
'## Priorities supported by this audit','',
'1. Correct the latest-risk-attempt race: use completed, canonical, age-valid evidence during a bounded in-progress refresh; distinguish refresh failure, staleness and real risk changes. Keep entry/rebalance blocked when evidence is actually unavailable. Test a brief pause/recheck policy for transient infrastructure conditions before committing to liquidation.',
'2. Align reference anchor construction with LP readiness: preserve 64 confirmations on the private node and qualifying references, including when reference heads spread apart. Do not fix this by accepting unconfirmed or disagreeing hashes.',
'3. Make entry admission economically meaningful: re-quote stale/off-center narrow ranges, require adequate actual deployment, and screen unusually expensive gas against a conservative fee-payback scenario. The precise thresholds need testing.',
'4. Repair experiment availability with explicit invalidation alerts and an audited prospective restart. Preserve the stopped run and its losses; do not backfill the overnight gap. Make the recenter candidate exercise a genuinely different path before ranking it.',
'5. Compare the corrected policies over a fresh overnight/weekend sample. The current evidence does not justify a live-money launch, calling ±20 or ±30 optimal, or summing per-session alpha as continuous campaign alpha.','',
'## Reproduction and evidence','',f'- Frozen source SHA-256: `{r["sourceSha256"]}`.',
'- The source snapshot and full execution evidence are in `data/paper-performance-2026-09-09/source.json` (hash sidecar); normalized report is `report-v2.json`; last model marks are `experiment-partial.json`. Checked-in copies are [session metrics](session-metrics.json) and [partial experiment metrics](experiment-partial-metrics.json).',
'- `scripts/paper-performance-audit.mjs capture PRIVATE_ENV OUTPUT` exports without DB writes; `report FROZEN_SOURCE OUTPUT` recomputes all metrics and fails on a reconciliation error.',
'- `scripts/render-paper-performance.py REPORT SOURCE PARTIAL OUTPUT_DIR` renders this review and plots from frozen artifacts; Python matplotlib is only a reporting dependency.',
'- 22 sessions pass policy, source, execution and ancestry evidence checks; 876 fee intervals reconcile. No replayed fills, reset balances or historical guard changes were introduced.',
'- The normal production paper worker remained running throughout. Its state can advance after this cutoff; all numbers above belong to the same frozen snapshot.','']
(out/'README.md').write_text('\n'.join(lines))
print(json.dumps({'report':str(out/'README.md'),'png':str(out/'performance.png'),'sessions':len(sessions),'words':len(' '.join(lines).split())}))
