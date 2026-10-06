import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
// @ts-expect-error Dashboard browser module intentionally stays plain JavaScript.
import * as tabs from '../dashboard/tabs.js';

const {liveWorkerReasonLabel,liveCapabilityFrom,liveCapabilityBlockedMessage,liveWalletPanel,liveRowModel,
 liveBlockedReasonLabel,liveStageLabel,liveJobKindLabel,liveJobStatusLabel}=tabs as any;

const strategy=(extra:Record<string,unknown>={})=>({id:'rangekeeper_v1',paper:true,live:false,liveSetup:true,liveAdmission:true,...extra});

test('maps worker readiness reasons to concise human-readable text',()=>{
 assert.match(liveWorkerReasonLabel('live_wallet_worker_not_connected'),/worker is not connected/i);
 assert.match(liveWorkerReasonLabel('canonical_wallet_snapshot_stale'),/snapshot is stale/i);
 assert.match(liveWorkerReasonLabel('canonical_wallet_snapshot_unavailable'),/No canonical shared wallet snapshot/);
 assert.match(liveWorkerReasonLabel('live_runtime_or_wallet_history_schema_unavailable'),/database schema is not installed/);
 assert.match(liveWorkerReasonLabel('live_worker_readiness_probe_failed'),/readiness check could not run/);
 assert.match(liveWorkerReasonLabel('live_worker_readiness_unavailable'),/could not be determined/);
 assert.match(liveWorkerReasonLabel('server_operator_wallet_address_invalid'),/operator wallet address/);
 assert.match(liveWorkerReasonLabel('live_wallet_worker_not_ready'),/worker is not ready/);
 for(const code of ['live_wallet_worker_not_connected','canonical_wallet_snapshot_unavailable','canonical_wallet_snapshot_stale',
  'live_runtime_or_wallet_history_schema_unavailable','server_operator_wallet_address_invalid','live_worker_readiness_probe_failed',
  'live_worker_readiness_unavailable','live_wallet_worker_not_ready'])
  assert.doesNotMatch(liveWorkerReasonLabel(code),/_/,`${code} has a human label, not a raw identifier`);
 assert.equal(liveWorkerReasonLabel('some_new_reason'),'Live worker check failed: some new reason.',
  'an unknown code is shown in words, never hidden or shown as a raw identifier');
 assert.match(liveWorkerReasonLabel(''),/unspecified/);
 assert.match(liveWorkerReasonLabel(undefined),/unspecified/);
});

test('approval is enabled only when admission is installed and, if reported, the worker is ready',()=>{
 const older=liveCapabilityFrom(strategy());
 assert.equal(older.approvalEnabled,true,'a server that omits liveWorker is not treated as not ready');
 assert.equal(older.worker.reported,false);assert.equal(older.worker.ready,null);assert.deepEqual(older.reasons,[]);
 const ready=liveCapabilityFrom(strategy({liveWorker:{ready:true,missing:[]}}));
 assert.equal(ready.approvalEnabled,true);assert.equal(ready.worker.ready,true);assert.deepEqual(ready.reasons,[]);
 const down=liveCapabilityFrom(strategy({liveWorker:{ready:false,missing:['live_wallet_worker_not_connected','canonical_wallet_snapshot_stale']}}));
 assert.equal(down.approvalEnabled,false,'liveAdmission alone is not enough when the worker is not ready');
 assert.deepEqual(down.reasons.map((item:any)=>item.code),['live_wallet_worker_not_connected','canonical_wallet_snapshot_stale']);
 assert.equal(down.reasons.length,2);assert.match(liveCapabilityBlockedMessage(down),/not connected\..*snapshot is stale/);
 const schema=liveCapabilityFrom(strategy({liveAdmission:false,liveWorker:{ready:false,missing:['live_runtime_or_wallet_history_schema_unavailable']}}));
 assert.equal(schema.approvalEnabled,false);assert.equal(schema.reasons.length,1,'the worker reason explains the missing admission; no duplicate generic line');
 const bare=liveCapabilityFrom(strategy({liveWorker:{ready:false}}));
 assert.deepEqual(bare.reasons.map((item:any)=>item.code),['live_wallet_worker_not_ready']);
 const malformed=liveCapabilityFrom(strategy({liveWorker:'yes'}));
 assert.equal(malformed.approvalEnabled,false,'a malformed readiness field fails closed');
 const readyFlagOnly=liveCapabilityFrom(strategy({liveWorker:{ready:'true',missing:[]}}));
 assert.equal(readyFlagOnly.approvalEnabled,false,'only a boolean true counts as ready');
 const noAdmission=liveCapabilityFrom(strategy({liveAdmission:false}));
 assert.equal(noAdmission.approvalEnabled,false);
 assert.match(noAdmission.reasons[0].label,/Live admission is not available on this service/);
 const noSetup=liveCapabilityFrom(strategy({liveSetup:false,liveAdmission:false}));
 assert.match(noSetup.reasons[0].label,/Live setup review is not installed/);
 const unknown=liveCapabilityFrom(null);
 assert.equal(unknown.approvalEnabled,false);assert.equal(unknown.known,false);
 assert.match(unknown.reasons[0].label,/could not be read/);
 const dedup=liveCapabilityFrom(strategy({liveWorker:{ready:false,missing:['a','a',42,'','b']}}));
 assert.deepEqual(dedup.worker.missing,['a','b']);
 assert.equal(liveCapabilityBlockedMessage(ready),'Live admission is not available.');
});

const usdg='0x0000000000000000000000000000000000000001',aapl='0x00000000000000000000000000000000000000d0';
const wallet={kind:'live_wallet_review',status:'available',walletAddress:'0x0000000000000000000000000000000000000384',
 tokens:[{address:usdg,decimals:6,symbol:'USDG/USD',balanceRaw:'500000000',allocatedRaw:'100000000',pendingRaw:'25000000',availableRaw:'375000000'},
  {address:aapl,decimals:18,reference:'AAPL/USD',balanceRaw:'9000000000000000000',allocatedRaw:'1000000000000000000',pendingRaw:'0',availableRaw:'8000000000000000000'}],
 native:{balanceWei:'20000000000000000',allocatedWei:'2000000000000000',pendingWei:'100000000000000',exitReserveWei:'5000000000000000',availableWei:'12900000000000000'},
 blockers:[],reasons:[]};
const review=(extra:Record<string,unknown>={})=>({kind:'rangekeeper_live_setup_preflight',status:'indicative',input:{capitalQuoteRaw:'250000000'},
 profile:{token0:usdg,token1:aapl,decimals0:6,decimals1:18,quoteToken:0},
 wallet:{token0:{balanceRaw:'500000000',allocatedRaw:'100000000',pendingRaw:'25000000',freeRaw:'375000000'},
  token1:{balanceRaw:'9000000000000000000',allocatedRaw:'1000000000000000000',pendingRaw:'0',freeRaw:'8000000000000000000'},
  native:{balanceWei:'20000000000000000',allocatedWei:'2000000000000000',pendingWei:'100000000000000',exitReserveWei:'5000000000000000',freeWei:'12900000000000000'}},
 requirements:{token0Raw:'250000000',token1Raw:'340000000000000000',quoteValueRaw:'250000000',freeQuoteRaw:'375000000',shortfallQuoteRaw:'0',nativeWei:'6000000000000000'},
 costs:{status:'estimated',exitReserveWei:'4000000000000000'},...extra});

test('wallet panel shows balance, reserved by campaigns and free per token and native, with the reviewed request',()=>{
 const idle=liveWalletPanel(wallet,null);
 assert.equal(idle.summary,null);assert.equal(idle.rows.length,2);
 const [usd,stock]=idle.rows;
 assert.equal(usd.label,'USDG');assert.equal(usd.balance,'500');assert.equal(usd.reserved,'125');assert.equal(usd.free,'375');
 assert.equal(usd.reservedDetail,'allocated 100 · pending 25');assert.equal(usd.request,null);
 assert.equal(stock.label,'AAPL');assert.equal(stock.balance,'9');assert.equal(stock.reserved,'1');assert.equal(stock.free,'8');
 assert.equal(idle.native.balance,'0.02');assert.equal(idle.native.reserved,'0.0071','native reserved includes allocated, pending and exit reserve');
 assert.equal(idle.native.reservedDetail,'allocated 0.002 · pending 0.0001 · exit reserve 0.005');assert.equal(idle.native.free,'0.0129');
 const reviewed=liveWalletPanel(wallet,review());
 const [rUsd,rStock]=reviewed.rows;
 assert.equal(rUsd.request,'250');assert.equal(rUsd.shortfall,'0');assert.equal(rStock.request,'0.34');assert.equal(rStock.shortfall,'0');
 assert.equal(reviewed.native.request,'0.006');assert.equal(reviewed.native.shortfall,'0');
 assert.deepEqual(reviewed.summary,{capital:'250',allocationValue:'250',freeValue:'375',shortfall:'0',nativeRequest:'0.006',exitReserve:'0.004'});
 const short=liveWalletPanel(wallet,review({wallet:{...review().wallet,token0:{...review().wallet.token0,freeRaw:'200000000'},
  native:{...review().wallet.native,freeWei:'1000000000000000'}},requirements:{...review().requirements,shortfallQuoteRaw:'50000000',freeQuoteRaw:'200000000'}}));
 assert.equal(short.rows[0].shortfall,'50','shortfall is the request minus the free amount the review saw');
 assert.equal(short.native.shortfall,'0.005');assert.equal(short.summary!.shortfall,'50');
 const unreviewed=liveWalletPanel(wallet,{...review(),status:'unavailable'});
 assert.equal(unreviewed.summary,null,'an unavailable review contributes no request columns');
});

test('wallet panel reports missing or malformed evidence as unavailable and never as zero',()=>{
 const broken=liveWalletPanel({status:'available',walletAddress:'0x1',tokens:[
  {address:usdg,decimals:6,symbol:'USDG',balanceRaw:'not-a-number',allocatedRaw:'bad',pendingRaw:'?',availableRaw:null},
  {address:aapl,decimals:18,reference:'AAPL/USD',balanceRaw:'5',allocatedRaw:null,pendingRaw:'0',availableRaw:'5'},
  {address:'0x00000000000000000000000000000000000000d9',balanceRaw:'7',allocatedRaw:'0',pendingRaw:'0',availableRaw:'7'}],
  native:{balanceWei:'bad',allocatedWei:'?',pendingWei:'x',exitReserveWei:'x',availableWei:'x'}},null);
 assert.deepEqual([broken.rows[0].balance,broken.rows[0].reserved,broken.rows[0].free],['unavailable','unavailable','unavailable']);
 assert.equal(broken.rows[1].reserved,'unavailable','one missing component makes the reserved total unknown, not partial');
 assert.equal(broken.rows[1].balance,'0.000000000000000005');
 assert.equal(broken.rows[2].balance,'unavailable','a token without decimals is not formatted by guessing');
 assert.equal(broken.rows[2].label,'0x000000…000d9');
 assert.equal(broken.native.balance,'unavailable');assert.equal(broken.native.reserved,'unavailable');
 const none=liveWalletPanel({status:'unavailable',walletAddress:null,tokens:[],native:null,blockers:['wallet_snapshot_unavailable']},null);
 assert.deepEqual([none.rows.length,none.native,none.status,none.blockers],[0,null,'unavailable',['wallet_snapshot_unavailable']]);
 const reviewOnly=liveWalletPanel(null,review());
 assert.equal(reviewOnly.rows.length,2,'with no wallet response the reviewed tokens still come from the review');
 assert.equal(reviewOnly.rows[0].request,'250');
 const noRequest=liveWalletPanel(wallet,review({requirements:{token0Raw:'oops',token1Raw:null}}));
 assert.equal(noRequest.rows[0].request,'unavailable');assert.equal(noRequest.rows[0].shortfall,'unavailable');
});

test('labels job kinds, stages and recorded block reasons without exposing identifiers',()=>{
 assert.equal(liveJobKindLabel('change_range'),'Recenter');assert.equal(liveJobKindLabel('close_retain'),'Retain-close');
 assert.equal(liveJobKindLabel('open'),'Open');assert.equal(liveJobKindLabel('something_new'),'something new');
 assert.equal(liveJobStatusLabel('reconciling'),'reconciling');
 assert.equal(liveStageLabel(`withdraw:${'a'.repeat(32)}`),'withdraw liquidity');
 assert.equal(liveStageLabel('approve'),'token approval');assert.equal(liveStageLabel('swap'),'swap');
 assert.equal(liveStageLabel('mint:abc'),'mint position');assert.equal(liveStageLabel(null),null);
 assert.equal(liveBlockedReasonLabel('transaction_reverted:55555555-5555-4555-8555-555555555555:mint:abc'),'a transaction reverted');
 assert.equal(liveBlockedReasonLabel('job_blocked:mint'),'the job is blocked pending reconciliation (mint position)');
 assert.equal(liveBlockedReasonLabel('job_rejected'),'the job was rejected');
 assert.equal(liveBlockedReasonLabel('observation_gap_exceeded'),'observation gap exceeded');
 assert.equal(liveBlockedReasonLabel(null),'reason unavailable');
});

const campaign='aaaaaaaa-0000-4000-8000-000000000001';
const baseJob={id:'55555555-5555-4555-8555-555555555501',kind:'open',status:'succeeded',inFlight:false,stage:null,stageKind:null,
 stageStatus:null,nonce:null,txHash:null,attempt:1,createdAt:null,updatedAt:null};
function livePosition(lifecycle:string,live:Record<string,unknown>={},extra:Record<string,unknown>={}){
 return {id:`live-dep-${campaign}`,label:'RK-aaaaaaaa',mode:'live',asset:'AAPL',quote:'USDG',fee:3000,status:'open',history:false,
  hasLiquidity:true,capital:251.25,initial:250,fees:1.8,gas:0.12,range:[210,230],sourceAt:new Date().toISOString(),reasons:[],
  deployment:{campaignId:campaign,revision:1,strategyId:'rangekeeper_v1',lifecycle:'active',rangeState:'inside',
   token0:{symbol:'USDG',decimals:6},token1:{symbol:'AAPL',decimals:18},
   live:{lifecycle,phase:'holding',job:baseJob,blockedReason:null,nftId:'1000',range:{state:'inside'},
    allocation:{token0Raw:'200000000',token1Raw:'340000000000000000',nativeWei:'6000000000000000'},recenters:2,paidGasWei:'120000000000000',
    ...live}},...extra};
}

test('live rows format lifecycle, current job, stage, nonce and transaction hash for every state',()=>{
 const hash=`0x${'3'.repeat(64)}`;
 const queued=liveRowModel(livePosition('queued',{job:{...baseJob,status:'queued',inFlight:true},nftId:null,range:{state:'no_liquidity'}},
  {capital:null,initial:null,fees:null,gas:null,range:[null,null]}));
 assert.equal(queued.lifecycle,'queued');assert.equal(queued.label,'Queued');assert.match(queued.summary,/Queued · waiting for the live worker/);
 assert.equal(queued.retain.eligible,false);assert.equal(queued.retain.reason,'Retain-close can be reviewed once the campaign is holding.');
 const fact=(model:any,name:string)=>model.facts.find(([key]:[string,string])=>key===name)?.[1];
 assert.equal(fact(queued,'Position NFT'),'not minted yet');
 for(const name of ['Net value','LP fees','Net P&L','Gas paid'])assert.equal(fact(queued,name),
  name==='Gas paid'?'0.00012 native':'unavailable',`${name} reads unavailable, not zero`);
 const opening=liveRowModel(livePosition('opening',{job:{...baseJob,status:'confirming',inFlight:true,stage:'mint:abc',stageKind:'mint',
  stageStatus:'signed',nonce:'12',txHash:hash},nftId:null},{capital:null,initial:null,fees:null,gas:null}));
 assert.equal(opening.summary,'Opening · Open confirming · stage mint position · nonce 12 · tx 0x33333333…333333');
 assert.equal(fact(opening,'Current job'),`Open confirming · stage mint position · nonce 12 · tx ${hash}`,'the full hash is shown as text in the job fact');
 const unsigned=liveRowModel(livePosition('opening',{job:{...baseJob,status:'executing',inFlight:true,stageKind:'approve',stageStatus:'prepared',nonce:'11'}}));
 assert.match(unsigned.summary,/nonce 11 · transaction not yet signed/);
 const holding=liveRowModel(livePosition('holding'));
 assert.equal(holding.summary,'Holding · in range');assert.equal(holding.retain.eligible,true);assert.equal(holding.retain.reason,null);
 assert.equal(fact(holding,'Position NFT'),'1000');assert.equal(fact(holding,'Range'),'210.00 – 230.00 USDG · in range');
 assert.equal(fact(holding,'Net value'),'251.25');assert.equal(fact(holding,'Net P&L'),'+1.25');assert.equal(fact(holding,'LP fees'),'1.80');
 assert.equal(fact(holding,'Gas paid'),'0.12 USD · 0.00012 native');assert.equal(fact(holding,'Recenters completed'),'2');
 assert.equal(fact(holding,'Allocation'),'200 USDG · 0.34 AAPL · 0.006 native gas');assert.equal(fact(holding,'Last job'),'Open succeeded');
 const outside=liveRowModel(livePosition('holding',{range:{state:'outside'}}));
 assert.equal(outside.summary,'Holding · outside range');
 const recentering=liveRowModel(livePosition('recentering',{job:{...baseJob,kind:'change_range',status:'executing',inFlight:true,stage:'withdraw:abc',
  stageKind:'withdraw',stageStatus:'signed',nonce:'1000',txHash:hash}}));
 assert.equal(recentering.summary,'Recentering · Recenter executing · stage withdraw liquidity · nonce 1000 · tx 0x33333333…333333');
 assert.equal(recentering.retain.eligible,false);assert.match(recentering.retain.reason,/Recentering is in progress/);
 assert.equal(fact(recentering,'Current job').startsWith('Recenter executing'),true);
 const closing=liveRowModel(livePosition('closing',{job:{...baseJob,kind:'close_retain',status:'queued',inFlight:true}}));
 assert.equal(closing.summary,'Closing · retain tokens · Retain-close queued');assert.equal(closing.retain.reason,'Retain-close is already in progress.');
 const convertClosing=liveRowModel(livePosition('closing',{job:{...baseJob,kind:'close_convert',status:'executing',inFlight:true}}));
 assert.match(convertClosing.summary,/^Closing · convert to USDG · Convert-close executing/,'a convert exit is not described as a retained close');
 const convertClosed=liveRowModel(livePosition('closed',{job:{...baseJob,kind:'close_convert'},nftId:null,range:{state:'no_liquidity'}},{history:true,range:[null,null]}));
 assert.match(convertClosed.summary,/^Closed · converted to USDG; any unsold tokens remain/);
 const closed=liveRowModel(livePosition('closed',{job:{...baseJob,kind:'close_retain'},nftId:null,range:{state:'no_liquidity'}},{history:true,range:[null,null]}));
 assert.match(closed.summary,/^Closed/);assert.equal(closed.retain.reason,'This campaign is closed.');assert.equal(fact(closed,'Position NFT'),'none');
 const blocked=liveRowModel(livePosition('blocked',{blockedReason:'transaction_reverted:55555555-5555-4555-8555-555555555501:mint:abc'}));
 assert.equal(blocked.summary,'Blocked · a transaction reverted');assert.doesNotMatch(blocked.summary,/5555/);
 assert.match(blocked.retain.reason,/blocked/);
 assert.equal(liveRowModel({id:'x',deployment:{}}),null,'positions without live evidence have no live row model');
});

test('a worker that is not ready is stated for queued and in-flight rows, and clears when it is ready',()=>{
 const down=liveCapabilityFrom(strategy({liveWorker:{ready:false,missing:['live_wallet_worker_not_connected']}}));
 const ready=liveCapabilityFrom(strategy({liveWorker:{ready:true,missing:[]}}));
 const queued=livePosition('queued',{job:{...baseJob,status:'queued',inFlight:true},nftId:null});
 const withDown=liveRowModel(queued,down);
 assert.match(withDown.summary,/the live worker is not connected, so opening has not started/);
 assert.match(withDown.workerNote,/The live wallet worker is not connected\. Queued work resumes when it reconnects\./);
 const withReady=liveRowModel(queued,ready);
 assert.equal(withReady.workerNote,null);assert.doesNotMatch(withReady.summary,/not connected/);
 assert.equal(liveRowModel(queued,null).workerNote,null,'no readiness information means no claim either way');
 assert.equal(liveRowModel(queued,liveCapabilityFrom(strategy())).workerNote,null,'an older server that omits liveWorker makes no claim');
 const holding=liveRowModel(livePosition('holding'),down);
 assert.equal(holding.workerNote,null,'an idle holding campaign has no pending work to warn about');
 const recentering=liveRowModel(livePosition('recentering',{job:{...baseJob,kind:'change_range',status:'queued',inFlight:true}}),down);
 assert.match(recentering.workerNote,/Queued work resumes/);
});

// ---- app.js rendering of several concurrent live campaigns ----
// @ts-expect-error Dashboard browser module intentionally stays plain JavaScript.
const tabsModule=await import('../dashboard/tabs.js');
function appContext(capability:unknown=null,pathname='/operator'){
 const context:any=vm.createContext({document:{querySelector:()=>({addEventListener(){}}),addEventListener(){}},
  window:{addEventListener(){},concliqLiveCapability:capability===null?undefined:()=>capability,concliqOperatorAuthenticated:()=>true},
  location:{pathname},fetch:()=>new Promise(()=>{}),AbortSignal,__tabs:tabsModule});
 const script=readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8')
  .replace(/import \{[^\n]+\} from '\.\/deployment-actions\.js';/,
   'const mountPaperLifecycleAction=()=>{},mountStaticRetainAction=()=>{},mountPaperConvertAction=()=>{},mountPendingPaperAcceptanceRecovery=()=>{},mountLiveConvertAction=()=>{},liveConvertStorageKey=id=>`live-convert-${id}`;')
  .replace(/import (\{[^}]+\}) from '\.\/tabs\.js';/s,'const $1=__tabs;');
 vm.runInContext(script,context);
 return {context,run:(expression:string)=>vm.runInContext(expression,context)};
}
function serverPosition(n:number,lifecycle:string,status:string,live:Record<string,unknown>,extra:Record<string,unknown>={}){
 const id=`aaaaaaaa-0000-4000-8000-${String(n).padStart(12,'0')}`;
 return {id:`live-dep-${id}`,label:`RK-aaaaaaa${n}`,mode:'live',asset:'AAPL',quote:'USDG',fee:3000,status,history:lifecycle==='closed',
  hasLiquidity:live.nftId!=null,initialQuote:'250000000',navQuote:null,holdQuote:null,feesQuote:null,gasQuote:null,swapQuote:null,
  exitEstimateQuote:null,drawdownPpm:null,createdAt:new Date(Date.now()-3_600_000).toISOString(),endedAt:null,
  sourceAt:null,heartbeatAt:null,reasons:[],range:null,priceQuoteX18:null,inventory:{tokens:[],exposurePpm:null,nativeWei:null},
  tokenId:live.nftId??null,accounting:'unavailable',nextAction:null,
  deployment:{campaignId:id,revision:1,strategyId:'rangekeeper_v1',lifecycle:lifecycle==='closed'?'closed':'active',rangeState:'unknown',
   token0:{symbol:'USDG',decimals:6},token1:{symbol:'AAPL',decimals:18},
   operation:{id:null,kind:null,status:null,stage:null,reason:null},
   live:{lifecycle,phase:null,job:null,blockedReason:null,nftId:null,range:{state:'no_liquidity'},allocation:null,recenters:null,paidGasWei:null,...live}},...extra};
}

test('several live campaigns render concurrently as their own rows; only holding rows offer retain-close',()=>{
 const down=liveCapabilityFrom(strategy({liveWorker:{ready:false,missing:['live_wallet_worker_not_connected']}}));
 const {context,run}=appContext(down);
 const list=[
  serverPosition(1,'holding','open',{nftId:'1000',range:{state:'inside'},job:{...baseJob}},{navQuote:'251250000',feesQuote:'1800000',gasQuote:'120000',accounting:'recorded',sourceAt:new Date().toISOString(),range:['210000000000000000000','230000000000000000000']}),
  serverPosition(2,'holding','outside',{nftId:'999',range:{state:'outside'},job:{...baseJob}},{navQuote:'249000000',accounting:'recorded',sourceAt:new Date().toISOString()}),
  serverPosition(3,'recentering','recentring',{nftId:'1001',range:{state:'inside'},job:{...baseJob,kind:'change_range',status:'executing',inFlight:true,stageKind:'withdraw',nonce:'1000',txHash:`0x${'3'.repeat(64)}`,stageStatus:'signed'}}),
  serverPosition(4,'queued','waiting',{job:{...baseJob,status:'queued',inFlight:true}}),
  serverPosition(5,'blocked','blocked',{blockedReason:'job_blocked:mint',job:{...baseJob,status:'blocked'}}),
  serverPosition(6,'closed','closed',{nftId:null,job:{...baseJob,kind:'close_retain'}},{history:true}),
 ];
 Object.assign(context,{list});
 run('positions=list.map(normalize)');
 const rows=run('visible("live")') as any[];
 assert.deepEqual(rows.map(p=>p.deployment.live.lifecycle),['holding','holding','recentering','queued','blocked'],'the closed campaign is History only');
 const html=rows.map((_,index)=>{context.p=rows[index];return run('row(p,null)') as string;}).join('');
 assert.equal((html.match(/<tr class="[^"]*" data-position/g)??[]).length,5);
 assert.equal((html.match(/class="live-row-facts/g)??[]).length,5,'each campaign has its own facts row');
 assert.equal((html.match(/live-retain-action-root/g)??[]).length,2,'only the two holding campaigns offer retain-close');
 assert.match(html,/data-live-lifecycle="recentering"/);
 assert.match(html,/nonce 1000/);assert.match(html,/tx 0x33333333…333333/);assert.match(html,/0x3{64}/,'the full hash appears as text');
 assert.doesNotMatch(html,/<a [^>]*0x3/,'no explorer link is created');
 assert.match(html,/Queued · the live worker is not connected/);assert.match(html,/The live wallet worker is not connected\./);
 assert.match(html,/Blocked · the job is blocked pending reconciliation \(mint position\)/);
 assert.match(html,/Net value<\/dt><dd class="muted">unavailable<\/dd>/,'unproven economics read unavailable');
 assert.match(html,/<span class="muted">unavailable<\/span>/);
 const queuedRow=html.split('<tr class="live-row-facts')[4]!;
 assert.doesNotMatch(queuedRow,/>0\.00</,'a queued campaign is not zero-filled');
 assert.equal((html.match(/live-convert-action-root/g)??[]).length,2,'only the two holding campaigns offer the withdraw-and-convert exit');
 assert.equal((html.match(/data-can-review="true"/g)??[]).length,4,'each holding campaign offers both exits');
 run('modes.live.history=true');
 assert.deepEqual((run('visible("live")') as any[]).map(p=>p.deployment.live.lifecycle),['closed']);
 assert.equal(run('positions.filter(p=>["queued","blocked"].includes(p.deployment.live.lifecycle)).some(sourceStale)'),false,
  'queued and blocked campaigns with no source are not reported as stale');
});

test('live retain actions are omitted on the public dashboard and unauthenticated actions stay disabled in place',()=>{
 const {context,run}=appContext(null,'/');
 const position=serverPosition(1,'holding','open',{nftId:'1000',range:{state:'inside'},job:{...baseJob}});
 Object.assign(context,{position});
 context.p=run('normalize(position)');
 const html=run('row(p,null)') as string;
 assert.doesNotMatch(html,/live-retain-action-root|live-convert-action-root/);
 assert.match(html,/Live actions are available on the operator dashboard/);
 assert.equal(run('lifecycleControls(p)'),'','live positions get no pause or convert controls');
});

// ---- valuation basis ----
const {valuationAgeText,easternWeekdayTime,referenceReasonLabel,valuationBasisModel}=tabs as any;
const FRIDAY_CLOSE='2026-10-03T00:00:00.000Z';// Fri 20:00 ET
const feedsStale=[{name:'token0',symbol:'USDG',state:'fresh'},{name:'token1',symbol:'AAPL',state:'stale',updatedAt:FRIDAY_CLOSE},{name:'native',symbol:'ETH',state:'fresh'}];
const heldValuation={basis:'last_oracle_price',priceAsOf:FRIDAY_CLOSE,priceAgeAtMarkSeconds:38*3600,feeds:feedsStale,
 freshnessReasons:['token1_reference_age_unacceptable'],structuralReasons:[],poolImplied:{navQuote:'189500000',priceQuoteX18:'219000000000000000000'}};

test('formats the age and Eastern time of a held oracle price',()=>{
 assert.equal(valuationAgeText(45),'45s');assert.equal(valuationAgeText(600),'10m');assert.equal(valuationAgeText(3*3600),'3h');
 assert.equal(valuationAgeText(38*3600),'38h');assert.equal(valuationAgeText(50*3600),'2d 2h');
 for(const bad of [NaN,-1,null,undefined,'x'])assert.equal(valuationAgeText(bad),'age unavailable');
 assert.equal(easternWeekdayTime(FRIDAY_CLOSE),'Fri 20:00 ET');assert.equal(easternWeekdayTime('2026-01-05T01:30:00Z'),'Sun 20:30 ET');
 assert.equal(easternWeekdayTime('nope'),'time unavailable');
});

test('maps structural reference codes to words, naming the feed',()=>{
 assert.equal(referenceReasonLabel('token1_oracle_description_mismatch'),'risk token: the oracle feed description does not match');
 assert.equal(referenceReasonLabel('token0_oracle_round_incomplete'),'quote token: the oracle round is incomplete');
 assert.equal(referenceReasonLabel('native_oracle_timestamp_future'),'native gas: the oracle timestamp is in the future');
 assert.match(referenceReasonLabel('token1_asset_health'),/risk token: asset health check failed .*corporate action/);
 assert.equal(referenceReasonLabel('token1_oracle_older_than_hold_limit'),'risk token: the last oracle answer is older than 7 days');
 assert.equal(referenceReasonLabel('market_session_unverified'),'the market session could not be verified');
 assert.equal(referenceReasonLabel('reference_proof_inconsistent'),'the stored oracle evidence contradicts itself');
 assert.equal(referenceReasonLabel('brand_new_reason'),'brand new reason');assert.equal(referenceReasonLabel(undefined),'an unknown reference problem');
 for(const code of ['token1_asset_identity','token0_unsupported_stablecoin','token1_oracle_missing','native_oracle_read_failed','token1_reference_price_mismatch'])
  assert.doesNotMatch(referenceReasonLabel(code),/_/,code);
});

test('builds the basis badge model: fresh, last oracle price with age, unavailable, or nothing to value',()=>{
 const now=Date.parse(FRIDAY_CLOSE)+38*3600*1000;
 const fresh=valuationBasisModel({valuation:{basis:'oracle_fresh',priceAsOf:FRIDAY_CLOSE,priceAgeAtMarkSeconds:20,feeds:[],freshnessReasons:[],structuralReasons:[],poolImplied:null}},now);
 assert.equal(fresh.kind,'oracle_fresh');assert.equal(fresh.label,'Oracle fresh');assert.equal(fresh.poolImpliedNav,null);
 const held=valuationBasisModel({valuation:heldValuation},now);
 assert.equal(held.kind,'last_oracle_price');assert.equal(held.label,'Last oracle price · 38h old');
 assert.match(held.detail,/^Valued at last oracle price, Fri 20:00 ET, 38h old \(AAPL oracle past its age limit\)\./);
 assert.equal(held.summary,'Last oracle price, Fri 20:00 ET, 38h old');assert.equal(held.poolImpliedNav,189.5);
 const later=valuationBasisModel({valuation:heldValuation},now+5*3600*1000);
 assert.equal(later.label,'Last oracle price · 43h old','the age keeps counting from the price time, not the mark');
 const unavailable=valuationBasisModel({valuation:{basis:'unavailable',priceAsOf:null,feeds:[],freshnessReasons:[],
  structuralReasons:['token1_oracle_description_mismatch','token1_asset_health'],poolImplied:{navQuote:'1',priceQuoteX18:'1'}}},now);
 assert.equal(unavailable.label,'Valuation unavailable');
 assert.match(unavailable.detail,/risk token: the oracle feed description does not match; risk token: asset health check failed/);
 assert.equal(valuationBasisModel({valuation:{basis:'unavailable',structuralReasons:[]}},now).detail,
  'Oracle valuation is unavailable: no usable oracle evidence has been recorded for this mark.');
 assert.equal(valuationBasisModel({valuation:{basis:'mystery'}},now).kind,'unavailable','an unknown basis fails closed');
 assert.equal(valuationBasisModel({},now),null);assert.equal(valuationBasisModel(null,now),null);
 assert.equal(valuationBasisModel({valuation:heldValuation,deployment:{live:{lifecycle:'queued'}}},now),null,'nothing to value while queued');
 assert.equal(valuationBasisModel({valuation:heldValuation,deployment:{live:{lifecycle:'opening'}}},now),null);
 assert.equal(valuationBasisModel({valuation:heldValuation,deployment:{live:{lifecycle:'holding'}}},now).kind,'last_oracle_price');
 assert.equal(valuationBasisModel({valuation:{...heldValuation,poolImplied:{navQuote:'x'}}},now).poolImpliedNav,null);
});

test('live row facts state the basis, the held price time and the pool-implied figure',()=>{
 const now=Date.parse(FRIDAY_CLOSE)+38*3600*1000;
 const model=liveRowModel(livePosition('holding',{},{valuation:heldValuation}),null,now);
 const fact=(name:string)=>model.facts.find(([key]:[string,string])=>key===name)?.[1];
 assert.equal(fact('Valuation basis'),'Last oracle price, Fri 20:00 ET, 38h old');
 assert.equal(fact('Pool-implied NAV (indicative)'),'189.50 · not used for P&L');
 assert.equal(model.basis.kind,'last_oracle_price');
 const none=liveRowModel(livePosition('holding',{},{valuation:{basis:'unavailable',structuralReasons:['market_session_unverified'],poolImplied:null}}),null,now);
 assert.equal(none.facts.find(([key]:[string,string])=>key==='Valuation basis')[1],'Oracle valuation unavailable');
 assert.equal(none.facts.find(([key]:[string,string])=>key==='Pool-implied NAV (indicative)')[1],'unavailable');
 const queued=liveRowModel(livePosition('queued',{job:{...baseJob,status:'queued',inFlight:true},nftId:null},{valuation:{basis:'unavailable',poolImplied:null}}),null,now);
 assert.equal(queued.facts.some(([key]:[string,string])=>key==='Valuation basis'),false,'a queued campaign has no basis to report');
 assert.equal(liveRowModel(livePosition('holding'),null,now).facts.some(([key]:[string,string])=>key==='Valuation basis'),false,'older projections without a valuation block render unchanged');
});

test('rows show a basis badge, a held-price alert and the pool-implied metric in the detail',()=>{
 const {context,run}=appContext(null);
 const paper:any=serverPosition(7,'holding','open',{nftId:'1000',range:{state:'inside'},job:{...baseJob}},{mode:'paper',navQuote:'180000000',holdQuote:'150000000',
  initialQuote:'170000000',feesQuote:'2000000',accounting:'provisional',sourceAt:new Date().toISOString(),valuation:{...heldValuation,
  priceAsOf:new Date(Date.now()-38*3600*1000).toISOString()}});
 paper.deployment={...paper.deployment,strategyId:'rangekeeper_v1',lifecycle:'active',live:undefined,
  accounting:{policyVersion:'rangekeeper_paper_observed_flow_v1',modeledCosts:{cumulativeBoundValue:'3000000'},retainedModeledFees:{token0Raw:'1',token1Raw:'1'}},
  token0:{symbol:'USDG',decimals:6},token1:{symbol:'AAPL',decimals:18}};
 Object.assign(context,{paper});context.p=run('normalize(paper)');
 const row=run('row(p,null)') as string;
 assert.match(row,/<span class="basis-badge last_oracle_price" title="[^"]*Valued at last oracle price[^"]*">Last oracle price · 38h old<\/span>/);
 assert.match(row,/180\.00/);
 const metrics=run('deploymentMetrics(p)') as string;
 assert.match(metrics,/Pool-implied NAV \(indicative\)[\s\S]*189\.50[\s\S]*never used for P&amp;L|never used for P&L/);
 assert.match(metrics,/Provisional · last oracle price · 38h old/);
 assert.match(run('basisAlert(p)') as string,/class="alert neutral basis-alert last_oracle_price"><strong>Last oracle price · 38h old<\/strong>/);
 const fresh:any={...paper,valuation:{basis:'oracle_fresh',priceAsOf:new Date().toISOString(),priceAgeAtMarkSeconds:10,feeds:[],freshnessReasons:[],structuralReasons:[],poolImplied:null}};
 Object.assign(context,{fresh});context.q=run('normalize(fresh)');
 assert.match(run('row(q,null)') as string,/class="basis-badge oracle_fresh"[^>]*>Oracle fresh<\/span>/);
 assert.equal(run('basisAlert(q)'),'','a fresh basis needs no extra alert');
 assert.match(run('poolImpliedMetric(q)') as string,/Pool-implied NAV \(indicative\)[\s\S]*—/,'a missing pool-implied figure is a dash with the reason');
 const unavailable:any={...paper,navQuote:null,holdQuote:null,feesQuote:null,valuation:{basis:'unavailable',priceAsOf:null,feeds:[],freshnessReasons:[],
  structuralReasons:['token1_asset_health'],poolImplied:{navQuote:'189500000',priceQuoteX18:'1'}}};
 Object.assign(context,{unavailable});context.r=run('normalize(unavailable)');
 const unavailableRow=run('row(r,null)') as string;
 assert.match(unavailableRow,/class="basis-badge unavailable"[^>]*>Valuation unavailable<\/span>/);
 assert.doesNotMatch(unavailableRow,/Last oracle price/);
 assert.match(run('deploymentMetrics(r)') as string,/Pool-implied NAV \(indicative\)[\s\S]*189\.50/,'the indicative figure survives when the oracle headline is unavailable');
 assert.match(run('basisAlert(r)') as string,/risk token: asset health check failed/);
 const plain:any={...paper,valuation:undefined};Object.assign(context,{plain});context.s=run('normalize(plain)');
 assert.doesNotMatch(run('row(s,null)') as string,/basis-badge/,'positions without a valuation block (static rows) show no badge');
});

// ---- campaign scope ----
const {campaignScopeFromInputs,campaignScopeLabels,campaignScopeIsValid,CAMPAIGN_SCOPE_DEFAULT,liveSetupPreflightRequest,
 liveSetupPreflightFacts,easternDateTime}=tabs as any;
const registeredPool={marketProfileId:'67b2b303-e821-4450-bb7b-27171b12079f',poolAddress:'0x1111111111111111111111111111111111111111',tickSpacing:60};
const reviewLimits={maxDeploymentValue:'1',minDeploymentValue:'1',maxExposurePpm:1,maxLossValue:'1',maxDrawdownPpm:1,maxActionCost:'1',
 maxRollingCost:'1',maxCampaignCost:'1',exitReserveWei:'1',maxSlippageBps:50,minDeploymentPpm:1,maxSwapInputValue:'1',maxSwapInputPpm:1,
 maxSwapShortfallValue:'1',maxRecenters:2,maxLiquiditySharePpm:1,maxObservationGapSeconds:60};

test('campaign scope inputs default open-ended and validate against the kernel bounds',()=>{
 assert.deepEqual(CAMPAIGN_SCOPE_DEFAULT,{maxDurationSeconds:0,maxEconomicActions:0});
 const ok=(durationHours:string,maxActions:string)=>campaignScopeFromInputs({durationHours,maxActions});
 assert.deepEqual(ok('0','0'),{ok:true,scope:{maxDurationSeconds:0,maxEconomicActions:0}},'the prefilled values are open-ended and unlimited');
 assert.deepEqual(ok('12','2').scope,{maxDurationSeconds:43_200,maxEconomicActions:2});
 assert.deepEqual(ok('24','10').scope,{maxDurationSeconds:86_400,maxEconomicActions:10},'the upper bounds are accepted');
 assert.deepEqual(ok('1.5','1').scope,{maxDurationSeconds:5_400,maxEconomicActions:1});
 assert.deepEqual(ok('0.01','0').scope,{maxDurationSeconds:36,maxEconomicActions:0},'two decimals always make whole seconds');
 assert.deepEqual(ok(' 6 ',' 3 ').scope,{maxDurationSeconds:21_600,maxEconomicActions:3});
 for(const [hours,actions] of [['24.01','0'],['25','0'],['100','0'],['-1','0'],['1.234','0'],['1e1','0'],['abc','0'],['','0'],[' ','0'],['1,5','0'],
  ['0','11'],['0','-1'],['0','1.5'],['0','x'],['0',''],['0','2e0'],['0','010x']]){
  const result=ok(hours!,actions!);assert.equal(result.ok,false,`${hours}/${actions}`);assert(result.reason.length>20,'a failed input explains itself');
 }
 assert.match(ok('25','0').reason,/cannot exceed 24 hours/);assert.match(ok('0','11').reason,/0 to 10/);
 assert.equal(ok('0','010').ok,true,'leading zeros are the same whole number');
 assert.equal(campaignScopeIsValid({maxDurationSeconds:0,maxEconomicActions:0}),true);
 for(const bad of [null,undefined,{},{maxDurationSeconds:0},{maxDurationSeconds:86_401,maxEconomicActions:0},{maxDurationSeconds:0,maxEconomicActions:11},
  {maxDurationSeconds:1.5,maxEconomicActions:0},{maxDurationSeconds:0,maxEconomicActions:0,extra:1},{maxDurationSeconds:'0',maxEconomicActions:0}])
  assert.equal(campaignScopeIsValid(bad),false,JSON.stringify(bad));
});

test('campaign scope labels read Open-ended and Unlimited, and state finite values in words',()=>{
 assert.deepEqual(campaignScopeLabels({maxDurationSeconds:0,maxEconomicActions:0}),{duration:'Open-ended',actions:'Unlimited'});
 assert.deepEqual(campaignScopeLabels({maxDurationSeconds:43_200,maxEconomicActions:2}),{duration:'12 hours',actions:'2'});
 assert.equal(campaignScopeLabels({maxDurationSeconds:3_600,maxEconomicActions:1}).duration,'1 hour');
 assert.equal(campaignScopeLabels({maxDurationSeconds:5_400,maxEconomicActions:1}).duration,'1.5 hours');
 assert.equal(campaignScopeLabels({maxDurationSeconds:36,maxEconomicActions:1}).duration,'0.01 hours');
 assert.deepEqual(campaignScopeLabels({maxDurationSeconds:-1,maxEconomicActions:0}),{duration:'Unavailable',actions:'Unavailable'});
 assert.deepEqual(campaignScopeLabels(null),{duration:'Unavailable',actions:'Unavailable'});
});

test('the live review request carries the validated scope and rejects an invalid one before anything is sent',()=>{
 const scope={maxDurationSeconds:0,maxEconomicActions:0};
 const request=liveSetupPreflightRequest({pool:registeredPool,capital:'250',fullWidthSpacings:'20',limits:reviewLimits,liveSetup:true,campaignScope:scope});
 assert.equal(request.available,true,JSON.stringify(request));
 assert.deepEqual(request.payload.campaignScope,scope);
 assert.deepEqual(Object.keys(request.payload).sort(),['campaignScope','capitalQuoteRaw','fullWidthSpacings','limits','profileId']);
 assert.notEqual(request.payload.campaignScope,scope,'the payload carries a copy, not the caller object');
 const finite=liveSetupPreflightRequest({pool:registeredPool,capital:'250',fullWidthSpacings:'20',limits:reviewLimits,liveSetup:true,
  campaignScope:{maxDurationSeconds:43_200,maxEconomicActions:2}});
 assert.deepEqual(finite.payload.campaignScope,{maxDurationSeconds:43_200,maxEconomicActions:2});
 for(const bad of [{maxDurationSeconds:90_000,maxEconomicActions:0},{maxDurationSeconds:0,maxEconomicActions:11},{maxDurationSeconds:0},null,'open'])
  assert.equal(liveSetupPreflightRequest({pool:registeredPool,capital:'250',fullWidthSpacings:'20',limits:reviewLimits,liveSetup:true,campaignScope:bad}).available,false,JSON.stringify(bad));
 const without=liveSetupPreflightRequest({pool:registeredPool,capital:'250',fullWidthSpacings:'20',limits:reviewLimits,liveSetup:true});
 assert.equal('campaignScope' in without.payload,false,'a caller that does not choose a scope sends none');
});

test('the review summary states the frozen campaign scope in words',()=>{
 const facts=(result:unknown)=>Object.fromEntries(liveSetupPreflightFacts(result) as [string,string][]);
 const base={status:'indicative'};
 const open=facts({...base,policy:{config:{campaignScope:{maxDurationSeconds:0,maxEconomicActions:0}}}});
 assert.equal(open['Campaign duration'],'Open-ended · no expiry');
 assert.equal(open['Max economic actions'],'Unlimited · bounded by the cost, loss and recenter limits');
 const finite=facts({...base,policy:{config:{campaignScope:{maxDurationSeconds:43_200,maxEconomicActions:2}}}});
 assert.equal(finite['Campaign duration'],'12 hours after opening, then retain-close');
 assert.equal(finite['Max economic actions'],'2 including the opening, then retain-close');
 const echoed=facts({...base,input:{campaignScope:{maxDurationSeconds:3_600,maxEconomicActions:1}}});
 assert.equal(echoed['Campaign duration'],'1 hour after opening, then retain-close');
 const both=facts({...base,policy:{config:{campaignScope:{maxDurationSeconds:0,maxEconomicActions:0}}},input:{campaignScope:{maxDurationSeconds:3_600,maxEconomicActions:1}}});
 assert.equal(both['Campaign duration'],'Open-ended · no expiry','the frozen kernel config wins over the echoed request');
 assert.equal('Campaign duration' in facts({...base,policy:{config:{campaignScope:{maxDurationSeconds:-5,maxEconomicActions:0}}}}),false,'an invalid scope is not shown');
 assert.equal('Campaign duration' in facts(base),false);
});

test('live row facts show when a campaign expires and how many economic actions it has used',()=>{
 const scope=(extra:Record<string,unknown>)=>({maxDurationSeconds:0,maxEconomicActions:0,openEnded:true,expiresAt:null,economicActions:3,...extra});
 const fact=(model:any,name:string)=>model.facts.find(([key]:[string,string])=>key===name)?.[1];
 const open=liveRowModel(livePosition('holding',{scope:scope({})}));
 assert.equal(fact(open,'Expires'),'Open-ended');assert.equal(fact(open,'Economic actions'),'3 of unlimited');
 const expiry=new Date(Date.now()+5*3600*1000).toISOString();
 const finite=liveRowModel(livePosition('holding',{scope:scope({maxDurationSeconds:43_200,maxEconomicActions:2,openEnded:false,expiresAt:expiry,economicActions:2})}));
 assert.equal(fact(finite,'Expires'),easternDateTime(expiry));assert.match(fact(finite,'Expires'),/ET$/);
 assert.equal(fact(finite,'Economic actions'),'2 of 2');
 const queued=liveRowModel(livePosition('queued',{job:{...baseJob,status:'queued',inFlight:true},nftId:null,
  scope:scope({maxDurationSeconds:7_200,maxEconomicActions:4,openEnded:false,expiresAt:null,economicActions:null})}));
 assert.equal(fact(queued,'Expires'),'2 hours after opening','a campaign that has not opened has no date yet');
 assert.equal(fact(queued,'Economic actions'),'0 of 4');
 const queuedOpen=liveRowModel(livePosition('queued',{job:{...baseJob,status:'queued',inFlight:true},nftId:null,
  scope:scope({economicActions:null})}));
 assert.equal(fact(queuedOpen,'Expires'),'Open-ended');assert.equal(fact(queuedOpen,'Economic actions'),'0 of unlimited');
 const legacy=liveRowModel(livePosition('holding',{scope:scope({maxDurationSeconds:null,maxEconomicActions:null,openEnded:false,expiresAt:expiry,economicActions:1})}));
 assert.equal(fact(legacy,'Economic actions'),'1 (limit not recorded)');
 const unknown=liveRowModel(livePosition('holding',{scope:scope({maxDurationSeconds:null,maxEconomicActions:null,openEnded:null,expiresAt:null,economicActions:null})}));
 assert.equal(fact(unknown,'Expires'),'unavailable');assert.equal(fact(unknown,'Economic actions'),'unavailable');
 assert.equal(liveRowModel(livePosition('holding',{scope:undefined})).facts.some(([key]:[string,string])=>key==='Expires'),false,
  'an older projection without a scope renders unchanged');
});

test('position detail defaults to the Price & range chart and shows the range width in ticks',()=>{
 const {context,run}=appContext();
 assert.equal(run('modes.live.metric'),'range');assert.equal(run('modes.paper.metric'),'range');
 const width=(p:Record<string,unknown>)=>{context.p=p;return run('widthRow(p)') as string;};
 const text=(html:string)=>html.replace(/<[^>]+>/g,'');
 const live={tickLower:-218030,tickUpper:-217630,tickSpacing:10,strategy:{fullWidthSpacings:40}};
 assert.equal(text(width(live)),'Range width400 ticks (40 × 10) · ±2.0%');
 assert.equal(text(width({...live,strategy:{fullWidthSpacings:48}})),'Range width400 ticks (40 × 10) · ±2.0% · configured 480 ticks (48 × 10)');
 assert.equal(text(width({tickLower:-60,tickUpper:60})),'Range width120 ticks · ±0.6%','static strategies show the actual width only');
 assert.equal(text(width({rangekeeper:{tickLower:0,tickUpper:400},tickSpacing:10})),'Range width400 ticks (40 × 10) · ±2.0%');
 assert.equal(width({tickLower:null,tickUpper:null,tickSpacing:10,strategy:{fullWidthSpacings:40}}),'','no position, no width');
 assert.equal(width({}),'');
});
