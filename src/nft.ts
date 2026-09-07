import { z } from "zod";
import { createHistoricalClient } from "./history/client.js";
import { loadIndexerConfig } from "./indexer/config.js";
import { log } from "./logger.js";
import { collectNftPositionSnapshots } from "./nft/collector.js";
import {
  NftAccountingRunUnavailableError,
  PostgresNftPositionStore,
} from "./nft/store.js";

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NFT_POSITION_TOKEN_IDS: z.string().optional(),
});

interface CliOptions {
  readonly accountingRunId?: string;
  readonly help: boolean;
  readonly ifConfigured: boolean;
  readonly tokenIds: readonly string[];
}

function requireId(value: string | undefined, flag: string): string {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return value;
}

function parseCli(arguments_: readonly string[]): CliOptions {
  let accountingRunId: string | undefined;
  let help = false;
  let ifConfigured = false;
  const tokenIds: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    switch (argument) {
      case "--accounting-run":
        if (accountingRunId !== undefined) {
          throw new Error("--accounting-run supplied twice");
        }
        accountingRunId = requireId(arguments_[index + 1], argument);
        index += 1;
        break;
      case "--token-id":
        tokenIds.push(requireId(arguments_[index + 1], argument));
        index += 1;
        break;
      case "--if-configured":
        if (ifConfigured) throw new Error("--if-configured supplied twice");
        ifConfigured = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { accountingRunId, help, ifConfigured, tokenIds };
}

function parseEnvironmentTokenIds(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((entry) =>
    requireId(entry.trim(), "NFT_POSITION_TOKEN_IDS")
  );
}

function printHelp(): void {
  console.log(`Usage: npm run nft:snapshot -- [options]

Captures exact principal and fee state for configured Uniswap V3 Position
Manager NFT token IDs at an immutable accounting checkpoint.

Options:
  --token-id ID          Token ID to monitor; repeatable and overrides the env list
  --accounting-run ID    Exact accounting checkpoint; defaults to newest
  --if-configured        Exit successfully when no token IDs are configured
  -h, --help             Show this help

Environment:
  DATABASE_URL           Required PostgreSQL database
  NFT_POSITION_TOKEN_IDS Comma-separated positive token IDs
  RH_INDEXER_RPC_URL     Private RPC used for block-pinned contract reads
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const environment = environmentSchema.parse(process.env);
  const configured = options.tokenIds.length > 0
    ? options.tokenIds
    : parseEnvironmentTokenIds(environment.NFT_POSITION_TOKEN_IDS);
  const unique = [...new Set(configured)];
  if (unique.length !== configured.length) {
    throw new Error("NFT token IDs must be unique");
  }
  if (unique.length === 0) {
    if (options.ifConfigured) {
      log("info", "nft_position_snapshot_skipped", {
        reason: "no_token_ids_configured",
      });
      return;
    }
    throw new Error("No NFT token IDs are configured");
  }
  const indexer = loadIndexerConfig();
  const client = createHistoricalClient(indexer.rpcUrl, indexer.rpcTimeoutMs);
  const store = new PostgresNftPositionStore(environment.DATABASE_URL);
  try {
    await store.assertReady();
    let source;
    try {
      source = await store.loadSource({
        accountingRunId: options.accountingRunId,
        streamKey: indexer.streamKey,
      });
    } catch (error) {
      if (
        options.ifConfigured &&
        error instanceof NftAccountingRunUnavailableError
      ) {
        log("info", "nft_position_snapshot_skipped", {
          reason: "accounting_run_unavailable",
        });
        return;
      }
      throw error;
    }
    const snapshots = await collectNftPositionSnapshots({
      client,
      source,
      tokenIds: unique.map(BigInt),
    });
    const saved = await store.save(snapshots);
    log("info", "nft_position_snapshot_complete", {
      accountingRunId: source.run.runId,
      created: saved.created,
      existing: saved.existing,
      tokenIds: unique,
    });
    console.log(JSON.stringify(
      snapshots,
      (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value,
      2,
    ));
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  log("error", "nft_position_snapshot_failed", { error });
  process.exitCode = 1;
});
