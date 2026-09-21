import assert from 'node:assert/strict';
import {keccak256,type Address} from 'viem';
import type {RobinhoodClient} from '../../client.js';
import type {RangeKeeperConfig} from './config.js';
import type {RangeKeeperSource} from './chain.js';

/** Pin both the EIP-7702 indicator and its target bytecode. A wallet's code
 * may change without any token or NFT delta, so custody snapshots alone do
 * not prove that its signing/execution boundary is still the reviewed one. */
export async function verifyRangeKeeperWalletCode(client:RobinhoodClient,source:RangeKeeperSource,
 operator:Address,config:RangeKeeperConfig){
 const code=await client.getBytecode({address:operator,blockNumber:source.block});
 if(config.walletCode.kind==='eoa')assert(!code||code==='0x','Operator is no longer a plain EOA');
 else{
  const expected=`0xef0100${config.walletCode.delegate.slice(2)}`;
  assert(code?.toLowerCase()===expected.toLowerCase(),'Operator EIP-7702 delegate changed');
  const target=await client.getBytecode({address:config.walletCode.delegate,blockNumber:source.block});
  assert(target&&target!=='0x'&&keccak256(target)===config.walletCode.delegateCodeHash,
   'Operator delegate bytecode changed');
 }
 const block=await client.getBlock({blockNumber:source.block});
 assert(block.hash.toLowerCase()===source.hash.toLowerCase(),'Wallet-code source reorged');
}
