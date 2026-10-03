import {getAddress,isAddress,type Address, type Hash} from 'viem';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import type {RobinhoodClient} from '../client.js';
import type {MarketProfile} from '../deployments/market-profile.js';
import {scanPositionManagerWalletTransferHistory,type PositionManagerTransferIndexStore} from './position-manager-transfer-index.js';

/** Bounded, explicit maintenance only. HTTP review code should read persisted
 * evidence directly and must never invoke this function or trigger a backfill. */
export async function maintainRegisteredWalletPositionManagerHistory(input:{
 client:RobinhoodClient;store:PositionManagerTransferIndexStore;wallet:Address;
 profiles:readonly MarketProfile[];source:{block:bigint;hash:Hash;timestamp:number};
 chunkBlocks?:bigint;maxBlocksPerRun?:bigint;
}){
 if(!isAddress(input.wallet)||!input.store.walletScope||!isAddress(input.store.walletScope)||
  getAddress(input.store.walletScope).toLowerCase()!==getAddress(input.wallet).toLowerCase())
  return {status:'unavailable' as const,reason:'wallet_transfer_store_scope_mismatch',enumerationComplete:false as const,
   actionAvailable:false as const};
 if(input.profiles.length===0||input.profiles.some(profile=>profile.pool.chainId!==ROBINHOOD_CHAIN_ID||
  !isAddress(profile.pool.positionManager)))
  return {status:'unavailable' as const,reason:'registered_position_manager_profiles_unavailable',
   enumerationComplete:false as const,actionAvailable:false as const};
 const managers=new Set(input.profiles.map(profile=>getAddress(profile.pool.positionManager).toLowerCase()));
 if(managers.size!==1)return {status:'unavailable' as const,reason:'registered_position_manager_scope_ambiguous',
  enumerationComplete:false as const,actionAvailable:false as const};
 const manager=getAddress(input.profiles[0]!.pool.positionManager);
 return scanPositionManagerWalletTransferHistory({client:input.client,store:input.store,chainId:ROBINHOOD_CHAIN_ID,
  manager,source:input.source,chunkBlocks:input.chunkBlocks,maxBlocksPerRun:input.maxBlocksPerRun});
}
