// Read-only, resumable V3 position-manager census. Cache contains public RPC
// requests/results only; no RPC URLs, environment values or signer material.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {decodeEventLog,encodeFunctionData,decodeFunctionResult,parseAbi,keccak256,toHex,pad} from 'viem';

const [envPath,walletInput,output]=process.argv.slice(2);
assert(envPath&&/^0x[0-9a-f]{40}$/i.test(walletInput)&&output,
 'Usage: node scripts/research/competitor-lp-capture.mjs ENV WALLET OUTPUT_DIRECTORY');
process.loadEnvFile(envPath);
const wallet=walletInput.toLowerCase(),manager='0x73991a25c818bf1f1128deaab1492d45638de0d3';
const url=process.env.RH_INDEXER_RPC_URL??process.env.RH_RPC_URL;
assert(url,'Read RPC required');
mkdirSync(join(output,'rpc'),{recursive:true});
const stringify=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
let requests=0;
async function rpc(method,params,cache=true){
 const key=createHash('sha256').update(JSON.stringify({method,params})).digest('hex'),path=join(output,'rpc',key+'.json');
 if(cache&&existsSync(path))return JSON.parse(readFileSync(path,'utf8')).result;
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
 assert(response.ok,`RPC HTTP ${response.status}`);const body=await response.json();
 assert(!body.error,`${method}: ${body.error?.message}`);assert(body.result!==undefined&&body.result!==null,`${method}: result unavailable`);
 requests++;if(cache)writeFileSync(path,stringify({method,params,result:body.result}),{flag:'wx'});
 return body.result;
}
const anchorPath=join(output,'anchor.json');
let anchor;
if(existsSync(anchorPath)){anchor=JSON.parse(readFileSync(anchorPath,'utf8'));assert.equal(anchor.wallet,wallet);}
else {assert.equal(Number(BigInt(await rpc('eth_chainId',[],false))),4663);const head=Number(BigInt(await rpc('eth_blockNumber',[],false)))-64;
 const h=await rpc('eth_getBlockByNumber',[toHex(head),false]);anchor={wallet,manager,chainId:4663,fromBlock:0,toBlock:head,hash:h.hash,timestamp:Number(BigInt(h.timestamp)),capturedAt:new Date().toISOString()};writeFileSync(anchorPath,stringify(anchor),{flag:'wx'});}
assert.equal((await rpc('eth_getBlockByNumber',[toHex(anchor.toBlock),false],false)).hash,anchor.hash,'Anchor reorg');
const abi=parseAbi([
 'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
 'event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
 'event DecreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
 'event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)',
 'event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
 'event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
 'event Collect(address indexed owner,address recipient,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount0,uint128 amount1)',
 'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
 'function token0() view returns(address)','function token1() view returns(address)',
 'function fee() view returns(uint24)','function tickSpacing() view returns(int24)',
 'function symbol() view returns(string)','function decimals() view returns(uint8)',
 'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)',
 'function liquidity() view returns(uint128)',
 'function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
]);
async function call(address,functionName,args=[],block=anchor.toBlock){return decodeFunctionResult({abi,functionName,data:await rpc('eth_call',[{to:address,data:encodeFunctionData({abi,functionName,args})},toHex(block)])});}
function cachedLogs(topics,address,from,to){
 const params=[{address,fromBlock:toHex(from),toBlock:toHex(to),topics}];
 const key=createHash('sha256').update(JSON.stringify({method:'eth_getLogs',params})).digest('hex'),path=join(output,'rpc',key+'.json');
 if(existsSync(path))return JSON.parse(readFileSync(path,'utf8')).result;
 if(to-from<10000)return null;
 const middle=Math.floor((from+to)/2),left=cachedLogs(topics,address,from,middle);
 if(left===null)return null;const right=cachedLogs(topics,address,middle+1,to);
 return right===null?null:[...left,...right];
}
async function logRange(topics,address,from,to){
 const cached=cachedLogs(topics,address,from,to);if(cached!==null)return cached;
 try{return await rpc('eth_getLogs',[{address,fromBlock:toHex(from),toBlock:toHex(to),topics}]);}
 catch(error){
  if(to-from<10000||!/timeout|timed out|too many|limit/i.test(error.message))throw error;
  const middle=Math.floor((from+to)/2);
  return [...await logRange(topics,address,from,middle),...await logRange(topics,address,middle+1,to)];
 }
}
async function logs(topics,address=manager,from=0,to=anchor.toBlock){const all=[],starts=[];
 for(let start=from;start<=to;start+=1500000)starts.push(start);
 // Bound provider load while keeping historical scans practical.
 for(let i=0;i<starts.length;i+=3)for(const part of await Promise.all(starts.slice(i,i+3).map(start=>logRange(topics,address,start,Math.min(start+1499999,to)))))all.push(...part);
 return all;
}
const transfers=await logs([keccak256(toHex('Transfer(address,address,uint256)')),null,pad(wallet,{size:32})]);
const ids=[...new Set(transfers.map(l=>l.topics[3]))];console.log(JSON.stringify({stage:'discovered',nfts:ids.length,requests}));
assert(ids.length>0&&ids.length<=2000,'Unexpected NFT count');
// If every received NFT was minted here, none of its events can predate the
// earliest mint. Acquired NFTs still require the full historical scan.
const lifeFrom=transfers.every(l=>BigInt(l.topics[1])===0n)?Math.min(...transfers.map(l=>Number(BigInt(l.blockNumber)))):0;
const life=[];for(let i=0;i<ids.length;i+=100)life.push(...await logs([[
 keccak256(toHex('IncreaseLiquidity(uint256,uint128,uint256,uint256)')),
 keccak256(toHex('DecreaseLiquidity(uint256,uint128,uint256,uint256)')),
 keccak256(toHex('Collect(uint256,address,uint256,uint256)'))
],ids.slice(i,i+100)],manager,lifeFrom));
console.log(JSON.stringify({stage:'liquidity_events',events:life.length,requests}));
// Wallet custody needs incoming and outgoing transfers, not every later
// transfer between unrelated owners. Any non-burn outgoing transfer excludes
// the NFT from exclusively-owned lifetime economics. Query by wallet rather
// than a large tokenId OR list (much cheaper on historical log providers).
const outgoing=await logs([keccak256(toHex('Transfer(address,address,uint256)')),pad(wallet,{size:32})],manager,lifeFrom);
const idSet=new Set(ids),ownership=[...new Map([...transfers,...outgoing.filter(l=>idSet.has(l.topics[3]))].map(l=>[l.transactionHash+':'+l.logIndex,l])).values()];
console.log(JSON.stringify({stage:'custody_events',events:ownership.length,requests}));
const hashes=[...new Set([...transfers,...life,...ownership].map(l=>l.transactionHash))];
const receipts=[],headers={},transactions={};
for(const hash of hashes){const receipt=await rpc('eth_getTransactionReceipt',[hash]);
 if(!headers[receipt.blockNumber]){const h=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);headers[receipt.blockNumber]={number:Number(BigInt(h.number)),hash:h.hash,timestamp:Number(BigInt(h.timestamp))};}
 assert.equal(receipt.blockHash,headers[receipt.blockNumber].hash,'Receipt not canonical');assert.equal(receipt.status,'0x1');
 const tx=await rpc('eth_getTransactionByHash',[hash]);transactions[hash]={from:tx.from,to:tx.to,nonce:Number(BigInt(tx.nonce)),value:tx.value,input:tx.input};
 receipts.push({receipt,events:receipt.logs.flatMap(log=>{try {const d=decodeEventLog({abi,data:log.data,topics:log.topics});return [{address:log.address,index:Number(BigInt(log.logIndex)),name:d.eventName,args:d.args}];}catch{return [];}})});
 if(receipts.length%50===0)console.log(JSON.stringify({stage:'receipts',done:receipts.length,total:hashes.length,requests}));
}
const pools={};
for(const address of new Set(receipts.flatMap(r=>r.events.filter(e=>e.name==='Mint'||e.name==='Burn').map(e=>e.address)))){
 const [token0,token1,fee,tickSpacing]=await Promise.all(['token0','token1','fee','tickSpacing'].map(n=>call(address,n)));
 const [symbol0,symbol1,decimals0,decimals1]=await Promise.all([call(token0,'symbol'),call(token1,'symbol'),call(token0,'decimals'),call(token1,'decimals')]);
 pools[address]={token0,token1,fee,tickSpacing,symbol0,symbol1,decimals0,decimals1};
}
// Exact price immediately before the action: previous block slot0 plus the
// last same-block swap preceding this event, including earlier transactions.
const prices={};
for(const {receipt,events} of receipts){const block=Number(BigInt(receipt.blockNumber));
 for(const event of events.filter(e=>e.name==='Mint'||e.name==='Burn'||e.name==='Collect'&&e.args.tickLower!==undefined)){
  const key=receipt.transactionHash+':'+event.index;if(prices[key])continue;
  const slot=await call(event.address,'slot0',[],block-1);
  const swaps=await rpc('eth_getLogs',[{address:event.address,fromBlock:toHex(block),toBlock:toHex(block),topics:[keccak256(toHex('Swap(address,address,int256,int256,uint160,uint128,int24)'))]}]);
  const preceding=swaps.filter(l=>Number(BigInt(l.logIndex))<event.index).sort((a,b)=>Number(BigInt(a.logIndex)-BigInt(b.logIndex))).at(-1);
  const d=preceding?decodeEventLog({abi,data:preceding.data,topics:preceding.topics}).args:null;
  prices[key]={sqrtPriceX96:String(d?.sqrtPriceX96??slot[0]),tick:d?.tick??slot[1],priorBlock:block-1,precedingSwap:preceding??null};
 }
}
const positions={};for(const topic of ids){const id=String(BigInt(topic));try{positions[id]={value:await call(manager,'positions',[BigInt(id)])};}catch(error){positions[id]={unavailable:error.message};}}
assert.equal((await rpc('eth_getBlockByNumber',[toHex(anchor.toBlock),false],false)).hash,anchor.hash,'Anchor changed during capture');
const report={schemaVersion:1,anchor,transfers,ownership,receipts,transactions,headers,pools,prices,positions,
 limitations:['Only this V3 position manager and NFTs received by this wallet; other protocols, wallets and hedge venues are not included.','Ownership history covers wallet incoming/outgoing transfers, not subsequent transfers between unrelated owners; transferred positions are excluded from lifetime economics.','RPC results are pinned and receipts matched to canonical headers; no independent-reference valuation or full-wallet P&L is inferred.']};
const bytes=stringify(report);writeFileSync(join(output,'capture.json'),bytes);writeFileSync(join(output,'capture.sha256'),createHash('sha256').update(bytes).digest('hex')+'\n');
console.log(JSON.stringify({stage:'complete',nfts:ids.length,receipts:receipts.length,pools:Object.keys(pools).length,requests,output}));
