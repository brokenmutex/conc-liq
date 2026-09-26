import assert from 'node:assert/strict';
import test from 'node:test';
import type {RobinhoodClient} from '../src/client.js';
import {contentHash} from '../src/deployments/contracts.js';
import {readLiveIndependentReferenceEvidence} from '../src/deployments/live-independent-reference-evidence.js';
import {marketProfileSchema} from '../src/deployments/market-profile.js';

const hash=`0x${'a'.repeat(64)}`;
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:'0x1111111111111111111111111111111111111111',
 pool:'0x2222222222222222222222222222222222222222',token0:'0x3333333333333333333333333333333333333333',
 token1:'0x4444444444444444444444444444444444444444',quoteToken:0,decimals0:18,decimals1:18,fee:3000,
 tickSpacing:60,positionManager:'0x5555555555555555555555555555555555555555',
 router:'0x6666666666666666666666666666666666666666',quoter:'0x7777777777777777777777777777777777777777',
 poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:hash,quoterCodeHash:hash,
 reference0:'T0/USD',reference1:'T1/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  token1:{kind:'stock_token',maxAgeSeconds:300,session:'latest_equity_session',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:300,maxPoolDeviationPpm:50_000}});
const source={block:100n,hash:hash as `0x${string}`,timestamp:Math.floor(Date.now()/1000)-20};

test('reference evidence rejects a stale saved profile before any chain or HTTP read',async()=>{
 let reads=0;
 const client={getChainId:async()=>{reads++;return 4663;}} as unknown as RobinhoodClient;
 const result=await readLiveIndependentReferenceEvidence({client,targetStrategyId:'static_manual_v1',profile,
  profileHash:'0'.repeat(64),source});
 assert.equal(result.status,'unavailable');assert.equal(result.missing[0],'saved_market_profile_hash_mismatch');
 assert.equal(result.actionAvailable,false);assert.equal(reads,0);
});

test('reference evidence requires 64 confirmations before loading any reference feeds',async()=>{
 const client={getChainId:async()=>4663,getBlock:async(args?:{blockNumber?:bigint})=>args?.blockNumber===undefined?
  {number:150n,hash:`0x${'b'.repeat(64)}`,timestamp:1_790_000_050n}:
  {number:args.blockNumber,hash,timestamp:BigInt(source.timestamp)}} as unknown as RobinhoodClient;
 const result=await readLiveIndependentReferenceEvidence({client,targetStrategyId:'rangekeeper_v1',profile,
  profileHash:contentHash(profile),source});
 assert.equal(result.status,'unavailable');assert.equal(result.missing[0],'reference_source_not_confirmed');
 assert.equal(result.actionAvailable,false);
});
