// Shared source-row reader for the offline research harnesses.
//
// `sourceSql`'s `covered` predicate joins `indexer_cursors.last_scanned_block`.
// The tail calls `runBackfill` every ~10 s, which begins with
// `PostgresEventStore.rewind(fromBlock = nextBlock - reorgOverlap)`. That
// deletes `indexer_checkpoints` at or above `fromBlock` and then re-points the
// cursor at the highest *surviving* checkpoint row. Because every cycle
// deletes the previous cycle's checkpoint, the highest survivor is whatever
// predates the reorg window by more than one cycle -- on this database, block
// 59,644,695 from 2026-09-10. For the ~1.0-1.6 s until `saveChunk` commits,
// every consumer reads the cursor 6.5M blocks in the past and `covered` is
// false for every row. Measured duty cycle: 20 of 215 reads, 9.3%
// (notes/execution-defects-2026-09-18/cursor-probe-2026-09-18.log).
//
// The fix belongs in `src/indexer/store.ts` (W4.2) and cannot be deployed
// without restarting the tail, so offline harnesses wait for a healthy cursor
// instead. Read-only; nothing here writes.
import assert from 'node:assert/strict';

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const DEFAULT_RESEARCH_DATABASE_URL='postgresql://root@localhost/conc_liq?host=/var/run/postgresql';

/** Select an explicit database for offline research replay without reusing the
 * runtime DATABASE_URL. The dedicated name prevents a service environment
 * from silently retargeting historical research. */
export function researchDatabaseUrl(environment=process.env){
  const value=environment.RESEARCH_DATABASE_URL??DEFAULT_RESEARCH_DATABASE_URL;
  const parsed=new URL(value);
  assert(['postgres:','postgresql:'].includes(parsed.protocol),'RESEARCH_DATABASE_URL must be PostgreSQL');
  assert(parsed.pathname.length>1,'RESEARCH_DATABASE_URL must name a database');
  return value;
}

/** Retarget the deployed release's fee-500 checkpoint query at another tier.
 * The working tree's `sourceSqlForFee` is the real fix, but it reads
 * `covered_through_block`, which arrives with migration 3 and cannot be
 * applied while the collectors run an older release. Rewriting the two fee
 * literals in the deployed string gets a 3000-tier book out of the same
 * database without touching either. Both substitutions are asserted. */
export function retargetSourceFee(sourceSql,fee){
  assert(Number.isInteger(fee)&&fee>0&&fee<1000000,'Pool fee outside the V3 domain');
  if(fee===500)return sourceSql;
  const out=sourceSql.replaceAll('t.fee=500',`t.fee=${fee}`).replaceAll('p.fee=500',`p.fee=${fee}`);
  assert(out.includes(`t.fee=${fee}`)&&out.includes(`p.fee=${fee}`)&&!out.includes('fee=500'),
    'Checkpoint query does not carry the expected fee literals');
  return out;
}

/** Block until the indexer cursor is at or beyond the newest checkpoint for
 * this pool, so the `covered` predicate is evaluated against real coverage. */
export async function awaitHealthyCursor(db,streamKey,pool,attempts=60){
  const head=(await db.query(`SELECT max(c.block_number)::text AS block FROM v3_strategy_checkpoint_runs c
    JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id=c.id
    WHERE c.stream_key=$1 AND LOWER(p.pool_address)=$2`,[streamKey,pool])).rows[0]?.block;
  if(!head)return null;
  for(let i=0;i<attempts;i++){
    const row=(await db.query('SELECT last_scanned_block::text AS block FROM indexer_cursors WHERE stream_key=$1',[streamKey])).rows[0];
    // The newest checkpoint can legitimately lead the cursor by one tail
    // cycle; only the 6.5M-block readback has to be waited out.
    if(row&&BigInt(row.block)>=BigInt(head)-100000n)return row.block;
    await sleep(500);
  }
  return null;
}

/** Read the covered, canonical, identity-valid checkpoint rows for one pool.
 * Retries across the cursor readback window rather than accepting its result. */
export async function readSourceRows(db,sourceSql,{streamKey,rwa,pool,since,end,fee=500,attempts=40}){
  sourceSql=retargetSourceFee(sourceSql,fee);
  for(let attempt=0;attempt<attempts;attempt++){
    await awaitHealthyCursor(db,streamKey,pool);
    // Bound the window in SQL. The original harnesses compared the covered
    // count against every row the pool has ever had, so once history accrued
    // past SIM_END the ratio fell below 0.9 and a clean read was misread as a
    // coverage flake. The denominator has to be the window, not the table.
    const raw=(await db.query(sourceSql+' AND c.block_timestamp>=$4 AND c.block_timestamp<=$5 ORDER BY c.block_number,c.id',
      [streamKey,rwa,pool,since,new Date(end).toISOString()])).rows;
    const rows=raw.filter(r=>r.canonical===true&&r.covered===true&&r.coverage_identity_valid===true);
    if(raw.length&&rows.length>=raw.length*0.9)return rows;
    console.error(`${pool} coverage flake (${rows.length}/${raw.length} covered), retrying`);
    await sleep(1000);
  }
  assert.fail('no covered rows after retrying the indexer cursor readback window');
}
