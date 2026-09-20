// Compact the ignored full replays into tracked, reviewable evidence.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';

const [root,output]=process.argv.slice(2);assert(root&&output&&!existsSync(output),'Usage: node scripts/research/hybrid-lp-compact.mjs REPLAY_ROOT NEW_OUTPUT');
const read=path=>JSON.parse(readFileSync(path,'utf8')),hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const paths={AAPL:`${root}/AAPL.json`,NVDA:`${root}/NVDA.json`},replays=Object.fromEntries(Object.entries(paths).map(([symbol,path])=>[symbol,read(path)]));
for(const [symbol,replay] of Object.entries(replays)){
  assert.equal(replay.symbol,symbol);assert.equal(replay.executionEligible,false);assert.equal(replay.promotionEligible,false);
  assert.equal(replay.canonicalEndVerified,true);for(const [path,digest] of Object.entries(replay.code))assert.equal(hash(path),digest,`${symbol}: ${path} changed after replay`);
}
const compact=result=>({scenario:result.scenario,session:result.session,arm:result.name,entries:result.entries,recenters:result.recenters,
  swaps:result.swaps,stagedReceipts:result.stageReceipts,netPnlQuote:result.netPnlQuote,poolMarkedAlphaQuote:result.matchedPoolMarkedAlphaQuote,
  independentReferenceAlphaQuote:null,fees0:result.fees0,fees1:result.fees1,feesQuote:result.feesQuote,gasPaidQuote:result.gasPaidQuote,
  adverseSelectionQuote:result.adverseSelectionQuote??'0',terminalExitCostQuote:result.terminalExitCostQuote,
  totalCostsWithExitQuote:result.totalCostsWithExitQuote??result.totalGasWithExitQuote,maximumDrawdownPpm:result.drawdownPpm,
  maximumRiskyExposurePpm:result.maximumRiskyExposurePpm,holdingMs:result.holdingMs,outsideMs:result.outsideMs,totalMs:result.totalMs,
  terminalHoldings:result.terminalHoldings,terminalPosition:result.terminalPosition,rejections:result.decisionRejections});
const results=Object.fromEntries(Object.entries(replays).map(([symbol,replay])=>[symbol,replay.results.map(compact)]));
const hybrid=Object.values(results).flat().filter(result=>result.arm.startsWith('hybrid_'));
assert(hybrid.length>0&&hybrid.every(result=>result.entries===0&&result.recenters===0&&result.swaps===0&&result.netPnlQuote==='0'));
const experimentPath='research/experiments/hybrid-lp-250-2026-09-20.json';
const result={schemaVersion:1,id:'hybrid-lp-250-results-2026-09-20',generatedAt:'2026-09-20',experiment:{path:experimentPath,sha256:hash(experimentPath)},
  fullReplay:{AAPL:{path:paths.AAPL,sha256:hash(paths.AAPL)},NVDA:{path:paths.NVDA,sha256:hash(paths.NVDA)}},results,
  decision:{candidate:null,status:'rejected',reason:'No hybrid fixed or adaptive arm passed the strict keep-versus-move economic gate on either development asset in base or stress, full-session or off-hours mode.'},
  unresolvedPromotionGates:['independent_reference_alpha_unavailable','validation_period_unavailable','hybrid_stage_costs_borrowed_or_assumed',
    'approval_cost_and_allowance_state_unavailable','prospective_three_week_two_weekend_paper_not_run','size_pool_specific_exit_cost_not_measured'],
  interpretation:{AAPL:'The pre-existing inventory-only development arm had positive modeled pool-marked results; the staged hybrid did not enter.',
    NVDA:'The pre-existing controls lost absolute value in the development window; the staged hybrid did not enter.',
    cashAlpha:'When a hybrid never enters, pool-marked alpha is zero. The inherited alphaQuote subtracts passive liquidation costs and is not used for selection.'},
  dayLevelDispersion:{status:'unavailable',reason:'The retained full replay did not persist independent-reference interval marks; no day-level alpha is manufactured from terminal pool marks.'},
  validationDataComplete:false,independentReferenceAvailable:false,executionEligible:false,broadcastsEnabled:false,promotionEligible:false};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,rows:Object.values(results).reduce((n,rows)=>n+rows.length,0),decision:result.decision.status}));
