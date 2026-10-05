import type { Pool, PoolClient } from "pg";

// Exact supported migration history. Change only alongside a reviewed migration.
// Read-only workers must never repair or bootstrap a database implicitly.
export const REQUIRED_SCHEMA_VERSION = 3;
export const DEPLOYMENT_SCHEMA_VERSION = 15;
export const REQUIRED_DEPLOYMENT_SCHEMA_VERSION = 11;
export const LIVE_WALLET_SCHEMA_VERSION = 12;
export const LIVE_RUNTIME_SCHEMA_VERSION = 13;
export const POSITION_MANAGER_WALLET_TRANSFER_SCHEMA_VERSION = 14;
export const RPC_HEALTH_SINGLE_REFERENCE_QUORUM_SCHEMA_VERSION = 15;
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

/** Indexer writes require canonical timestamps and scan bounds from migration 8. */
export async function assertIndexerEventTimestampsSchemaReady(
  db: Pick<Pool | PoolClient, "query">,
): Promise<void> {
  await assertSchemaReady(db);
  const row = (await db.query<{ version: number }>(
    "SELECT max(version)::int AS version FROM schema_migrations",
  )).rows[0];
  if ((row?.version ?? 0) < 8) throw new Error(SCHEMA_ERROR);
}

/** The paper accounting journal and its append-only invalidations require v7.
 * Existing read-only services can still run against checked older schemas
 * until an authorized migration. */
export async function assertDeploymentSchemaReady(db: Pick<Pool | PoolClient,"query">):Promise<void>{
 await assertSchemaReady(db);
 const row=(await db.query<{version:number}>('SELECT max(version)::int AS version FROM schema_migrations')).rows[0];
 if((row?.version??0)<REQUIRED_DEPLOYMENT_SCHEMA_VERSION)throw new Error(SCHEMA_ERROR);
}

/** Shared-wallet admission/queue workers require their explicit migration.
 * Earlier paper/read-only deployment services remain compatible with v11. */
export async function assertLiveWalletSchemaReady(db:Pick<Pool|PoolClient,'query'>):Promise<void>{
 await assertSchemaReady(db);
 const row=(await db.query<{version:number}>('SELECT max(version)::int AS version FROM schema_migrations')).rows[0];
 // Later checked migrations keep earlier capabilities; assertSchemaReady bounds the maximum.
 if((row?.version??0)<LIVE_WALLET_SCHEMA_VERSION)throw new Error(SCHEMA_ERROR);
}

/** Campaign-addressed live RangeKeeper runtime state requires v13. */
export async function assertLiveRuntimeSchemaReady(db:Pick<Pool|PoolClient,'query'>):Promise<void>{
 await assertSchemaReady(db);
 const row=(await db.query<{version:number}>('SELECT max(version)::int AS version FROM schema_migrations')).rows[0];
 if((row?.version??0)<LIVE_RUNTIME_SCHEMA_VERSION)throw new Error(SCHEMA_ERROR);
}

/** Wallet-scoped Position Manager replay writes require their isolated v14
 * tables. Older global transfer indexes remain readable without this gate. */
export async function assertPositionManagerWalletTransferSchemaReady(
 db:Pick<Pool|PoolClient,'query'>,
):Promise<void>{
 await assertSchemaReady(db);
 const row=(await db.query<{version:number}>('SELECT max(version)::int AS version FROM schema_migrations')).rows[0];
 if((row?.version??0)<POSITION_MANAGER_WALLET_TRANSFER_SCHEMA_VERSION)throw new Error(SCHEMA_ERROR);
}
