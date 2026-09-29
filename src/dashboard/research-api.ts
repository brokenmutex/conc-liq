import {
  RESEARCH_BUCKETS_PER_HOUR,
  RESEARCH_RETAINED_HOURS,
  RESEARCH_WINDOW_HOURS,
  type ResearchPool,
  type ResearchSnapshot,
} from "./research.js";

export const DEFAULT_RESEARCH_CAPITAL_QUOTE_RAW = "250000000";
const MIN_RESEARCH_CAPITAL_QUOTE_RAW = 1_000_000n;
const MAX_RESEARCH_CAPITAL_QUOTE_RAW = 100_000n * 1_000_000n;
const ALLOWED_SUMMARY_KEYS = new Set(["capitalQuoteRaw"]);
const ALLOWED_DETAIL_KEYS = new Set([
  "pool", "capitalQuoteRaw", "hours", "width", "snapshotId",
]);

export interface ResearchDetailsRequest {
  readonly poolAddress: string;
  readonly capitalQuoteRaw: string;
  readonly hours: number;
  readonly width: number;
  readonly snapshotId: string;
}

export type ResearchSummary = Omit<ResearchSnapshot, "buckets" | "pools"> & {
  readonly retainedHours: number;
  readonly bucketCount: number;
  readonly pools: readonly Omit<ResearchPool, "series" | "depth" | "depthReferences">[];
};

/** Recompute wall-clock freshness for cached economics without repricing them. */
function responseSnapshot(snapshot: ResearchSnapshot, nowMilliseconds = Date.now()): ResearchSnapshot {
  const maxAgeSeconds = snapshot.sourceFreshness?.maxAgeSeconds ?? 90;
  const sourceMilliseconds = snapshot.asOf === null ? NaN : Date.parse(snapshot.asOf);
  const ageMilliseconds = nowMilliseconds - sourceMilliseconds;
  const sourceFreshness = !Number.isFinite(ageMilliseconds) || ageMilliseconds < 0
    ? { status: "unavailable" as const, asOf: snapshot.asOf, ageSeconds: null, maxAgeSeconds }
    : { status: ageMilliseconds <= maxAgeSeconds * 1_000 ? "fresh" as const : "stale" as const,
      asOf: snapshot.asOf, ageSeconds: Math.floor(ageMilliseconds / 1_000), maxAgeSeconds };
  return { ...snapshot, sourceFreshness };
}

export function researchSummaryProjection(snapshot: ResearchSnapshot): ResearchSummary {
  const { buckets, pools, ...summary } = responseSnapshot(snapshot);
  return {
    ...summary,
    retainedHours: RESEARCH_RETAINED_HOURS,
    bucketCount: buckets.length,
    pools: pools.map(({ series: _series, depth: _depth,
      depthReferences: _depthReferences, ...pool }) => pool),
  };
}

export function researchPoolDetailProjection(
  snapshot: ResearchSnapshot,
  input: ResearchDetailsRequest,
): unknown | null {
  const current = responseSnapshot(snapshot);
  const pool = current.pools.find((entry) =>
    entry.poolAddress.toLowerCase() === input.poolAddress.toLowerCase()
  );
  if (pool === undefined) return null;
  const bucketCount = Math.round(input.hours * RESEARCH_BUCKETS_PER_HOUR);
  return {
    snapshotId: current.snapshotId,
    generatedAt: current.generatedAt,
    asOf: current.asOf,
    sourceFreshness: current.sourceFreshness,
    capitalQuoteRaw: current.capitalQuoteRaw,
    hours: input.hours,
    width: input.width,
    pool: { ...pool, series: pool.series.slice(-bucketCount) },
  };
}

function exactKeys(params: URLSearchParams, allowed: ReadonlySet<string>): boolean {
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) return false;
  }
  return true;
}

export function parseResearchCapital(raw: string | null): string | null {
  if (raw === null) return DEFAULT_RESEARCH_CAPITAL_QUOTE_RAW;
  if (!/^(0|[1-9][0-9]{0,11})$/.test(raw)) return null;
  const capital = BigInt(raw);
  return capital >= MIN_RESEARCH_CAPITAL_QUOTE_RAW &&
      capital <= MAX_RESEARCH_CAPITAL_QUOTE_RAW
    ? capital.toString() : null;
}

export function parseResearchSummaryRequest(
  params: URLSearchParams,
): string | null {
  if (!exactKeys(params, ALLOWED_SUMMARY_KEYS)) return null;
  return parseResearchCapital(params.get("capitalQuoteRaw"));
}

export function parseResearchDetailsRequest(
  params: URLSearchParams,
): ResearchDetailsRequest | null {
  if (!exactKeys(params, ALLOWED_DETAIL_KEYS) ||
      [...ALLOWED_DETAIL_KEYS].some((key) => params.get(key) === null)) return null;
  const poolAddress = params.get("pool")!;
  const capitalQuoteRaw = parseResearchCapital(params.get("capitalQuoteRaw"));
  const hoursText = params.get("hours")!;
  const hours = Number(hoursText);
  const widthText = params.get("width")!;
  const width = Number(widthText);
  const snapshotId = params.get("snapshotId")!;
  if (!/^0x[0-9a-f]{40}$/i.test(poolAddress) || capitalQuoteRaw === null ||
      !RESEARCH_WINDOW_HOURS.some((candidate) => candidate === hours) ||
      !/^(0|[1-9][0-9]*)$/.test(widthText) || !Number.isInteger(width) ||
      width < 0 || width >= 6 ||
      !/^[A-Za-z0-9:._-]{1,200}$/.test(snapshotId)) return null;
  return { poolAddress: poolAddress.toLowerCase(), capitalQuoteRaw,
    hours, width, snapshotId };
}
