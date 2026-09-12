import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {recoverMessageAddress,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {LivePilotConfig} from './config.js';
import {pilotIntentSchema,verifyPilotSignature,type PilotIntent} from './journal.js';

/** Keep the secret out of process.env, subprocesses, JSON and error messages.
 * Only public identity, an ownership challenge and exact intent signing are exposed.
 * No RPC client or broadcast method is available here.
 */
export function loadPilotEnvSigner(config:LivePilotConfig,baseDirectory:string) {
 assert(config.operator&&config.signer?.kind==='env_file','Pilot env-file signer is not configured');
 const path=resolve(baseDirectory,config.signer.reference);
 let account:ReturnType<typeof privateKeyToAccount>;
 try {
  const stat=statSync(path);
  assert(stat.isFile()&&(stat.mode&0o077)===0);
  const values=parseEnv(readFileSync(path,'utf8')),value=values[config.signer.variable]?.trim();
  assert(value&&/^(0x)?[0-9a-fA-F]{64}$/.test(value));
  account=privateKeyToAccount((value.startsWith('0x')?value:`0x${value}`) as Hex);
 } catch { throw new Error('Cannot load pilot key: check the configured env variable and private file permissions'); }
 assert.equal(account.address.toLowerCase(),config.operator.toLowerCase(),'Pilot signer address does not match configured operator');
 return {
  address:account.address,
  async proveOwnership() {
   const message=['conc-liq live pilot wallet ownership proof','Chain ID: 4663',`Operator: ${account.address}`,
    `Challenge: ${randomUUID()}`,`Created: ${new Date().toISOString()}`,
    'Purpose: deployment preparation; this message does not authorize transfers or transactions.'].join('\n');
   const signature=await account.signMessage({message});
   assert.equal((await recoverMessageAddress({message,signature})).toLowerCase(),account.address.toLowerCase());
   return {kind:'eip191_wallet_ownership_v1' as const,address:account.address,message,signature,verified:true};
  },
  // Call only after the controller authorizes calldata and durably reserves intent.
  // This method never sends or stores a transaction; the journal must persist it.
  async signIntent(input:PilotIntent) {
   const intent=pilotIntentSchema.parse(input);
   assert.equal(intent.operator.toLowerCase(),account.address.toLowerCase(),'Intent operator differs from signer');
   const raw=await account.signTransaction({type:'eip1559',chainId:intent.chainId,nonce:intent.nonce,
    to:intent.to,data:intent.data as Hex,value:BigInt(intent.value),gas:BigInt(intent.gas),
    maxFeePerGas:BigInt(intent.maxFeePerGas),maxPriorityFeePerGas:BigInt(intent.maxPriorityFeePerGas)});
   const hash=await verifyPilotSignature(intent,raw);
   return {raw,hash};
  },
 };
}
