import assert from 'node:assert/strict';
import {getAddress,parseAbiItem} from 'viem';

const transfer=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)');
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const checkpoint=b=>({number:b.number,hash:b.hash,parentHash:b.parentHash,timestamp:Number(b.timestamp)});
const parsed=log=>({blockNumber:log.blockNumber,blockHash:log.blockHash,transactionHash:log.transactionHash,
 transactionIndex:log.transactionIndex,logIndex:log.logIndex,...log.args});

/** Test fixture whose wallet-scoped genesis coverage comes from actual bounded
 * RPC queries. It never asserts global coverage from an empty wallet result.
 * Only reads reach the upstream node. Local stages extend it with actual logs. */
export async function createCanonicalWalletTransferFixture({client,source,manager,wallet,
 chunkBlocks=10_000_000n,beforeQuery=async()=>{}}){
 manager=getAddress(manager);wallet=getAddress(wallet);
 assert(chunkBlocks>0n&&chunkBlocks<=10_000_000n);
 assert.equal(await client.getChainId(),4663);
 const initial=await client.getBlock({blockNumber:source.block});
 assert(same(initial.hash,source.hash)&&Number(initial.timestamp)===source.timestamp,'Transfer RPC source identity mismatch');
 assert((await client.getBlock()).number>=source.block+64n,'Transfer RPC does not yet confirm the source to 64 blocks');
 const transfers=[],headers=new Map(),ranges=[];
 let requests=0;
 for(let fromBlock=0n;fromBlock<=source.block;fromBlock+=chunkBlocks){
  const toBlock=fromBlock+chunkBlocks-1n<source.block?fromBlock+chunkBlocks-1n:source.block;
  for(const args of [{from:wallet},{to:wallet}]){
   await beforeQuery();requests++;
   const logs=await client.getLogs({address:manager,event:transfer,args,fromBlock,toBlock,strict:true});
   assert(logs.length<=10_000,'Wallet transfer query exceeded its bounded log count');
   for(const log of logs){
    assert(log.removed!==true&&log.blockNumber>=fromBlock&&log.blockNumber<=toBlock);
    assert(same(log.address,manager)&&(same(log.args.from,wallet)||same(log.args.to,wallet)));
    transfers.push(parsed(log));
   }
  }
  ranges.push({fromBlock:String(fromBlock),toBlock:String(toBlock)});
 }
 const unique=new Map();
 const identity=t=>[String(t.blockNumber),t.blockHash.toLowerCase(),t.transactionHash.toLowerCase(),
  t.transactionIndex,t.logIndex,t.from.toLowerCase(),t.to.toLowerCase(),String(t.tokenId)];
 for(const t of transfers){
  const key=`${t.transactionHash.toLowerCase()}:${t.logIndex}`,prior=unique.get(key);
  if(prior)assert.deepEqual(identity(prior),identity(t),'Conflicting wallet transfer query results');
  else unique.set(key,t);
 }
 const ordered=[...unique.values()].sort((a,b)=>a.blockNumber!==b.blockNumber?a.blockNumber<b.blockNumber?-1:1:
  a.transactionIndex-b.transactionIndex||a.logIndex-b.logIndex);
 assert(ordered.length<=1_000_000);
 const eventBlocks=[...new Set(ordered.map(t=>String(t.blockNumber)))].map(BigInt);
 assert(eventBlocks.length<=10_000);
 for(const number of [...eventBlocks,source.block]){
  const b=await client.getBlock({blockNumber:number});
  assert(ordered.filter(t=>t.blockNumber===number).every(t=>same(t.blockHash,b.hash)));
  headers.set(String(number),checkpoint(b));
 }
 assert(same((await client.getBlock({blockNumber:source.block})).hash,source.hash));
 let cursor={chainId:4663,manager,startBlock:0n,nextBlock:source.block+1n,
  coveredThroughBlock:source.block,coveredThroughHash:source.hash,lastScannedBlock:source.block,lastScannedHash:source.hash};
 const store={walletScope:wallet,
  getCursor:async(chainId,m,start)=>chainId===4663&&same(m,manager)&&start===0n?{...cursor}:null,
  initializeCursor:async()=>{throw Error('Fixture cannot invent a genesis baseline');},
  recentCheckpoints:async()=>[...headers.values()].sort((a,b)=>a.number>b.number?-1:1),
  rewind:async()=>{throw Error('Fixture requires a fresh canonical scan after a reorg');},
  saveChunk:async chunk=>{
   assert(chunk.chainId===4663&&same(chunk.manager,manager)&&chunk.startBlock===0n);
   assert(chunk.fromBlock===cursor.nextBlock&&chunk.checkpoint.number===chunk.toBlock);
   assert(chunk.transfers.every(t=>same(t.from,wallet)||same(t.to,wallet)));
   for(const h of [...chunk.eventBlocks,chunk.checkpoint,...(chunk.fromCheckpoint?[chunk.fromCheckpoint]:[])])
    headers.set(String(h.number),h);
   ordered.push(...chunk.transfers);
   cursor={...cursor,nextBlock:chunk.toBlock+1n,coveredThroughBlock:chunk.toBlock,coveredThroughHash:chunk.checkpoint.hash,
    lastScannedBlock:chunk.toBlock,lastScannedHash:chunk.checkpoint.hash};
  },
  savePinnedCheckpoint:async(chainId,m,start,h)=>{
   assert(chainId===4663&&same(m,manager)&&start===0n&&h.number<=cursor.coveredThroughBlock);
   headers.set(String(h.number),h);
  },
  loadTransfers:async(chainId,m,start,to,limit)=>{
   assert(chainId===4663&&same(m,manager)&&start===0n);const result=ordered.filter(t=>t.blockNumber<=to);
   assert(result.length<=limit);return result;
  },
  loadReplayEvidence:async(chainId,m,start,to,limit)=>{
   assert(chainId===4663&&same(m,manager)&&start===0n);const result=ordered.filter(t=>t.blockNumber<=to);
   assert(result.length<=limit);return {cursor:{...cursor},checkpoints:[...headers.values()],transfers:result};
  },
 };
 return {store:Object.freeze(store),baseline:{scope:'wallet',wallet,manager,source,ranges,requests,transferCount:ordered.length,
  checkpointCount:headers.size,upstreamMutations:0}};
}
