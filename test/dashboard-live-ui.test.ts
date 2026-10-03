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
   'const mountPaperLifecycleAction=()=>{},mountStaticRetainAction=()=>{},mountPaperConvertAction=()=>{},mountPendingPaperAcceptanceRecovery=()=>{};')
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
 assert.equal((html.match(/data-can-review="true"/g)??[]).length,2);
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
 assert.doesNotMatch(html,/live-retain-action-root/);
 assert.match(html,/Live actions are available on the operator dashboard/);
 assert.equal(run('lifecycleControls(p)'),'','live positions get no pause or convert controls');
});
