import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {paperGasQuote} from '../src/paper/transaction-engine.ts';
const [capturePath,proofPath,output]=process.argv.slice(2);assert(output&&!fs.existsSync(output));
const digest=x=>createHash('sha256').update(x).digest('hex'),data=JSON.parse(fs.readFileSync(capturePath)),proofs=JSON.parse(fs.readFileSync(proofPath));
const convert=(wei,v)=>{const a=wei*BigInt(v.ethUsdAnswer)*10n**BigInt(v.quoteUsdDecimals)*1000000n,b=10n**18n*10n**BigInt(v.ethUsdDecimals)*BigInt(v.quoteUsdAnswer);return (a+b-1n)/b;};
function inspect(transactions,valuation){
 let gas=0n,local=0n,fee=0n,parent=0n,localAtSourcePrice=0n;
 const rows=transactions.map(t=>{const e=t.estimate,g=BigInt(e.gas),p=BigInt(e.parentGas),price=BigInt(e.baseFeeWei),total=BigInt(e.totalFeeWei);
  assert.equal(total,g*price);assert.equal(BigInt(e.parentFeeWei),p*price);assert.equal(BigInt(e.executionFeeWei)+BigInt(e.parentFeeWei),total);assert(p<=g);
  assert.equal(paperGasQuote(String(total),valuation),convert(total,valuation));
  gas+=g;local+=BigInt(t.localGasUsed);fee+=total;parent+=BigInt(e.parentFeeWei);localAtSourcePrice+=BigInt(t.localGasUsed)*price;
  return {action:t.action,gas:String(g),localGas:t.localGasUsed,gasPriceGwei:Number(price)/1e9,parentGas:String(p),quote:String(convert(total,valuation))};
 });
 const charge=convert(fee,valuation),separate=rows.reduce((n,t)=>n+BigInt(t.quote),0n);
 assert(separate-charge>=0n&&separate-charge<BigInt(rows.length));
 return {gas:String(gas),localGas:String(local),feeWei:String(fee),quote:Number(charge)/1e6,parentQuote:Number(convert(parent,valuation))/1e6,estimateVsLocalGas:Number(gas)/Number(local),localGasAtSourcePriceQuote:Number(convert(localAtSourcePrice,valuation))/1e6,gasPriceGwei:rows[0].gasPriceGwei,perTransactionRoundingDifferenceMicro:String(separate-charge),transactions:rows};
}
const campaign=data.rows.filter(r=>Number(r.session_id)>=5).sort((a,b)=>Number(a.id)-Number(b.id)).map(r=>{
 const end=r.result.transactions.findIndex(t=>t.action==='decrease_and_collect');assert(r.action!=='entry'||end>0);
 const tx=r.action==='entry'?r.result.transactions.slice(0,end):r.result.transactions;
 const x=inspect(tx,r.valuation);assert.equal(x.feeWei,r.action==='entry'?r.result.entryGasWei:r.result.totalGasWei);
 return {id:r.id,session:r.session_id,action:r.action,sourceBlock:r.source_block,sourceHash:r.source_hash,observedAt:r.observed_at,...x};
});
const proofRows=[];
for(const [name,p] of Object.entries(proofs.profiles)){
 const raw=fs.readFileSync(p.path);assert.equal(digest(raw),p.sha256);const r=JSON.parse(raw),x=inspect(r.result.transactions,r.valuation);
 assert.equal(x.feeWei,r.result.totalGasWei);proofRows.push({name,sourceBlock:r.result.source.block,sourceHash:r.result.source.hash,...x});
}
const distribution=xs=>{xs=[...xs].sort((a,b)=>a-b);const n=xs.length;return {n,min:xs[0],median:n%2?xs[(n-1)/2]:(xs[n/2-1]+xs[n/2])/2,p90:xs[Math.ceil(n*.9)-1],max:xs.at(-1)};};
const groups=['entry','exit'].map(action=>{const r=campaign.filter(x=>x.action===action);return {action,costUSDG:distribution(r.map(x=>x.quote)),gasPriceGwei:distribution(r.map(x=>x.gasPriceGwei)),estimateVsLocalGas:distribution(r.map(x=>x.estimateVsLocalGas))};});
const result={capturedAt:data.capturedAt,captureSha256:digest(fs.readFileSync(capturePath)),costEvidenceSha256:digest(fs.readFileSync(proofPath)),auditCodeSha256:digest(fs.readFileSync('scripts/audit-lp-gas-estimates.mjs')),checks:{gasTimesPrice:true,parentChargedOnce:true,oracleUnitConversion:true,transactionSum:true,roundingLessThanOneMicroPerTransaction:true},groups,proofs:proofRows,campaign,
 limitations:['Node gas estimates are not our realized Nitro receipts','Anvil execution gas at the source price is only a comparison; it does not prove identical live metering or all parent costs','Sample includes successful saved campaign entries and exits only; failed and hypothetical partial transactions are not represented','Historical gas-price distribution is not an off-hours forecast; shared fixed profiles are economic sensitivity scenarios']};
const raw=JSON.stringify(result,null,2)+'\n';fs.writeFileSync(output,raw,{flag:'wx'});fs.writeFileSync(output+'.sha256',digest(raw)+'\n',{flag:'wx'});console.log(JSON.stringify({groups,proofs:proofRows.map(({transactions,...p})=>p)},null,2));
