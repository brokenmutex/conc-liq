import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { encodeFunctionData, decodeEventLog, parseAbi, type Address, type Hash, type Hex } from "viem";
import { createRobinhoodClient } from "./client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { loadPoolManifest } from "./indexer/manifest.js";
import { parseGuardedCanaryCli } from "./canary-plan/config.js";
import { PostgresGuardedCanaryPlanStore } from "./canary-plan/store.js";
import { ViemGuardedCanaryReader } from "./canary-plan/reader.js";
import { buildGuardedCanaryDraft } from "./canary-plan/evaluate.js";
import { buildCanaryExit, decodeCanaryExit, readCanaryPosition } from "./canary-plan/exit.js";
import { NONFUNGIBLE_POSITION_MANAGER } from "./constants.js";
import { PostgresRpcHealthGate } from "./rpc-health/store.js";
import { loadRpcHealthGateConfig } from "./rpc-health/config.js";
import { pace } from "./history/client.js";
import { sanitizeRiskError } from "./risk/evaluate.js";

const erc20 = parseAbi([
  "function transfer(address to,uint256 amount) returns (bool)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);
const nftEvents = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"]);
const json = (value: unknown) => JSON.stringify(value, (_key, entry: unknown) => typeof entry === "bigint" ? entry.toString() : entry, 2);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedLocalPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing local port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function main(): Promise<void> {
  const options = parseGuardedCanaryCli(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run canary:rehearse -- <same explicit policy flags as canary:plan>\nCreates an owned local Anvil fork, uses simulated funding, and writes data/canary-rehearsal.json. No live transactions. Requires ANVIL_BIN or anvil in PATH.");
    return;
  }
  if (!options.operator || options.budgetQuote === undefined || options.budgetCapQuote === undefined ||
      options.halfWidthSpacings === undefined || options.slippageBps === undefined || options.maxOracleDeviationPpm === undefined ||
      options.maxLiquiditySharePpm === undefined || options.ttlSeconds === undefined) throw new Error("All explicit canary policy flags are required");
  if (options.budgetQuote > 10_000_000n || options.budgetCapQuote > 10_000_000n) throw new Error("Local rehearsal is capped at 10 USDG of simulated quote value");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const indexer = loadIndexerConfig();
  const healthConfig = loadRpcHealthGateConfig();
  if (!healthConfig.enabled) throw new Error("Rehearsal requires the private-node health gate");
  const gate = new PostgresRpcHealthGate({ connectionString: process.env.DATABASE_URL, enabled: true, cacheMs: 2000, maxSampleAgeSeconds: 30 });
  const store = new PostgresGuardedCanaryPlanStore(process.env.DATABASE_URL);
  let child: ReturnType<typeof spawn> | undefined;
  let proxy: ReturnType<typeof createServer> | undefined;
  let preflightRequests = 0;
  const upstream = { requests: 0, rejected: 0, rejectedMethods: [] as string[], methods: {} as Record<string, number>, maxRequests: 600 };
  try {
    const source = await store.loadLatestSource({ fee: 500, rwaSymbol: "NVDA", streamKey: indexer.streamKey });
    const manifest = await loadPoolManifest(indexer.poolsPath);
    assert(manifest.pools.some((pool) => pool.address === source.poolAddress && pool.rwaAddress === source.rwaAddress && pool.fee === 500));
    const donor = manifest.pools.find((pool) => pool.rwaSymbol === "NVDA" && pool.fee === 3000)?.address;
    if (!donor) throw new Error("Missing separate NVDA pool for simulated fixture funding");
    const live = createRobinhoodClient(indexer.rpcUrl, indexer.rpcTimeoutMs, {
      beforeRequest: async () => { await gate.assertBulkAllowed(); preflightRequests += 1; }, retryCount: 0,
    });
    const reader = new ViemGuardedCanaryReader(live);
    const chain = await reader.readState({ operator: options.operator, source });
    const riskGate = await store.readRiskGate({ streamKey: indexer.streamKey, maxCanonicalityAgeSeconds: 30, maxSnapshotAgeSeconds: 180 });
    const rpcHealth = await gate.assertBulkAllowed();
    if (!rpcHealth) throw new Error("Missing node-health evidence");
    const entryReadiness = await store.readEntryReadiness(source.blockNumber);
    const draft = buildGuardedCanaryDraft({ chain, createdAt: new Date().toISOString(), maxCheckpointAgeSeconds: 180,
      operator: options.operator, source, riskGate, rpcHealth, entryReadiness,
      policy: { budgetQuote: options.budgetQuote, budgetCapQuote: options.budgetCapQuote, halfWidthSpacings: options.halfWidthSpacings,
        slippageBps: options.slippageBps, maxOracleDeviationPpm: options.maxOracleDeviationPpm,
        maxLiquiditySharePpm: options.maxLiquiditySharePpm, ttlSeconds: options.ttlSeconds } });
    const blockTag = `0x${source.blockNumber.toString(16)}`;
    // The fork can fetch only the pinned recent block. No mutation method is forwarded.
    const stateIndex: Record<string, number> = { eth_getCode: 1, eth_getStorageAt: 2, eth_getBalance: 1, eth_getTransactionCount: 1, eth_getBlockByNumber: 0 };
    proxy = createServer(async (request, response) => {
      try {
        let raw = "";
        for await (const chunk of request) { raw += String(chunk); if (raw.length > 100_000) throw new Error("Oversized fork request"); }
        const body = JSON.parse(raw) as { id: unknown; method: string; params?: unknown[] };
        if (Array.isArray(body) || typeof body.method !== "string") throw new Error("Invalid fork request");
        let result: unknown;
        if (body.method === "eth_chainId") result = "0x1237";
        else if (body.method === "net_version") result = "4663";
        else if (body.method === "eth_blockNumber") result = blockTag;
        // Pending local transaction lookups can fall through Anvil's fork backend.
        // They cannot exist upstream; return not-found without a network request.
        else if (body.method === "eth_getTransactionReceipt" || body.method === "eth_getTransactionByHash") result = null;
        else {
          const index = Object.hasOwn(stateIndex, body.method) ? stateIndex[body.method] : undefined;
          if (index === undefined || body.params?.[index] !== blockTag) { upstream.rejected += 1; upstream.rejectedMethods.push(body.method); throw new Error("Unpinned or unsupported fork request"); }
          if (upstream.requests >= upstream.maxRequests) throw new Error("Fork read cap exceeded");
          upstream.requests += 1;
          upstream.methods[body.method] = (upstream.methods[body.method] ?? 0) + 1;
          await gate.assertBulkAllowed();
          await pace(indexer.rpcUrl, 100);
          const remote = await fetch(indexer.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "error" });
          if (!remote.ok) throw new Error("Fork upstream HTTP failure");
          const decoded = await remote.json() as { error?: unknown; result?: unknown };
          if (decoded.error) throw new Error("Fork upstream RPC failure");
          result = decoded.result;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Read-only fork proxy rejected request" } }));
      }
    });
    await new Promise<void>((resolve) => proxy!.listen(0, "127.0.0.1", resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Missing proxy port");
    const port = await unusedLocalPort();
    const localUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.env.ANVIL_BIN ?? "anvil", ["--host", "127.0.0.1", "--port", String(port), "--accounts", "0", "--chain-id", "4663",
      "--fork-url", `http://127.0.0.1:${proxyAddress.port}`, "--fork-block-number", source.blockNumber.toString(), "--retries", "0", "--silent"], { stdio: "ignore" });
    let spawnError = false;
    child.on("error", () => { spawnError = true; });
    async function localRpc(method: string, params: unknown[] = []): Promise<unknown> {
      if (spawnError || !child || child.exitCode !== null || child.signalCode !== null) throw new Error("Owned local Anvil process is not running");
      const response = await fetch(localUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(120000) });
      const body = await response.json() as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(`Local rehearsal ${method}: ${body.error.message ?? "RPC error"}`);
      return body.result;
    }
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { const version = await localRpc("web3_clientVersion"); ready = typeof version === "string" && /anvil/iu.test(version); } catch { /* startup */ }
      if (ready) break;
      await sleep(250);
    }
    if (!ready) throw new Error("Local Anvil did not start");
    const metadata = await localRpc("anvil_metadata") as { forkedNetwork?: { forkBlockNumber?: number; forkBlockHash?: string } };
    assert.equal(metadata.forkedNetwork?.forkBlockNumber, Number(source.blockNumber));
    assert.equal(metadata.forkedNetwork?.forkBlockHash?.toLowerCase(), source.blockHash.toLowerCase());
    const local = createRobinhoodClient(localUrl, 120000, { retryCount: 0 });
    const operator = options.operator;
    const receipts: { action: string; hash: Hash; gasUsed: bigint; effectiveGasPrice: bigint }[] = [];
    async function send(action: string, from: Address, to: Address, data: Hex, record = true) {
      const hash = await localRpc("eth_sendTransaction", [{ from, to, data, gas: "0x7a1200" }]) as Hash;
      const receipt = await local.waitForTransactionReceipt({ hash, pollingInterval: 50, timeout: 120000 });
      assert.equal(receipt.status, "success", `Local ${action} reverted`);
      if (record) receipts.push({ action, hash, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice });
      return receipt;
    }
    await localRpc("anvil_impersonateAccount", [donor]);
    await localRpc("anvil_impersonateAccount", [operator]);
    await localRpc("anvil_setBalance", [donor, "0x56bc75e2d63100000"]);
    await localRpc("anvil_setBalance", [operator, "0x56bc75e2d63100000"]);
    for (const [token, amount] of [[source.token0, BigInt(draft.transaction.amount0Desired)], [source.token1, BigInt(draft.transaction.amount1Desired)]] as const) {
      const balance = await local.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [donor] });
      assert(balance >= amount, "Insufficient simulated donor balance");
      await send("fixture_funding", donor, token, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [operator, amount] }), false);
    }
    async function balances() {
      return Promise.all([local.readContract({ address: source.token0, abi: erc20, functionName: "balanceOf", args: [operator] }),
        local.readContract({ address: source.token1, abi: erc20, functionName: "balanceOf", args: [operator] }), local.getBalance({ address: operator })]);
    }
    const before = await balances();
    for (const [token, amount] of [[source.token0, BigInt(draft.transaction.amount0Desired)], [source.token1, BigInt(draft.transaction.amount1Desired)]] as const) {
      await send("approve", operator, token, encodeFunctionData({ abi: erc20, functionName: "approve", args: [NONFUNGIBLE_POSITION_MANAGER, amount] }));
    }
    const localReader = new ViemGuardedCanaryReader(local);
    const mintSimulation = await localReader.simulate({ operator, calldata: draft.transaction.calldata, blockNumber: await local.getBlockNumber({ cacheTime: 0 }) });
    assert(mintSimulation.succeeded, mintSimulation.error ?? "Mint simulation failed");
    const minted = await send("mint", operator, NONFUNGIBLE_POSITION_MANAGER, draft.transaction.calldata);
    const transfer = minted.logs.filter((log) => log.address.toLowerCase() === NONFUNGIBLE_POSITION_MANAGER.toLowerCase()).flatMap((log) => {
      try { return [decodeEventLog({ abi: nftEvents, data: log.data, topics: log.topics })]; } catch { return []; }
    }).find((event) => event.args.from === "0x0000000000000000000000000000000000000000" && event.args.to.toLowerCase() === operator.toLowerCase());
    assert(transfer, "Mint receipt has no matching NFT transfer");
    const tokenId = transfer.args.tokenId;
    assert.equal(tokenId.toString(), mintSimulation.tokenId);
    await localRpc("anvil_mine", ["0x3"]);
    const observedBlock = await local.getBlock({ blockTag: "latest" });
    const position = await readCanaryPosition(local, tokenId, observedBlock.number);
    const afterMint = await balances();
    const exit = buildCanaryExit({ operator, owner: position.owner, tokenId, source, position,
      sqrtPriceX96: chain.pool.sqrtPriceX96, blockTimestamp: observedBlock.timestamp, slippageBps: options.slippageBps, ttlSeconds: options.ttlSeconds });
    const simulatedExit = await local.call({ account: operator, to: exit.to, data: exit.calldata, blockNumber: observedBlock.number });
    assert(simulatedExit.data);
    const exitAmounts = decodeCanaryExit(simulatedExit.data);
    await send("decrease_and_collect", operator, exit.to, exit.calldata);
    for (const token of [source.token0, source.token1]) {
      await send("revoke_approval", operator, token, encodeFunctionData({ abi: erc20, functionName: "approve", args: [NONFUNGIBLE_POSITION_MANAGER, 0n] }));
      assert.equal(await local.readContract({ address: token, abi: erc20, functionName: "allowance", args: [operator, NONFUNGIBLE_POSITION_MANAGER] }), 0n);
    }
    const finalPosition = await readCanaryPosition(local, tokenId, await local.getBlockNumber({ cacheTime: 0 }));
    const afterExit = await balances();
    assert.equal(finalPosition.liquidity, 0n); assert.equal(finalPosition.tokensOwed0, 0n); assert.equal(finalPosition.tokensOwed1, 0n);
    assert.equal(afterExit[0]! - afterMint[0]!, exitAmounts.collected0);
    assert.equal(afterExit[1]! - afterMint[1]!, exitAmounts.collected1);
    const gasCost = receipts.reduce((sum, receipt) => sum + receipt.gasUsed * receipt.effectiveGasPrice, 0n);
    assert.equal(before[2]! - afterExit[2]!, gasCost);
    const terminal = await live.getBlock({ blockNumber: source.blockNumber });
    assert.equal(terminal.hash, source.blockHash);
    const evidence = { completedAt: new Date().toISOString(), executionEligible: false, broadcastAuthorized: false,
      scope: "local_anvil_mint_observe_decrease_collect", source: draft.source, policy: draft.policy, operator,
      livePreflightReasons: draft.reasons, entryReadiness, mintTransaction: draft.transaction, mintSimulation,
      tokenId, position, exit, exitAmounts, finalPosition, balances: { before, afterMint, afterExit }, receipts,
      localEvmGasCostWei: gasCost, upstream, preflightRequests, totalPrivateReadRequests: preflightRequests + upstream.requests,
      limitations: ["simulated token funding from a different pool on the local fork only", "no swaps during the observation window; no fee-accrual or adverse-selection result", "local EVM gas excludes Robinhood L1 data fees and is not a live cost measurement", "does not approve the live operator, policy, or current market conditions"] };
    await mkdir("data", { recursive: true });
    await writeFile("data/canary-rehearsal.json", json(evidence) + "\n");
    console.log(json({ event: "canary_local_lifecycle_passed", sourceBlock: source.blockNumber, tokenId, upstream, livePreflightReasons: draft.reasons, localEvmGasCostWei: gasCost, evidencePath: "data/canary-rehearsal.json" }));
  } finally {
    child?.kill("SIGTERM");
    if (proxy) { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy!.close(() => resolve())); }
    await store.close(); await gate.close();
  }
}
main().catch((error: unknown) => { console.error(sanitizeRiskError(error)); process.exitCode = 1; });
