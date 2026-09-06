import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadHistoryConfig, HISTORY_TRANSPORT_URL } from "../src/history/client.js";
import { createHyperSyncFetch, NativeHyperSync } from "../src/history/hypersync.js";

const config = loadHistoryConfig("https://live.invalid", {
  HISTORY_SOURCE: "hypersync", ENVIO_API_TOKEN: "secret-token", HISTORY_REQUEST_INTERVAL_MS: "0",
});
const hash = `0x${"11".repeat(32)}` as const;
const txHash = `0x${"22".repeat(32)}` as const;
const owner = "0x1111111111111111111111111111111111111111";
const nativeLog = { address: owner, block_number: 10, block_hash: hash, transaction_hash: txHash,
  transaction_index: 2, log_index: 3, data: "0xab", topic0: hash, topic1: null, removed: false };
const rpcRequest = (method: string, params: unknown[] = []) => ({
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});

describe("native HyperSync", () => {
  it("maps positional topic filters and follows exclusive next_block pages without omissions", async () => {
    const queries: Record<string, unknown>[] = [];
    const native = new NativeHyperSync(config, async (url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret-token");
      if (String(url).endsWith("/chain_id")) return Response.json({ chain_id: 4663 });
      const body = JSON.parse(String(init?.body)); queries.push(body);
      return Response.json(body.from_block === 10 ? {
        next_block: 11, data: [{ logs: [nativeLog] }],
        rollback_guard: { first_block_number: 10, block_number: 10, hash, first_parent_hash: hash },
      } : {
        next_block: 13, data: [{ logs: [{ ...nativeLog, block_number: 12, log_index: 4 }] }],
        rollback_guard: { first_block_number: 11, block_number: 12, hash, first_parent_hash: hash },
      });
    });
    const result = await native.logs({ fromBlock: "0xa", toBlock: "0xc", address: owner, topics: [hash, null, [txHash]] });
    assert.deepEqual(queries.map((query) => [query.from_block, query.to_block]), [[10, 13], [11, 13]]);
    assert.deepEqual(queries[0]!.logs, [{ address: [owner], topics: [[hash], [], [txHash]] }]);
    assert.deepEqual(result.map((row) => row.blockNumber), ["0xa", "0xc"]);
    assert.equal(result[0]!.transactionIndex, "0x2");
  });

  it("rejects stalled or oversized pages, out-of-page rows, and cross-page reorgs", async () => {
    for (const failure of ["stalled", "oversized", "row", "reorg"]) {
      let calls = 0;
      const native = new NativeHyperSync(config, async (url) => {
        if (String(url).endsWith("/chain_id")) return Response.json({ chain_id: 4663 });
        calls += 1;
        return Response.json({ next_block: failure === "stalled" ? 10 : failure === "oversized" ? 14 : calls === 1 ? 11 : 13,
          data: [{ logs: failure === "row" ? [{ ...nativeLog, block_number: 13 }] : [] }],
          rollback_guard: failure === "reorg" ? {
            first_block_number: calls === 1 ? 10 : 11, block_number: calls === 1 ? 10 : 12,
            hash, first_parent_hash: calls === 1 ? hash : txHash,
          } : null,
        });
      });
      await assert.rejects(native.query(10, 13, {}), /pagination|outside|reorg/);
    }
  });

  it("checks chain identity, missing metadata, and block pinning", async () => {
    const bad = new NativeHyperSync(config, async () => Response.json({ chain_id: 1 }));
    await assert.rejects(bad.chainId(), /chain ID/);
    const native = new NativeHyperSync(config, async (url) => String(url).endsWith("/chain_id")
      ? Response.json({ chain_id: 4663 }) : Response.json({ next_block: 11, data: [] }));
    await assert.rejects(native.block("latest"), /invalid unsigned/);
    await assert.rejects(native.block("0xa"), /metadata is unavailable/);
  });

  it("preserves exact native gas/calldata fields including padded hex and missing L1 gas", async () => {
    for (const l1 of ["0x0009", null]) {
      const native = new NativeHyperSync(config, async (url, init) => {
        if (String(url).endsWith("/chain_id")) return Response.json({ chain_id: 4663 });
        const body = JSON.parse(String(init?.body));
        assert.equal(body.from_block, 10); assert.equal(body.to_block, 11);
        return Response.json({ next_block: 11, data: [{ transactions: [{ block_number: 10, block_hash: hash,
          hash: txHash, transaction_index: 2, chain_id: "0x1237", from: owner, to: owner,
          input: "0xaabbccdd", status: 1, gas_used: "0x000a", gas_used_for_l1: l1,
          effective_gas_price: "0x20000000000001" }] }] });
      });
      const raw = await native.transaction(txHash, 10n);
      assert.equal(raw.input, "0xaabbccdd"); assert.equal(raw.gasUsed, 10n);
      assert.equal(raw.gasUsedForL1, l1 === null ? null : 9n);
      assert.equal(raw.effectiveGasPrice, 9007199254740993n);
    }
  });

  it("does not send unsupported, unpinned, or missing-archive reads to a provider", async () => {
    let calls = 0;
    const adapter = createHyperSyncFetch(config, async () => { calls += 1; throw new Error(); });
    for (const method of ["eth_call", "eth_getCode", "eth_sendRawTransaction", "eth_getTransactionReceipt"]) {
      await assert.rejects(adapter(HISTORY_TRANSPORT_URL, rpcRequest(method, [{}, "0xa"])));
    }
    assert.equal(calls, 0);
  });

  it("sanitizes HTTP, authentication, and network failures", async () => {
    for (const status of [403, 429, 500]) {
      const native = new NativeHyperSync(config, async () => new Response("secret-token", { status }));
      await assert.rejects(native.chainId(), (error: Error) => {
        assert.equal(error.message, `HyperSync HTTP ${status}`); return true;
      });
    }
    const native = new NativeHyperSync(config, async () => { throw new Error("secret-token"); });
    await assert.rejects(native.chainId(), /HyperSync transport failed/);
  });
});
