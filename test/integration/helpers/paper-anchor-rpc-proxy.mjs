// Narrow loopback JSON-RPC proxy for an opt-in static-paper recovery test.
// It forwards normal traffic unchanged and can replace one already-observed
// accepted anchor hash after worker restart. It never logs the upstream URL or
// request/response bodies; this is fault injection, not a canonical reorg.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

const blockNumber=value=>{
 if(typeof value!=='string'||!/^0x[0-9a-f]+$/i.test(value))return null;
 try{return BigInt(value).toString();}catch{return null;}
};
const idKey=id=>`${typeof id}:${JSON.stringify(id)}`;
const normalizedHash=value=>typeof value==='string'&&/^0x[0-9a-f]{64}$/i.test(value)?value.toLowerCase():null;

/** Start a loopback-only proxy. Set a replacement only after the accepted UI
 * operation is persisted and immediately before the restarted worker starts.
 * `hash` is the injected replacement hash; the accepted hash is learned from
 * prior normal `eth_getBlockByNumber` responses for the same block. */
export async function startProxy({rpcUrl,timeoutMs=20_000,maxBodyBytes=8*1024*1024}={}){
 assert.equal(typeof rpcUrl,'string','upstream RPC URL is required');
 const upstream=new URL(rpcUrl);
 assert(['http:','https:'].includes(upstream.protocol),'upstream RPC must use HTTP(S)');
 assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>0,'proxy timeout must be positive');
 assert(Number.isSafeInteger(maxBodyBytes)&&maxBodyBytes>0,'proxy body bound must be positive');
 let changedAnchor=null,faultCount=0;const seenHashes=new Map();
 const server=createServer(async(request,response)=>{
  if(request.method!=='POST'){
   response.writeHead(405,{'content-type':'application/json'});response.end('{"error":"method_not_allowed"}');return;
  }
  const chunks=[];let bodyBytes=0,tooLarge=false;
  try{
   for await(const chunk of request){
    bodyBytes+=chunk.length;if(bodyBytes>maxBodyBytes){tooLarge=true;break;}chunks.push(chunk);
   }
   if(tooLarge){request.resume();response.writeHead(413);response.end();return;}
   const body=Buffer.concat(chunks).toString('utf8');let payload;
   try{payload=JSON.parse(body);}catch{
    response.writeHead(400,{'content-type':'application/json'});response.end('{"error":"invalid_json"}');return;
   }
   const forwarded=await fetch(upstream,{method:'POST',headers:{'content-type':'application/json'},body,
    signal:AbortSignal.timeout(timeoutMs)});
   const text=await forwarded.text();let result;
   try{result=JSON.parse(text);}catch{
    response.writeHead(forwarded.status,{'content-type':forwarded.headers.get('content-type')??'application/json'});
    response.end(text);return;
   }
   const requests=Array.isArray(payload)?payload:[payload],responses=Array.isArray(result)?result:[result],
    byId=new Map(requests.filter(item=>item&&typeof item==='object'&&'id'in item)
     .map(item=>[idKey(item.id),item]));
   for(const rpcResponse of responses){
    if(!rpcResponse||typeof rpcResponse!=='object'||!('id'in rpcResponse)||!('result'in rpcResponse))continue;
    const rpcRequest=byId.get(idKey(rpcResponse.id));if(!rpcRequest||!Array.isArray(rpcRequest.params))continue;
    let targetResult=rpcResponse.result;
    if(!targetResult||typeof targetResult!=='object'||Array.isArray(targetResult))continue;
    if(rpcRequest.method==='eth_getBlockByNumber'){
     const requested=blockNumber(rpcRequest.params[0]),returned=blockNumber(targetResult.number);
     if(requested!==null&&requested===returned){
      const canonical=normalizedHash(targetResult.hash);
      if(changedAnchor&&requested===changedAnchor.block&&canonical&&seenHashes.get(requested)===canonical){
       targetResult.hash=changedAnchor.hash;faultCount++;
      }else if(!changedAnchor&&canonical)seenHashes.set(requested,canonical);
     }
    }else if(rpcRequest.method==='eth_getBlockByHash'&&changedAnchor&&
     normalizedHash(rpcRequest.params[0])===seenHashes.get(changedAnchor.block)&&
     blockNumber(targetResult.number)===changedAnchor.block&&
     normalizedHash(targetResult.hash)===seenHashes.get(changedAnchor.block)){
     targetResult.hash=changedAnchor.hash;faultCount++;
    }else if(rpcRequest.method==='eth_getBlockByHash'&&!changedAnchor){
     const returned=blockNumber(targetResult.number),canonical=normalizedHash(targetResult.hash);
     if(returned!==null&&canonical)seenHashes.set(returned,canonical);
    }
   }
   response.writeHead(forwarded.status,{'content-type':forwarded.headers.get('content-type')??'application/json'});
   response.end(JSON.stringify(result));
  }catch{
   if(!response.headersSent){response.writeHead(502,{'content-type':'application/json'});
    response.end('{"error":"upstream_unavailable"}');}
  }
 });
 await new Promise((resolve,reject)=>{
  const onError=error=>{server.off('listening',onListening);reject(error);};
  const onListening=()=>{server.off('error',onError);resolve();};
  server.once('error',onError);server.once('listening',onListening);server.listen(0,'127.0.0.1');
 });
 const address=server.address();assert(address&&typeof address!=='string','proxy failed to bind loopback');
 return {url:`http://127.0.0.1:${address.port}`,
  setChangedAnchor({block,hash}){
   assert(!changedAnchor,'only one changed anchor may be active');
   const normalizedBlock=typeof block==='bigint'?block.toString():String(block);
   assert(/^(0|[1-9][0-9]*)$/.test(normalizedBlock),'anchor block must be a decimal integer');
   const replacement=normalizedHash(hash);assert(replacement,'replacement hash must be 32-byte hex');
   const acceptedHash=seenHashes.get(normalizedBlock);
   assert(acceptedHash,'the proxy must observe the accepted block hash before fault injection');
   assert.notEqual(replacement,acceptedHash,'replacement must differ from the accepted hash');
   changedAnchor={block:normalizedBlock,hash:replacement};
  },
  clearChangedAnchor(){changedAnchor=null;},
  diagnostics(){return {faultCount};},
  async close(){server.closeIdleConnections?.();if(server.listening){server.close();await once(server,'close');}}
 };
}
