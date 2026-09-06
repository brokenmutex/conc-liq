import type { IndexedV3Event } from "../indexer/domain.js";

function normalized(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && value.startsWith("0x")) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalized(item)]),
  );
  return value;
}

export function compareHistoricalEvents(
  expected: readonly IndexedV3Event[],
  actual: readonly IndexedV3Event[],
): void {
  function byKey(events: readonly IndexedV3Event[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const event of events) {
      const key = `${event.transactionHash.toLowerCase()}:${event.logIndex}`;
      if (result.has(key)) throw new Error(`Duplicate historical event ${key}`);
      result.set(key, JSON.stringify(normalized(event)));
    }
    return result;
  }
  const left = byKey(expected);
  const right = byKey(actual);
  if (left.size !== right.size) throw new Error(`Historical event count mismatch: stored=${left.size}, provider=${right.size}`);
  for (const [key, value] of left) {
    if (value !== right.get(key)) throw new Error(`Historical event mismatch at ${key}`);
  }
}
