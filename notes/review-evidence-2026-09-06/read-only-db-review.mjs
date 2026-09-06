import pg from '/root/conc-liq/node_modules/pg/lib/index.js';
const db = new pg.Client({connectionString: process.env.DATABASE_URL,connectionTimeoutMillis:5000});
try {
 await db.connect();
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await db.query("SET LOCAL statement_timeout = '15s'");
 const queries = {
  time: 'SELECT now() AS observed_at, pg_size_pretty(pg_database_size(current_database())) AS database_size',
  health: 'SELECT observed_at,state,allow_bulk,reasons,lag_blocks,lag_seconds,private_latency_ms FROM rpc_health_samples ORDER BY observed_at DESC LIMIT 1',
  health24h: "SELECT state,count(*) FROM rpc_health_samples WHERE observed_at > now()-interval '24 hours' GROUP BY state",
  checkpoints: "SELECT p.rwa_symbol,p.fee,p.status,count(*),min(r.block_timestamp),max(r.block_timestamp) FROM v3_strategy_pool_checkpoints p JOIN v3_strategy_checkpoint_runs r ON r.id=p.checkpoint_run_id WHERE p.rwa_symbol='NVDA' AND p.fee=500 GROUP BY 1,2,3",
  checkpointReasons: "SELECT reason,count(*) FROM v3_strategy_pool_checkpoints p CROSS JOIN LATERAL jsonb_array_elements_text(p.reasons) reason WHERE p.rwa_symbol='NVDA' AND p.fee=500 GROUP BY 1 ORDER BY 2 DESC",
  perp: 'SELECT quality_pass,expected_pricing_mode,count(*),min(observed_at),max(observed_at) FROM perp_reference_snapshot_runs GROUP BY 1,2',
  basis: 'SELECT reference_mode,quality_pass,count(*),count(distinct checkpoint_run_id) AS checkpoints,min(evaluated_at),max(evaluated_at) FROM perp_pool_basis_runs GROUP BY 1,2',
  basisReasons: 'SELECT reason,count(*) FROM perp_pool_basis_runs b CROSS JOIN LATERAL jsonb_array_elements_text(b.reasons) reason GROUP BY 1 ORDER BY 2 DESC',
  costs: 'SELECT id,rwa_symbol,fee,status,entry_cost_quote_raw,rebalance_cost_quote_raw,exit_cost_quote_raw,reasons,warnings,components FROM v3_guarded_cost_models ORDER BY id DESC LIMIT 3',
  joined: 'SELECT count(*) FROM v3_joined_policy_replay_runs',
  oracleReplay: 'SELECT id,computed_at,checkpoint_count,completed_candidates,excluded_candidates,entry_cost_quote,rebalance_cost_quote FROM v3_oracle_policy_replay_runs ORDER BY id DESC LIMIT 3',
  oracleCandidates: 'SELECT half_width_spacings,status,failure_reason,lp_alpha_quote,absolute_pnl_quote FROM v3_oracle_policy_replay_candidates WHERE replay_run_id=(SELECT max(id) FROM v3_oracle_policy_replay_runs)',
  canary: 'SELECT id,status,reasons FROM guarded_canary_plan_runs ORDER BY id DESC LIMIT 3',
  weekend: 'SELECT id,snapshot FROM perp_weekend_assessment_runs ORDER BY id DESC LIMIT 1',
  joinTiming: `SELECT count(*) AS passing_rows,count(*) FILTER (WHERE p.observed_at>c.block_timestamp) AS perp_after_pool_block,min(extract(epoch FROM (p.observed_at-c.block_timestamp))) AS min_delay_seconds,max(extract(epoch FROM (p.observed_at-c.block_timestamp))) AS max_delay_seconds FROM perp_pool_basis_runs b JOIN v3_strategy_checkpoint_runs c ON c.id=b.checkpoint_run_id JOIN perp_reference_snapshot_runs p ON p.id=b.perp_snapshot_run_id WHERE b.quality_pass`,
  joinedGaps: `WITH c AS (SELECT DISTINCT c.id,c.block_timestamp FROM v3_strategy_checkpoint_runs c JOIN perp_pool_basis_runs b ON b.checkpoint_run_id=c.id WHERE b.quality_pass), gaps AS (SELECT block_timestamp-lag(block_timestamp) OVER (ORDER BY block_timestamp) AS gap FROM c) SELECT max(gap)::text AS max_gap,count(*) FILTER (WHERE gap>interval '10 minutes') AS gaps_over_ten_minutes FROM gaps`,
  staleBasisProofs: "SELECT count(*) FILTER (WHERE c.canonical IS DISTINCT FROM TRUE OR c.block_number<>r.block_number OR lower(c.expected_hash)<>lower(r.block_hash) OR lower(c.observed_hash)<>lower(r.block_hash)) AS invalid_current_proofs,count(*) AS passing_rows FROM perp_pool_basis_runs b JOIN v3_strategy_checkpoint_runs r ON r.id=b.checkpoint_run_id LEFT JOIN risk_snapshot_canonicality c ON c.risk_run_id=r.risk_run_id WHERE b.quality_pass"
 };
 for(const [name,sql] of Object.entries(queries)) {
  const r=await db.query(sql);
  if(name==='oracleReplay') for(const row of r.rows) if(row.snapshot?.candidates) row.snapshot.candidates=row.snapshot.candidates.map(({steps,...rest})=>rest);
  if(name==='weekend') for(const row of r.rows) if(row.snapshot?.sessions) delete row.snapshot.sessions;
  console.log(JSON.stringify({name,rows:r.rows}));
 }
 await db.query('ROLLBACK');
} catch(e) { console.error(e.code, e.message); process.exitCode=1; }
finally {await db.end();}
