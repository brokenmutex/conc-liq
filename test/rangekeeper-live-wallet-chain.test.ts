import assert from 'node:assert/strict';
import test from 'node:test';
import type {Pool} from 'pg';
import type {RobinhoodClient} from '../src/client.js';
import type {PositionManagerTransferIndexStore} from '../src/nft/position-manager-transfer-index.js';
import {readRangeKeeperLiveWallet} from '../src/deployments/rangekeeper-live-wallet-chain.js';
import {marketProfileSchema} from '../src/deployments/market-profile.js';

const H=`0x${'a'.repeat(64)}`;
function profile(manager:string){return marketProfileSchema.parse({pool:{chainId:4663,
 factory:'0x6666666666666666666666666666666666666666',pool:'0x7777777777777777777777777777777777777777',
 token0:'0x2222222222222222222222222222222222222222',token1:'0x3333333333333333333333333333333333333333',
 quoteToken:0,decimals0:18,decimals1:6,fee:3000,tickSpacing:60,positionManager:manager,
 router:'0x5555555555555555555555555555555555555555',quoter:'0x8888888888888888888888888888888888888888',
 poolCodeHash:H,token0CodeHash:H,token1CodeHash:H,managerCodeHash:H,quoterCodeHash:H,
 reference0:'RISK/USD',reference1:'USDG/USD',nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
 token0:{kind:'stock_token',maxAgeSeconds:300,session:'latest_equity_session',corporateAction:'reject_pending'},
 token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:300,maxPoolDeviationPpm:50_000}});}
const source={block:100n,hash:H as `0x${string}`,timestamp:Math.floor(Date.now()/1000)-5};

test('wallet reader fails before RPC when registered profiles disagree on manager custody scope',async()=>{
 let calls=0;
 const client={getChainId:async()=>{calls++;return 4663;}} as unknown as RobinhoodClient;
 const result=await readRangeKeeperLiveWallet({client,pool:{} as Pool,walletAddress:'0x1111111111111111111111111111111111111111',
  source,profiles:[profile('0x4444444444444444444444444444444444444444'),
   profile('0x9999999999999999999999999999999999999999')],transferStore:{} as PositionManagerTransferIndexStore});
 assert.equal(result.status,'unavailable');
 assert(result.reasons.includes('registered_profiles_position_manager_mismatch'));
 assert.equal(calls,0,'Invalid scope must not trigger RPC or database reads');
});

test('wallet reader rejects an empty catalog and invalid fixed wallet without touching RPC',async()=>{
 let calls=0;
 const client={getChainId:async()=>{calls++;return 4663;}} as unknown as RobinhoodClient;
 const result=await readRangeKeeperLiveWallet({client,pool:{} as Pool,walletAddress:'not-an-address',source,
  profiles:[],transferStore:{} as PositionManagerTransferIndexStore});
 assert.equal(result.status,'unavailable');
 assert(result.reasons.includes('server_operator_wallet_address_invalid'));
 assert(result.reasons.includes('registered_market_profiles_unavailable'));
 assert.equal(calls,0);
});
