import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accrueRangeKeeperTimeInRange,type RangeKeeperLiveState} from '../src/strategy/rangekeeper/live-domain.js';

const MAX=90,position=(liquidity=10n)=>({tokenId:77n,tickLower:-60,tickUpper:60,liquidity});
const state=(over:{tick?:number;timestamp?:number;position?:any;activeTokenId?:bigint|null}={}) => ({
 activeSeconds:100,outsideSeconds:50,lastMarkTimestamp:1000,
 activeTokenId:over.activeTokenId===undefined?77n:over.activeTokenId,
 last:{source:{block:1n,hash:'0x1',timestamp:over.timestamp??1000},tick:over.tick??0,
  position:over.position===undefined?position():over.position}}) as unknown as RangeKeeperLiveState;
const run=(s:RangeKeeperLiveState,next:number)=>{accrueRangeKeeperTimeInRange(s,next,MAX);return {a:s.activeSeconds-100,o:s.outsideSeconds-50};};

test('gap is attributed to the previous snapshot being in range',()=>{
 assert.deepEqual(run(state({tick:0}),1020),{a:20,o:0});
 assert.deepEqual(run(state({tick:-60}),1020),{a:20,o:0},'tickLower is inclusive');
});
test('gap is attributed to the previous snapshot being out of range, not the current tick',()=>{
 assert.deepEqual(run(state({tick:60}),1020),{a:0,o:20},'tickUpper is exclusive');
 assert.deepEqual(run(state({tick:-61}),1020),{a:0,o:20});
});
test('no active liquid position accrues nothing',()=>{
 assert.deepEqual(run(state({position:null}),1020),{a:0,o:0});
 assert.deepEqual(run(state({position:position(0n)}),1020),{a:0,o:0});
 assert.deepEqual(run(state({activeTokenId:null}),1020),{a:0,o:0});
 assert.deepEqual(run(state({activeTokenId:99n}),1020),{a:0,o:0},'snapshot position must be the campaign active token');
});
test('oversized, zero and negative gaps are not attributed',()=>{
 assert.deepEqual(run(state(),1000+MAX),{a:MAX,o:0},'exactly the cap still counts');
 assert.deepEqual(run(state(),1000+MAX+1),{a:0,o:0});
 assert.deepEqual(run(state(),1000),{a:0,o:0});
 assert.deepEqual(run(state(),990),{a:0,o:0});
});
