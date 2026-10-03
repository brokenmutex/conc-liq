import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createRobinhoodClient} from '../../src/client.js';
import {parseRangeKeeperConfig,initialRangeKeeperState} from '../../src/strategy/rangekeeper/config.js';
import {rangeKeeperConfirmedSource} from '../../src/strategy/rangekeeper/source.js';
import {RangeKeeperChain} from '../../src/strategy/rangekeeper/chain.js';
import {planRangeKeeper,rawValue} from '../../src/strategy/rangekeeper/planner.js';
import {readCanonicalPaperOpenFrame} from '../../src/deployments/paper-preview.js';
import {simulateLiveSetupCandidate} from '../../src/deployments/rangekeeper-live-setup-simulation.js';

// Opt-in canonical reads and a disposable impersonated fork only. No key is
// loaded and no transaction is submitted to the archive/read RPC.
try{
 const env=parseEnv(readFileSync(process.argv[2]??'.env','utf8'));
 const rpcUrl=env.RH_ARCHIVE_RPC_URL;assert(rpcUrl,'Archive RPC unavailable');
 const config=parseRangeKeeperConfig(JSON.parse(readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8')));
 assert.equal(config.broadcastEnabled,false);
 const client=createRobinhoodClient(rpcUrl,15000,{retryCount:0,beforeRequest:async()=>{}});
 const source=await rangeKeeperConfirmedSource(client),profile={pool:config.pool,referencePolicy:config.referencePolicy};
 const frame=await readCanonicalPaperOpenFrame(client,profile,{block:String(source.block),hash:source.hash,timestamp:source.timestamp});
 assert(frame.referenceEligible&&frame.price0&&frame.price1&&frame.nativePrice,'Independent references unavailable');
 const chain=new RangeKeeperChain(client,config.pool),snapshot=await chain.snapshot(source,config.operator,null);
 const amount0=250_000_000n,amount1=0n;
 assert(snapshot.wallet0>amount0&&snapshot.wallet1>=amount1,'Fixture requires a positive untouched token reserve');
 const value=rawValue(amount0,frame.price0,config.pool.decimals0);
 const observation={block:source.block,hash:source.hash,timestamp:source.timestamp,tick:frame.tick,
  sqrtPriceX96:frame.sqrtPriceX96,continuity:'canonical',wallet0:amount0,wallet1:amount1,released0:0n,released1:0n,
  nativeWei:snapshot.nativeWei,requiredExitReserveWei:config.limits.exitReserveWei,
  price0:frame.price0,price1:frame.price1,nativePrice:frame.nativePrice,position:null,pending:false,
  entryAllowed:true,safeExitRequired:false,executionReady:true,liquiditySharePpm:0,
  actionCost:config.limits.maxActionCost,actionGasWei:0n,reservedCost:0n,rollingSpentCost:0n,campaignSpentCost:0n,
  campaignStartValue:value,highWaterValue:value,recenters:0};
 const planned=await planRangeKeeper({state:initialRangeKeeperState(config,'allocated-fork-review'),observation,
  limits:config.limits,spacing:config.pool.tickSpacing,decimals0:config.pool.decimals0,decimals1:config.pool.decimals1,
  quoteToken:config.pool.quoteToken,maxPoolDeviationPpm:config.referencePolicy.maxPoolDeviationPpm,
  quote:(token,amount)=>chain.quote(source,token,amount,frame.price0,frame.price1),simulate:async()=>true});
 assert(planned.candidate,`Candidate unavailable: ${planned.reason}`);
 const [latest,gasPrice]=await Promise.all([client.getBlock(),client.getGasPrice()]);
 const proof=await simulateLiveSetupCandidate({profile,source:frame.source,operator:config.operator,
  candidate:planned.candidate,allocation:{token0Raw:String(amount0),token1Raw:String(amount1),nativeWei:String(snapshot.nativeWei)},
  limits:config.limits,prices:{price0:frame.price0,price1:frame.price1,nativePrice:frame.nativePrice},
  baseFeePerGasWei:latest.baseFeePerGas,marketGasPriceWei:gasPrice},{client,rpcUrl,anvilBinary:env.ANVIL_BINARY??'/root/.foundry/bin/anvil'});
 assert(proof.gasByStage.some(s=>s.phase==='entry'&&s.kind==='mint'));
 assert(proof.gasByStage.some(s=>s.phase==='exit'&&s.kind==='withdraw'));
 assert(proof.gasByStage.some(s=>s.phase==='exit'&&s.kind==='swap'));
 console.log(JSON.stringify({event:'allocated_live_setup_fork_verified',source:proof.source,
  provenance:proof.provenance,stages:proof.gasByStage,syntheticNativeFunding:proof.syntheticNativeFunding,
  actionGasWei:proof.actionGasWei,completeExitGasWei:proof.completeExitGasWei,
  untouchedToken0ReserveRaw:String(snapshot.wallet0-amount0),sequenceHash:proof.sequenceHash}));
}catch(error){
 console.error((error instanceof Error?error.message:'Allocated fork review failed').replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,260));
 process.exitCode=1;
}
