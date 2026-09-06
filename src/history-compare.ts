import pg from "pg";
import type { Address, Hash, Hex } from "viem";
import { JsonRpcActionCostReader } from "./action-cost/reader.js";
import { createHistoricalClient, loadHistoryConfig } from "./history/client.js";
import { compareHistoricalEvents } from "./history/compare.js";
import { loadIndexerConfig } from "./indexer/config.js";
import type { IndexedV3Event, JsonValue } from "./indexer/domain.js";
import { fetchCheckpoint, fetchV3Events } from "./indexer/logs.js";
import { loadPoolManifest } from "./indexer/manifest.js";
import { log } from "./logger.js";

interface EventRow {
  chain_id: string; pool_address: Address; block_number: string; block_hash: Hash;
  transaction_hash: Hash; transaction_index: number; log_index: number;
  event_name: string; event_args: JsonValue; raw_topics: Hex[]; raw_data: Hex;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: npm run history:compare -- [--to-block N] [--blocks N]\nRead-only comparison of NVDA/500 events and at most 20 transaction fee records. Maximum 25000 blocks; default 10000. HISTORY_SOURCE=hypersync or envio required.");
    return;
  }
  const flags = new Map<string, bigint>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!["--to-block", "--blocks"].includes(flag) || flags.has(flag) ||
        !value || !/^\d+$/.test(value)) throw new Error("Invalid history comparison arguments");
    flags.set(flag, BigInt(value));
  }
  const blocks = flags.get("--blocks") ?? 10_000n;
  if (blocks < 1n || blocks > 25_000n) throw new Error("Comparison requires 1 to 25000 blocks");
  const config = loadIndexerConfig();
  const source = loadHistoryConfig(config.rpcUrl).source;
  if (source === "legacy") throw new Error("An isolated HISTORY_SOURCE is required");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const fullManifest = await loadPoolManifest(config.poolsPath);
  const pools = fullManifest.pools.filter((pool) => pool.rwaSymbol === "NVDA" && pool.fee === 500);
  if (pools.length !== 1) throw new Error("Expected exactly one verified NVDA/500 pool");
  const manifest = { ...fullManifest, pools };
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  const history = createHistoricalClient(config.rpcUrl, config.rpcTimeoutMs);
  const receipts = new JsonRpcActionCostReader({
    gate: { async assertBulkAllowed() { return null; } },
    rpcUrl: config.rpcUrl, timeoutMs: config.rpcTimeoutMs,
  });
  try {
    await db.connect();
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET LOCAL statement_timeout = '30s'");
    const boundary = await db.query<{ block_number: string; block_hash: Hash }>(
      `SELECT block_number::text, block_hash FROM indexer_checkpoints c
       WHERE stream_key=$1 AND ($2::bigint IS NULL OR block_number=$2)
       ORDER BY c.block_number DESC LIMIT 1`,
      [config.streamKey, flags.get("--to-block")?.toString() ?? null],
    );
    const stored = boundary.rows[0];
    if (!stored) throw new Error("No stored checkpoint at the requested comparison boundary");
    const toBlock = BigInt(stored.block_number);
    const fromBlock = toBlock - blocks + 1n;
    if (fromBlock < pools[0]!.createdBlock) throw new Error("Comparison starts before pool creation");
    const rows = await db.query<EventRow>(
      `SELECT chain_id::text, pool_address, block_number::text, block_hash,
         transaction_hash, transaction_index, log_index, event_name, event_args, raw_topics, raw_data
       FROM v3_pool_events e WHERE stream_key=$1 AND lower(pool_address)=lower($2)
         AND block_number BETWEEN $3 AND $4 ORDER BY e.block_number, transaction_index, log_index`,
      [config.streamKey, pools[0]!.address, fromBlock.toString(), toBlock.toString()],
    );
    await db.query("ROLLBACK");
    const expected: IndexedV3Event[] = rows.rows.map((row) => ({
      chainId: Number(row.chain_id), poolAddress: row.pool_address, blockNumber: BigInt(row.block_number),
      blockHash: row.block_hash, transactionHash: row.transaction_hash, transactionIndex: row.transaction_index,
      logIndex: row.log_index, eventName: row.event_name, args: row.event_args, topics: row.raw_topics, data: row.raw_data,
    }));
    if (expected.length === 0) throw new Error("Comparison window has no stored NVDA events");
    const actual: IndexedV3Event[] = [];
    for (let from = fromBlock; from <= toBlock; from += 5_000n) {
      const end = from + 4_999n < toBlock ? from + 4_999n : toBlock;
      actual.push(...await fetchV3Events(history, manifest, from, end));
    }
    compareHistoricalEvents(expected, actual);
    const checkpoint = await fetchCheckpoint(history, toBlock);
    if (checkpoint.number !== toBlock || checkpoint.hash.toLowerCase() !== stored.block_hash.toLowerCase()) {
      throw new Error("Historical checkpoint differs from stored chain hash");
    }
    const sampled = new Map(actual.map((event) => [event.transactionHash, event]));
    let transactions = 0;
    let calldataBytes = 0;
    let l1GasPresent = 0;
    for (const event of [...sampled.values()].slice(0, 20)) {
      const raw = await receipts.read(event.transactionHash, event.blockNumber);
      if (raw.chainId !== manifest.chainId || raw.blockNumber !== event.blockNumber ||
          raw.blockHash.toLowerCase() !== event.blockHash.toLowerCase() ||
          raw.transactionIndex !== event.transactionIndex || raw.status !== "success") {
        throw new Error("Historical transaction/receipt does not match indexed inclusion");
      }
      transactions += 1;
      calldataBytes += (raw.input.length - 2) / 2;
      if (raw.gasUsedForL1 !== null) l1GasPresent += 1;
    }
    log("info", "historical_comparison_passed", {
      source: source === "hypersync" ? "envio_hypersync" : "envio_hyperrpc", poolAddress: pools[0]!.address, fromBlock, toBlock,
      blockHash: checkpoint.hash, events: actual.length, transactions, calldataBytes,
      receiptsWithL1Gas: l1GasPresent, privateNodeRequests: 0, databaseWrites: 0,
      executionEligible: false,
    });
  } finally { await db.end(); }
}

main().catch((error: unknown) => {
  log("error", "historical_comparison_failed", { error });
  process.exitCode = 1;
});
