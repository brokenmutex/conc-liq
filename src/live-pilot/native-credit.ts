import assert from 'node:assert/strict';
import type {Hex} from 'viem';
import type {RobinhoodClient} from '../client.js';
import type {PilotSnapshot} from './domain.js';

export interface NativeCreditProof {
 kind:'canonical_direct_native_credit_v1';fromBlock:string;toBlock:string;totalWei:string;
 transfers:{hash:Hex;block:string;blockHash:Hex;from:string;valueWei:string}[];
}
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();

/** Bounded automatic discovery; explicit hashes allow repair after a long halt.
 * Internal transfers and unexplained residuals require separate investigation.
 * Receipt gas is supplied only by the receipt reconciliation path.
 */
export async function proveNativeCredit(client:RobinhoodClient,before:PilotSnapshot,after:PilotSnapshot,
 gasWei=0n,hashes?:Hex[]):Promise<NativeCreditProof|null> {
 const delta=BigInt(after.native)-BigInt(before.native)+gasWei;
 if(delta===0n)return null;
 assert(delta>0n,'Unexplained native debit');
 const start=BigInt(before.block),end=BigInt(after.block);
 assert(end>start,'Native credit requires a later source block');
 assert(same(before.operator,after.operator));
 assert.equal(await client.getChainId(),4663,'Native credit chain mismatch');
 const verifySources=async()=>{
  assert(same((await client.getBlock({blockNumber:start})).hash,before.hash),'Native credit prior source reorged');
  assert(same((await client.getBlock({blockNumber:end})).hash,after.hash),'Native credit current source reorged');
 };
 await verifySources();
 const code=await client.getBytecode({address:after.operator,blockNumber:end});
 assert(!code||code==='0x','Native credit requires an undelegated EOA');
 let candidates=hashes;
 if(!candidates){
  assert(end-start<=512n,'Native credit discovery exceeds 512 blocks; explicit receipt hashes required');
  candidates=[];
  for(let first=start+1n;first<=end;first+=8n){
   const blocks=await Promise.all(Array.from({length:Number(end-first+1n<8n?end-first+1n:8n)},(_,i)=>client.getBlock({blockNumber:first+BigInt(i),includeTransactions:true})));
   for(const block of blocks)for(const tx of block.transactions)
    if(tx.to&&same(tx.to,after.operator)&&tx.value>0n)candidates.push(tx.hash);
  }
 }
 assert(candidates.length>0&&candidates.length<=64,'Native credit requires 1 to 64 direct transfers');
 assert.equal(new Set(candidates.map(h=>h.toLowerCase())).size,candidates.length,'Duplicate native credit hash');
 const transfers:NativeCreditProof['transfers']=[];
 for(const hash of candidates){
  const [tx,r]=await Promise.all([client.getTransaction({hash}),client.getTransactionReceipt({hash})]);
  assert(same(tx.hash,hash)&&same(r.transactionHash,hash),'Native credit receipt hash mismatch');
  assert(r.status==='success'&&tx.to&&same(tx.to,after.operator)&&!same(tx.from,after.operator)&&tx.value>0n&&tx.input==='0x','Not a successful direct native deposit');
  assert(tx.blockNumber===r.blockNumber&&r.blockNumber>start&&r.blockNumber<=end,'Native credit outside snapshot interval');
  assert(tx.blockHash&&same(tx.blockHash,r.blockHash)&&same((await client.getBlock({blockNumber:r.blockNumber})).hash,r.blockHash),'Native credit receipt reorged');
  transfers.push({hash,block:String(r.blockNumber),blockHash:r.blockHash,from:tx.from,valueWei:String(tx.value)});
 }
 assert.equal(transfers.reduce((n,t)=>n+BigInt(t.valueWei),0n),delta,'Native transfers do not explain the exact balance difference');
 await verifySources();
 return {kind:'canonical_direct_native_credit_v1',fromBlock:before.block,toBlock:after.block,totalWei:String(delta),transfers};
}
