import pg, { type PoolClient } from "pg";

const { Pool } = pg;

export class PostgresTailLock {
  private readonly pool: InstanceType<typeof Pool>;
  private client: PoolClient | null = null;
  private lockName: string | null = null;

  public constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 1 });
  }

  public async acquire(streamKey: string): Promise<void> {
    this.client = await this.pool.connect();
    this.lockName = `v3-tail:${streamKey}`;
    const result = await this.client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [this.lockName],
    );
    if (result.rows[0]?.locked !== true) {
      throw new Error(`Another tail process holds the ${streamKey} lock`);
    }
  }

  public async close(): Promise<void> {
    if (this.client !== null) {
      if (this.lockName !== null) {
        await this.client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          this.lockName,
        ]).catch(() => undefined);
      }
      this.client.release();
      this.client = null;
      this.lockName = null;
    }
    await this.pool.end();
  }
}
