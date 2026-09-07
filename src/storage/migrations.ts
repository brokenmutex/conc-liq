import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { SCHEMA_SQL } from "./schema.js";
import { LEGACY_BASELINE_CATALOG_SHA256 } from "./legacy-baseline.js";
import { MIGRATION_CHECKSUMS } from "./migration-checksums.js";

// v1 is the frozen pre-versioning schema. Existing databases are verified and
// registered, never subjected to its historical UPDATE/DROP statements again.
export const RUNTIME_IDENTITY_SQL = `
ALTER TABLE paper_sessions ADD COLUMN runtime_identity JSONB;
ALTER TABLE paper_execution_runs ADD COLUMN runtime_identity JSONB;
`;
export const MIGRATIONS = [SCHEMA_SQL, RUNTIME_IDENTITY_SQL] as const;
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex");

// Read while search_path names just this schema. pg_get_* renders references
// consistently without schema qualifiers. Ignore column order and constraint
// names, which can differ after the old additive migrations.
export async function readSchemaCatalog(client: PoolClient) {
  const columns = (await client.query(`SELECT c.relname AS table_name,a.attname AS name,
    format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
    pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname<>'schema_migrations'
    ORDER BY c.relname,a.attname`)).rows;
  const constraints = (await client.query(`SELECT c.relname AS table_name,
    pg_get_constraintdef(k.oid) AS definition,k.convalidated AS validated
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname<>'schema_migrations'
    ORDER BY c.relname,definition`)).rows;
  const indexes = (await client.query(`SELECT t.relname AS table_name,
    pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid AS valid
    FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=current_schema() AND t.relname<>'schema_migrations'
    ORDER BY t.relname,definition`)).rows;
  // Index definitions always qualify the table; normalize only our schema.
  const schema = (await client.query<{ name: string }>("SELECT current_schema() AS name")).rows[0]!.name;
  const distinctConstraints = [...new Map(constraints.map(row => [JSON.stringify(row), row])).values()];
  return JSON.stringify({ columns, constraints: distinctConstraints, indexes }).replaceAll(`${schema}.`, "").replaceAll(`${identifier(schema)}.`, "");
}

export async function migrateDatabase(client: PoolClient, options: { baseline?: boolean } = {}): Promise<number[]> {
  if (MIGRATIONS.some((sql, i) => checksum(sql) !== MIGRATION_CHECKSUMS[i])) {
    throw new Error("Migration checksum changed; append a migration instead of editing an applied one");
  }
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    const target = (await client.query<{ name: string | null }>("SELECT current_schema() AS name")).rows[0]?.name;
    if (!target) throw new Error("Explicit target schema is required");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('conc-liq-migrations'),hashtext($1))", [target]);
    // Prevent unqualified names from resolving into a different schema.
    await client.query(`SET LOCAL search_path=${identifier(target)}`);
    const existing = (await client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()
      AND c.relkind='r' AND c.relname<>'schema_migrations'`)).rows[0]!.n;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      method TEXT NOT NULL CHECK(method IN ('applied','verified_baseline')))`);
    const history = (await client.query<{ version: number; checksum: string }>("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows;
    if (history.length > MIGRATIONS.length || history.some((r, i) => r.version !== i + 1 || r.checksum !== MIGRATION_CHECKSUMS[i])) {
      throw new Error("Unsupported or modified database migration history");
    }
    const applied: number[] = [];
    for (let i = history.length; i < MIGRATIONS.length; i++) {
      let method = "applied";
      if (i === 0 && existing > 0) {
        if (!options.baseline) throw new Error("Unversioned existing database: use db:migrate -- --baseline to verify and register it");
        const actual = await readSchemaCatalog(client);
        const scratch = `migration_verify_${randomUUID().replaceAll("-", "")}`;
        await client.query(`CREATE SCHEMA ${identifier(scratch)}`);
        await client.query(`SET LOCAL search_path=${identifier(scratch)}`);
        await client.query(SCHEMA_SQL);
        const expected = await readSchemaCatalog(client);
        await client.query(`SET LOCAL search_path=${identifier(target)}`);
        await client.query(`DROP SCHEMA ${identifier(scratch)} CASCADE`);
        if (actual !== expected && checksum(actual) !== LEGACY_BASELINE_CATALOG_SHA256) throw new Error("Existing schema differs from the frozen baseline; no migration or data repair was committed");
        method = "verified_baseline";
      } else {
        await client.query(MIGRATIONS[i]!);
      }
      await client.query("INSERT INTO schema_migrations(version,checksum,method) VALUES($1,$2,$3)", [i + 1, MIGRATION_CHECKSUMS[i], method]);
      applied.push(i + 1);
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
