// Read-only, bounded reconstruction of the supplied two-wallet AMC case.
// Cached payloads contain only public chain data. Never signs or broadcasts.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseAbi,encodeFunctionData,decodeFunctionResult,decodeEventLog,keccak256,toHex,pad} from 'viem';
import {sqrtRatioAtTick,principalAmounts} from '../../src/backtest/principal.ts';
import {feeGrowthInside,subtractUint256} from '../../src/accounting/math.ts';

const [env,root]=process.argv.slice(2);assert(env&&root,'Usage: node --import tsx scripts/research/competitor-cluster-day.mjs ENV NEW_OR_RESUMED_OUTPUT');
process.loadEnvFile(env);const url=process.env.RH_INDEXER_RPC_URL??process.env.RH_RPC_URL;assert(url);
const wallets=['0xc0051f40abf4b7f9aa1e81d38558d38d4d1ad130','0xa7b474644912d08210c8962564e2f53fd0a7d5cf'];
const manager='0x73991a25c818bf1f1128deaab1492d45638de0d3',pool='0xaa34fea710a1a737840329051d81d3b0b7c564d5';
const tokens=['0x05a3d1cd21d0c88145e82600e62e7e496e0f222b','0x5fc5360d0400a0fd4f2af552add042d716f1d168'];
const stringify=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?String(v):v,2)+'\n',sha=x=>createHash('sha256').update(x).digest('hex');
mkdirSync(join(root,'rpc'),{recursive:true});let requests=0;const inFlight=new Map();
async function rpc(method,params,fresh=false){
 const key=sha(JSON.stringify({method,params})),file=join(root,'rpc',key+'.json');
 if(!fresh&&existsSync(file))return JSON.parse(readFileSync(file,'utf8')).result;
 if(inFlight.has(key))return inFlight.get(key);
 const work=(async()=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(25000)});
  assert(r.ok,`RPC HTTP ${r.status}`);const b=await r.json();assert(!b.error,`${method}: ${b.error?.message}`);assert(b.result!==null&&b.result!==undefined,`${method} unavailable`);requests++;
  if(!fresh)writeFileSync(file,stringify({method,params,result:b.result}),{flag:'wx'});return b.result;})();
 inFlight.set(key,work);try{return await work;}finally{inFlight.delete(key);}
}
async function batch(items,fn,width=4){const out=[];for(let i=0;i<items.length;i+=width)out.push(...await Promise.all(items.slice(i,i+width).map(fn)));return out;}
async function blockAt(iso){let a=49000000,b=57000000;const target=Date.parse(iso)/1000;while(a<b){const m=Math.floor((a+b)/2),h=await rpc('eth_getBlockByNumber',[toHex(m),false]);if(Number(BigInt(h.timestamp))<target)a=m+1;else b=m;}return a;}
const sig=s=>keccak256(toHex(s)),word=a=>pad(a,{size:32}),address=t=>'0x'+t.slice(-40).toLowerCase();
const transfer=sig('Transfer(address,address,uint256)'),swap=sig('Swap(address,address,int256,int256,uint160,uint128,int24)');
async function rangeLogs(address,topics,from,to){try{return await rpc('eth_getLogs',[{address,topics,fromBlock:toHex(from),toBlock:toHex(to)}]);}
 catch(e){if(to-from<1000||!/timeout|timed out|limit/i.test(e.message))throw e;const m=Math.floor((from+to)/2);return [...await rangeLogs(address,topics,from,m),...await rangeLogs(address,topics,m+1,to)];}}
async function logs(address,topics,from,to){const starts=[];for(let b=from;b<=to;b+=200000)starts.push(b);return (await batch(starts,b=>rangeLogs(address,topics,b,Math.min(b+199999,to)),2)).flat();}
const abi=parseAbi([
 'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
 'event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
 'event DecreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
 'event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)',
 'event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
 'event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
 'event Collect(address indexed owner,address recipient,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount0,uint128 amount1)',
 'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
 'function token0() view returns(address)','function token1() view returns(address)','function fee() view returns(uint24)','function tickSpacing() view returns(int24)',
 'function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)',
 'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)',
 'function feeGrowthGlobal0X128() view returns(uint256)','function feeGrowthGlobal1X128() view returns(uint256)',
 'function ticks(int24) view returns(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)',
 'function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
]);
async function call(to,functionName,args,block){return decodeFunctionResult({abi,functionName,data:await rpc('eth_call',[{to,data:encodeFunctionData({abi,functionName,args})},toHex(block)])});}
assert.equal(Number(BigInt(await rpc('eth_chainId',[],true))),4663);
const [first,dayEnd,nextEnd]=await Promise.all(['2026-09-04T00:00:00Z','2026-09-05T00:00:00Z','2026-09-06T00:00:00Z'].map(blockAt));
const bounds=[first-1,dayEnd-1,nextEnd-1],headers={};for(const n of bounds)headers[n]=await rpc('eth_getBlockByNumber',[toHex(n),false],true);
const anchor={chainId:4663,wallets,manager,pool,first,dayEndExclusive:dayEnd,settlementEndExclusive:nextEnd,boundaries:bounds.map(n=>({block:n,hash:headers[n].hash,timestamp:Number(BigInt(headers[n].timestamp))}))};
const anchorFile=join(root,'anchor.json');if(existsSync(anchorFile))assert.deepEqual(JSON.parse(readFileSync(anchorFile,'utf8')),anchor);else writeFileSync(anchorFile,stringify(anchor),{flag:'wx'});
const metadata=Object.fromEntries(await Promise.all(['token0','token1','fee','tickSpacing'].map(async n=>[n,await call(pool,n,[],bounds[2])])));
assert.equal(metadata.token0.toLowerCase(),tokens[0]);assert.equal(metadata.token1.toLowerCase(),tokens[1]);assert.equal(metadata.fee,3000);assert.equal(metadata.tickSpacing,60);
assert.equal(await call(tokens[0],'decimals',[],bounds[2]),18);assert.equal(await call(tokens[1],'decimals',[],bounds[2]),6);
const births=await logs(manager,[transfer,word('0x0'),wallets.map(word)],first,dayEnd-1);
const ids=[...new Set(births.map(l=>l.topics[3]))];assert(ids.length>0&&ids.length<500);
console.log(stringify({stage:'births',nfts:ids.length,requests}).trim());
const life=await logs(manager,[[sig('IncreaseLiquidity(uint256,uint128,uint256,uint256)'),sig('DecreaseLiquidity(uint256,uint128,uint256,uint256)'),sig('Collect(uint256,address,uint256,uint256)')],ids],first,nextEnd-1);
const nftOut=await logs(manager,[transfer,wallets.map(word)],first,nextEnd-1);
console.log(stringify({stage:'nft_history',events:life.length,requests}).trim());
const tokenLogs=[...new Map((await Promise.all([
 logs(tokens,[transfer,wallets.map(word)],first,nextEnd-1),logs(tokens,[transfer,null,wallets.map(word)],first,nextEnd-1)
])).flat().map(l=>[l.transactionHash+':'+l.logIndex,l])).values()].sort((a,b)=>Number(BigInt(a.blockNumber)-BigInt(b.blockNumber))||Number(BigInt(a.logIndex)-BigInt(b.logIndex)));
assert(tokenLogs.every(l=>l.topics.length===3));console.log(stringify({stage:'token_transfers',events:tokenLogs.length,requests}).trim());
const receipts={},transactions={};
async function receipt(hash){if(receipts[hash])return receipts[hash];const r=await rpc('eth_getTransactionReceipt',[hash]),tx=await rpc('eth_getTransactionByHash',[hash]);
 const n=Number(BigInt(r.blockNumber));headers[n]??=await rpc('eth_getBlockByNumber',[r.blockNumber,false]);assert.equal(r.blockHash,headers[n].hash);
 transactions[hash]={from:tx.from,to:tx.to,nonce:Number(BigInt(tx.nonce)),value:tx.value,input:tx.input};receipts[hash]={raw:r,events:r.logs.flatMap(l=>{try{const d=decodeEventLog({abi,data:l.data,topics:l.topics});return[{address:l.address,index:Number(BigInt(l.logIndex)),name:d.eventName,args:d.args}];}catch{return[];}})};return receipts[hash];}
await batch([...new Set([...births,...life,...nftOut,...tokenLogs].map(l=>l.transactionHash))],receipt);
const nonceCoverage=[];
for(const wallet of wallets){const before=Number(BigInt(await rpc('eth_getTransactionCount',[wallet,toHex(first-1)]))),after=Number(BigInt(await rpc('eth_getTransactionCount',[wallet,toHex(nextEnd-1)])));
 assert.equal(await rpc('eth_getCode',[wallet,toHex(first-1)]),'0x','Sender census requires an EOA');
 assert.equal(await rpc('eth_getCode',[wallet,toHex(nextEnd-1)]),'0x','Sender census requires an EOA');
 assert(after-before<1000,'Bounded sender census exceeds 1000 transactions');
 const known=new Set(Object.values(transactions).filter(t=>t.from===wallet).map(t=>t.nonce));const missing=[];for(let n=before;n<after;n++)if(!known.has(n))missing.push(n);
 await batch(missing,async nonce=>{let a=first,b=nextEnd-1;while(a<b){const m=Math.floor((a+b)/2),n=Number(BigInt(await rpc('eth_getTransactionCount',[wallet,toHex(m)])));if(n<=nonce)a=m+1;else b=m;}
  const block=await rpc('eth_getBlockByNumber',[toHex(a),true]),tx=block.transactions.find(t=>t.from===wallet&&Number(BigInt(t.nonce))===nonce);assert(tx,'Missing nonce transaction');await receipt(tx.hash);});
 const found=Object.values(transactions).filter(t=>t.from===wallet&&t.nonce>=before&&t.nonce<after);assert.equal(new Set(found.map(t=>t.nonce)).size,after-before);
 nonceCoverage.push({wallet,before,after,transactions:after-before,additionalNonceLookups:missing.length,complete:true});
}
console.log(stringify({stage:'sender_census',nonceCoverage,receipts:Object.keys(receipts).length,requests}).trim());
const balances={};for(const n of bounds){balances[n]={};for(const wallet of wallets)balances[n][wallet]=await Promise.all(tokens.map(t=>call(t,'balanceOf',[wallet],n)));}
const running=structuredClone(balances[first-1]),preTx={},internal=[];
for(const l of tokenLogs){preTx[l.transactionHash]??=structuredClone(running);const from=address(l.topics[1]),to=address(l.topics[2]),i=tokens.indexOf(l.address),amount=BigInt(l.data);assert(i>=0);
 if(wallets.includes(from)){running[from][i]-=amount;assert(running[from][i]>=0n,'Negative token ledger');}if(wallets.includes(to))running[to][i]+=amount;
 if(wallets.includes(from)&&wallets.includes(to))internal.push({hash:l.transactionHash,block:Number(BigInt(l.blockNumber)),from,to,token:l.address,amount});
}
assert.deepEqual(running,balances[nextEnd-1],'Settlement token ledger mismatch');
const atDay=structuredClone(balances[first-1]);for(const l of tokenLogs.filter(l=>Number(BigInt(l.blockNumber))<dayEnd)){const f=address(l.topics[1]),t=address(l.topics[2]),i=tokens.indexOf(l.address),v=BigInt(l.data);if(wallets.includes(f))atDay[f][i]-=v;if(wallets.includes(t))atDay[t][i]+=v;}
assert.deepEqual(atDay,balances[dayEnd-1],'Day token ledger mismatch');
const cohort={};const rows=Object.values(receipts).sort((a,b)=>Number(BigInt(a.raw.blockNumber)-BigInt(b.raw.blockNumber))||Number(BigInt(a.raw.transactionIndex)-BigInt(b.raw.transactionIndex)));
async function priceBefore(r,e){const n=Number(BigInt(r.raw.blockNumber)),slot=await call(pool,'slot0',[],n-1),swaps=await rpc('eth_getLogs',[{address:pool,fromBlock:toHex(n),toBlock:toHex(n),topics:[swap]}]);
 const last=swaps.filter(l=>Number(BigInt(l.logIndex))<e.index).at(-1);return last?decodeEventLog({abi,data:last.data,topics:last.topics}).args:{sqrtPriceX96:slot[0],tick:slot[1]};}
const value=(price,a0,a1)=>a1+a0*price*price/(1n<<192n);
for(const r of rows){const used=new Set(),usedPayments=new Set();for(const e of r.events.filter(e=>e.address===manager&&['IncreaseLiquidity','DecreaseLiquidity','Collect'].includes(e.name))){
 const id=String(e.args.tokenId);if(!ids.includes(word(toHex(e.args.tokenId))))continue;
 const name=e.name==='IncreaseLiquidity'?'Mint':e.name==='DecreaseLiquidity'?'Burn':'Collect',p=cohort[id];
 const core=r.events.filter(x=>x.index<e.index&&!used.has(x.index)&&x.address===pool&&x.name===name&&x.args.tickLower!==undefined&&(!p||x.args.tickLower===p.lower&&x.args.tickUpper===p.upper)&&(name==='Collect'||x.args.amount===e.args.liquidity)).at(-1);
 if(!core){assert(!p,`Missing core event ${id}`);continue;}used.add(core.index);
 const position=cohort[id]??={id,lower:core.args.tickLower,upper:core.args.tickUpper,events:[]};const mark=await priceBefore(r,core),hash=r.raw.transactionHash;
 if(name==='Collect')for(const i of [0,1]){const amount=core.args['amount'+i];if(amount===0n)continue;
  const payment=r.raw.logs.find(l=>!usedPayments.has(l.logIndex)&&Number(BigInt(l.logIndex))<core.index&&l.address===tokens[i]&&l.topics.length===3&&l.topics[0]===transfer&&address(l.topics[1])===pool&&address(l.topics[2])===core.args.recipient.toLowerCase()&&BigInt(l.data)===amount);
  assert(payment,'Collect payment mismatch');usedPayments.add(payment.logIndex);}
 position.events.push({kind:name,hash,block:Number(BigInt(r.raw.blockNumber)),index:core.index,at:Number(BigInt(headers[Number(BigInt(r.raw.blockNumber))].timestamp))*1000,amount0:core.args.amount0,amount1:core.args.amount1,liquidity:core.args.amount??0n,recipient:core.args.recipient??null,price:mark.sqrtPriceX96,tick:mark.tick,quoteValue:value(mark.sqrtPriceX96,core.args.amount0,core.args.amount1)});
}}
const daySlot=await call(pool,'slot0',[],dayEnd-1),endSlot=await call(pool,'slot0',[],nextEnd-1);
const dayGlobals=await Promise.all([0,1].map(i=>call(pool,`feeGrowthGlobal${i}X128`,[],dayEnd-1)));
const endGlobals=await Promise.all([0,1].map(i=>call(pool,`feeGrowthGlobal${i}X128`,[],nextEnd-1)));
const total=(events,key)=>events.reduce((n,e)=>n+e[key],0n),positionRows=[];
writeFileSync(join(root,'capture-stage.json'),stringify({anchor,metadata,births,life,nftOut,tokenLogs,receipts,transactions,headers,balances,nonceCoverage,internalTransfers:internal,cohort}));
async function snapshot(p,boundary,slot,globals){
 const pos=await call(manager,'positions',[BigInt(p.id)],boundary),events=p.events.filter(e=>e.block<=boundary);
 const adds=events.filter(e=>e.kind==='Mint'),burns=events.filter(e=>e.kind==='Burn'),collects=events.filter(e=>e.kind==='Collect');
 assert.equal(pos[2].toLowerCase(),tokens[0]);assert.equal(pos[3].toLowerCase(),tokens[1]);assert.equal(pos[4],3000);assert.equal(pos[5],p.lower);assert.equal(pos[6],p.upper);
 assert.equal(total(adds,'liquidity')-total(burns,'liquidity'),pos[7],'NFT liquidity ledger mismatch');
 const uncollected=[pos[10],pos[11]];
 if(pos[7]>0n){const [lo,hi]=await Promise.all([call(pool,'ticks',[p.lower],boundary),call(pool,'ticks',[p.upper],boundary)]);
  for(const i of [0,1]){const inside=feeGrowthInside({currentTick:slot[1],tickLower:p.lower,tickUpper:p.upper,feeGrowthGlobalX128:globals[i],lowerFeeGrowthOutsideX128:lo[2+i],upperFeeGrowthOutsideX128:hi[2+i]});uncollected[i]+=pos[7]*subtractUint256(inside,pos[8+i])/(1n<<128n);}}
 const fees=[0,1].map(i=>total(collects,'amount'+i)-total(burns,'amount'+i)+uncollected[i]);assert(fees.every(v=>v>=0n));
 const principal=principalAmounts({liquidity:pos[7],tickLower:p.lower,tickUpper:p.upper,sqrtPriceX96:slot[0]});
 return {liquidity:pos[7],uncollected,fees,principal};
}
for(const p of Object.values(cohort)){
 const adds=p.events.filter(e=>e.kind==='Mint'),burns=p.events.filter(e=>e.kind==='Burn'),collects=p.events.filter(e=>e.kind==='Collect'),last=burns.at(-1);
 assert(adds.length&&last);
 assert(collects.every(e=>wallets.includes(e.recipient.toLowerCase())),'External collect recipient');
 assert(!nftOut.some(l=>String(BigInt(l.topics[3]))===p.id&&!wallets.includes(address(l.topics[2]))&&BigInt(l.topics[2])!==0n),'External NFT custody');
 const end=await snapshot(p,nextEnd-1,endSlot,endGlobals),day=await snapshot(p,dayEnd-1,daySlot,dayGlobals);
 const fullySettled=end.liquidity===0n&&end.uncollected.every(v=>v===0n),fees=end.fees;
 const center=sqrtRatioAtTick((p.lower+p.upper)/2),deltas=[0,1].map(i=>total(collects,'amount'+i)-total(adds,'amount'+i));
 const dayFees=day.fees;
 const firstMint=adds[0],firstTx=transactions[firstMint.hash],before=preTx[firstMint.hash]?.[firstTx.from];assert(before,'No pre-mint wallet ledger');
 const gas=[...new Set(p.events.map(e=>e.hash))].reduce((n,h)=>n+BigInt(receipts[h].raw.gasUsed)*BigInt(receipts[h].raw.effectiveGasPrice),0n);
 positionRows.push({id:p.id,mintedAt:new Date(firstMint.at).toISOString(),closedAt:fullySettled?new Date(last.at).toISOString():null,lastWithdrawalAt:new Date(last.at).toISOString(),fullySettled,remainingLiquidity:end.liquidity,remainingLiquidityPpmOfAdds:end.liquidity*1000000n/total(adds,'liquidity'),lower:p.lower,upper:p.upper,spanSpacings:(p.upper-p.lower)/60,adds:adds.length,
  mintHash:firstMint.hash,burnHash:last.hash,mintBlock:firstMint.block,mintIndex:firstMint.index,burnBlock:last.block,burnIndex:last.index,
  withdrawalTick:last.tick,withdrawalInRange:last.tick>=p.lower&&last.tick<p.upper,
  windowFeesRaw:fees,windowFeesAtCenterQuote:value(center,...fees),windowFeesAtEndQuote:value(endSlot[0],...fees),
  closedCenterMarkedTokenFlowPnlBeforeGasQuote:fullySettled?value(center,...deltas):null,closedCashflowPnlBeforeGasQuote:fullySettled?total(collects,'quoteValue')-total(adds,'quoteValue'):null,
  dayFeesRaw:dayFees,dayFeesAtCenterQuote:value(center,...dayFees),dayFeesAtMidnightQuote:value(daySlot[0],...dayFees),midnight:day,settlementBoundary:end,
  initialAtCenterQuote:value(center,firstMint.amount0,firstMint.amount1),mintAmounts:[firstMint.amount0,firstMint.amount1],walletBeforeMint:before,unusedWalletAfterMint:before.map((v,i)=>v-firstMint['amount'+i]),gasWei:gas,events:p.events});
 positionRows.at(-1).allDepositsAtActionQuote=total(adds,'quoteValue');
 positionRows.at(-1).firstWithdrawalInRange=burns[0].tick>=p.lower&&burns[0].tick<p.upper;
}
positionRows.sort((a,b)=>Date.parse(a.mintedAt)-Date.parse(b.mintedAt));
const intervals=Object.values(cohort).flatMap(p=>p.events.filter(e=>e.kind!=='Collect').map(e=>({...e,id:p.id}))).sort((a,b)=>a.block-b.block||a.index-b.index);
const liveLiquidity=new Map();let active=0,maximumConcurrent=0;for(const e of intervals){const before=liveLiquidity.get(e.id)??0n,after=before+(e.kind==='Mint'?e.liquidity:-e.liquidity);assert(after>=0n);liveLiquidity.set(e.id,after);active+=Number(after>0n)-Number(before>0n);maximumConcurrent=Math.max(maximumConcurrent,active);}
const senderTx=Object.entries(transactions).filter(([,t])=>wallets.includes(t.from)),swapTx=senderTx.filter(([h])=>receipts[h].events.some(e=>e.name==='Swap'));
const daySenderTx=senderTx.filter(([h])=>Number(BigInt(receipts[h].raw.blockNumber))<dayEnd),daySwapTx=daySenderTx.filter(([h])=>receipts[h].events.some(e=>e.name==='Swap'));
const dayAmcSwapTx=daySwapTx.filter(([h])=>receipts[h].events.some(e=>e.name==='Swap'&&e.address===pool));
const cohortHashes=[...new Set(Object.values(cohort).flatMap(p=>p.events.map(e=>e.hash)))];
const settled=positionRows.filter(p=>p.fullySettled);
for(const n of bounds)assert.equal((await rpc('eth_getBlockByNumber',[toHex(n),false],true)).hash,headers[n].hash,'Boundary reorg');
const capture={anchor,metadata,births,life,nftOut,tokenLogs,receipts,transactions,headers,balances,nonceCoverage,internalTransfers:internal,positions:positionRows};
const bytes=stringify(capture);writeFileSync(join(root,'capture.json'),bytes);writeFileSync(join(root,'capture.sha256'),sha(bytes)+'\n');
const result={anchor,captureSha256:sha(bytes),codeSha256:sha(readFileSync('scripts/research/competitor-cluster-day.mjs')),cohortPositions:positionRows.length,maximumConcurrent,
 totals:Object.fromEntries(['windowFeesAtCenterQuote','windowFeesAtEndQuote','dayFeesAtCenterQuote','dayFeesAtMidnightQuote','initialAtCenterQuote','allDepositsAtActionQuote'].map(k=>[k,total(positionRows,k)])),
 fullySettledPositions:settled.length,positionsRetainingLiquidity:positionRows.filter(p=>p.remainingLiquidity>0n).length,
 settledOnlyTotals:Object.fromEntries(['closedCenterMarkedTokenFlowPnlBeforeGasQuote','closedCashflowPnlBeforeGasQuote'].map(k=>[k,total(settled,k)])),
 dayTransactionSummary:{originating:daySenderTx.length,withV3Swaps:daySwapTx.length,withAmcPoolSwaps:dayAmcSwapTx.length,amcPoolSwapEvents:dayAmcSwapTx.reduce((n,[h])=>n+receipts[h].events.filter(e=>e.name==='Swap'&&e.address===pool).length,0)},
 cohortActionReceipts:cohortHashes.length,cohortActionReceiptsWithSwaps:cohortHashes.filter(h=>receipts[h].events.some(e=>e.name==='Swap')).length,
 dayAmcSwaps:dayAmcSwapTx.map(([hash,tx])=>({hash,from:tx.from,to:tx.to,at:new Date(Number(BigInt(headers[Number(BigInt(receipts[hash].raw.blockNumber))].timestamp))*1000).toISOString(),events:receipts[hash].events.filter(e=>e.name==='Swap'&&e.address===pool)})),
 positions:positionRows.map(({events,...p})=>p),internalTransfers:internal,balances,nonceCoverage,coveredSenderTransactions:senderTx.length,coveredSenderTransactionsWithV3Swaps:swapTx.map(([h,t])=>({hash:h,...t})),
 inRangeFullClosures:settled.filter(p=>p.withdrawalInRange).length,tokenLedgerReconciled:true,
 limits:['Scope is September 4 births and AMC/USDG wallet balances through September 5. Other assets/protocol positions are not valued.','Exact token fees are separate from pool-price and fixed-center valuation diagnostics; independent-reference and net wallet P&L remain unavailable.','Nonce coverage proves originating transactions only, not every call initiated by another address on behalf of the wallets.','Zero decoded V3 swaps does not prove no off-chain hedge or no other protocol trade.','Unused wallet inventory is not automatically free strategy capital; collateral/other commitments are unknown.'],executionEligible:false};
writeFileSync(join(root,'analysis.json'),stringify(result));console.log(stringify({stage:'complete',positions:result.cohortPositions,maximumConcurrent,fullySettled:result.fullySettledPositions,residualPositions:result.positionsRetainingLiquidity,inRangeFullClosures:result.inRangeFullClosures,totals:result.totals,nonceCoverage,dayTransactionSummary:result.dayTransactionSummary,swapTransactions:swapTx.length,internalTransfers:internal.length,requests}));
