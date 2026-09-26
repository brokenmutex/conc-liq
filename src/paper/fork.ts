import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { Hash } from "viem";
import { pace } from "../history/client.js";

export interface ForkSource { number: bigint; hash: Hash; timestamp: bigint }
export interface ReadBudget { requests:number;rejected:number;methods:Record<string,number>;maxRequests:number }
export interface ForkReadDiagnostics {
  uniqueRequestSignatures:number;duplicateRequests:number;duplicateRequestsByMethod:Record<string,number>;
  immutableReadRequests:number;duplicateImmutableReadRequests:number;
  duplicateImmutableReadsByMethod:Record<string,number>;
  prefetchHintCount:number;prefetchedFreshReads:number;prefetchSkipped:number;prefetchFailures:number;
  prefetchElapsedMs:number;
}
/** Address/slot shapes only. Values are always fetched fresh at a new pinned source. */
export type ForkReadHint = Readonly<{method:"eth_getCode";params:readonly [string,string]} |
  {method:"eth_getStorageAt";params:readonly [string,string,string]}>;
const MAX_PREFETCH_HINTS=256;
const MAX_PREFETCH_CONCURRENCY=4;
const addressPattern=/^0x[0-9a-fA-F]{40}$/u;
const slotPattern=/^0x[0-9a-fA-F]{64}$/u;

function validateForkReadHints(hints:readonly ForkReadHint[],blockTag:string):ForkReadHint[]{
  if(hints.length>MAX_PREFETCH_HINTS)throw new Error("Too many owned-fork read hints");
  const unique=new Map<string,ForkReadHint>();
  for(const hint of hints){
    if(hint.method==="eth_getCode"){
      if(!Array.isArray(hint.params)||hint.params.length!==2||!addressPattern.test(hint.params[0])||
        !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(hint.params[1]))throw new Error("Malformed owned-fork code hint");
    }else if(hint.method==="eth_getStorageAt"){
      if(!Array.isArray(hint.params)||hint.params.length!==3||!addressPattern.test(hint.params[0])||
        !slotPattern.test(hint.params[1])||!/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(hint.params[2]))
        throw new Error("Malformed owned-fork storage hint");
    }else throw new Error("Unsupported owned-fork read hint");
    const copy=(hint.method==="eth_getCode"
      ?{method:hint.method,params:[hint.params[0],blockTag] as const}
      :{method:hint.method,params:[hint.params[0],hint.params[1],blockTag] as const}) as ForkReadHint;
    unique.set(JSON.stringify([copy.method,copy.params]),copy);
  }
  return [...unique.values()];
}

export function forkReadHintKey(method:string,params:readonly unknown[]):string{
  return JSON.stringify([method,params]);
}

/** Fetches hint values anew at this source, bracketed by canonical anchors.
 * The caller owns the read budget/pacing; no values escape this invocation. */
export async function fetchFreshForkReadPrefetch(input:{source:ForkSource;hints:readonly ForkReadHint[];
 read:(method:string,params:unknown[])=>Promise<unknown>;verifyAnchor:()=>Promise<void>;
 canContinue?:()=>boolean}):Promise<{values:Map<string,string>;hintCount:number;fetched:number;
 skipped:number;failures:number;elapsedMs:number}>{
 const blockTag=`0x${input.source.number.toString(16)}`;
 const hints=validateForkReadHints(input.hints,blockTag),startedAt=Date.now();
 const values=new Map<string,string>();let fetched=0,skipped=0,failures=0;
 if(hints.length){
  await input.verifyAnchor();
  let next=0;
  const worker=async()=>{
   while(true){
    const index=next++;if(index>=hints.length)return;
    const hint=hints[index]!;
    try{
     const value=await input.read(hint.method,[...hint.params]);
     if(typeof value==="string"&&/^0x(?:[0-9a-f]{2})*$/iu.test(value)&&
       (hint.method!=="eth_getStorageAt"||value.length===66)){
      values.set(forkReadHintKey(hint.method,hint.params),value);fetched++;
     }else skipped++;
    }catch{
     failures++;
     if(input.canContinue&&!input.canContinue())throw new Error("Owned paper fork prefetch exhausted its read/time budget");
    }
   }
  };
  await Promise.all(Array.from({length:Math.min(MAX_PREFETCH_CONCURRENCY,hints.length)},()=>worker()));
  await input.verifyAnchor();
 }
 return {values,hintCount:hints.length,fetched,skipped,failures,elapsedMs:Date.now()-startedAt};
}
const stateIndex: Record<string, number> = {
  eth_getCode: 1, eth_getStorageAt: 2, eth_getBalance: 1,
  eth_getTransactionCount: 1, eth_getBlockByNumber: 0, eth_call: 1, eth_estimateGas: 1,
};
const immutableReadMethods=new Set(["eth_getCode","eth_getStorageAt","eth_getBalance","eth_getTransactionCount"]);

export function assertPinnedRead(method: string, params: readonly unknown[], source: ForkSource) {
  const index = Object.hasOwn(stateIndex, method) ? stateIndex[method] : undefined;
  if (index === undefined || params[index] !== `0x${source.number.toString(16)}`) {
    throw new Error("Only pinned read methods may reach the upstream node");
  }
}

async function unusedPort() {
  const server = createTcpServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

// All mutations terminate at an owned local Anvil process. The upstream
// transport has a separate whitelist and never forwards a send/sign method.
export async function openPaperFork(input: {
  source: ForkSource; rpcUrl: string; beforeRead: () => Promise<void>;
  maxRequests?: number; intervalMs?: number; timeoutMs?: number;
  /** Pin local Anvil time to the canonical fork point and advance one second
   * per mined block. Off by default for existing paper fork consumers. */
  deterministicClock?: boolean;
  /** Request-scoped address/slot shapes learned from an earlier owned fork. */
  prefetchHints?:readonly ForkReadHint[];
  /** Receives the bounded shapes observed during this owned fork, never values. */
  onReadHints?:(hints:readonly ForkReadHint[])=>void;
}) {
  const budget: ReadBudget = {requests:0,rejected:0,methods:{},maxRequests:input.maxRequests??400};
  const diagnostics:ForkReadDiagnostics={uniqueRequestSignatures:0,duplicateRequests:0,
    duplicateRequestsByMethod:{},immutableReadRequests:0,duplicateImmutableReadRequests:0,
    duplicateImmutableReadsByMethod:{},prefetchHintCount:0,prefetchedFreshReads:0,
    prefetchSkipped:0,prefetchFailures:0,prefetchElapsedMs:0};
  const requestSignatures=new Set<string>();
  const deadline = Date.now() + (input.timeoutMs ?? 150_000);
  const blockTag = `0x${input.source.number.toString(16)}`;
  const observedHints=new Map<string,ForkReadHint>();
  const prefetchedValues=new Map<string,unknown>();
  const hints=validateForkReadHints(input.prefetchHints??[],blockTag);
  diagnostics.prefetchHintCount=hints.length;
  const read = async (method: string, params: unknown[] = []): Promise<unknown> => {
    try { assertPinnedRead(method, params, input.source); }
    catch (error) { budget.rejected++; throw error; }
    if (Date.now() >= deadline || budget.requests >= budget.maxRequests) throw new Error("Paper fork read/time budget exhausted");
    budget.requests++;
    budget.methods[method] = (budget.methods[method] ?? 0) + 1;
    const signature=createHash("sha256").update(JSON.stringify([method,params])).digest("hex");
    if(requestSignatures.has(signature)){
      diagnostics.duplicateRequests++;
      diagnostics.duplicateRequestsByMethod[method]=(diagnostics.duplicateRequestsByMethod[method]??0)+1;
      if(immutableReadMethods.has(method)){
        diagnostics.duplicateImmutableReadRequests++;
        diagnostics.duplicateImmutableReadsByMethod[method]=(diagnostics.duplicateImmutableReadsByMethod[method]??0)+1;
      }
    }else{
      requestSignatures.add(signature);diagnostics.uniqueRequestSignatures++;
    }
    if(immutableReadMethods.has(method))diagnostics.immutableReadRequests++;
    if(method==="eth_getCode"||method==="eth_getStorageAt"){
      try{
        const hint:ForkReadHint=method==="eth_getCode"
          ?{method,params:params as unknown as readonly [string,string]}
          :{method,params:params as unknown as readonly [string,string,string]};
        const validated=validateForkReadHints([hint],blockTag)[0];
        if(validated)observedHints.set(JSON.stringify([validated.method,validated.params]),validated);
      }catch{/* Ordinary unsupported/malformed local requests are rejected below by assertPinnedRead. */}
    }
    await input.beforeRead();
    await pace(input.rpcUrl, input.intervalMs ?? 100);
    if(Date.now()>=deadline)throw new Error("Paper fork read/time budget exhausted");
    const response = await fetch(input.rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
    });
    if (!response.ok) throw new Error(`Paper upstream HTTP ${response.status}`);
    const result = await response.json() as { result?: unknown; error?: { code?: number; message?: string } };
    if (result.error) throw new Error(`Paper upstream ${method} failed (${result.error.code ?? "unknown"}): ${(result.error.message ?? "RPC error").replace(/https?:\/\/\S+/gu, "[redacted-url]").slice(0, 300)}`);
    return result.result;
  };
  const anchor=async()=>{
    const value=await read("eth_getBlockByNumber",[blockTag,false]) as {hash?:unknown;timestamp?:unknown}|null;
    if(!value||typeof value.hash!=="string"||value.hash.toLowerCase()!==input.source.hash.toLowerCase()||
      typeof value.timestamp!=="string"||BigInt(value.timestamp)!==input.source.timestamp)
      throw new Error("Owned paper fork source anchor changed");
  };
  const prefetch=async()=>{
    if(!hints.length)return;
    const result=await fetchFreshForkReadPrefetch({source:input.source,hints,read,verifyAnchor:anchor,
      canContinue:()=>Date.now()<deadline&&budget.requests<budget.maxRequests});
    for(const [key,value] of result.values)prefetchedValues.set(key,value);
    diagnostics.prefetchedFreshReads=result.fetched;diagnostics.prefetchSkipped=result.skipped;
    diagnostics.prefetchFailures=result.failures;diagnostics.prefetchElapsedMs=result.elapsedMs;
  };
  const proxy = createServer(async (request, response) => {
    let id: unknown = null;
    try {
      let raw = "";
      for await (const chunk of request) { raw += String(chunk); if (raw.length > 100_000) throw new Error("Oversized fork request"); }
      const body = JSON.parse(raw) as { id?: unknown; method: string; params?: unknown[] };
      id = body.id;
      if (Array.isArray(body)) throw new Error("Fork batch requests are unsupported");
      let result: unknown;
      if (body.method === "eth_chainId") result = "0x1237";
      else if (body.method === "net_version") result = "4663";
      else if (body.method === "eth_blockNumber") result = blockTag;
      else if (["eth_getTransactionReceipt", "eth_getTransactionByHash"].includes(body.method)) result = null;
      else {
        const params=body.params??[];
        const key=forkReadHintKey(body.method,params);
        if(Date.now()>=deadline)throw new Error("Paper fork time budget exhausted");
        if(prefetchedValues.has(key))result=prefetchedValues.get(key);
        else result = await read(body.method, params);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message: "Bounded read-only paper proxy rejected request" } }));
    }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert(address && typeof address !== "string");
  const port = await unusedPort();
  const localUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.env.ANVIL_BIN ?? "anvil", [
    "--host", "127.0.0.1", "--port", String(port), "--accounts", "0", "--chain-id", "4663",
    "--fork-url", `http://127.0.0.1:${address.port}`, "--fork-block-number", String(input.source.number),
    ...(input.deterministicClock ? ["--timestamp", String(input.source.timestamp)] : []),
    "--retries", "0", "--silent",
  ], { stdio: "ignore" });
  let spawnError = false;
  child.on("error", () => { spawnError = true; });
  const request = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error("Owned paper Anvil is not running");
    if (Date.now() >= deadline) throw new Error("Paper fork time budget exhausted");
    const response = await fetch(localUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(60_000, deadline - Date.now()))),
    });
    const result = await response.json() as { result?: T; error?: { message?: string } };
    if (result.error) throw new Error(`Local paper ${method}: ${(result.error.message ?? "RPC failure").slice(0, 300)}`);
    return result.result as T;
  };
  let deterministicTransactionIndex = 0;
  const rpc = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    if (input.deterministicClock && method === "eth_sendTransaction") {
      deterministicTransactionIndex++;
      const nextTimestamp = Number(input.source.timestamp) + deterministicTransactionIndex;
      assert(Number.isSafeInteger(nextTimestamp), "Deterministic fork timestamp exceeds safe integer range");
      await request("anvil_setNextBlockTimestamp", [nextTimestamp]);
    }
    return request<T>(method, params);
  };
  const close = async () => {
    let callbackError:unknown;
    try{
      input.onReadHints?.([...observedHints.values()].slice(0,MAX_PREFETCH_HINTS).map(hint=>
        hint.method==="eth_getCode"?{method:hint.method,params:[...hint.params] as [string,string]}:
         {method:hint.method,params:[...hint.params] as [string,string,string]}));
    }catch(error){callbackError=error;}
    try{
      if (!spawnError && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
          child.once("exit", () => { clearTimeout(timeout); resolve(); });
          child.kill("SIGTERM");
        });
      }
    }finally{
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
    if(callbackError)throw callbackError;
  };
  try {
    await prefetch();
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { ready = /anvil/iu.test(await rpc<string>("web3_clientVersion")); } catch { /* startup */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, "Owned Anvil failed to start");
    const metadata = await rpc<{ forkedNetwork?: { forkBlockNumber?: number; forkBlockHash?: string } }>("anvil_metadata");
    assert.equal(metadata.forkedNetwork?.forkBlockNumber, Number(input.source.number));
    assert.equal(metadata.forkedNetwork?.forkBlockHash?.toLowerCase(), input.source.hash.toLowerCase());
    return { rpc, read, close, source: input.source, blockTag, budget, diagnostics, localUrl };
  } catch (error) { try{await close();}catch{/* Preserve the startup failure. */} throw error; }
}
export type PaperFork = Awaited<ReturnType<typeof openPaperFork>>;
