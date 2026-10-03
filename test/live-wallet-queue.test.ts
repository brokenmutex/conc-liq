import test from 'node:test';
import {normalizeLiveCustodyPositionManager} from '../src/deployments/live-wallet-queue.js';

test('canonical NFT custody manager keys normalize checksummed verifier evidence',()=>{
 const checksummed='0xAbCdEfabcdefABCDEFabcdefABCDEFabcdefABCD';
 assert.equal(normalizeLiveCustodyPositionManager(checksummed),checksummed.toLowerCase());
 assert.throws(()=>normalizeLiveCustodyPositionManager('not-an-address'),/malformed/);
});
import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';
import type {Address,Hex} from 'viem';
import {pilotIntentSchema,verifyPilotSignature,type PilotIntent} from '../src/live-pilot/journal.js';

const account=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);
const intent=pilotIntentSchema.parse({id:'11111111-1111-4111-8111-111111111111',chainId:4663,operator:account.address,
 action:'rangekeeper_open',nonce:7,to:'0x2222222222222222222222222222222222222222',data:'0x1234',value:'0',gas:'200000',
 maxFeePerGas:'1000000000',maxPriorityFeePerGas:'1000000',sourceBlock:'100',sourceHash:`0x${'a'.repeat(64)}` as `0x${string}`}) as PilotIntent;

test('wallet queue accepts only the exact persisted signed intent and never a different nonce or destination',async()=>{
 const raw=await account.signTransaction({type:'eip1559',chainId:4663,nonce:intent.nonce,to:intent.to as Address,data:intent.data as Hex,value:0n,
  gas:BigInt(intent.gas),maxFeePerGas:BigInt(intent.maxFeePerGas),maxPriorityFeePerGas:BigInt(intent.maxPriorityFeePerGas)});
 assert.match(await verifyPilotSignature(intent,raw),/^0x[0-9a-f]{64}$/);
 const changed={...intent,nonce:intent.nonce+1};
 await assert.rejects(()=>verifyPilotSignature(changed,raw));
 await assert.rejects(()=>verifyPilotSignature({...intent,to:'0x3333333333333333333333333333333333333333'},raw));
});

test('queue intent schema rejects client-controlled chain, access-list envelope fields, and malformed nonce',()=>{
 assert.throws(()=>pilotIntentSchema.parse({...intent,chainId:1}));
 assert.throws(()=>pilotIntentSchema.parse({...intent,nonce:-1}));
 assert.throws(()=>pilotIntentSchema.parse({...intent,unreviewed:true}));
});
