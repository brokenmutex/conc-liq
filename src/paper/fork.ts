import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { Hash } from "viem";
import { pace } from "../history/client.js";

export interface ForkSource { number: bigint; hash: Hash; timestamp: bigint }
export interface ReadBudget { requests: number; rejected: number; methods: Record<string, number>; maxRequests: number }
const stateIndex: Record<string, number> = {
  eth_getCode: 1, eth_getStorageAt: 2, eth_getBalance: 1,
  eth_getTransactionCount: 1, eth_getBlockByNumber: 0, eth_call: 1, eth_estimateGas: 1,
};

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
}) {
  const budget: ReadBudget = { requests: 0, rejected: 0, methods: {}, maxRequests: input.maxRequests ?? 400 };
  const deadline = Date.now() + (input.timeoutMs ?? 150_000);
  const blockTag = `0x${input.source.number.toString(16)}`;
  const read = async (method: string, params: unknown[] = []): Promise<unknown> => {
    try { assertPinnedRead(method, params, input.source); }
    catch (error) { budget.rejected++; throw error; }
    if (Date.now() >= deadline || budget.requests >= budget.maxRequests) throw new Error("Paper fork read/time budget exhausted");
    budget.requests++;
    budget.methods[method] = (budget.methods[method] ?? 0) + 1;
    await input.beforeRead();
    await pace(input.rpcUrl, input.intervalMs ?? 100);
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
      else result = await read(body.method, body.params ?? []);
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
    "--retries", "0", "--silent",
  ], { stdio: "ignore" });
  let spawnError = false;
  child.on("error", () => { spawnError = true; });
  const rpc = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
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
  const close = async () => {
    if (!spawnError && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
        child.once("exit", () => { clearTimeout(timeout); resolve(); });
        child.kill("SIGTERM");
      });
    }
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  };
  try {
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
    return { rpc, read, close, source: input.source, blockTag, budget, localUrl };
  } catch (error) { await close(); throw error; }
}
export type PaperFork = Awaited<ReturnType<typeof openPaperFork>>;
