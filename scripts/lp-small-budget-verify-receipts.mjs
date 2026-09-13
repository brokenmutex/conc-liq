import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {createRobinhoodClient} from '../src/client.ts';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
const [envPath,root]=process.argv.slice(2),e=parseEnv(readFileSync(envPath,'utf8')),cfg=loadIndexerConfig(e),raw=readFileSync(root+'/live-ledger.json'),ledger=JSON.parse(raw);
const gate=new PostgresRpcHealthGate({connectionString:e.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30}),client=createRobinhoodClient(cfg.rpcUrl,20000,{beforeRequest:()=>gate.assertBulkAllowed().then(()=>{}),retryCount:0});
const actions=ledger.actions.filter(a=>a.receipt),rows=[];
try{
 for(let offset=0;offset<actions.length;offset+=4){const batch=await Promise.allSettled(actions.slice(offset,offset+4).map(async a=>{
  const saved=a.receipt,receipt=await client.getTransactionReceipt({hash:a.hash}),block=await client.getBlock({blockNumber:receipt.blockNumber});assert.equal(block.hash,receipt.blockHash);assert.equal(receipt.blockHash,saved.receipt.blockHash);assert.equal(receipt.status,saved.receipt.status);assert.equal(receipt.transactionHash,a.hash);assert.equal(String(receipt.gasUsed),saved.receipt.gasUsed);assert.equal(String(receipt.effectiveGasPrice),saved.receipt.effectiveGasPrice);
  const gas=receipt.gasUsed*receipt.effectiveGasPrice;assert.equal(String(gas),saved.facts.gasWei);
  const o=saved.gasValuation.proof.oracles,eth=o.find(o=>o.feed.baseAsset==='ETH').state,usd=o.find(o=>o.feed.baseAsset==='USDG').state;
  const quote=gas*BigInt(eth.answer)*10n**BigInt(usd.decimals)*1000000n/(10n**18n*BigInt(usd.answer)*10n**BigInt(eth.decimals));assert.equal(String(quote),saved.gasValuation.quote);
  assert.deepEqual(receipt.logs.map(l=>[l.address.toLowerCase(),l.data,l.topics]),saved.receipt.logs.map(l=>[l.address.toLowerCase(),l.data,l.topics]));
  return {id:a.id,hash:a.hash,block:String(receipt.blockNumber),blockHash:receipt.blockHash,status:receipt.status,gasWei:String(gas),gasQuote:String(quote)};
 }));for(const r of batch){if(r.status==='rejected')throw r.reason;rows.push(r.value);}}
 const gas=rows.reduce((n,r)=>n+BigInt(r.gasWei),0n),quote=rows.reduce((n,r)=>n+BigInt(r.gasQuote),0n);assert.equal(String(gas),ledger.campaign.state.gasSpentWei);assert.equal(String(quote),ledger.campaign.state.gasSpentQuote);
 writeFileSync(root+'/receipt-verification.json',JSON.stringify({at:new Date().toISOString(),ledgerSha256:createHash('sha256').update(raw).digest('hex'),rows,receiptGasMatches:true,receiptLogsMatch:true,receiptBlocksCanonical:true,oracleConversionRecomputed:true,gasWei:String(gas),gasQuote:String(quote)},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({receipts:rows.length,gasQuote:String(quote),verified:true}));
}finally{await gate.close();}
