import assert from 'node:assert/strict';
import test from 'node:test';
import {getAddress,keccak256,type Address} from 'viem';
import type {RobinhoodClient} from '../src/client.js';
import {marketProfileSchema} from '../src/deployments/market-profile.js';
import {readLiveWalletAllocation,type CompleteNftCustodyEvidence} from '../src/deployments/live-wallet-reader.js';

const wallet='0x1111111111111111111111111111111111111111' as Address;
const token0='0x2222222222222222222222222222222222222222' as Address;
const token1='0x3333333333333333333333333333333333333333' as Address;
const manager='0x4444444444444444444444444444444444444444' as Address;
const router='0x5555555555555555555555555555555555555555' as Address;
const hash=`0x${'a'.repeat(64)}` as const;
const managerCode='0x60006000' as const,managerHash=keccak256(managerCode);
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:'0x6666666666666666666666666666666666666666',
 pool:'0x7777777777777777777777777777777777777777',token0,token1,quoteToken:0,decimals0:18,decimals1:6,fee:3000,
 tickSpacing:60,positionManager:manager,router,quoter:'0x8888888888888888888888888888888888888888',
 poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:managerHash,quoterCodeHash:hash,
 reference0:'RISK/USD',reference1:'USDG/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{token0:{kind:'stock_token',maxAgeSeconds:300,session:'latest_equity_session',corporateAction:'reject_pending'},
  token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:300,maxPoolDeviationPpm:50_000}});
const makeSource=(block=100n)=>({block,hash,timestamp:Math.floor(Date.now()/1000)-5});
const pinnedSource=makeSource();
const commitments=(nftTokenIds:string[]=[]):{status:'available';rows:any[]}=>({status:'available',rows:[{
 campaignId:'active-campaign',active:true,known:true,allocatedByTokenAddress:{},pendingByTokenAddress:{},
 allocatedNativeWei:'0',pendingNativeWei:'0',exitReserveWei:'0',nftTokenIds,
}]});

function mockClient(options:{nftCount?:bigint;pendingNonce?:number;allowance?:bigint;reorg?:boolean;
 finalReorg?:boolean;managerCode?:`0x${string}`}={}){
 let pinnedReads=0;
 const client={
  getChainId:async()=>4663,
  getBlock:async(args?:{blockNumber?:bigint})=>{
   if(args?.blockNumber===undefined)return {number:200n,hash,timestamp:BigInt(Math.floor(Date.now()/1000))};
   pinnedReads++;
   return {number:args.blockNumber,hash:(options.reorg&&pinnedReads>1||options.finalReorg&&pinnedReads>2)?
    `0x${'b'.repeat(64)}`:hash,
    timestamp:BigInt(pinnedSource.timestamp)};
  },
  getBytecode:async()=>options.managerCode??managerCode,
  getTransactionCount:async(args:{blockNumber?:bigint;blockTag?:string})=>args.blockTag==='pending'?
   (options.pendingNonce??7):7,
  getBalance:async()=>1000n,
  readContract:async(args:{address:Address;functionName:string})=>{
   if(args.functionName==='balanceOf')return args.address.toLowerCase()===manager.toLowerCase()?(options.nftCount??0n):1000n;
   if(args.functionName==='allowance')return options.allowance??0n;
   if(args.functionName==='ownerOf')return wallet;
   throw new Error(`unexpected read ${args.functionName}`);
  },
 };
 return client as unknown as RobinhoodClient;
}
function validNft(input:{source?:unknown;operator?:string|null;positionManager?:string|null;tokenIds?:string[];
 retiredEmptyTokenIds?:string[]}|{}={}){
 const src=pinnedSource;return {kind:'complete_position_manager_nft_custody',status:'available',
  enumerationComplete:true,tokenIds:['23'],missing:[],source:{block:String(src.block),hash:src.hash,
   timestamp:src.timestamp,confirmed:true},operator:wallet,positionManager:manager,...input} as CompleteNftCustodyEvidence;
}
const read=(overrides:Record<string,unknown>={})=>readLiveWalletAllocation({walletAddress:wallet,
 client:mockClient(),source:pinnedSource,profiles:[profile],commitments:commitments(),...overrides} as never);

test('canonical zero NFT count gives a clean available wallet review',async()=>{
 const review=await read();
 assert.equal(review.status,'available');assert.equal(review.source.confirmed,true);
 assert.equal(review.nftCustody?.enumerationComplete,true);assert.deepEqual(review.nftCustody?.tokenIds,[]);
 assert.equal(review.native.nonce.status,'available');assert.equal(review.native.pendingNonce.status,'available');
 assert.equal(review.tokens.length,2);assert(review.tokens.every(token=>token.availableRaw==='1000'));
 assert.equal(review.allowances.length,4);assert(review.allowances.every(row=>row.raw.status==='available'));
 assert.equal(review.actionAvailable,false);assert.equal(review.executionEligible,false);
});

test('accepts a source-bound complete NFT set that matches active campaign ownership',async()=>{
 const review=await read({client:mockClient({nftCount:1n}),commitments:commitments(['23']),
  readCompleteNftCustody:async()=>validNft()});
 assert.equal(review.status,'available');assert.deepEqual(review.nftCustody?.tokenIds,['23']);
});

test('accepts retired NFT ids only when explicitly attested empty and exactly accounted',async()=>{
 const accepted=await read({client:mockClient({nftCount:1n}),commitments:commitments(),
  readCompleteNftCustody:async()=>validNft({retiredEmptyTokenIds:['23']})});
 assert.equal(accepted.status,'available');
 const unaccounted=await read({client:mockClient({nftCount:2n}),commitments:commitments(),
  readCompleteNftCustody:async()=>validNft({tokenIds:['23','24'],retiredEmptyTokenIds:['23']})});
 assert.equal(unaccounted.status,'unavailable');
 assert(unaccounted.blockers.includes('wallet_nft_set_does_not_match_active_campaign_ownership'));
});

test('rejects forged NFT evidence with source, operator, manager, or count mismatch',async()=>{
 const mutations=[
  validNft({source:{block:'101',hash,timestamp:pinnedSource.timestamp,confirmed:true}}),
  validNft({operator:'0x9999999999999999999999999999999999999999'}),
  validNft({positionManager:'0x9999999999999999999999999999999999999999'}),
  validNft({tokenIds:['23','24']}),
 ];
 for(const evidence of mutations){
  const review=await read({client:mockClient({nftCount:1n}),commitments:commitments(['23']),
   readCompleteNftCustody:async()=>evidence});
  assert.equal(review.status,'unavailable');
  assert(review.blockers.includes('complete_nft_custody_source_or_count_mismatch'));
 }
});

test('unknown active commitments keep free token and native balances unavailable',async()=>{
 const review=await read({commitments:{status:'unavailable',reasons:['active_live_campaign_state_unresolved'],rows:[
  {campaignId:'legacy',active:true,known:false},
 ]}});
 assert.equal(review.status,'unavailable');
 assert(review.tokens.every(token=>token.availableRaw===null));
 assert.equal(review.native.availableWei,null);
});

test('canonical and pending nonce mismatch blocks the wallet review',async()=>{
 const review=await read({client:mockClient({pendingNonce:8})});
 assert.equal(review.status,'unavailable');
 assert(review.blockers.includes('wallet_canonical_pending_nonce_mismatch'));
});

test('pre-existing nonzero router or manager allowance blocks the wallet review',async()=>{
 const review=await read({client:mockClient({allowance:1n})});
 assert.equal(review.status,'unavailable');
 assert(review.blockers.some(reason=>reason.startsWith('wallet_preexisting_allowance_not_zero:')));
});

test('source reorganization during inventory reads makes the review unavailable',async()=>{
 const review=await read({client:mockClient({reorg:true})});
 assert.equal(review.status,'unavailable');
 assert(review.blockers.includes('pinned_source_changed_during_snapshot'));
});

test('source is rechecked after optional complete NFT custody reads',async()=>{
 const review=await read({client:mockClient({nftCount:1n,finalReorg:true}),commitments:commitments(['23']),
  readCompleteNftCustody:async()=>validNft()});
 assert.equal(review.status,'unavailable');
 assert(review.blockers.includes('canonical_source_changed_after_wallet_custody_reads'));
});

test('registered manager bytecode must match its profile code hash at the pinned source',async()=>{
 const review=await read({client:mockClient({managerCode:'0x6001'})});
 assert.equal(review.status,'unavailable');
 assert(review.blockers.includes('position_manager_code_hash_mismatch_at_source'));
 const conflicting=marketProfileSchema.parse({...profile,pool:{...profile.pool,managerCodeHash:`0x${'b'.repeat(64)}`}});
 const registryConflict=await read({profiles:[profile,conflicting]});
 assert.equal(registryConflict.status,'unavailable');
 assert(registryConflict.blockers.includes('registered_profiles_manager_code_hash_mismatch'));
});

test('stale sources and profiles with a different position manager are rejected',async()=>{
 const stale=await read({source:{...pinnedSource,timestamp:Math.floor(Date.now()/1000)-181}});
 assert(stale.blockers.includes('pinned_source_stale_or_invalid'));
 const other=marketProfileSchema.parse({...profile,pool:{...profile.pool,
  pool:'0x9999999999999999999999999999999999999999',
  positionManager:'0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}});
 const mismatched=await read({profiles:[profile,other]});
 assert(mismatched.blockers.includes('registered_profiles_position_manager_mismatch'));
});
