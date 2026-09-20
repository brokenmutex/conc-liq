import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [root]=process.argv.slice(2);assert(root,'Usage: node scripts/research/competitor-lp-analyze.mjs CAPTURE_DIRECTORY');
const bytes=readFileSync(root+'/capture.json');assert.equal(createHash('sha256').update(bytes).digest('hex'),readFileSync(root+'/capture.sha256','utf8').trim());
const c=JSON.parse(bytes),wallet=c.anchor.wallet,manager=c.anchor.manager;
const stringify=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
const zero='0x'+'0'.repeat(40),address=t=>'0x'+t.slice(-40).toLowerCase();
const ownership={};for(const l of c.ownership){const id=String(BigInt(l.topics[3]));(ownership[id]??=[]).push({from:address(l.topics[1]),to:address(l.topics[2]),block:Number(BigInt(l.blockNumber))});}
const positions={},actions=[];
const receipts=[...c.receipts].sort((a,b)=>Number(BigInt(a.receipt.blockNumber)-BigInt(b.receipt.blockNumber))||Number(BigInt(a.receipt.transactionIndex)-BigInt(b.receipt.transactionIndex)));
const value=(pool,price,a0,a1)=>{const p=c.pools[pool],x=BigInt(price)**2n,q=1n<<192n;
 if(p.token0.toLowerCase()==='0x5fc5360d0400a0fd4f2af552add042d716f1d168')return a0+a1*q/x;
 if(p.token1.toLowerCase()==='0x5fc5360d0400a0fd4f2af552add042d716f1d168')return a1+a0*x/q;
 return null;};
for(const {receipt,events} of receipts){const at=c.headers[receipt.blockNumber].timestamp*1000,used=new Set(),usedPayments=new Set();
 for(const event of events.filter(e=>e.address.toLowerCase()===manager&&['IncreaseLiquidity','DecreaseLiquidity','Collect'].includes(e.name))){
  const id=event.args.tokenId;if(!ownership[id])continue;
  const name=event.name==='IncreaseLiquidity'?'Mint':event.name==='DecreaseLiquidity'?'Burn':'Collect';
  const prior=positions[id];
  const matches=events.filter(e=>e.index<event.index&&!used.has(e.index)&&e.name===name&&e.args.tickLower!==undefined&&
   (!prior||(e.address===prior.pool&&e.args.tickLower===prior.lower&&e.args.tickUpper===prior.upper))&&
   (name==='Collect'||e.args.amount===event.args.liquidity));
  const core=matches.at(-1);assert(core,`Core ${name} missing for ${id} in ${receipt.transactionHash}`);used.add(core.index);
  const p=positions[id]??={id,pool:core.address,lower:core.args.tickLower,upper:core.args.tickUpper,adds:[],burns:[],collects:[]};
  if(name==='Collect')for(const i of [0,1]){
   const amount=BigInt(core.args['amount'+i]);if(amount===0n)continue;
   const token=c.pools[p.pool]['token'+i].toLowerCase(),recipient=core.args.recipient.toLowerCase();
   const payment=receipt.logs.filter(l=>!usedPayments.has(l.logIndex)&&Number(BigInt(l.logIndex))<core.index&&
    l.address.toLowerCase()===token&&l.topics.length===3&&l.topics[0]==='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'&&
    address(l.topics[1])===p.pool.toLowerCase()&&address(l.topics[2])===recipient&&BigInt(l.data)===amount).at(-1);
   assert(payment,`Core Collect payment mismatch ${id} token${i} ${receipt.transactionHash}`);usedPayments.add(payment.logIndex);
  }
  const mark=c.prices[receipt.transactionHash+':'+core.index]??null;
  const row={hash:receipt.transactionHash,block:Number(BigInt(receipt.blockNumber)),index:core.index,at:new Date(at).toISOString(),atMs:at,
   from:receipt.from,nonce:c.transactions[receipt.transactionHash].nonce,liquidity:core.args.amount??null,amount0:core.args.amount0,amount1:core.args.amount1,
   recipient:core.args.recipient??null,price:mark?.sqrtPriceX96??null,tick:mark?.tick??null,
   quoteValue:mark?value(p.pool,mark.sqrtPriceX96,BigInt(core.args.amount0),BigInt(core.args.amount1)):null,
   inRange:mark?mark.tick>=p.lower&&mark.tick<p.upper:null,
   rangeFraction:mark?(mark.tick-p.lower)/(p.upper-p.lower):null,
   gasWei:BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice),collectPaymentsVerified:name==='Collect'?true:null};
  if(name==='Mint')p.adds.push(row);else if(name==='Burn')p.burns.push(row);else p.collects.push(row);
  actions.push({...row,tokenId:id,pool:p.pool,kind:name,lower:p.lower,upper:p.upper});
 }
}
const sum=(rows,key)=>rows.reduce((n,r)=>n+BigInt(r[key]),0n);
const summary=[];
for(const p of Object.values(positions)){
 const transfers=ownership[p.id],birth=transfers.find(t=>t.from===zero),last=p.burns.at(-1),current=c.positions[p.id];
 const solelyOwned=!!birth&&birth.to===wallet&&transfers.every(t=>t.to===wallet||t.to===zero);
 const directCollections=p.collects.every(x=>x.recipient?.toLowerCase()===wallet);
 const liquidity=sum(p.adds,'liquidity')-sum(p.burns,'liquidity');assert(liquidity>=0n);
 const burnt=transfers.some(t=>t.to===zero),settled=liquidity===0n&&(burnt||current?.value&&current.value[7]==='0'&&current.value[10]==='0'&&current.value[11]==='0');
 const eligible=solelyOwned&&directCollections&&settled&&!!last;
 const fees=eligible?{amount0:sum(p.collects,'amount0')-sum(p.burns,'amount0'),amount1:sum(p.collects,'amount1')-sum(p.burns,'amount1')}:null;
 if(fees)assert(fees.amount0>=0n&&fees.amount1>=0n,`Principal unreconciled ${p.id}`);
 const terminalDelta0=sum(p.collects,'amount0')-sum(p.adds,'amount0'),terminalDelta1=sum(p.collects,'amount1')-sum(p.adds,'amount1');
 const cashflowAvailable=[...p.adds,...p.collects].every(x=>x.quoteValue!==null);
 const ownTx=new Set([...p.adds,...p.burns,...p.collects].map(x=>x.hash));
 const gasWei=[...ownTx].reduce((n,h)=>{const r=c.receipts.find(x=>x.receipt.transactionHash===h).receipt;return n+(r.from.toLowerCase()===wallet?BigInt(r.gasUsed)*BigInt(r.effectiveGasPrice):0n);},0n);
 summary.push({id:p.id,pool:p.pool,pair:c.pools[p.pool].symbol0+'/'+c.pools[p.pool].symbol1,fee:c.pools[p.pool].fee,
  lower:p.lower,upper:p.upper,spanTicks:p.upper-p.lower,spanSpacings:(p.upper-p.lower)/c.pools[p.pool].tickSpacing,
  createdAt:p.adds[0]?.at,closedAt:eligible?last.at:null,durationHours:eligible?(last.atMs-p.adds[0].atMs)/3600000:null,
  solelyOwned,directCollections,settled,closedEconomicsEligible:eligible,remainingLiquidity:liquidity,adds:p.adds.length,burns:p.burns.length,collects:p.collects.length,
  initialPrincipalQuote:p.adds[0]?.quoteValue,withdrawalInRange:last?.inRange??null,withdrawalRangeFraction:last?.rangeFraction??null,
  closedFeesRaw:fees,closedFeesAtWithdrawalPoolPriceQuote:fees&&last.price?value(p.pool,last.price,fees.amount0,fees.amount1):null,
  poolMarkedTokenFlowSurplusBeforeGasQuote:eligible&&last.price?value(p.pool,last.price,terminalDelta0,terminalDelta1):null,
  poolMarkedCashflowPnlBeforeGasQuote:eligible&&cashflowAvailable?sum(p.collects,'quoteValue')-sum(p.adds,'quoteValue'):null,
  relatedTransactionGasWei:gasWei,independentReferencePnlQuote:null,netWalletPnlQuote:null});
}
const transitions=[];
for(const p of summary.filter(p=>p.settled)){
 const pos=positions[p.id],burn=pos.burns.at(-1);if(!burn)continue;
 const replacement=summary.filter(q=>q.pool===p.pool&&q.id!==p.id&&Date.parse(q.createdAt)>burn.atMs&&Date.parse(q.createdAt)-burn.atMs<=3600000).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt))[0];
 if(!replacement)continue;
 const mint=positions[replacement.id].adds[0],sameNonce=burn.from.toLowerCase()===wallet&&mint.from.toLowerCase()===wallet&&mint.nonce===burn.nonce+1;
 const txs=[burn.hash,mint.hash].map(h=>c.receipts.find(x=>x.receipt.transactionHash===h));
 transitions.push({oldId:p.id,newId:replacement.id,pool:p.pool,pair:p.pair,at:burn.at,seconds:(mint.atMs-burn.atMs)/1000,
  inRange:burn.inRange,rangeFraction:burn.rangeFraction,oldSpan:p.spanTicks,newSpan:replacement.spanTicks,
  oldRange:[p.lower,p.upper],newRange:[replacement.lower,replacement.upper],burnHash:burn.hash,mintHash:mint.hash,
  consecutiveWalletNonces:sameNonce,directManagerPair:[burn.hash,mint.hash].every(h=>c.transactions[h].to?.toLowerCase()===manager),
  noV3SwapEventsInPair:txs.every(r=>r.events.every(e=>e.name!=='Swap'))});
}
const pools=Object.keys(c.pools).map(pool=>{const rows=summary.filter(p=>p.pool===pool),closed=rows.filter(p=>p.closedEconomicsEligible);return {pool,...c.pools[pool],positions:rows.length,closed:closed.length,
  inRangeWithdrawals:closed.filter(p=>p.withdrawalInRange===true).length,
  closedFeesAtWithdrawalPoolPriceQuote:closed.length&&closed.every(p=>p.closedFeesAtWithdrawalPoolPriceQuote!==null)?sum(closed,'closedFeesAtWithdrawalPoolPriceQuote'):null,
  poolMarkedTokenFlowSurplusBeforeGasQuote:closed.length&&closed.every(p=>p.poolMarkedTokenFlowSurplusBeforeGasQuote!==null)?sum(closed,'poolMarkedTokenFlowSurplusBeforeGasQuote'):null,
  poolMarkedCashflowPnlBeforeGasQuote:closed.length&&closed.every(p=>p.poolMarkedCashflowPnlBeforeGasQuote!==null)?sum(closed,'poolMarkedCashflowPnlBeforeGasQuote'):null};});
const result={schemaVersion:1,anchor:c.anchor,captureSha256:createHash('sha256').update(bytes).digest('hex'),positions:summary,pools,transitions,
 limits:['Closed fee tokens use core pool Collect minus Burn principal, after every top-up and collection; open/transferred positions excluded.','Pool-marked token-flow surplus is a funding-adjusted LP-vs-held-token diagnostic, before gas, not independent-reference alpha.','Pool-marked cashflow P&L values each deposit and collection at its contemporaneous pool price; it excludes wallet swaps, external hedges and native gas valuation.','Per-position related gas can overlap when a transaction touches multiple NFTs; do not sum it as wallet gas.','A nearby replacement is a temporal association; consecutive nonces/no swaps strengthen but do not prove the complete off-chain decision rule.'],executionEligible:false};
writeFileSync(root+'/analysis.json',stringify(result));writeFileSync(root+'/actions.json',stringify(actions));
console.log(stringify({positions:summary.length,closed:summary.filter(p=>p.closedEconomicsEligible).length,pools,transitions:transitions.length,earlyTransitions:transitions.filter(t=>t.inRange).length}));
