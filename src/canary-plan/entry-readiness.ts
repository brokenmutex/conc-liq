import type { RpcHealthEvaluation } from "../rpc-health/domain.js";

export interface CanaryEntryReadiness {
  readonly policy: "robinhood_quorum_recovery_regular_session_v1";
  readonly evaluatedAt: string;
  readonly chainEligible: boolean;
  readonly session: "regular_session" | "closed" | "calendar_unavailable";
  readonly reasons: readonly string[];
  readonly sampleIds: readonly string[];
  readonly recoverySeconds: 300;
}

// Published 2026 US cash-equity calendar. Unsupported years fail closed.
// https://www.nyse.com/trade/hours-calendars (verified 2026-09-06)
const holidays = new Set(["01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26", "12-25"]);
const earlyCloses = new Set(["11-27", "12-24"]);
export function regularEquitySession(at: string): CanaryEntryReadiness["session"] {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "calendar_unavailable";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  if (parts.year !== "2026") return "calendar_unavailable";
  const day = `${parts.month}-${parts.day}`;
  if (parts.weekday === "Sat" || parts.weekday === "Sun" || holidays.has(day)) return "closed";
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const close = earlyCloses.has(day) ? 13 * 60 : 16 * 60;
  // Leave five minutes after open/recovery and before close for this entry trial.
  return minute >= 9 * 60 + 35 && minute < close - 5 ? "regular_session" : "closed";
}

/** Observed RPC agreement/recovery, not a claim of L1 finality or a sequencer oracle. */
export function evaluateCanaryEntryReadiness(input: {
  readonly now: string;
  readonly sourceBlock: bigint;
  readonly samples: readonly { id: string; snapshot: RpcHealthEvaluation }[];
}): CanaryEntryReadiness {
  const now = Date.parse(input.now);
  const start = now - 300_000;
  const reasons: string[] = [];
  const samples = [...input.samples].sort((a, b) => Date.parse(a.snapshot.observedAt) - Date.parse(b.snapshot.observedAt));
  // Include the last sample at/before the start, so the recovery window has no blind edge.
  const previous = samples.findLastIndex((sample) => Date.parse(sample.snapshot.observedAt) <= start);
  const window = samples.slice(Math.max(0, previous));
  const first = window[0]?.snapshot;
  const last = window.at(-1)?.snapshot;
  if (!Number.isFinite(now) || !first || !last || previous < 0 || window.length < 16) {
    reasons.push("chain_recovery_history_incomplete");
  }
  let preceding: number | undefined;
  let firstHead: bigint | undefined;
  let lastHead: bigint | undefined;
  for (const { snapshot: sample } of window) {
    const observed = Date.parse(sample.observedAt);
    if (!Number.isFinite(observed) || observed > now ||
        (preceding !== undefined && (observed - preceding > 20_000 || observed <= preceding))) {
      reasons.push("chain_health_sample_gap_or_timestamp");
    }
    preceding = observed;
    if (sample.state !== "healthy" || !sample.allowBulk || sample.reasons.length > 0 || sample.privateSyncing !== false) {
      reasons.push("chain_recovery_not_continuously_healthy");
    }
    try {
      if (sample.anchorBlock === null || sample.anchorHash === null || sample.privateHead === null || sample.privateHeadTimestamp === null) throw new Error();
      const anchor = BigInt(sample.anchorBlock);
      const head = BigInt(sample.privateHead);
      const hash = sample.anchorHash.toLowerCase();
      const matches = sample.probes.filter((probe) =>
        probe.chainId === 4663 && probe.error === null && probe.anchorError === null &&
        probe.anchorBlock !== null && BigInt(probe.anchorBlock) === anchor &&
        probe.anchorHash?.toLowerCase() === hash && probe.headBlock !== null &&
        BigInt(probe.headBlock) - anchor >= 64n && probe.headTimestamp !== null &&
        Math.floor(observed / 1000) - Number(probe.headTimestamp) >= 0 &&
        Math.floor(observed / 1000) - Number(probe.headTimestamp) <= 15,
      );
      if (matches.filter((probe) => probe.role === "private").length !== 1 ||
          new Set(matches.filter((probe) => probe.role === "reference").map((probe) => probe.name)).size < 2 ||
          sample.privateAnchorHash?.toLowerCase() !== hash) reasons.push("chain_anchor_quorum_unproven");
      if (lastHead !== undefined && head < lastHead) reasons.push("chain_head_regressed");
      firstHead ??= head;
      lastHead = head;
    } catch { reasons.push("chain_health_evidence_malformed"); }
  }
  if (first && start - Date.parse(first.observedAt) > 20_000) reasons.push("chain_recovery_history_incomplete");
  if (!last || now - Date.parse(last.observedAt) > 20_000) reasons.push("chain_health_latest_stale");
  if (firstHead === undefined || lastHead === undefined || lastHead <= firstHead) reasons.push("chain_head_not_advancing");
  if (last?.anchorBlock === null || last?.anchorBlock === undefined || input.sourceBlock > BigInt(last.anchorBlock)) {
    reasons.push("source_ahead_of_confirmed_quorum");
  }
  const chainEligible = reasons.length === 0;
  const session = regularEquitySession(input.now);
  if (session !== "regular_session") reasons.push(`equity_session_${session}`);
  return { policy: "robinhood_quorum_recovery_regular_session_v1", evaluatedAt: input.now,
    chainEligible, session, reasons: [...new Set(reasons)], sampleIds: window.map((sample) => sample.id), recoverySeconds: 300 };
}
