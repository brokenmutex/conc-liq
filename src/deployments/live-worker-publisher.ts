import assert from 'node:assert/strict';
import {keccak256,type Hex} from 'viem';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {redactLiveWorkerText} from './live-worker-signer.js';

type Rpc=(method:string,params:unknown[])=>Promise<unknown>;
const ALREADY_KNOWN=/already known|known transaction|already imported|already exists/i;

function jsonRpc(url:string,timeoutMs:number,fetchImpl:typeof fetch):Rpc{
 let id=0;
 return async(method,params)=>{
  let response:Response;
  // Transport errors can embed the credentialed endpoint; surface only a redacted code.
  try{response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},redirect:'error',
   body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(timeoutMs)});}
  catch(error){throw new Error(`broadcast_rpc_unreachable:${redactLiveWorkerText(error instanceof Error?error.name:'error',[url],40)}`);}
  if(!response.ok)throw new Error(`broadcast_rpc_http_${response.status}`);
  let body:{result?:unknown;error?:{code?:unknown;message?:unknown}};
  try{body=await response.json() as typeof body;}catch{throw new Error('broadcast_rpc_response_invalid');}
  if(body.error)throw new Error(`broadcast_rpc_error:${redactLiveWorkerText(body.error.message,[url],160)}`);
  return body.result;
 };
}

/** Startup read-only proof that the independent publisher endpoint serves the expected chain. */
export async function assertLiveWorkerBroadcastChain(input:{url:string;timeoutMs?:number;fetchImpl?:typeof fetch}){
 const result=await jsonRpc(input.url,input.timeoutMs??12_000,input.fetchImpl??fetch)('eth_chainId',[]);
 assert(typeof result==='string'&&/^0x[0-9a-fA-F]+$/.test(result)&&BigInt(result)===BigInt(ROBINHOOD_CHAIN_ID),
  'Broadcast endpoint is on the wrong chain');
}

/** Publishes already-persisted signed bytes with eth_sendRawTransaction and
 * rejects any acknowledgement whose hash differs from keccak256(raw). A node
 * that already holds these exact bytes is accepted as idempotent success: the
 * hash is content-defined, so it can only be this transaction. */
export function createLiveWorkerPublisher(input:{url:string;timeoutMs?:number;fetchImpl?:typeof fetch}){
 const rpc=jsonRpc(input.url,input.timeoutMs??15_000,input.fetchImpl??fetch);
 return async(raw:Hex):Promise<Hex>=>{
  assert(typeof raw==='string'&&/^0x(?:[0-9a-fA-F]{2})+$/.test(raw),'Raw transaction is malformed');
  const expected=keccak256(raw);
  let result:unknown;
  try{result=await rpc('eth_sendRawTransaction',[raw]);}
  catch(error){
   if(error instanceof Error&&error.message.startsWith('broadcast_rpc_error:')&&ALREADY_KNOWN.test(error.message))return expected;
   throw error;
  }
  if(typeof result!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(result)||result.toLowerCase()!==expected.toLowerCase())
   throw new Error('publisher_hash_differs_from_raw');
  return result as Hex;
 };
}
