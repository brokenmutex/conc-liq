import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveRangeKeeperReceiptCost} from '../src/deployments/rangekeeper-live-campaign-effects.js';
import type {RangeKeeperSnapshot} from '../src/strategy/rangekeeper/live-domain.js';
import type {RangeKeeperConfig} from '../src/strategy/rangekeeper/config.js';

const source={block:100n,hash:`0x${'a'.repeat(64)}` as `0x${string}`,timestamp:1_800_000_000};
const snapshot=(wallet0:bigint,wallet1:bigint):RangeKeeperSnapshot=>({source,operator:`0x${'1'.repeat(40)}` as `0x${string}`,
 wallet0,wallet1,nativeWei:10n,nonce:4,nftCount:0n,tick:0,sqrtPriceX96:1n,unlocked:true,poolLiquidity:0n,allowances:[],position:null});
const pool:RangeKeeperConfig['pool']={chainId:4663,factory:`0x${'2'.repeat(40)}`,pool:`0x${'3'.repeat(40)}`,token0:`0x${'4'.repeat(40)}`,
 token1:`0x${'5'.repeat(40)}`,quoteToken:1 as const,decimals0:18,decimals1:6,fee:3000,tickSpacing:60,
 positionManager:`0x${'6'.repeat(40)}`,router:`0x${'7'.repeat(40)}`,quoter:`0x${'8'.repeat(40)}`,poolCodeHash:`0x${'a'.repeat(64)}` as `0x${string}`,
 token0CodeHash:`0x${'b'.repeat(64)}` as `0x${string}`,token1CodeHash:`0x${'c'.repeat(64)}` as `0x${string}`,
 managerCodeHash:`0x${'d'.repeat(64)}` as `0x${string}`,quoterCodeHash:`0x${'e'.repeat(64)}` as `0x${string}`,
 reference0:'T0/USD',reference1:'T1/USD',nativeReference:'ETH/USD',numeraire:'USD'};
const swap={kind:'swap' as const,token:0 as const,amountIn:10n**18n,minOut:1n,deadline:1_800_000_100n};
const receiptHash=`0x${'f'.repeat(64)}` as `0x${string}`;

test('receipt accounting uses receipt-block prices rather than pre-transaction authorization prices',()=>{
 const before=snapshot(20n*10n**18n,0n),after=snapshot(19n*10n**18n,1_900_000n);
 const cost=deriveRangeKeeperReceiptCost({plan:swap,before,after,gasWei:100n,receiptHash,pool,status:'success',
  valuation:{source:{block:'100',hash:source.hash,timestamp:source.timestamp},proofHash:'a'.repeat(64),
   // These are the canonical receipt-source observations. Frozen auth prices are intentionally absent from this API.
   price0:(2n*10n**18n).toString(),price1:(10n**18n).toString(),nativePrice:(3n*10n**18n).toString()}});
 assert.equal(cost.actualSwapOutput,1_900_000n);
 assert.equal(cost.gasValue,300n);
 assert.equal(cost.swapFeeValue,6n*10n**15n);
 assert.equal(cost.swapShortfallValue,94_000_000_000_000_000n);
});

test('receipt reference outage keeps measured gas in native units and leaves fiat costs unknown',()=>{
 const before=snapshot(20n*10n**18n,0n),after=snapshot(19n*10n**18n,1_900_000n);
 const cost=deriveRangeKeeperReceiptCost({plan:swap,before,after,gasWei:12345n,receiptHash,pool,status:'success'});
 assert.equal(cost.gasValue,null);assert.equal(cost.swapFeeValue,null);assert.equal(cost.swapShortfallValue,null);
 assert.equal(cost.actualSwapOutput,1_900_000n);
});

test('reverted swap charges no unexecuted swap cost while preserving gas valuation',()=>{
 const before=snapshot(20n*10n**18n,0n),after=snapshot(20n*10n**18n,0n);
 const cost=deriveRangeKeeperReceiptCost({plan:swap,before,after,gasWei:5n,receiptHash,pool,status:'reverted',
  valuation:{source:{block:'100',hash:source.hash,timestamp:source.timestamp},proofHash:'a'.repeat(64),
   price0:'2000000000000000000',price1:'1000000000000000000',nativePrice:'3000000000000000000'}});
 assert.equal(cost.gasValue,15n);assert.equal(cost.swapFeeValue,0n);assert.equal(cost.swapShortfallValue,0n);
});
