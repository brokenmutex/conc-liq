import assert from 'node:assert/strict';import {test} from 'node:test';import {readFileSync} from 'node:fs';
import {dilutedFeeReplay,creditDilutedFees} from '../src/paper/diluted-fees.js';
import {ExperimentMarket,type ExperimentEvent,type MarketSeed} from '../src/experiment/market.js';
import {initialPaperState,advancePaper,type PaperInput,type PaperCheckpoint,type PaperPosition} from '../src/paper/engine.js';
import {liquidityShare,liquidityShareAllowed} from '../src/paper/liquidity-share.js';
import {feeSharePolicyChange,executionPolicyHash} from '../src/paper/policy-history.js';
import {paperPolicySchema} from '../src/paper/config.js';import {policyHash} from '../src/paper/engine.js';
const q=1n<<128n,hash='0x'+'a'.repeat(64),price=String(1n<<96n);
function scenario(ours='1000',outside=false){
 const seed:MarketSeed={price,tick:0,liquidity:'1000',global0:'0',global1:'0',protocol0:0,protocol1:0,ticks:[{tick:-20,gross:'1000',net:'1000'},{tick:20,gross:'1000',net:'-1000'}]};
 const before={block:'1',hash,blockTimestamp:'2026-09-12T08:00:00Z',sqrtPriceX96:price,tick:0,liquidity:'1000',feeGrowth0:'0',feeGrowth1:'0'} as PaperCheckpoint;
 const range=outside?{tickLower:20,tickUpper:40}:{tickLower:-20,tickUpper:20};
 if(outside){seed.ticks[1]={tick:20,gross:'2000',net:'0'};seed.ticks.push({tick:40,gross:'1000',net:'-1000'});}
 const boundary={block:'1',hash,...range,lower:{gross:outside?'2000':'1000',outside0:'0',outside1:'0'},upper:{gross:'1000',outside0:'0',outside1:'0'}};
 const position:PaperPosition={...range,liquidity:ours,idle0:'0',idle1:'0',fee0:'7',fee1:'11',hold0:'100',hold1:'200',enteredAt:before.blockTimestamp,boundaryFees:boundary,feeRemainder0:'0',feeRemainder1:'0'};
 const event=(log:number,name:string,args:ExperimentEvent['args']):ExperimentEvent=>({block:'2',hash,tx:0,log,name,args});
 const events=[event(0,'Flash',{paid0:'300',paid1:'100'}),event(1,'Mint',{tickLower:-20,tickUpper:20,amount:'1000'}),
  event(2,'SetFeeProtocol',{feeProtocol0Old:0,feeProtocol1Old:0,feeProtocol0New:4,feeProtocol1New:5}),event(3,'Flash',{paid0:'600',paid1:'1000'})];
 const m=new ExperimentMarket(seed);for(const e of events)m.apply(e);
 const after={...before,block:'2',blockTimestamp:'2026-09-12T08:01:00Z',liquidity:String(m.liquidity),feeGrowth0:String(m.global0),feeGrowth1:String(m.global1)};
 const endBoundary={...structuredClone(boundary),block:'2'};endBoundary.lower.gross=outside?'3000':'2000';if(!outside)endBoundary.upper.gross='2000';
 return {seed,before,after,position,endBoundary,events};
}
test('fee dilution uses each segment depth and protocol fee, reconciling exact observed growth',()=>{
 const s=scenario(),p=dilutedFeeReplay(s.seed,s.events,s.before,s.after,s.position,s.endBoundary);
 assert.equal(p.raw0,String(((300n*q/2000n)+(450n*q/3000n))*1000n));
 assert.equal(p.raw1,String(((100n*q/2000n)+(800n*q/3000n))*1000n));
 assert.equal(p.undilutedRaw0,String((300n*q/1000n+450n*q/2000n)*1000n));
 assert(BigInt(p.raw0)<BigInt(p.undilutedRaw0));assert.equal(p.maxRatioPpm,'1000000');assert.equal(p.events,4);
 const absent=scenario('1000',true),zero=dilutedFeeReplay(absent.seed,absent.events,absent.before,absent.after,absent.position,absent.endBoundary);
 assert.equal(zero.raw0,'0');assert.equal(zero.raw1,'0');
});
test('incomplete, reordered or conflicting replay evidence cannot credit fees',()=>{
 const s=scenario(),replay=(events=s.events,after=s.after,end=s.endBoundary)=>dilutedFeeReplay(s.seed,events,s.before,after,s.position,end);
 assert.throws(()=>replay(s.events.slice(1)),/fee0 mismatch/);assert.throws(()=>replay([...s.events].reverse()),/ordered/);
 assert.throws(()=>replay(s.events.map(e=>({...e,hash:'0xbad'}))));assert.throws(()=>replay(s.events,{...s.after,feeGrowth1:'0'}),/fee1 mismatch/);
 assert.throws(()=>replay(s.events,s.after,{...s.endBoundary,lower:{...s.endBoundary.lower,gross:'0'}}),/continuity/);
});
test('new credit preserves historical fee balances and records parallel undiluted increments with remainders',()=>{
 const s=scenario(),proof=dilutedFeeReplay(s.seed,s.events,s.before,s.after,s.position,s.endBoundary),state=initialPaperState();
 state.position=structuredClone(s.position);state.execution={intent:null,entryRunId:'1',exitRunId:null,gasSpentWei:'0',holdGasQuote:'0',exitReserveWei:'0',allowances:[],earnedFee0:'700',earnedFee1:'1100',lastValuation:null};
 state.position.feeRemainder0=String(q-1n);
 creditDilutedFees(state,s.before,s.after,s.endBoundary,proof);
 assert.equal(state.feeModel!.legacyEarned0,'700');assert.equal(state.feeModel!.legacyEarned1,'1100');assert.equal(state.feeModel!.fromBlock,'1');
 assert.equal(state.position.fee0,String(7n+(BigInt(proof.raw0)+q-1n)/q));assert.equal(state.position.feeRemainder0,String((BigInt(proof.raw0)+q-1n)%q));
 assert.equal(state.execution.earnedFee0,'700','Cumulative ledger is advanced once by the transaction engine');
 const fresh=()=>{const r=structuredClone(state);r.position=structuredClone(s.position);return r;};
 assert.throws(()=>creditDilutedFees(fresh(),s.before,s.after,s.endBoundary,undefined),/missing/);
 assert.throws(()=>creditDilutedFees(fresh(),s.before,s.after,s.endBoundary,{...proof,fromBlock:'0'}));
 assert.throws(()=>creditDilutedFees(fresh(),s.before,s.after,s.endBoundary,{...proof,raw0:String(BigInt(proof.undilutedRaw0)+1n)}));
});
test('share warning permits recentering above threshold, retaining both ratios and legacy caps',()=>{
 const old={maxLiquiditySharePpm:20000},next={...old,liquidityShareMode:'warn_v1' as const};
 assert.equal(liquidityShareAllowed(21n,1000n,old),false);assert.equal(liquidityShareAllowed(21n,1000n,next),true);
 assert.equal(liquidityShareAllowed(20n,1000n,old),true);
 assert.deepEqual(liquidityShare(21n,1000n,next),{mode:'warn_v1',thresholdPpm:20000,ratioToExistingPpm:'21000',shareAfterDepositPpm:'20568',exceedsThreshold:true});
 assert.equal(liquidityShareAllowed(1n,0n,old),false);assert.equal(liquidityShare(1n,0n,next).shareAfterDepositPpm,'1000000');
});
test('open-policy upgrade permits only the agreed fee/share change and retains historical hashes',()=>{
 const read=(name:string)=>paperPolicySchema.parse(JSON.parse(readFileSync(new URL(`../config/${name}.json`,import.meta.url),'utf8')));
 const old=read('paper-nvda-5000-recenter-continuous'),next=read('paper-nvda-5000-recenter-diluted'),change=feeSharePolicyChange(old,next);
 for(const patch of [{maxSlippageBps:100},{halfWidthSpacings:3},{budgetQuote:'4000000000'},{maxLiquiditySharePpm:10000}])assert.throws(()=>feeSharePolicyChange(old,{...next,...patch}),/Only diluted/);
 assert.throws(()=>paperPolicySchema.parse({...old,liquidityShareMode:'warn_v1'}),/diluted/);
 const id={buildId:'a'.repeat(64),configHash:'b'.repeat(64),nodeVersion:process.version},history=[{from:id,to:{...id,buildId:'c'.repeat(64)},throughRunId:'50',throughObservationId:'100',at:'2026-09-12T08:00:00Z',stateSha256:'d'.repeat(64),policyChange:change}];
 assert.equal(executionPolicyHash(policyHash(next),next,history,'50'),policyHash(old));assert.equal(executionPolicyHash(policyHash(next),next,history,'51'),policyHash(next));
 assert.throws(()=>executionPolicyHash(policyHash(old),old,history));
});

test('forward ledger credits adjusted fees once and a high liquidity warning does not trigger exit',()=>{
 const s=scenario(),proof=dilutedFeeReplay(s.seed,s.events,s.before,s.after,s.position,s.endBoundary),state=initialPaperState();
 const policy=paperPolicySchema.parse(JSON.parse(readFileSync(new URL('../config/paper-nvda-5000-recenter-diluted.json',import.meta.url),'utf8')));
 state.status='open';state.position=structuredClone(s.position);state.last={...s.before,capturedAt:s.before.blockTimestamp};
 state.execution={intent:null,entryRunId:'1',exitRunId:null,gasSpentWei:'0',holdGasQuote:'0',exitReserveWei:'0',allowances:[],earnedFee0:'700',earnedFee1:'1100',lastValuation:null};
 const input:PaperInput={now:s.after.blockTimestamp,checkpoint:{...s.after,capturedAt:s.after.blockTimestamp},dataReasons:[],entryReasons:[],chainHealthy:true,holdingChainReady:true,
 pathMinTick:0,pathMaxTick:0,swapCount:'0',boundaryFees:s.endBoundary,boundaryContinuity:true,dilutedFees:proof,execution:{available:true}};
 const original=structuredClone(state),next=advancePaper(state,policy,input);
 assert.equal(next.status,'open');assert.equal(next.action,'mark');assert.deepEqual(next.reasons,[]);assert.equal(next.liquidityShare!.exceedsThreshold,true);
 assert.equal(next.execution!.earnedFee0,String(700n+BigInt(proof.raw0)/q));assert.equal(next.execution!.earnedFee1,String(1100n+BigInt(proof.raw1)/q));
 assert.deepEqual(state,original);assert.equal(next.costsPaidQuote,state.costsPaidQuote);assert.equal(next.position!.hold0,state.position!.hold0);
 assert.throws(()=>advancePaper(next,policy,input),/advance strictly/);
});
