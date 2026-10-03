import assert from 'node:assert/strict';
import {lstatSync,readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {parseEnv} from 'node:util';
import {isAddress,keccak256,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {pilotIntentSchema,verifyPilotSignature,type PilotIntent} from '../live-pilot/journal.js';

const URL_TEXT=/\b(?:https?|wss?|postgres(?:ql)?):\/\/\S+/gi;
/** Bounded, credential-free text for logs. URLs and any caller-supplied secret are removed. */
export function redactLiveWorkerText(value:unknown,secrets:readonly string[]=[],max=240):string{
 let text=value instanceof Error?value.message:typeof value==='string'?value:'unknown';
 text=text.replace(URL_TEXT,'[redacted-url]');
 for(const secret of secrets)if(secret.length>=8)text=text.split(secret).join('[redacted]');
 return text.slice(0,max);
}

/** Config-free adaptation of the RangeKeeper env-file signer for the shared
 * wallet worker. The key must be a private regular file and its derived address
 * must equal the configured operator wallet. The signer has no RPC or
 * broadcast capability and returns only the signed raw transaction; callers
 * (the queue) persist the exact bytes before any publisher sees them. */
export function loadLiveWorkerSigner(input:{file:string;variable:string;wallet:string}){
 assert(isAbsolute(input.file),'Signer file path must be absolute');
 assert(isAddress(input.wallet),'A configured operator wallet is required');
 assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.variable),'Signer variable name is invalid');
 let account:ReturnType<typeof privateKeyToAccount>;
 try{
  // lstat: a symlink is not a regular private file even if its target is.
  const stat=lstatSync(input.file);assert(stat.isFile()&&(stat.mode&0o077)===0,'Key file must be private');
  const value=parseEnv(readFileSync(input.file,'utf8'))[input.variable]?.trim();
  assert(value&&/^(0x)?[0-9a-fA-F]{64}$/.test(value));
  account=privateKeyToAccount((value.startsWith('0x')?value:`0x${value}`) as Hex);
 }catch{throw new Error('Cannot load live signer key: check private file permissions and configured variable');}
 assert.equal(account.address.toLowerCase(),input.wallet.toLowerCase(),'Signer differs from configured operator wallet');
 return {address:account.address,async signIntent(raw:PilotIntent):Promise<Hex>{
  const intent=pilotIntentSchema.parse(raw);
  assert.equal(intent.operator.toLowerCase(),account.address.toLowerCase(),'Intent operator differs from signer');
  const signed=await account.signTransaction({type:'eip1559',chainId:intent.chainId,nonce:intent.nonce,
   to:intent.to,data:intent.data as Hex,value:BigInt(intent.value),gas:BigInt(intent.gas),
   maxFeePerGas:BigInt(intent.maxFeePerGas),maxPriorityFeePerGas:BigInt(intent.maxPriorityFeePerGas),accessList:[]});
  // Exact envelope and recovered sender must match the persisted intent before the bytes can be stored.
  assert.equal(await verifyPilotSignature(intent,signed),keccak256(signed));
  return signed;
 }};
}
