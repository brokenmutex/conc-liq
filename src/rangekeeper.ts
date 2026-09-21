import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {getAddress} from 'viem';
import {createRobinhoodClient} from './client.js';
import {parseRangeKeeperConfig,rangeKeeperConfigHash} from './strategy/rangekeeper/config.js';
import {RangeKeeperChain} from './strategy/rangekeeper/chain.js';
import {readRangeKeeperReferences} from './strategy/rangekeeper/reference.js';

async function main(){
const [command,configPath,operatorArg,rpcEnvPath]=process.argv.slice(2);
assert(command==='inspect'&&configPath,'Usage: rangekeeper inspect CONFIG [OPERATOR] [RUNTIME_ENV]');
const config=parseRangeKeeperConfig(JSON.parse(readFileSync(configPath,'utf8')));
assert(!config.broadcastEnabled,'Inspection requires disabled configuration');
const rpc=rpcEnvPath?parseEnv(readFileSync(rpcEnvPath,'utf8')).RH_ARCHIVE_RPC_URL:
 process.env.RH_ARCHIVE_RPC_URL??'https://rpc.mainnet.chain.robinhood.com';
assert(rpc,'Read-only archive RPC is unavailable');
const client=createRobinhoodClient(rpc,15_000,{retryCount:0});
const latest=await client.getBlock();assert(latest.number>64n);
const block=await client.getBlock({blockNumber:latest.number-64n});
const source={block:block.number,hash:block.hash,timestamp:Number(block.timestamp)};
const chain=new RangeKeeperChain(client,config.pool);
const identity=await chain.verify(source);
const reference=await readRangeKeeperReferences(client,source,config);
const operator=operatorArg?getAddress(operatorArg):config.operator;
assert(!config.operator||!operator||operator.toLowerCase()===config.operator.toLowerCase(),
 'Inspected operator differs from the frozen campaign configuration');
const wallet=operator?await chain.snapshot(source,operator,null):null;
console.log(JSON.stringify({policyId:config.policyId,strategyVersion:config.strategyVersion,configHash:rangeKeeperConfigHash(config),
 broadcastEnabled:false,source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
 pool:config.pool.pool,token0:config.pool.token0,token1:config.pool.token1,quoteToken:config.pool.quoteToken,
 codeHashes:{pool:identity.poolCodeHash,token0:identity.token0CodeHash,token1:identity.token1CodeHash},
 reference:{eligible:reference.eligible,reasons:reference.reasons,price0:reference.price0?.toString()??null,
  price1:reference.price1?.toString()??null,nativePrice:reference.nativePrice?.toString()??null},
 wallet:wallet?{operator,wallet0:String(wallet.wallet0),wallet1:String(wallet.wallet1),nativeWei:String(wallet.nativeWei),
  nftCount:String(wallet.nftCount),confirmedNonce:wallet.nonce,tick:wallet.tick,poolLiquidity:String(wallet.poolLiquidity),
  allowances:wallet.allowances.map(a=>({token:a.token,spender:a.spender,amount:String(a.amount)}))}:null},null,2));
}
main().catch(()=>{console.error('RangeKeeper inspection failed; inspect the configuration and RPC connection');process.exitCode=1;});
