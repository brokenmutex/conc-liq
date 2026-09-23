import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {assertPaperCloseConvertSampleContext} from '../src/deployments/paper-close-convert-gas-sample-context.js';

const hash=`0x${'1'.repeat(64)}`;
const input:any={campaignId:'00000000-0000-4000-8000-000000000001',terminalMarkId:'12',previousMarkId:'11',
 profile:{pool:{pool:'0x0000000000000000000000000000000000000001'}},
 openModel:{campaignId:'00000000-0000-4000-8000-000000000001',candidate:{range:{tickLower:-10,tickUpper:10},liquidity:'9'}},
 frame:{source:{block:'20',hash,timestamp:200}}};
const terminal:any={ending:'close_convert',fromMarkId:'11',toMarkId:'12',
 profile:{pool:{pool:'0x0000000000000000000000000000000000000001'}},
 range:{tickLower:-10,tickUpper:10},liquidity:9n,after:{source:{...input.frame.source}}};

describe('static/manual close-convert sampler input binding',()=>{
 it('accepts only the persisted exact close endpoint and open position identity',()=>{
  assert.doesNotThrow(()=>assertPaperCloseConvertSampleContext(input,terminal));
  assert.throws(()=>assertPaperCloseConvertSampleContext(input,{...terminal,toMarkId:'13'}));
  assert.throws(()=>assertPaperCloseConvertSampleContext(input,{...terminal,
   after:{source:{...terminal.after.source,hash:`0x${'2'.repeat(64)}`}}}),/persisted terminal source/);
 });
 it('fails closed when there is no persisted converted-close endpoint',()=>{
  assert.throws(()=>assertPaperCloseConvertSampleContext(input,null),/endpoint is unavailable/);
  assert.throws(()=>assertPaperCloseConvertSampleContext(input,{...terminal,ending:'valuation'}),
   /endpoint is unavailable/);
 });
});
