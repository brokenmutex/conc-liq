import assert from 'node:assert/strict';
import {getAddress,parseAbi,type Address,type Hex} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {pilotIntentSchema} from '../live-pilot/journal.js';
import {encodeRangeKeeperTx} from '../strategy/rangekeeper/calldata.js';
import type {RangeKeeperPool} from '../strategy/rangekeeper/domain.js';
import type {RangeKeeperLiveAction,RangeKeeperSnapshot} from '../strategy/rangekeeper/live-domain.js';
import {reconcileRangeKeeperAction} from '../strategy/rangekeeper/live-reconcile.js';
import {nonfungiblePositionManagerReadAbi} from '../nft/abi.js';
import {liveSetupEvidenceHash} from './rangekeeper-live-setup-simulation.js';

const balanceAbi=parseAbi(['function balanceOf(address) view returns(uint256)',
 'function allowance(address,address) view returns(uint256)','function ownerOf(uint256) view returns(address)']);
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const key=(address:string)=>getAddress(address).toLowerCase();
const ids=(values:readonly string[])=>{
 assert(values.length<=100&&values.every(v=>/^[1-9][0-9]*$/.test(v))&&new Set(values).size===values.length,'Invalid complete NFT set');
 return [...values].sort();
};
const amounts=(values:Record<string,bigint>)=>{
 const entries=Object.entries(values).map(([address,value])=>{
  assert(typeof value==='bigint'&&value>=0n,'Invalid liquid amount');return [key(address),value] as const;
 });
 assert(entries.length>0&&entries.length<=8&&new Set(entries.map(([address])=>address)).size===entries.length,'Invalid token scope');
 return Object.fromEntries(entries.sort(([a],[b])=>a.localeCompare(b)));
};
export interface RangeKeeperWholeWalletSnapshot {
 operator:Address;source:RangeKeeperSnapshot['source'];nonce:number;nativeWei:bigint;
 tokens:Record<string,bigint>;nftTokenIds:string[];
 allowances:{token:Address;spender:Address;amount:bigint}[];
}
export interface RangeKeeperWalletCampaignAllocation {
 campaignId:string;liquidByTokenAddress:Record<string,bigint>;
 nativeSpendWei:bigint;exitReserveWei:bigint;nftTokenIds:string[];
}
export type RangeKeeperWalletReconcileAction=Pick<RangeKeeperLiveAction,'hash'|'plan'|'before'|'intent'>;

/** Canonical receipt attribution for one operation in the shared wallet queue.
 * The queue must supply its persisted pre-stage snapshot/allocation and commit
 * this result with its outbox/receipt under the same wallet lock. Nothing signs,
 * broadcasts or updates a database here. */
export async function reconcileRangeKeeperWalletReceipt(input:{client:RobinhoodClient;pool:RangeKeeperPool;
 action:RangeKeeperWalletReconcileAction;beforeWallet:RangeKeeperWholeWalletSnapshot;
 afterWallet:RangeKeeperWholeWalletSnapshot;afterPool:RangeKeeperSnapshot;
 allocation:RangeKeeperWalletCampaignAllocation;exitSpendAllowed:boolean}){
 const {client,pool,action,beforeWallet:before,afterWallet:after,afterPool,allocation}=input;
 const intent=pilotIntentSchema.parse(action.intent);assert(action.hash,'Signed action hash missing');
 assert.equal(intent.chainId,pool.chainId);assert(same(before.operator,intent.operator)&&same(after.operator,intent.operator));
 assert.equal(before.nonce,intent.nonce);assert.equal(after.nonce,intent.nonce+1);
 assert.equal(String(before.source.block),intent.sourceBlock);assert(same(before.source.hash,intent.sourceHash));
 assert(after.source.block>before.source.block,'Receipt precedes its prepared source');
 const encoded=encodeRangeKeeperTx(pool,intent.operator,action.plan);
 assert(same(encoded.to,intent.to)&&same(encoded.data,intent.data),'Receipt intent differs from strategy plan');
 const beforeTokens=amounts(before.tokens),afterTokens=amounts(after.tokens),liquid=amounts(allocation.liquidByTokenAddress);
 assert.deepEqual(Object.keys(beforeTokens),Object.keys(afterTokens),'Wallet token scope changed');
 assert(Object.keys(liquid).every(address=>address in beforeTokens),'Allocation token outside wallet scope');
 const t0=key(pool.token0),t1=key(pool.token1);
 assert(t0 in beforeTokens&&t1 in beforeTokens&&t0 in liquid&&t1 in liquid,'Pool allocation missing');
 const allocatedNfts=ids(allocation.nftTokenIds);
 assert(allocatedNfts.length<=1,'Campaign has more than one managed position');
 if(allocatedNfts.length)assert(action.before.position?.tokenId!==null&&
  String(action.before.position?.tokenId)===allocatedNfts[0],'Prepared position differs from campaign custody');
 if(action.before.position){
  const p=action.before.position;
  assert(same(p.owner,intent.operator)&&same(p.token0,pool.token0)&&same(p.token1,pool.token1)&&p.fee===pool.fee,
   'Prepared position differs from approved pool');
  if(p.liquidity>0n||p.tokensOwed0>0n||p.tokensOwed1>0n)
   assert(allocatedNfts.includes(String(p.tokenId)),'Prepared position belongs to another campaign');
 }
 const bindPool=(wallet:RangeKeeperWholeWalletSnapshot,snapshot:RangeKeeperSnapshot,tokens:Record<string,bigint>)=>{
  assert(same(wallet.operator,snapshot.operator));assert.equal(wallet.source.block,snapshot.source.block);
  assert(same(wallet.source.hash,snapshot.source.hash));assert.equal(wallet.source.timestamp,snapshot.source.timestamp);
  assert.equal(wallet.nonce,snapshot.nonce);assert.equal(wallet.nativeWei,snapshot.nativeWei);
  assert.equal(tokens[t0],snapshot.wallet0);assert.equal(tokens[t1],snapshot.wallet1);
  assert.equal(BigInt(ids(wallet.nftTokenIds).length),snapshot.nftCount);
 };
 bindPool(before,action.before,beforeTokens);bindPool(after,afterPool,afterTokens);
 const [chainId,receipt,transaction,tip,start,end]=await Promise.all([
  client.getChainId(),client.getTransactionReceipt({hash:action.hash}),client.getTransaction({hash:action.hash}),
  client.getBlock(),client.getBlock({blockNumber:before.source.block}),client.getBlock({blockNumber:after.source.block}),
 ]);
 assert.equal(chainId,ROBINHOOD_CHAIN_ID);assert(tip.number>=receipt.blockNumber+64n,'Receipt is not confirmed');
 assert.equal(receipt.blockNumber,after.source.block);assert(same(receipt.blockHash,after.source.hash));
 assert(same(start.hash,before.source.hash)&&Number(start.timestamp)===before.source.timestamp,'Prepared source changed');
 assert(same(end.hash,after.source.hash)&&Number(end.timestamp)===after.source.timestamp,'Receipt source changed');
 assert(same(receipt.transactionHash,action.hash)&&same(receipt.from,intent.operator),'Receipt sender or hash changed');
 assert(same(transaction.hash,action.hash)&&same(transaction.from,intent.operator)&&transaction.to&&same(transaction.to,intent.to));
 assert.equal(transaction.nonce,intent.nonce);assert.equal(transaction.input.toLowerCase(),intent.data.toLowerCase());
 assert.equal(transaction.value,0n);assert.equal(transaction.gas,BigInt(intent.gas));
 assert.equal(transaction.maxFeePerGas,BigInt(intent.maxFeePerGas));
 assert.equal(transaction.maxPriorityFeePerGas,BigInt(intent.maxPriorityFeePerGas));
 assert.equal(transaction.blockNumber,receipt.blockNumber);assert(transaction.blockHash&&same(transaction.blockHash,receipt.blockHash));
 const verifyWallet=async(wallet:RangeKeeperWholeWalletSnapshot,tokens:Record<string,bigint>)=>{
  const blockNumber=wallet.source.block,nftIds=ids(wallet.nftTokenIds);
  assert(Number.isSafeInteger(wallet.nonce)&&wallet.nonce>=0&&wallet.nativeWei>=0n);
  const [native,nonce,count]=await Promise.all([client.getBalance({address:wallet.operator,blockNumber}),
   client.getTransactionCount({address:wallet.operator,blockNumber}),client.readContract({address:pool.positionManager,
    abi:balanceAbi,functionName:'balanceOf',args:[wallet.operator],blockNumber})]);
  assert.equal(native,wallet.nativeWei);assert.equal(nonce,wallet.nonce);assert.equal(count,BigInt(nftIds.length));
  await Promise.all(Object.entries(tokens).map(async([address,amount])=>assert.equal(await client.readContract({
   address:address as Address,abi:balanceAbi,functionName:'balanceOf',args:[wallet.operator],blockNumber}),amount)));
  for(let offset=0;offset<nftIds.length;offset+=8)await Promise.all(nftIds.slice(offset,offset+8).map(async id=>{
   const owner=await client.readContract({address:pool.positionManager,abi:balanceAbi,functionName:'ownerOf',args:[BigInt(id)],blockNumber});
   assert(same(owner,wallet.operator),'NFT owner changed');
  }));
  assert(wallet.allowances.length<=64,'Allowance scope out of bounds');
  const pairs=wallet.allowances.map(a=>`${key(a.token)}:${key(a.spender)}`);
  assert.equal(new Set(pairs).size,pairs.length,'Duplicate allowance pair');
  await Promise.all(wallet.allowances.map(async a=>assert.equal(await client.readContract({address:a.token,abi:balanceAbi,
   functionName:'allowance',args:[wallet.operator,a.spender],blockNumber}),a.amount)));
 };
 await verifyWallet(before,beforeTokens);await verifyWallet(after,afterTokens);
 for(const snapshot of [action.before,afterPool])if(snapshot.position){
  const p=snapshot.position;assert(p.tokenId!==null,'Position token ID missing');
  const [owner,actual]=await Promise.all([client.readContract({address:pool.positionManager,abi:balanceAbi,
   functionName:'ownerOf',args:[p.tokenId],blockNumber:snapshot.source.block}),
   client.readContract({address:pool.positionManager,abi:nonfungiblePositionManagerReadAbi,functionName:'positions',
    args:[p.tokenId],blockNumber:snapshot.source.block})]);
  assert(same(owner,p.owner)&&same(actual[2],p.token0)&&same(actual[3],p.token1),'Canonical position identity differs');
  assert.deepEqual([actual[4],actual[5],actual[6],actual[7],actual[10],actual[11]],
   [p.fee,p.tickLower,p.tickUpper,p.liquidity,p.tokensOwed0,p.tokensOwed1],'Canonical position custody differs');
 }
 const allowanceMap=(wallet:RangeKeeperWholeWalletSnapshot)=>Object.fromEntries(wallet.allowances.map(a=>[`${key(a.token)}:${key(a.spender)}`,a.amount]));
 const oldAllowances=allowanceMap(before),newAllowances=allowanceMap(after);
 assert.deepEqual(Object.keys(oldAllowances).sort(),Object.keys(newAllowances).sort(),'Allowance scope changed');
 for(const address of Object.keys(beforeTokens))if(address!==t0&&address!==t1)
  assert.equal(afterTokens[address],beforeTokens[address],'Another pool token changed');
 for(const pair of Object.keys(oldAllowances)){
  const [token,spender]=pair.split(':');
  if((token!==t0&&token!==t1)||(spender!==key(pool.router)&&spender!==key(pool.positionManager)))
   assert.equal(newAllowances[pair],oldAllowances[pair],'Another operation allowance changed');
 }
 for(const snapshot of [action.before,afterPool])for(const a of snapshot.allowances){
  const map=snapshot===action.before?oldAllowances:newAllowances;
  assert.equal(map[`${key(a.token)}:${key(a.spender)}`],a.amount,'Pool allowance differs from complete wallet');
 }
 const proof=reconcileRangeKeeperAction(pool,action,receipt,afterPool);
 const nextLiquidByTokenAddress={...liquid};
 for(const address of [t0,t1]){
  const next=liquid[address]!+afterTokens[address]!-beforeTokens[address]!;
  assert(next>=0n&&next<=afterTokens[address]!,'Receipt spent sibling capital');nextLiquidByTokenAddress[address]=next;
 }
 assert(allocation.nativeSpendWei>=0n&&allocation.exitReserveWei>=0n);
 let nextNativeSpendWei=allocation.nativeSpendWei-proof.gasWei,nextExitReserveWei=allocation.exitReserveWei;
 if(nextNativeSpendWei<0n){assert(input.exitSpendAllowed,'Receipt invaded campaign exit reserve');
  nextExitReserveWei+=nextNativeSpendWei;nextNativeSpendWei=0n;assert(nextExitReserveWei>=0n,'Receipt spent sibling native reserve');}
 const expected=ids(before.nftTokenIds),managed=ids(allocation.nftTokenIds),retiredNftTokenIds:string[]=[];
 assert(managed.every(id=>expected.includes(id)),'Campaign NFT outside wallet');
 if(proof.createdTokenId!==null){const created=String(proof.createdTokenId);expected.push(created);managed.push(created);}
 if(proof.status==='success'&&action.plan.kind==='withdraw'){
  const retired=String(action.plan.tokenId);assert(managed.includes(retired),'Withdrawal NFT belongs to another campaign');
  managed.splice(managed.indexOf(retired),1);retiredNftTokenIds.push(retired);
 }
 assert.deepEqual(ids(after.nftTokenIds),ids(expected),'Unattributed NFT change');
 const result={receipt,source:after.source,nonce:after.nonce,gasWei:proof.gasWei,status:proof.status,
  collection:proof.collection,nextLiquidByTokenAddress,nextNativeSpendWei,nextExitReserveWei,
  nextNftTokenIds:ids(managed),retiredNftTokenIds};
 const receiptHash=liveSetupEvidenceHash(receipt);
 // Recheck after all bounded reads; no mid-read reorg can qualify this result.
 const [finalStart,finalEnd]=await Promise.all([client.getBlock({blockNumber:before.source.block}),client.getBlock({blockNumber:after.source.block})]);
 assert(same(finalStart.hash,before.source.hash)&&same(finalEnd.hash,after.source.hash),'Canonical source changed during attribution');
 return {...result,afterWallet:structuredClone(after),afterPool:structuredClone(afterPool),positionManager:pool.positionManager,
  position:afterPool.position?structuredClone(afterPool.position):null,
  receiptHash,proofHash:liveSetupEvidenceHash({campaignId:allocation.campaignId,intent,
  beforeWallet:before,afterWallet:after,allocation,result,receiptHash})};
}
