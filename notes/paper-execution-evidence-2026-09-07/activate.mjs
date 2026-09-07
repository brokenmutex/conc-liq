import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import pg from 'pg';
import {PaperStore} from '../../src/paper/store.ts';
import {DEFAULT_PAPER_POLICY} from '../../src/paper/engine.ts';
const stream=process.env.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1';
const database=new pg.Client({connectionString:process.env.DATABASE_URL});
const store=new PaperStore(process.env.DATABASE_URL);
await database.connect();
try {
 await store.migrate();
 const old=(await database.query("SELECT *, (SELECT COUNT(*)::int FROM paper_observations WHERE session_id=paper_sessions.id) AS observations FROM paper_sessions WHERE stream_key=$1 AND status NOT IN ('closed','invalid')",[stream])).rows;
 assert.equal(old.length,1);
 assert.equal(old[0].policy.executionBasis,'transaction_simulation');
 assert.equal(old[0].state.position,null);
 assert.equal(old[0].state.pnlQuote,null);
 assert.equal(await store.stop(stream),old[0].id);
 const id=await store.start(stream,DEFAULT_PAPER_POLICY);
 const preserved=(await database.query('SELECT policy_hash,state FROM paper_sessions WHERE id=$1',[old[0].id])).rows[0];
 assert.equal(preserved.policy_hash,old[0].policy_hash);
 assert.equal(preserved.state.position,null);
 const next=(await database.query('SELECT * FROM paper_sessions WHERE id=$1',[id])).rows[0];
 const evidence={observedAt:new Date().toISOString(),previous:{id:old[0].id,policyHash:old[0].policy_hash,observations:old[0].observations,status:'closed',position:null},current:{id,createdAt:next.created_at,policy:next.policy,policyHash:next.policy_hash,status:next.status,position:null},executionEligible:false,broadcastAuthorized:false};
 await writeFile(new URL('activation.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{await store.close();await database.end();}
