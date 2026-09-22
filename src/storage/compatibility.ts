import type { Pool, PoolClient } from "pg";

// Exact supported migration history. Change only alongside a reviewed migration.
// Read-only workers must never repair or bootstrap a database implicitly.
export const REQUIRED_SCHEMA_VERSION = 3;
export const DEPLOYMENT_SCHEMA_VERSION = 6;
export const SCHEMA_ERROR = "Database schema incompatible; run the release's explicit db:migrate command before starting workers";

export async function assertSchemaReady(db: Pick<Pool | PoolClient, "query">): Promise<void> {
  const present = await db.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='schema_migrations' AND c.relkind='r') AS present",
  );
  if (!present.rows[0]?.present) throw new Error(SCHEMA_ERROR);
  const rows = (await db.query<{ version: number; checksum: string }>(
    "SELECT version, checksum FROM schema_migrations ORDER BY version",
  )).rows;
  // Generated from immutable migration texts; imported without loading DDL.
  const { MIGRATION_CHECKSUMS } = await import("./migration-checksums.js");
  if (rows.length < REQUIRED_SCHEMA_VERSION || rows.length > DEPLOYMENT_SCHEMA_VERSION || rows.some((row, index) =>
    row.version !== index + 1 || row.checksum !== MIGRATION_CHECKSUMS[index])) {
    throw new Error(SCHEMA_ERROR);
  }
}

/** The new paper accounting journal requires v6. Existing read-only services
 * can still run against checked v3-v5 schemas until an authorized migration. */
export async function assertDeploymentSchemaReady(db: Pick<Pool | PoolClient,"query">):Promise<void>{
 await assertSchemaReady(db);
 const row=(await db.query<{version:number}>('SELECT max(version)::int AS version FROM schema_migrations')).rows[0];
 if(row?.version!==DEPLOYMENT_SCHEMA_VERSION)throw new Error(SCHEMA_ERROR);
}
