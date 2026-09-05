import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  HyperliquidPerpAsset,
  HyperliquidPerpContext,
  PerpCandleSource,
  PerpMarketContextSource,
  PerpReferenceEvidence,
  RawPerpCandle,
} from "./domain.js";
import { parseUnsignedDecimalX18 } from "./math.js";

const unsignedDecimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u);
const signedDecimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u);

const assetSchema = z.object({
  isDelisted: z.boolean().optional(),
  marginMode: z.string().optional(),
  maxLeverage: z.number().int().positive(),
  name: z.string().min(1),
  onlyIsolated: z.boolean().optional(),
  szDecimals: z.number().int().min(0).max(18),
});

const contextSchema = z.object({
  dayBaseVlm: unsignedDecimal,
  dayNtlVlm: unsignedDecimal,
  funding: signedDecimal,
  impactPxs: z.tuple([unsignedDecimal, unsignedDecimal]).nullable(),
  markPx: unsignedDecimal,
  midPx: unsignedDecimal.nullable(),
  openInterest: unsignedDecimal,
  oraclePx: unsignedDecimal,
  premium: signedDecimal.nullable(),
  prevDayPx: unsignedDecimal,
});

const marketResponseSchema = z.tuple([
  z.object({ universe: z.array(assetSchema) }),
  z.array(contextSchema),
]);

const rawCandleSchema = z.object({
  T: z.number().int().nonnegative(),
  c: unsignedDecimal,
  h: unsignedDecimal,
  i: z.literal("1h"),
  l: unsignedDecimal,
  n: z.number().int().nonnegative(),
  o: unsignedDecimal,
  s: z.string().min(1),
  t: z.number().int().nonnegative(),
  v: unsignedDecimal,
});

interface FetchedJson {
  readonly evidence: PerpReferenceEvidence;
  readonly value: unknown;
}

async function postInfo(input: {
  readonly body: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly url: string;
}): Promise<FetchedJson> {
  const request = JSON.stringify(input.body);
  const response = await fetch(input.url, {
    body: request,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Hyperliquid info API returned HTTP ${response.status}`);
  }
  const raw = await response.text();
  return {
    evidence: {
      fetchedAt: new Date().toISOString(),
      request: input.body,
      sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      url: input.url,
    },
    value: JSON.parse(raw) as unknown,
  };
}

function asset(value: z.infer<typeof assetSchema>): HyperliquidPerpAsset {
  return {
    isDelisted: value.isDelisted ?? false,
    marginMode: value.marginMode ?? null,
    maxLeverage: value.maxLeverage,
    name: value.name,
    onlyIsolated: value.onlyIsolated ?? false,
    szDecimals: value.szDecimals,
  };
}

function context(value: z.infer<typeof contextSchema>): HyperliquidPerpContext {
  return {
    dayBaseVolume: value.dayBaseVlm,
    dayNotionalVolume: value.dayNtlVlm,
    funding: value.funding,
    impactPrices: value.impactPxs,
    markPrice: value.markPx,
    midPrice: value.midPx,
    openInterest: value.openInterest,
    oraclePrice: value.oraclePx,
    premium: value.premium,
    previousDayPrice: value.prevDayPx,
  };
}

export function parseMarketContext(
  value: unknown,
  coin: string,
  evidence: PerpReferenceEvidence,
): PerpMarketContextSource {
  const [metadata, contexts] = marketResponseSchema.parse(value);
  if (metadata.universe.length !== contexts.length) {
    throw new Error("Hyperliquid metadata and context lengths differ");
  }
  const matches = metadata.universe
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.name === coin);
  if (matches.length !== 1) {
    throw new Error(`Hyperliquid response contains ${matches.length} ${coin} markets`);
  }
  const selected = matches[0]!;
  const selectedContext = contexts[selected.index];
  if (selectedContext === undefined) {
    throw new Error(`Hyperliquid response has no context for ${coin}`);
  }
  return {
    asset: asset(selected.entry),
    assetIndex: selected.index,
    context: context(selectedContext),
    evidence,
  };
}

export async function fetchPerpMarketContext(input: {
  readonly coin: string;
  readonly dex: string;
  readonly timeoutMs: number;
  readonly url: string;
}): Promise<PerpMarketContextSource> {
  const result = await postInfo({
    body: { dex: input.dex, type: "metaAndAssetCtxs" },
    timeoutMs: input.timeoutMs,
    url: input.url,
  });
  return parseMarketContext(result.value, input.coin, result.evidence);
}

function rawCandle(value: z.infer<typeof rawCandleSchema>): RawPerpCandle {
  return {
    close: value.c,
    closeTimeMs: value.T,
    high: value.h,
    interval: value.i,
    low: value.l,
    open: value.o,
    openTimeMs: value.t,
    symbol: value.s,
    tradeCount: value.n,
    volume: value.v,
  };
}

export function parseCandles(input: {
  readonly coin: string;
  readonly evidence: PerpReferenceEvidence;
  readonly fromTimeMs: number;
  readonly toTimeMs: number;
  readonly value: unknown;
}): PerpCandleSource {
  const parsed = z.array(rawCandleSchema).parse(input.value).map(rawCandle);
  const seen = new Set<number>();
  const candles = parsed.map((entry) => {
    if (entry.symbol !== input.coin) {
      throw new Error(`Hyperliquid returned candle for unexpected ${entry.symbol}`);
    }
    if (entry.closeTimeMs <= entry.openTimeMs) {
      throw new Error("Hyperliquid candle has an invalid time range");
    }
    if (
      entry.openTimeMs < input.fromTimeMs ||
      entry.closeTimeMs > input.toTimeMs
    ) {
      throw new Error("Hyperliquid candle is outside the requested range");
    }
    if (seen.has(entry.openTimeMs)) {
      throw new Error(`Hyperliquid returned duplicate candle ${entry.openTimeMs}`);
    }
    seen.add(entry.openTimeMs);
    const open = parseUnsignedDecimalX18(entry.open, "candle open");
    const close = parseUnsignedDecimalX18(entry.close, "candle close");
    const high = parseUnsignedDecimalX18(entry.high, "candle high");
    const low = parseUnsignedDecimalX18(entry.low, "candle low");
    if (open <= 0n || close <= 0n || high <= 0n || low <= 0n) {
      throw new Error("Hyperliquid candle price must be positive");
    }
    if (high < open || high < close || high < low || low > open || low > close) {
      throw new Error("Hyperliquid candle OHLC bounds are inconsistent");
    }
    return {
      closePriceX18: close.toString(),
      closeTimeMs: entry.closeTimeMs,
      highPriceX18: high.toString(),
      interval: entry.interval,
      lowPriceX18: low.toString(),
      openPriceX18: open.toString(),
      openTimeMs: entry.openTimeMs,
      raw: entry,
      tradeCount: String(entry.tradeCount),
      volumeX18: parseUnsignedDecimalX18(entry.volume, "candle volume").toString(),
    } as const;
  }).sort((left, right) => left.openTimeMs - right.openTimeMs);
  return {
    candles,
    evidence: input.evidence,
    fromTimeMs: input.fromTimeMs,
    interval: "1h",
    toTimeMs: input.toTimeMs,
  };
}

export async function fetchPerpCandles(input: {
  readonly coin: string;
  readonly fromTimeMs: number;
  readonly timeoutMs: number;
  readonly toTimeMs: number;
  readonly url: string;
}): Promise<PerpCandleSource> {
  const result = await postInfo({
    body: {
      req: {
        coin: input.coin,
        endTime: input.toTimeMs,
        interval: "1h",
        startTime: input.fromTimeMs,
      },
      type: "candleSnapshot",
    },
    timeoutMs: input.timeoutMs,
    url: input.url,
  });
  return parseCandles({
    coin: input.coin,
    evidence: result.evidence,
    fromTimeMs: input.fromTimeMs,
    toTimeMs: input.toTimeMs,
    value: result.value,
  });
}
