import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {MIGRATIONS} from '../src/storage/migrations.js';
import {MIGRATION_CHECKSUMS} from '../src/storage/migration-checksums.js';
import {RPC_HEALTH_SINGLE_REFERENCE_QUORUM_SQL} from '../src/storage/rpc-health-single-reference-quorum-migration.js';
import {DEPLOYMENT_SCHEMA_VERSION,RPC_HEALTH_SINGLE_REFERENCE_QUORUM_SCHEMA_VERSION} from '../src/storage/compatibility.js';

test('v15 single-reference RPC health quorum migration is append-only and checksum-bound',()=>{
 assert.equal(MIGRATIONS.length,15);assert.equal(MIGRATION_CHECKSUMS.length,15);
 assert.equal(DEPLOYMENT_SCHEMA_VERSION,15);assert.equal(RPC_HEALTH_SINGLE_REFERENCE_QUORUM_SCHEMA_VERSION,15);
 assert.equal(MIGRATIONS[14],RPC_HEALTH_SINGLE_REFERENCE_QUORUM_SQL);
 assert.equal(createHash('sha256').update(MIGRATIONS[14]!).digest('hex'),MIGRATION_CHECKSUMS[14]);
});

test('v15 only relaxes the stored quorum minimum to one and touches nothing else',()=>{
 const sql=RPC_HEALTH_SINGLE_REFERENCE_QUORUM_SQL;
 assert.match(sql,/reference_quorum >= 1/);
 assert.doesNotMatch(sql,/reference_quorum >= 2/);
 assert.deepEqual([...sql.matchAll(/ALTER TABLE (\w+)/g)].map(m=>m[1]),['rpc_health_samples','rpc_health_samples']);
 assert.doesNotMatch(sql,/\b(UPDATE|DELETE|INSERT|DROP TABLE|TRUNCATE)\b/i);
 // The other bounds of the replaced check are preserved exactly.
 for(const bound of ['reference_count >= 0','consecutive_healthy >= 0','consecutive_unhealthy >= 0'])assert(sql.includes(bound));
});
