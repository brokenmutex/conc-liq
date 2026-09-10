import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {simulateInventoryRecenter,simulateInventoryTrim} from '../src/research/inventory-fork.ts';
import {simulatePaperExit} from '../src/paper/execution-exit.ts';
import {openPaperFork} from '../src/paper/fork.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {loadRiskConfig} from '../src/risk/config.ts';
import {createRobinhoodClient} from '../src/client.ts';
import {ViemRiskChainReader} from '../src/risk/reader.ts';
import {fetchFeedDirectory,selectOracleFeed} from '../src/risk/source.ts';
import {evaluateOracleRisk,sanitizeRiskError} from '../src/risk/evaluate.ts';
import {evaluatePaperUsdgOracle} from '../src/paper/usdg-oracle.ts';
import {paperGasQuote} from '../src/paper/transaction-engine.ts';
const [envPath,paperPath,marketPath,observationId,action,output]=process.argv.slice(2);
assert(envPath&&paperPath&&marketPath&&observationId&&['exit','recenter','preserve','trim'].includes(action)&&output);
assert(!fs.existsSync(output));
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=path=>{const raw=fs.readFileSync(path,'utf8');assert.equal(hash(raw),fs.readFileSync(path+'.sha256','utf8').trim());return JSON.parse(raw);};
Object.assign(process.env,parseEnv(fs.readFileSync(envPath,'utf8')));
const paper=read(paperPath),data=read(marketPath),observation=paper.observations.find(o=>o.id===observationId);
assert(observation?.state.position&&observation.state.status==='open'&&observation.state.reference?.eligible);
const session=paper.sessions.find(s=>s.id===observation.session_id),cp=observation.state.last,market=new ExperimentMarket(data.seed);
for(const frame of data.frames){for(const event of frame.events)market.apply(event);market.verify(frame);if(frame.id===cp.id)break;}
assert.equal(market.price,BigInt(cp.sqrtPriceX96));
const policy=session.policy,inventory={...observation.state.position,allowances:observation.state.execution.allowances,
 nativeBalanceWei:String(10n**18n-BigInt(observation.state.execution.gasSpentWei))};
const config=loadIndexerConfig(),riskConfig=loadRiskConfig(),gate=new PostgresRpcHealthGate({connectionString:process.env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const beforeRead=()=>gate.assertBulkAllowed().then(()=>{});
const live=createRobinhoodClient(config.rpcUrl,config.rpcTimeoutMs,{beforeRequest:beforeRead,retryCount:0});
let fork;const transactions=[];
try{
 const block=await live.getBlock({blockNumber:BigInt(cp.block)});assert.equal(block.hash.toLowerCase(),cp.hash.toLowerCase());
 const directory=await fetchFeedDirectory(riskConfig.feedDirectoryUrl,5000),reader=new ViemRiskChainReader(live);
 const oracle=async symbol=>{const feed=selectOracleFeed(directory.payload,symbol);assert(feed);const state=await reader.readOracle(feed.address,block.number);
  const input={feed,state,blockTimestamp:block.timestamp,maxPriceAgeSeconds:86400};const evaluated=symbol==='USDG'?evaluatePaperUsdgOracle(input,1800):evaluateOracleRisk(input);assert(evaluated.executionEligible,`${symbol}: ${evaluated.reasons}`);return evaluated;};
 const eth=await oracle('ETH'),usdg=await oracle('USDG');
 const valuation={sourceBlock:cp.block,sourceHash:cp.hash,computedAt:new Date().toISOString(),ethUsdAnswer:eth.state.answer,ethUsdDecimals:eth.state.decimals,quoteUsdAnswer:usdg.state.answer,quoteUsdDecimals:usdg.state.decimals};
 fork=await openPaperFork({source:{number:block.number,hash:block.hash,timestamp:block.timestamp},rpcUrl:config.rpcUrl,beforeRead,maxRequests:600,intervalMs:100,timeoutMs:180000});
 const log=tx=>{transactions.push(tx);console.log(JSON.stringify({action:tx.action,gasQuote:String(paperGasQuote(tx.estimate.totalFeeWei,valuation))}));};
 const result=action==='exit'?await simulatePaperExit(fork,policy,inventory,log):action==='trim'?await simulateInventoryTrim(fork,policy,inventory,market.source(),log):await simulateInventoryRecenter(fork,policy,inventory,market.source(),action==='preserve',log);
 const out={sessionId:session.id,observationId,action,paperSha256:fs.readFileSync(paperPath+'.sha256','utf8').trim(),marketSha256:fs.readFileSync(marketPath+'.sha256','utf8').trim(),valuation,oracleEvidence:{eth,usdg},gasQuote:String(paperGasQuote(result.totalGasWei,valuation)),result};
 const raw=JSON.stringify(out,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';fs.writeFileSync(output,raw,{flag:'wx'});fs.writeFileSync(output+'.sha256',hash(raw)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'succeeded',action,sessionId:session.id,observationId,gasQuote:out.gasQuote,transactions:transactions.length,upstream:fork.budget,output}));
}catch(error){
 const out={status:'unavailable',action,sessionId:session.id,observationId,error:sanitizeRiskError(error),transactions,upstream:fork?.budget};
 fs.writeFileSync(output+'.failed.json',JSON.stringify(out,null,2)+'\n',{flag:'wx'});throw error;
}finally{await fork?.close();await gate.close();}
