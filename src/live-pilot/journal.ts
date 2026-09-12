import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {getAddress,isAddress,keccak256,parseTransaction,recoverTransactionAddress,type Hex,type TransactionSerializedEIP1559} from 'viem';
import type {Pool} from 'pg';

const uint=z.string().regex(/^(0|[1-9][0-9]*)$/);
const address=z.string().refine(isAddress).transform(value=>getAddress(value));
const bytes=z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
export const pilotIntentSchema=z.object({
 id:z.string().uuid(),chainId:z.literal(4663),operator:address,action:z.string().min(1),
 nonce:z.number().int().nonnegative().safe(),to:address,data:bytes,value:z.literal('0'),
 gas:uint.refine(n=>BigInt(n)>0n),maxFeePerGas:uint.refine(n=>BigInt(n)>0n),maxPriorityFeePerGas:uint,
 sourceBlock:uint,sourceHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
}).strict().refine(p=>BigInt(p.maxFeePerGas)>=BigInt(p.maxPriorityFeePerGas));
export type PilotIntent=z.infer<typeof pilotIntentSchema>;

/** Exact envelope matching only; the strategy must separately authorize calldata. */
export async function verifyPilotSignature(input:PilotIntent,raw:Hex) {
 const intent=pilotIntentSchema.parse(input),tx=parseTransaction(raw);
 assert.equal(tx.type,'eip1559');assert.equal(tx.chainId,intent.chainId);
 assert.equal(tx.nonce,intent.nonce);assert.equal(tx.to?.toLowerCase(),intent.to.toLowerCase());
 assert.equal((tx.data??'0x').toLowerCase(),intent.data.toLowerCase());assert.equal(tx.value??0n,BigInt(intent.value));
 assert.equal(tx.gas,BigInt(intent.gas));assert.equal(tx.maxFeePerGas,BigInt(intent.maxFeePerGas));
 assert.equal(tx.maxPriorityFeePerGas??0n,BigInt(intent.maxPriorityFeePerGas));
 assert.equal(tx.accessList?.length??0,0,'Access list was not part of the prepared intent');
 assert.equal((await recoverTransactionAddress({serializedTransaction:raw as TransactionSerializedEIP1559})).toLowerCase(),intent.operator.toLowerCase());
 return keccak256(raw);
}

/** Preparation-stage durable outbox. There is deliberately no send or unlock API.
 * An unknown broadcast acknowledgement or timeout retains the same bytes/nonce.
 * A future reconciliation controller must prove wallet and NFT state before it
 * can finish an intent and permit another transaction. Never unlock on timeout.
 */
export class PilotJournal {
 private readonly table:string;
 constructor(private readonly pool:Pool,private readonly schema:string) {
  assert(/^[a-z][a-z0-9_]{0,62}$/.test(schema),'Invalid journal schema');
  this.table=`"${schema}".transaction_intents`;
 }
 async initialize() {
  await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
  await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
   id uuid PRIMARY KEY,chain_id integer NOT NULL CHECK(chain_id=4663),operator text NOT NULL,
   nonce bigint NOT NULL CHECK(nonce>=0),intent jsonb NOT NULL,
   status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','signed')),
   raw_transaction text,transaction_hash text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
   UNIQUE(chain_id,operator),UNIQUE(chain_id,operator,nonce),
   CHECK((status='prepared' AND raw_transaction IS NULL AND transaction_hash IS NULL)
      OR (status='signed' AND raw_transaction IS NOT NULL AND transaction_hash IS NOT NULL))
  )`);
 }
 async prepare(input:PilotIntent) {
  const intent=pilotIntentSchema.parse(input);
  // The wallet uniqueness constraint also covers concurrent workers/processes.
  await this.pool.query(`INSERT INTO ${this.table}(id,chain_id,operator,nonce,intent)
   VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
  [intent.id,intent.chainId,intent.operator.toLowerCase(),intent.nonce,JSON.stringify(intent)]);
  const stored=await this.read(intent.id);assert(isDeepStrictEqual(stored.intent,intent),'Intent ID already contains different transaction');
  return stored;
 }
 async recordSigned(id:string,raw:Hex) {
  const current=await this.read(id),hash=await verifyPilotSignature(current.intent,raw);
  await this.pool.query(`UPDATE ${this.table} SET raw_transaction=$2,transaction_hash=$3,status='signed'
   WHERE id=$1 AND status='prepared'`,[id,raw.toLowerCase(),hash]);
  const stored=await this.read(id);
  assert.equal(stored.raw_transaction,raw.toLowerCase(),'A different signature was already persisted');
  assert.equal(stored.transaction_hash,hash);
  return stored;
 }
 async read(id:string) {
  const result=await this.pool.query<{intent:PilotIntent;status:'prepared'|'signed';raw_transaction:Hex|null;transaction_hash:Hex|null}>(
   `SELECT intent,status,raw_transaction,transaction_hash FROM ${this.table} WHERE id=$1`,[id]);
  assert(result.rows[0],'Unknown transaction intent');return result.rows[0];
 }
}
