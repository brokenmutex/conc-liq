import assert from 'node:assert/strict';
import pg from 'pg';
import {privateKeyToAccount} from 'viem/accounts';
import {USDG} from '../../src/constants.ts';
import {PilotJournal} from '../../src/live-pilot/journal.ts';
assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});
const schema=`live_pilot_test_${process.pid}_${Date.now()}`;
const account=privateKeyToAccount(`0x${'01'.repeat(32)}`);
const intent={id:'37df20c4-12ab-4fd4-a5a5-020f0dcd06f5',chainId:4663,operator:account.address,
 action:'approval_fixture',nonce:7,to:USDG,data:'0x1234',value:'0',gas:'50000',maxFeePerGas:'100000000',maxPriorityFeePerGas:'0',sourceBlock:'1234',sourceHash:`0x${'ab'.repeat(32)}`};
const tx={type:'eip1559',chainId:4663,nonce:7,to:USDG,data:'0x1234',value:0n,gas:50000n,maxFeePerGas:100000000n,maxPriorityFeePerGas:0n};
try{
 const first=new PilotJournal(pool,schema);await first.initialize();
 const results=await Promise.all([first.prepare(intent),first.prepare(intent)]);assert(results.every(r=>r.status==='prepared'));
 await assert.rejects(()=>first.prepare({...intent,nonce:8}),'An intent cannot be rewritten');
 await assert.rejects(()=>first.prepare({...intent,id:'b4cb2c4a-d27c-4f11-863a-169e5eb4169f',nonce:8}),'A second outstanding transaction cannot reserve another nonce');
 const raw=await account.signTransaction(tx),signed=await first.recordSigned(intent.id,raw);assert.equal(signed.status,'signed');
 // Simulate a process restart after persisting, before/after an unknown RPC ack.
 const restarted=new PilotJournal(pool,schema),recovered=await restarted.read(intent.id);
 assert.equal(recovered.transaction_hash,signed.transaction_hash);assert.equal(recovered.raw_transaction,raw);
 assert.equal((await restarted.recordSigned(intent.id,raw)).transaction_hash,signed.transaction_hash);
 const wrong=await account.signTransaction({...tx,nonce:8});
 await assert.rejects(()=>restarted.recordSigned(intent.id,wrong), 'Invalid payload cannot replace the durable record');
 assert.equal((await restarted.read(intent.id)).raw_transaction,raw);
 console.log('Live pilot journal: concurrent reservation, idempotency, exact signed bytes and restart recovery passed; no broadcaster or reconciliation unlock');
}finally{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();}
