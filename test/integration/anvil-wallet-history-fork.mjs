// Reduce historical bytecode failures without campaigns, databases or signing.
// All state changes terminate at the branded loopback fork; upstream is read-only.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {parseAbi,keccak256} from 'viem';
import {createRobinhoodClient} from '../../src/client.ts';
import {openPaperFork} from '../../src/paper/fork.ts';

const env=parseEnv(readFileSync(process.argv[2]??'.env','utf8'));
const client=createRobinhoodClient(env.RH_PUBLIC_RPC_URL??'https://rpc.mainnet.chain.robinhood.com',20_000,{retryCount:0});
const block=await client.getBlock({blockNumber:(await client.getBlockNumber())-128n});
const source={number:block.number,hash:block.hash,timestamp:block.timestamp};
const tokens=['0x117cc2133c37b721f49de2a7a74833232b3b4c0c',
 '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
 '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',
 '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3',
 '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
 '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68'];
const wallet='0xdb2430b4e9ac14be6554d3942822be74811a1af9';
const abi=parseAbi(['function balanceOf(address) view returns(uint256)']);
const baseline=await Promise.all(tokens.map(async address=>({address,
 codeHash:keccak256(await client.getCode({address,blockNumber:source.number})),
 balance:await client.readContract({address,abi,functionName:'balanceOf',args:[wallet],blockNumber:source.number})})));
let fork;
try{
 fork=await openPaperFork({source,rpcUrl:env.RH_PUBLIC_RPC_URL??'https://rpc.mainnet.chain.robinhood.com',
  anvilBinary:process.env.ANVIL_BINARY_TEST,beforeRead:async()=>{},maxRequests:10_000,timeoutMs:180_000});
 const local=createRobinhoodClient(fork.localUrl,20_000,{retryCount:0});
 console.log(JSON.stringify({event:'canonical_token_code_hashes',tokens:baseline.map(t=>({address:t.address,codeHash:t.codeHash}))}));
 if(!process.argv.includes('--read-only'))for(const address of tokens){
  // Load account records into local state while preserving canonical native
  // balances and original code. No ERC20 storage or bytecode is modified.
  const native=await local.getBalance({address});
  await fork.rpc('anvil_setBalance',[address,`0x${native.toString(16)}`]);
 }
 await fork.rpc('anvil_setBlockTimestampInterval',[0]);
 for(let step=0;step<20;step++){
  await fork.rpc('anvil_mine',['0x40','0x0']);
  const head=await local.getBlockNumber({cacheTime:0}),historical=head-64n;
  for(const token of baseline){
   for(const blockNumber of [historical,head]){
    const balance=await local.readContract({address:token.address,abi,functionName:'balanceOf',args:[wallet],blockNumber});
    assert.equal(balance,token.balance);
    const code=await local.getCode({address:token.address,blockNumber});assert(code);
    assert.equal(keccak256(code),token.codeHash);
   }
  }
  console.log(JSON.stringify({step:step+1,localBlocks:String(head-source.number),historicalReadsPassed:true}));
 }
 console.log(JSON.stringify({event:'anvil_wallet_history_verified',source:String(source.number),steps:20,budget:fork.budget}));
}catch(error){
 console.error(String(error?.stack??error).replace(/https?:\/\/\S+/g,'[redacted-url]').slice(0,2500));process.exitCode=1;
}finally{await fork?.close();}
