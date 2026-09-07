import pg from "pg";
import { z } from "zod";
import { assertSchemaReady } from "../storage/compatibility.js";
import type { PerpBasisAssessment, PerpBasisSource } from "./domain.js";

const { Pool } = pg;

const unsignedDecimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u);
const integer = z.string().regex(/^\d+$/u);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);

const tokenSchema = z.object({
  effectiveAt: integer,
  newUIMultiplier: integer,
  oraclePaused: z.boolean(),
  uiMultiplier: integer,
});

const assetSchema = z.object({
  flags: z.object({
    corporateActionPending: z.boolean(),
    multiplierConsistent: z.boolean(),
    registryActive: z.boolean(),
    tradingCapabilitiesComplete: z.boolean(),
    tradingCapabilitiesTradable: z.boolean(),
  }),
  onchain: tokenSchema.nullable(),
  registry: z.object({
    address: z.string().min(1),
    currentMultiplier: unsignedDecimal,
    pendingMultiplier: z.string().nullable(),
  }),
});

const quoteOracleSchema = z.object({
  feed: z.object({
    address: z.string().min(1),
    baseAsset: z.string().min(1),
    decimals: z.number().int().min(0).max(255),
    heartbeatSeconds: z.number().int().positive(),
    quoteAsset: z.string().min(1),
  }),
  flags: z.object({
    decimalsMatch: z.boolean(),
    descriptionMatches: z.boolean(),
    roundComplete: z.boolean(),
    timestampNotFuture: z.boolean(),
  }).nullable(),
  state: z.object({
    answer: z.string().regex(/^-?\d+$/u),
    answeredInRound: integer,
    decimals: z.number().int().min(0).max(255),
    roundId: integer,
    updatedAt: integer,
  }).nullable(),
});

const perpSnapshotSchema = z.object({
  context: z.object({
    markPrice: unsignedDecimal,
    midPrice: unsignedDecimal.nullable(),
  }),
  metrics: z.object({ oraclePriceX18: integer }),
  reasons: z.array(z.string()),
});

interface CheckpointRow {
  asset_snapshot: unknown;
  block_hash: string;
  block_number: string;
  block_timestamp: Date;
  canonical: boolean | null;
  canonical_block_number: string | null;
  canonical_expected_hash: string | null;
  canonical_observed_hash: string | null;
  captured_at: Date;
  checkpoint_run_id: string;
  fee: number;
  liquidity: string;
  oracle_price_x18: string | null;
  pool_address: string;
  pool_price_x18: string;
  pool_reasons: unknown;
  pool_status: string;
  pool_unlocked: boolean;
  quote_oracle: unknown;
  risk_run_id: string;
  rwa_address: string;
  rwa_symbol: string;
  stream_key: string;
  token0: string;
  token1: string;
  token_address: string;
}

interface PerpRow {
  coin: string;
  dex: string;
  evidence_sha256: string;
  expected_pricing_mode: string;
  observed_at: Date;
  perp_snapshot: unknown;
  quality_pass: boolean;
  snapshot_run_id: string;
  status: string;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} is malformed`);
  }
  return value as string[];
}

function source(checkpoint: CheckpointRow, perp: PerpRow): PerpBasisSource {
  if (checkpoint.pool_status !== "valid" && checkpoint.pool_status !== "excluded") {
    throw new Error("Perp basis pool status is invalid");
  }
  if (perp.status !== "observed" && perp.status !== "quality_rejected") {
    throw new Error("Perp basis snapshot status is invalid");
  }
  if (perp.expected_pricing_mode !== "scheduled_internal_weekend" &&
      perp.expected_pricing_mode !== "external_session_expected") {
    throw new Error("Perp basis pricing mode is invalid");
  }
  hash.parse(checkpoint.block_hash);
  const asset = assetSchema.parse(checkpoint.asset_snapshot);
  const quoteParsed = checkpoint.quote_oracle === null
    ? null
    : quoteOracleSchema.parse(checkpoint.quote_oracle);
  const quote = quoteParsed?.flags === null || quoteParsed?.state === null ||
      quoteParsed === null
    ? null
    : {
        answer: quoteParsed.state.answer,
        answeredInRound: quoteParsed.state.answeredInRound,
        baseAsset: quoteParsed.feed.baseAsset,
        decimals: quoteParsed.state.decimals,
        decimalsMatch: quoteParsed.flags.decimalsMatch,
        descriptionMatches: quoteParsed.flags.descriptionMatches,
        feedAddress: quoteParsed.feed.address,
        heartbeatSeconds: quoteParsed.feed.heartbeatSeconds,
        quoteAsset: quoteParsed.feed.quoteAsset,
        roundComplete: quoteParsed.flags.roundComplete,
        roundId: quoteParsed.state.roundId,
        timestampNotFuture: quoteParsed.flags.timestampNotFuture,
        updatedAt: quoteParsed.state.updatedAt,
      };
  const perpSnapshot = perpSnapshotSchema.parse(perp.perp_snapshot);
  return {
    asset: {
      corporateActionPending: asset.flags.corporateActionPending,
      currentMultiplier: asset.registry.currentMultiplier,
      multiplierConsistent: asset.flags.multiplierConsistent,
      pendingMultiplier: asset.registry.pendingMultiplier,
      registryActive: asset.flags.registryActive,
      registryAddress: asset.registry.address,
      token: asset.onchain === null ? null : {
        effectiveAt: asset.onchain.effectiveAt,
        newUiMultiplierX18: asset.onchain.newUIMultiplier,
        oraclePaused: asset.onchain.oraclePaused,
        uiMultiplierX18: asset.onchain.uiMultiplier,
      },
      tokenAddress: checkpoint.token_address,
      tradingCapabilitiesComplete: asset.flags.tradingCapabilitiesComplete,
      tradingCapabilitiesTradable: asset.flags.tradingCapabilitiesTradable,
    },
    chain: {
      blockHash: checkpoint.block_hash,
      blockNumber: checkpoint.block_number,
      blockTimestamp: checkpoint.block_timestamp.toISOString(),
      canonical: checkpoint.canonical === true,
      canonicalBlockNumber: checkpoint.canonical_block_number,
      canonicalExpectedHash: checkpoint.canonical_expected_hash,
      canonicalObservedHash: checkpoint.canonical_observed_hash,
      capturedAt: checkpoint.captured_at.toISOString(),
      chainlinkOraclePriceX18: checkpoint.oracle_price_x18,
      checkpointRunId: checkpoint.checkpoint_run_id,
      fee: checkpoint.fee,
      liquidity: checkpoint.liquidity,
      poolAddress: checkpoint.pool_address,
      poolPriceX18: checkpoint.pool_price_x18,
      poolReasons: stringArray(checkpoint.pool_reasons, "Pool reasons"),
      poolStatus: checkpoint.pool_status,
      poolUnlocked: checkpoint.pool_unlocked,
      riskRunId: checkpoint.risk_run_id,
      rwaAddress: checkpoint.rwa_address,
      rwaSymbol: checkpoint.rwa_symbol,
      streamKey: checkpoint.stream_key,
      token0: checkpoint.token0,
      token1: checkpoint.token1,
    },
    perp: {
      coin: perp.coin,
      dex: perp.dex,
      evidenceSha256: perp.evidence_sha256,
      expectedPricingMode: perp.expected_pricing_mode,
      markPrice: perpSnapshot.context.markPrice,
      midPrice: perpSnapshot.context.midPrice,
      observedAt: perp.observed_at.toISOString(),
      oraclePriceX18: perpSnapshot.metrics.oraclePriceX18,
      qualityPass: perp.quality_pass,
      reasons: perpSnapshot.reasons,
      snapshotRunId: perp.snapshot_run_id,
      status: perp.status,
    },
    quoteOracle: quote,
  };
}

export interface PerpBasisSaveResult {
  readonly created: boolean;
  readonly runId: string;
}

export class PostgresPerpBasisStore {
  private readonly pool: InstanceType<typeof Pool>;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async assertReady(): Promise<void> {
    await assertSchemaReady(this.pool);
  }

  public async loadLatest(input: {
    readonly coin: string;
    readonly dex: string;
    readonly fee: number;
    readonly rwaSymbol: string;
    readonly streamKey: string;
  }): Promise<PerpBasisSource> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const checkpoints = await client.query<CheckpointRow>(
        `SELECT r.id::text AS checkpoint_run_id, r.risk_run_id::text,
                r.stream_key,
                r.block_number::text, r.block_hash, r.block_timestamp,
                r.captured_at, p.pool_address, p.rwa_symbol, p.rwa_address,
                p.fee, p.token0, p.token1, p.liquidity::text,
                p.pool_unlocked, p.status AS pool_status,
                p.reasons AS pool_reasons, p.pool_price_x18::text,
                p.oracle_price_x18::text, c.canonical,
                c.block_number::text AS canonical_block_number,
                c.expected_hash AS canonical_expected_hash,
                c.observed_hash AS canonical_observed_hash,
                a.token_address, a.snapshot AS asset_snapshot,
                rr.snapshot->'quoteOracle' AS quote_oracle
         FROM v3_strategy_checkpoint_runs r
         JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id = r.id
         JOIN risk_snapshot_runs rr ON rr.id = r.risk_run_id
         JOIN asset_risk_snapshots a ON a.run_id = r.risk_run_id
           AND UPPER(a.symbol) = UPPER(p.rwa_symbol)
         LEFT JOIN risk_snapshot_canonicality c ON c.risk_run_id = r.risk_run_id
         WHERE r.stream_key = $1 AND UPPER(p.rwa_symbol) = UPPER($2)
           AND p.fee = $3
         ORDER BY r.block_number DESC, r.id DESC
         LIMIT 1`,
        [input.streamKey, input.rwaSymbol, input.fee],
      );
      const checkpoint = checkpoints.rows[0];
      if (checkpoint === undefined) {
        throw new Error(`No strategy checkpoint exists for ${input.rwaSymbol}/${input.fee}`);
      }
      const perps = await client.query<PerpRow>(
        `SELECT id::text AS snapshot_run_id, dex, coin, observed_at,
                expected_pricing_mode, status, quality_pass, evidence_sha256,
                snapshot AS perp_snapshot
         FROM perp_reference_snapshot_runs
         WHERE dex = $1 AND coin = $2
         ORDER BY observed_at DESC, id DESC
         LIMIT 1`,
        [input.dex, input.coin],
      );
      const perp = perps.rows[0];
      if (perp === undefined) {
        throw new Error(`No perp snapshot exists for ${input.coin}`);
      }
      await client.query("COMMIT");
      return source(checkpoint, perp);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(assessment: PerpBasisAssessment): Promise<PerpBasisSaveResult> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO perp_pool_basis_runs (
         schema_version, checkpoint_run_id, risk_run_id, perp_snapshot_run_id,
         evaluated_at, stream_key, pool_address, rwa_symbol, fee, dex, coin,
         reference_mode, status, quality_pass, primary_reference_available,
         fallback_candidate, source_skew_seconds, checkpoint_age_seconds,
         perp_snapshot_age_seconds, quote_oracle_age_seconds,
         multiplier_x18, perp_reference_usd_x18, token_reference_usd_x18,
         usdg_usd_x18, token_reference_usdg_x18, pool_price_x18,
         chainlink_price_x18, pool_perp_deviation_ppm,
         chainlink_perp_deviation_ppm, methodology, execution_eligible,
         reasons, limitations, thresholds, snapshot
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32::jsonb,
         $33::jsonb,$34::jsonb,$35::jsonb
       ) ON CONFLICT (checkpoint_run_id, perp_snapshot_run_id, pool_address)
         DO NOTHING RETURNING id::text`,
      [
        assessment.schemaVersion,
        assessment.source.chain.checkpointRunId,
        assessment.source.chain.riskRunId,
        assessment.source.perp.snapshotRunId,
        assessment.evaluatedAt,
        assessment.source.chain.streamKey,
        assessment.source.chain.poolAddress.toLowerCase(),
        assessment.source.chain.rwaSymbol,
        assessment.source.chain.fee,
        assessment.source.perp.dex,
        assessment.source.perp.coin,
        assessment.referenceMode,
        assessment.status,
        assessment.qualityPass,
        assessment.primaryReferenceAvailable,
        assessment.fallbackCandidate,
        assessment.metrics.sourceSkewSeconds,
        assessment.metrics.checkpointAgeSeconds,
        assessment.metrics.perpSnapshotAgeSeconds,
        assessment.metrics.quoteOracleAgeSeconds,
        assessment.metrics.multiplierX18,
        assessment.metrics.perpReferenceUsdX18,
        assessment.metrics.tokenReferenceUsdX18,
        assessment.metrics.usdgUsdX18,
        assessment.metrics.tokenReferenceUsdgX18,
        assessment.metrics.poolPriceX18,
        assessment.metrics.chainlinkPriceX18,
        assessment.metrics.poolPerpDeviationPpm,
        assessment.metrics.chainlinkPerpDeviationPpm,
        assessment.methodology,
        assessment.executionEligible,
        JSON.stringify(assessment.reasons),
        JSON.stringify(assessment.limitations),
        JSON.stringify(assessment.thresholds),
        JSON.stringify(assessment),
      ],
    );
    const inserted = result.rows[0]?.id;
    if (inserted !== undefined) return { created: true, runId: inserted };
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id::text FROM perp_pool_basis_runs
       WHERE checkpoint_run_id = $1 AND perp_snapshot_run_id = $2
         AND LOWER(pool_address) = LOWER($3)`,
      [
        assessment.source.chain.checkpointRunId,
        assessment.source.perp.snapshotRunId,
        assessment.source.chain.poolAddress,
      ],
    );
    const runId = existing.rows[0]?.id;
    if (runId === undefined) throw new Error("Perp basis insert did not resolve a run ID");
    return { created: false, runId };
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
