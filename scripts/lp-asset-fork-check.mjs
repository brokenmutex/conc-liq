// Pinned read-only upstream RPC. All transactions and fixture funding stay on owned Anvil.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {getAddress,parseAbi} from 'viem';
import {openPaperFork} from '../src/paper/fork.ts';
import {simulatePaperRoundTrip} from '../src/paper/execution.ts';
import {simulatePaperExit} from '../src/paper/execution-exit.ts';
import {quotePaperRecenter,simulatePaperRecenter} from '../src/paper/execution-recenter.ts';
import {canonicalBalances,marketRange} from '../src/paper/market.ts';
import {paperPolicy} from '../src/paper/config.ts';
import {createRobinhoodClient} from '../src/client.ts';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {sanitizeRiskError} from '../src/risk/evaluate.ts';
const [envPath,dir,symbolList='AAPL,GOOGL,GME,SLV,TSLA,SPCX',halfWidthText='20']=process.argv.slice(2);assert(envPath&&dir);
Object.assign(process.env,parseEnv(readFileSync(envPath,'utf8')));process.env.ANVIL_BIN??='/root/.foundry/bin/anvil';
const cfg=loadIndexerConfig(),u=JSON.parse(readFileSync(dir+'/universe.json')),base=JSON.parse(readFileSync('config/paper-nvda-5000-recenter-diluted.json'));
const halfWidth=Number(halfWidthText);assert(Number.isInteger(halfWidth)&&halfWidth>0&&halfWidth%10===0);base.halfWidthSpacings=halfWidth/10;
const gate=new PostgresRpcHealthGate({connectionString:process.env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const beforeRead=()=>gate.assertBulkAllowed().then(()=>{}),client=createRobinhoodClient(cfg.rpcUrl,cfg.rpcTimeoutMs,{beforeRequest:beforeRead,retryCount:0});
const write=(path,data)=>{const raw=JSON.stringify(data,null,2)+'\n';writeFileSync(path,raw);writeFileSync(path+'.sha256',createHash('sha256').update(raw).digest('hex')+'\n');};
try{
 const source=await client.getBlock({blockNumber:BigInt(u.anchor.number)});assert.equal(source.hash,u.anchor.hash);
 const later=await client.getBlock({blockNumber:source.number+1n});
 for(const symbol of symbolList.split(',')){
  const p=u.rows.find(p=>p.symbol===symbol&&p.fee===500);assert(p);
  const market={symbol:p.symbol,rwa:getAddress(p.address),pool:getAddress(p.pool),fee:p.fee,tickSpacing:p.spacing,rwaDecimals:p.decimals};
  const policy=paperPolicy({...base,market});const result={symbol,policy,source:{block:String(source.number),hash:source.hash},executionEligible:false,stages:{}};let fork;
  const open=b=>openPaperFork({source:{number:b.number,hash:b.hash,timestamp:b.timestamp},rpcUrl:cfg.rpcUrl,beforeRead,maxRequests:800});
  try{
   const range=marketRange(BigInt(p.sqrtPriceX96),p.tick,halfWidth,p.spacing),abi=parseAbi(['function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)']);
   result.boundaries=await Promise.all([range.tickLower,range.tickUpper].map(async tick=>{const t=await client.readContract({address:market.pool,abi,functionName:'ticks',args:[tick],blockNumber:source.number});return {tick,gross:String(t[0]),initialized:t[7]};}));
   fork=await open(source);const roundTrip=await simulatePaperRoundTrip(fork,policy);result.stages.roundTrip={passed:true,proof:roundTrip};await fork.close();fork=null;
   console.log(JSON.stringify({symbol,stage:'roundTrip',cashDeltaQuote:roundTrip.cashDeltaQuote,gasWei:roundTrip.totalGasWei}));write(dir+`/fork-${symbol}.json`,result);
   const idle=canonicalBalances(market,BigInt(roundTrip.balances.afterMint.quote),BigInt(roundTrip.balances.afterMint.rwa));
   const inventory={...roundTrip.range,liquidity:roundTrip.liquidity,idle0:String(idle.amount0),idle1:String(idle.amount1),fee0:'3',fee1:'5',allowances:roundTrip.allowances,nativeBalanceWei:'1000000000000000000'};
   fork=await open(later);result.stages.restoredExit={passed:true,proof:await simulatePaperExit(fork,policy,inventory)};await fork.close();fork=null;write(dir+`/fork-${symbol}.json`,result);
   // Deliberately one-sided, out-of-range inventory; tests mechanics, not a simulated earnings record.
   const outside={...inventory,tickLower:range.tickUpper+20,tickUpper:range.tickUpper+60,liquidity:'1000',...Object.fromEntries(Object.entries(canonicalBalances(market,5000000000n,0n)).map(([k,v])=>[k==='amount0'?'idle0':'idle1',String(v)])),fee0:'3',fee1:'5'};
   fork=await open(source);const intent=await quotePaperRecenter(fork,policy,outside);await fork.close();fork=null;
   fork=await open(later);result.stages.recenter={passed:true,proof:await simulatePaperRecenter(fork,policy,outside,intent)};await fork.close();fork=null;
   result.passed=result.boundaries.every(b=>b.initialized&&BigInt(b.gross)>0n);result.limitations=['Mechanics and costs at pinned states; not a forward fee-income result','Recenter uses deliberately constructed one-sided inventory'];
  }catch(error){result.passed=false;result.error=sanitizeRiskError(error);}
  finally{await fork?.close();write(dir+`/fork-${symbol}.json`,result);console.log(JSON.stringify({symbol,passed:result.passed,error:result.error,stages:Object.keys(result.stages)}));}
 }
}finally{await gate.close();}
