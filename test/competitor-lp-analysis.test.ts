import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const wallet='0x'+'1'.repeat(40),manager='0x'+'2'.repeat(40),pool='0x'+'3'.repeat(40),stock='0x'+'4'.repeat(40);
const usdg='0x5fc5360d0400a0fd4f2af552add042d716f1d168',zero='0x'+'0'.repeat(40);
const topic=(x:string)=>'0x'+x.slice(2).padStart(64,'0'),hash=(n:number)=>'0x'+String(n).padStart(64,'0');
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function fixture(){
 const events=(kind:string,liquidity:string,amount0:string,amount1:string)=>[
  {address:pool,index:3,name:kind,args:{owner:manager,tickLower:0,tickUpper:10,amount:liquidity,amount0,amount1}},
  {address:manager,index:4,name:kind==='Mint'?'IncreaseLiquidity':'DecreaseLiquidity',args:{tokenId:'1',liquidity,amount0,amount1}},
 ];
 const payments=[usdg,stock].map((token,i)=>({address:token,logIndex:'0x'+(5+i),topics:[transfer,topic(pool),topic(wallet)],data:'0x'+(i?280:150).toString(16)}));
 const receipts=[events('Mint','10','100','200'),events('Mint','5','50','60'),[
  ...events('Burn','15','140','250'),
  {address:pool,index:7,name:'Collect',args:{owner:manager,recipient:wallet,tickLower:0,tickUpper:10,amount0:'150',amount1:'280'}},
  // Requested periphery amounts differ from actual pool transfers.
  {address:manager,index:8,name:'Collect',args:{tokenId:'1',recipient:wallet,amount0:'151',amount1:'282'}},
 ]].map((events,i)=>({events,receipt:{transactionHash:hash(i+1),blockNumber:'0x'+(i+1),transactionIndex:'0x0',from:wallet,gasUsed:'0x64',effectiveGasPrice:'0x2',logs:i===2?payments:[]}}));
 return {anchor:{wallet,manager},ownership:[{topics:[transfer,topic(zero),topic(wallet),topic('0x1')],blockNumber:'0x1'}],
  receipts,headers:Object.fromEntries([1,2,3].map(i=>['0x'+i,{timestamp:i*60}])),
  transactions:Object.fromEntries([1,2,3].map(i=>[hash(i),{nonce:i}])),
  pools:{[pool]:{token0:usdg,token1:stock,symbol0:'USDG',symbol1:'TEST',fee:500,tickSpacing:10}},
  prices:Object.fromEntries([[1,3],[2,3],[3,3],[3,7]].map(([n,index])=>[hash(n!)+':'+index,{sqrtPriceX96:String(1n<<96n),tick:5}])),
  positions:{'1':{value:['0','0','0','0','0','0','0','0','0','0','0','0']}}};
}
function analyze(c:ReturnType<typeof fixture>){
 const dir=mkdtempSync(join(tmpdir(),'competitor-analysis-test-'));
 try{
  const bytes=JSON.stringify(c);writeFileSync(join(dir,'capture.json'),bytes);
  writeFileSync(join(dir,'capture.sha256'),createHash('sha256').update(bytes).digest('hex'));
  execFileSync(process.execPath,['scripts/research/competitor-lp-analyze.mjs',dir],{stdio:'pipe'});
  return JSON.parse(readFileSync(join(dir,'analysis.json'),'utf8'));
 }finally{rmSync(dir,{recursive:true,force:true});}
}
test('competitor fees reconcile all top-ups and actual core payments, not periphery requests',()=>{
 const result=analyze(fixture()),p=result.positions[0];
 assert.equal(p.adds,2);assert.equal(p.settled,true);assert.equal(p.solelyOwned,true);
 assert.deepEqual(p.closedFeesRaw,{amount0:'10',amount1:'30'});
 assert.equal(p.closedFeesAtWithdrawalPoolPriceQuote,'40');
 assert.equal(p.poolMarkedTokenFlowSurplusBeforeGasQuote,'20');
 assert.equal(p.poolMarkedCashflowPnlBeforeGasQuote,'20');
 assert.equal(p.relatedTransactionGasWei,'600');assert.equal(p.netWalletPnlQuote,null);
});
test('competitor analysis rejects a missing actual payment and excludes transferred ownership',()=>{
 const bad=fixture();bad.receipts[2]!.receipt.logs[0]!.data='0x95';
 assert.throws(()=>analyze(bad),/Core Collect payment mismatch/);
 const transferred=fixture();transferred.ownership.push({topics:[transfer,topic(wallet),topic(stock),topic('0x1')],blockNumber:'0x2'});
 const p=analyze(transferred).positions[0];assert.equal(p.solelyOwned,false);assert.equal(p.closedFeesRaw,null);
 const indirect=fixture();
 for(const e of indirect.receipts[2]!.events)if(e.name==='Collect'&&'recipient' in e.args)e.args.recipient=stock;
 for(const payment of indirect.receipts[2]!.receipt.logs)payment.topics[2]=topic(stock);
 const excluded=analyze(indirect);assert.equal(excluded.positions[0].solelyOwned,true);
 assert.equal(excluded.positions[0].directCollections,false);assert.equal(excluded.positions[0].closedEconomicsEligible,false);
 assert.equal(excluded.pools[0].closedFeesAtWithdrawalPoolPriceQuote,null);
});
