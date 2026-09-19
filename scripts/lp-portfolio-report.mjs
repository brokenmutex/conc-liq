import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {sessionReferenceAt} from '../src/research/session-reference.ts';

const base='data/lp-portfolio-2026-09-08',out='notes/active-lp-research-2026-09-07';
const json=x=>JSON.stringify(x,null,2)+'\n',money=v=>v===null?'unavailable':(Number(v)/1e6).toFixed(2),pct=v=>(Number(v)/1e4).toFixed(2)+'%';
const key=r=>[r.budgetQuoteRaw,r.halfWidthTicks,r.mode,r.transactionCostQuote,r.feeIncomePpm].join(':');
const auditOnly=process.argv[2]==='--audit-only';assert(process.argv.length===2||(auditOnly&&['weekday','weekend'].includes(process.argv[3])));
const reports={};let reconciled=0,reproduced=0;
for(const window of auditOnly?[process.argv[3]]:['weekday','weekend']){
 const path=`${base}/${window}-all-v1.json`,text=await readFile(path,'utf8'),data=JSON.parse(text);
 const first=JSON.parse(await readFile(`${base}/${window}-1000-v1.json`,'utf8'));
 const firstByKey=new Map(first.results.map(r=>[key(r),r])),refs=new Map(data.referenceMarks.map(r=>[r.at,r]));
 for(const r of data.results){
  let cash=BigInt(r.initialCashQuoteRaw),nvda=BigInt(r.initialNvdaRaw),cost=BigInt(r.transactionCostQuote);
  for(const a of r.actions){cash-=cost;
   if(a.action==='mint'){cash-=BigInt(a.principal0Raw);nvda-=BigInt(a.principal1Raw);
    assert.equal(a.tickUpper-a.tickLower,r.halfWidthTicks*2);assert(a.tickLower%10===0&&a.tickUpper%10===0);
    assert(cash*5n>=BigInt(a.navQuoteRaw));
    const lpValue=BigInt(a.principal0Raw)+BigInt(a.principal1Raw)*BigInt(refs.get(a.at).priceX18)/10n**30n;
    assert(lpValue<=BigInt(a.navQuoteRaw)*4n/5n+2n,'LP allocation exceeds 80% after rounding');
   }
   else if(a.action==='remove_collect'){cash+=BigInt(a.principal0Raw)+BigInt(a.fee0Raw);nvda+=BigInt(a.principal1Raw)+BigInt(a.fee1Raw);}
   else if(a.action==='sell_nvda'){cash+=BigInt(a.receivedQuoteRaw);nvda-=BigInt(a.soldNvdaRaw);}
   else assert.fail('Unknown ledger action');
   assert(cash>=0n&&nvda>=0n);assert.equal(cash,BigInt(a.cashQuoteRaw));assert.equal(nvda,BigInt(a.nvdaRaw));
  }
  assert.equal(cash,BigInt(r.finalCashQuoteRaw));assert.equal(nvda,BigInt(r.finalNvdaRaw));
  assert.equal(BigInt(r.actions.length)*cost,BigInt(r.modeledTransactionCostsQuoteRaw));
  assert(r.terminalRemovalCompleted);assert.equal(r.modeledFees0Raw,r.collectedFees0Raw);assert.equal(r.modeledFees1Raw,r.collectedFees1Raw);reconciled++;
  if(firstByKey.has(key(r))){assert.deepEqual(r,firstByKey.get(key(r)));reproduced++;}
 }
 reports[window]={source:path,sha256:createHash('sha256').update(text).digest('hex'),manifest:data.manifest,coverage:data.coverage,
  results:data.results.map(({actions,marks,...r})=>r)};
}
if(auditOnly){console.log(JSON.stringify({reconciled,reproduced}));process.exit(0);}
const weekendReference=JSON.parse(await readFile('data/lp-weekend-2026-09-07/backfill/references.json','utf8')),
 timing=JSON.parse(await readFile('data/lp-research-2026-09-07/weekend-timestamps.json','utf8'));
const start=timing.headers.find(h=>h.number===timing.fromBlock).timestamp,end=timing.headers.find(h=>h.number===timing.toBlock).timestamp;
const reopening={observations:0,passing:0,reasons:{},nvdaPublications:weekendReference.roles.rwa.rounds.length-1,quotePublications:weekendReference.roles.quote.rounds.length-1};
for(let at=start;at<=end;at+=60){if(at<reports.weekend.manifest.referencePolicy.closures[0].end)continue;
 const r=sessionReferenceAt(weekendReference.roles,reports.weekend.manifest.referencePolicy,at);reopening.observations++;if(r.available)reopening.passing++;
 for(const reason of r.reasons)reopening.reasons[reason]=(reopening.reasons[reason]??0)+1;
}
await mkdir(out,{recursive:true});
const evidence={executionEligible:false,measuredNetAlphaQuoteRaw:null,checks:{actionLedgersReconciled:reconciled,thousandBudgetRunsReproduced:reproduced},reopening,reports};
await writeFile(`${out}/portfolio-economic-sensitivity.json`,json(evidence),{flag:'wx'});
const rows=[];for(const h of [10,20,30,40,50]){
 const select=(w,mode,cost='50000',fee=1000000)=>reports[w].results.find(r=>r.budgetQuoteRaw==='1000000000'&&r.halfWidthTicks===h&&r.mode===mode&&r.transactionCostQuote===cost&&r.feeIncomePpm===fee);
 rows.push(`| ±${h} | ${money(select('weekday','fixed').modeledNetAlphaQuoteRaw)} | ${money(select('weekday','persistent70').modeledNetAlphaQuoteRaw)} | ${money(select('weekend','fixed').modeledNetAlphaQuoteRaw)} | ${money(select('weekend','persistent70').modeledNetAlphaQuoteRaw)} |`);
}
const sizes=[];for(const budget of [250,500,1000,2000,3000,4000,5000]){
 const candidates=reports.weekend.results.filter(r=>r.budgetQuoteRaw===String(budget*1e6)&&r.transactionCostQuote==='50000'&&r.feeIncomePpm===1000000);
 const best=mode=>candidates.filter(r=>r.mode===mode).sort((a,b)=>Number(BigInt(b.modeledNetAlphaQuoteRaw)-BigInt(a.modeledNetAlphaQuoteRaw)))[0];
 const f=best('fixed'),a=best('persistent70');
 sizes.push(`| ${budget} | ±${f.halfWidthTicks} / ${money(f.modeledNetAlphaQuoteRaw)} | ${pct(f.peakLiquiditySharePpm)} | ±${a.halfWidthTicks} / ${money(a.modeledNetAlphaQuoteRaw)} | ${pct(a.peakLiquiditySharePpm)} |`);
}
const sensitivity=[];for(const cost of ['10000','50000','250000','1000000'])for(const fee of [1000000,500000]){
 const get=(half,mode)=>reports.weekend.results.find(r=>r.budgetQuoteRaw==='1000000000'&&r.halfWidthTicks===half&&r.mode===mode&&r.transactionCostQuote===cost&&r.feeIncomePpm===fee);
 sensitivity.push(`| ${money(cost)} | ${fee/10000}% | ${money(get(10,'fixed').modeledNetAlphaQuoteRaw)} | ${money(get(20,'fixed').modeledNetAlphaQuoteRaw)} | ${money(get(40,'persistent70').modeledNetAlphaQuoteRaw)} |`);
}
const note=`# LP portfolio replay — September 8, 2026

The ledger and first economic sensitivity are implemented. These are self-financing **modeled** returns on an unchanged historical price path. Measured strategy profitability remains unavailable; execution is disabled. The five half-widths are ±10, ±20, ±30, ±40 and ±50 raw ticks, aligned to the pool's 10-tick grid, with total widths 20–100. Grid alignment means actual distances from the current price can differ between the two sides.

The weekend sample favors a fixed range with mandatory risk intervention over routine recentering. This is an exploratory comparison of one weekday window and one weekend, not a validated optimum. A fixed range here may still be withdrawn or traded under the same reference and inventory safeguards as the active policy.

## Results at 1,000 USDG

Net alpha versus holding the identical opening tokens, in USDG, assuming 0.05 USDG per successful operation and 100% of modeled allocated fee income:

| Half-width | Weekday fixed | Weekday active | Weekend fixed | Weekend active |
| --- | ---: | ---: | ---: | ---: |
${rows.join('\n')}

Weekday: August 10 00:28:17–August 12 00:24:22 UTC. Weekend: August 14 18:26:52–August 16 21:59:00 UTC, ending before the assumed reopening. The weekday active ±10/20/30 runs have no position at roughly 84–88% of observations: their positive alpha largely reflects changing inventory exposure during a falling reference market, and must not be interpreted as continuous productive LP deployment. The weekday active ±10 run has negative absolute P&L despite positive alpha.

The weekend active ±10 and ±20 policies lose relative to passive holding in this cost scenario. Repeated recentering progressively consumes available NVDA; eventually there may be too little to fund a new two-sided range. This policy deliberately does not buy NVDA just to restore a 50/50 split. The geometry-only screen concealed this funding constraint by resizing from a constant budget.

## Seven deployment sizes

The highest modeled weekend alpha within each tested mode at 0.05 USDG/operation and full allocated fee income is shown below. These are sample maxima, not deployment recommendations. Peak share is our hypothetical liquidity divided by historical plus our liquidity, across mint and earning segments.

| Budget USDG | Fixed half-width / alpha USDG | Fixed peak share | Active half-width / alpha USDG | Active peak share |
| --- | ---: | ---: | ---: | ---: |
${sizes.join('\n')}

Increasing size can make the unchanged-price-path assumption materially less credible. A higher dollar result at a large share of the pool is not evidence that the same result is executable.

## Cost and fee sensitivity at 1,000 USDG

Weekend net alpha in USDG. The 50% column setting halves allocated income while preserving the historical price path and inventory effects; it does not simulate a different stream of orders.

| Cost per operation USDG | Allocated fee income | Fixed ±10 | Fixed ±20 | Active ±40 |
| --- | ---: | ---: | ---: | ---: |
${sensitivity.join('\n')}

## Frozen policy and accounting

- Every candidate and its passive comparator starts with the same pre-held, preapproved inventory: 40% NVDA and 60% USDG at the opening independent reference. Acquisition, approval and funding costs are outside this endowed-inventory experiment.
- Each mint uses actual balances, deploys at most 80% of current reference NAV and leaves at least 20% USDG cash at mint. It can deploy less when one token is scarce. No capital reset or free token conversion occurs.
- An initial or resumed placement is immediate at an eligible minute observation. Routine recentering requires price to travel 70% toward a boundary for two observations, a 10-minute cooldown, and a 60-second pending delay. Its proposed bounds are frozen until execution and expire if price leaves them.
- A reference/price/token violation schedules withdrawal with a 60-second delay. A sampled NVDA exposure at or above 60% overrides routine timing, removes the LP and attempts an exact-depth sale toward 50%. Exposure can overshoot 60%; that number is an intervention threshold, not a hard cap. Recovery before execution cancels the pending risk action.
- Risk sales include pool fees and impact, reject more than 50 bps of shortfall from pre-trade pool spot, and check the post-trade ±5% independent-price band. Each successful mint, remove/collect bundle and swap separately deducts a hypothetical transaction cost. Costs are scenarios, not receipt measurements or ETH-to-USDG conversions.
- Mint funding rounds up; burn principal rounds down. Historical swap fees are clipped to the position range, reduced by protocol fees, diluted by added LP liquidity and accrued through crossings. Terminal removal pays its cost, and remaining NVDA is marked at the common independent reference. This is NAV, not cash liquidation proceeds.

## Freshness and weekend evidence

The research scenario uses the mapped 86,400-second heartbeat for each active feed. The NVDA close anchor is accepted only if valid at closure; USDG stays independently age-gated throughout. Operational 300-second settings are unchanged.

The explicit calendar assumption is Friday 17:00 ET–Sunday 18:00 ET closed, matching the mapped US_Equities_24/5 category in [Chainlink's market-hours documentation](https://docs.chain.link/data-feeds/selecting-data-feeds#market-hours). This is a research use of a held close reference; it does not establish a tradable weekend fair value or provider endorsement of using the feed outside its market hours.

Archive verification found **${reopening.nvdaPublications} new NVDA rounds and ${reopening.quotePublications} USDG rounds** over the captured Friday–Sunday window. All ${reports.weekend.coverage.observations} pre-reopening decision marks pass the experimental price-reference rule, including ${reports.weekend.coverage.heldPassing} held-anchor marks. The ${reopening.observations} observations after the assumed reopening have **${reopening.passing} passing references**; a fresh NVDA publication is required and none appears by August 16 23:40 UTC. No final post-reopening net-alpha claim is made.

Token code/pause/multiplier checks use the latest available archive snapshot: 29 weekday snapshots, four weekend snapshots. Forward-filling between them is an explicit assumption. Historical issuer registry status and sequencer continuity remain unverified. The weekend oracle log census is restricted to proxies and aggregators; it is not a complete token-log census.

## Validation and remaining work

${reconciled} action ledgers reconcile every raw wallet balance and charged operation. The ${reproduced} 1,000 USDG scenarios reproduce exactly when included in the seven-size runs. TypeScript and all 244 tests pass, including 14 new tests for conservation, costs, fee allocation, quote direction/impact, delayed interventions and session expiry.

The replay preserves historical market prices, swaps and other LP actions while adding hypothetical liquidity. Fee allocation at our added boundaries is modeled, and induced arbitrage, changed routing/volume and other LP responses are omitted. Following our hypothetical inventory sale, immediate remint uses the quoted price/depth, then canonical observations return to the historical path. The scorer is suitable for identifying hypotheses and failure modes, not proving live profitability.

Next: freeze fixed ±10 and ±20 as narrow-range candidates and retain active ±40 as a control; validate across additional independent weekends and overnight windows with an explicit capacity cutoff. Add an inventory-restoration purchase variant as a separate costed policy before claiming routine recentering has been optimized. Compare actual transaction/fork paths and gas valuation with the scenario breakpoints, then use forward paper evidence. The untouched holdout and live execution remain unused.

Evidence: [all scenario summaries](active-lp-research-2026-09-07/portfolio-economic-sensitivity.json), [replay runner](../scripts/lp-portfolio-replay.mjs), [report generator and independent balance audit](../scripts/lp-portfolio-report.mjs), [portfolio ledger](../src/research/portfolio.ts), [math](../src/research/portfolio-math.ts), [session reference](../src/research/session-reference.ts), [tests](../test/lp-portfolio.test.ts). Full action/mark series and input/code hashes are under ignored local \`data/lp-portfolio-2026-09-08/\`.
`;
await writeFile('notes/active-lp-portfolio-replay-2026-09-08.md',note,{flag:'wx'});
console.log(JSON.stringify({reconciled,reproduced,reopening,output:'notes/active-lp-portfolio-replay-2026-09-08.md'}));
