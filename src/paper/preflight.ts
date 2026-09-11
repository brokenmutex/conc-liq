import { isDeepStrictEqual } from 'node:util';

/** Compare persisted JSON values, independent of PostgreSQL jsonb key order.
 * JSON round-tripping also matches how optional undefined properties persist.
 * Array order, values, added fields, and removed fields remain significant. */
export function samePersistedPaperState(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}
