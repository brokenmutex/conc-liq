import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {pilotIntentSchema,verifyPilotSignature,type PilotIntent} from '../../live-pilot/journal.js';
import type {RangeKeeperConfig} from './config.js';

/** The signer has no RPC or broadcast capability. The controller must persist
 * the exact EIP-1559 intent before invoking signIntent. */
export function loadRangeKeeperSigner(config:RangeKeeperConfig,baseDirectory:string){
 assert(config.operator&&config.signer?.kind==='env_file','RangeKeeper signer is not configured');
 const path=resolve(baseDirectory,config.signer.reference);
 let account:ReturnType<typeof privateKeyToAccount>;
 try{
  const stat=statSync(path);assert(stat.isFile()&&(stat.mode&0o077)===0,'Key file must be private');
  const values=parseEnv(readFileSync(path,'utf8')),value=values[config.signer.variable]?.trim();
  assert(value&&/^(0x)?[0-9a-fA-F]{64}$/.test(value));
  account=privateKeyToAccount((value.startsWith('0x')?value:`0x${value}`) as Hex);
 }catch{throw new Error('Cannot load RangeKeeper key: check private file permissions and configured variable');}
 assert.equal(account.address.toLowerCase(),config.operator.toLowerCase(),'Signer differs from frozen operator');
 return {address:account.address,async signIntent(input:PilotIntent){
  const intent=pilotIntentSchema.parse(input);
  assert.equal(intent.operator.toLowerCase(),account.address.toLowerCase());
  assert.equal(intent.chainId,config.pool.chainId);
  const raw=await account.signTransaction({type:'eip1559',chainId:intent.chainId,nonce:intent.nonce,
   to:intent.to,data:intent.data as Hex,value:BigInt(intent.value),gas:BigInt(intent.gas),
   maxFeePerGas:BigInt(intent.maxFeePerGas),maxPriorityFeePerGas:BigInt(intent.maxPriorityFeePerGas)});
  return {raw,hash:await verifyPilotSignature(intent,raw)};
 }};
}
