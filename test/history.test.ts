import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hash } from "viem";
import { createRobinhoodClient, type RobinhoodClient } from "../src/client.js";
import {
  createHistoryFetch, historyRequestTarget, HISTORY_TRANSPORT_URL, loadHistoryConfig,
} from "../src/history/client.js";
import { compareHistoricalEvents } from "../src/history/compare.js";
import type { IndexedV3Event } from "../src/indexer/domain.js";
import { loadIndexerConfig } from "../src/indexer/config.js";
import { fetchV3Events } from "../src/indexer/logs.js";
import { loadPoolManifest } from "../src/indexer/manifest.js";
import { runBackfill } from "../src/indexer/runner.js";
import type { PostgresEventStore } from "../src/indexer/store.js";

const liveUrl = "http://live.invalid:8547";
const config = loadHistoryConfig(liveUrl, { HISTORY_SOURCE: "envio", ENVIO_API_TOKEN: "secret-token", HISTORY_REQUEST_INTERVAL_MS: "0" });
const blockHash = `0x${"11".repeat(32)}` as Hash;
const event: IndexedV3Event = {
  args: { amount0: "100", amount1: "-20" }, blockHash, blockNumber: 100n,
  chainId: 4663, data: "0x1122", eventName: "Swap", logIndex: 3,
  poolAddress: "0x1111111111111111111111111111111111111111", topics: [blockHash],
  transactionHash: `0x${"22".repeat(32)}`, transactionIndex: 1,
};
function request(method: string, params: unknown[] = []): RequestInit {
  return { method: "POST", body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }) };
}

describe("historical provider isolation", () => {
  it("requires explicit enablement and refuses the live host as a historical provider", () => {
    assert.equal(loadHistoryConfig(liveUrl, {}).source, "legacy");
    assert.throws(() => loadHistoryConfig(liveUrl, { HISTORY_SOURCE: "envio" }), /requires/);
    assert.throws(() => loadHistoryConfig(liveUrl, {
      HISTORY_SOURCE: "envio", ENVIO_API_TOKEN: "token", RH_ARCHIVE_RPC_URL: "http://live.invalid:9999",
    }), /separate/);
    assert.throws(() => loadHistoryConfig(liveUrl, {
      HISTORY_SOURCE: "envio", RH_HISTORY_RPC_URL: "http://live.invalid/token",
    }), /separate/);
  });

  it("sends logs and receipt batches to Envio, verifying the chain once per transport", async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    const routed = createHistoryFetch(config, async (url, init) => {
      urls.push(String(url));
      const body = JSON.parse(String(init?.body));
      if (Array.isArray(body)) {
        methods.push(...body.map((item) => item.method));
        return Response.json(body.map((item) => ({ id: item.id, result: {} })));
      }
      methods.push(body.method);
      return Response.json({ id: body.id, result: body.method === "eth_chainId" ? "0x1237" : [] });
    });
    await routed(HISTORY_TRANSPORT_URL, request("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]));
    await routed(HISTORY_TRANSPORT_URL, { body: JSON.stringify([
      { id: 1, method: "eth_getTransactionByHash", params: [event.transactionHash] },
      { id: 2, method: "eth_getTransactionReceipt", params: [event.transactionHash] },
    ]) });
    assert.deepEqual(methods, ["eth_chainId", "eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
    assert(urls.every((url) => url === config.historyUrl));
  });

  it("does no network I/O for missing archive state or unsupported/signing methods", async () => {
    let calls = 0;
    const routed = createHistoryFetch(config, async () => { calls += 1; throw new Error(); });
    for (const method of ["eth_call", "eth_getCode", "eth_sendRawTransaction", "eth_estimateGas", "constructor"]) {
      await assert.rejects(routed(HISTORY_TRANSPORT_URL, request(method, [{}, "0x64"])));
    }
    assert.equal(calls, 0);
  });

  it("requires pinned state, verifies the archive chain, and never mixes endpoint batches", async () => {
    const archive = { ...config, archiveUrl: "https://archive.invalid/token" };
    assert.equal(historyRequestTarget(archive, { method: "eth_call", params: [{}, "0x64"] }), archive.archiveUrl);
    for (const tag of ["latest", "pending", undefined]) {
      assert.throws(() => historyRequestTarget(archive, { method: "eth_call", params: [{}, tag] }), /explicit block/);
    }
    const urls: string[] = [];
    const routed = createHistoryFetch(archive, async (url) => {
      urls.push(String(url)); return Response.json({ result: "0x1" });
    });
    await assert.rejects(routed(HISTORY_TRANSPORT_URL, request("eth_call", [{}, "0x64"])), /chain ID mismatch/);
    assert.deepEqual(urls, [archive.archiveUrl]);
    await assert.rejects(routed(HISTORY_TRANSPORT_URL, { body: JSON.stringify([
      { method: "eth_call", params: [{}, "0x64"] }, { method: "eth_getLogs", params: [{}] },
    ]) }), /Mixed/);
    assert.equal(urls.length, 1);
  });

  it("does not fall back or expose credentials through provider, transport, or viem errors", async () => {
    for (const mode of ["network", "http", "rpc"]) {
      let calls = 0;
      const routed = createHistoryFetch(config, async (url, init) => {
        calls += 1;
        assert.equal(url, config.historyUrl);
        const body = JSON.parse(String(init?.body));
        if (body.method === "eth_chainId") return Response.json({ result: "0x1237" });
        if (mode === "network") throw new Error(`failed ${config.historyUrl}`);
        if (mode === "http") return new Response(config.historyUrl, { status: 403 });
        return Response.json({ error: { code: -1, message: config.historyUrl } });
      });
      const client = createRobinhoodClient(HISTORY_TRANSPORT_URL, 1000, { fetchFn: routed, retryCount: 0 });
      await assert.rejects(client.getBlockNumber(), (error: Error) => {
        assert(!JSON.stringify(error).includes("secret-token"));
        assert(!error.message.includes("secret-token"));
        return true;
      });
      assert.equal(calls, 2);
    }
  });

  it("recovers from rate limiting and bounds retries without switching providers", async () => {
    for (const recover of [true, false]) {
      let requests = 0;
      const routed = createHistoryFetch(config, async (url, init) => {
        assert.equal(url, config.historyUrl);
        const body = JSON.parse(String(init?.body));
        if (body.method === "eth_chainId") return Response.json({ result: "0x1237" });
        requests += 1;
        if (recover && requests === 2) return Response.json({ result: "0x64" });
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      });
      if (recover) {
        const response = await routed(HISTORY_TRANSPORT_URL, request("eth_blockNumber"));
        assert.deepEqual(await response.json(), { result: "0x64" });
        assert.equal(requests, 2);
      } else {
        await assert.rejects(routed(HISTORY_TRANSPORT_URL, request("eth_blockNumber")), /HTTP 429/);
        assert.equal(requests, 3);
      }
    }
  });
});

describe("historical data verification", () => {
  it("compares complete event contents and rejects omissions, duplicates, or changed inclusion", () => {
    compareHistoricalEvents([event], [{ ...event, args: { amount1: "-20", amount0: "100" } }]);
    const mismatches: IndexedV3Event[][] = [[], [event, event], [{ ...event, data: "0xabcd" }],
      [{ ...event, blockHash: event.transactionHash }], [{ ...event, args: { amount0: "101" } }]];
    for (const actual of mismatches) {
      assert.throws(() => compareHistoricalEvents([event], actual), /mismatch|Duplicate/);
    }
  });

  it("fails before any database mutation on provider lag or chain disagreement", async () => {
    const manifest = await loadPoolManifest("config/indexer-pools.json");
    let mutations = 0;
    const store = new Proxy({}, { get() { return async () => { mutations += 1; }; } }) as PostgresEventStore;
    function client(hash: Hash): RobinhoodClient {
      return { async getBlock() { return { number: 100n, hash, parentHash: hash, timestamp: 1n }; } } as unknown as RobinhoodClient;
    }
    await assert.rejects(runBackfill(client(blockHash), manifest, loadIndexerConfig({}), {
      dryRun: false, toBlock: 100n, liveClient: client(event.transactionHash),
    }, store), /disagrees/);
    assert.equal(mutations, 0);
    await assert.rejects(runBackfill({ async getBlock() { throw new Error("provider lag"); } } as unknown as RobinhoodClient,
      manifest, loadIndexerConfig({}), { dryRun: false, toBlock: 100n, liveClient: client(blockHash) }, store), /provider lag/);
    assert.equal(mutations, 0);
  });

  it("rejects removed, out-of-range, and duplicate provider logs", async () => {
    const manifest = await loadPoolManifest("config/indexer-pools.json");
    const entry = { ...event, address: manifest.pools[0]!.address, removed: false };
    for (const logs of [[{ ...entry, removed: true }], [{ ...entry, blockNumber: 101n }], [entry, entry]]) {
      const client = { async getLogs() { return logs; } } as unknown as RobinhoodClient;
      await assert.rejects(fetchV3Events(client, manifest, 100n, 100n), /removed|outside|duplicate/);
    }
  });
});
