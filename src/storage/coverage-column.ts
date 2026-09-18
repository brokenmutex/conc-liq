/** Migration 3 adds `indexer_cursors.covered_through_block`. Readers that must
 * keep working on a database that has not run it cannot rely on COALESCE:
 * PostgreSQL rejects an unknown column at parse time. They ask once, here. */
export async function hasCoverageColumn(
  db: { query(text: string): Promise<{ rowCount: number | null }> },
): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema=ANY(current_schemas(false)) AND table_name='indexer_cursors' AND column_name='covered_through_block'",
  );
  return (result.rowCount ?? 0) > 0;
}
/** The cursor expression for a coverage predicate, given whether the column exists. */
export function coverageCursorSql(alias: string, coverageColumn: boolean): string {
  return coverageColumn
    ? `COALESCE(${alias}.covered_through_block,${alias}.last_scanned_block)`
    : `${alias}.last_scanned_block`;
}
