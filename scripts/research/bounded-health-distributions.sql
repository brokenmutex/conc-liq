-- Reproducible W4.3 health evidence. Read-only.
--
-- Usage:
--   psql "$RESEARCH_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
--     -v from_at=2026-09-12T14:24:00Z -v through_at=2026-09-15T06:00:00Z \
--     -f scripts/research/bounded-health-distributions.sql
--
-- Both boundaries are inclusive. Always record the psql output beside the
-- exact from_at and through_at values; rerunning with later bounds is a new
-- observation, not a reproduction of an older one.

\if :{?from_at}
\else
  \echo 'from_at is required'
  \quit 3
\endif
\if :{?through_at}
\else
  \echo 'through_at is required'
  \quit 3
\endif

SELECT :'from_at'::timestamptz AS from_at, :'through_at'::timestamptz AS through_at,
  CASE WHEN :'from_at'::timestamptz < :'through_at'::timestamptz THEN true
    ELSE pg_catalog.set_config('w4.invalid_bounds', 'from_at_must_precede_through_at', false)::boolean END AS valid_bounds;

-- Transient chain-fault episodes tracked by chainSince/chainPauseSeconds.
WITH t AS (
  SELECT observed_at, EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(reasons) x(v)
    WHERE x.v IN ('reference_count_below_quorum','reference_hash_quorum_unavailable','private_probe_failed',
      'private_reports_syncing','private_confirmed_anchor_unavailable','private_block_lag_soft',
      'private_time_lag_soft','private_latency_soft')) AS bad
  FROM rpc_health_samples
  WHERE observed_at BETWEEN :'from_at'::timestamptz AND :'through_at'::timestamptz),
s AS (SELECT observed_at, bad,
  row_number() OVER (ORDER BY observed_at) - row_number() OVER (PARTITION BY bad ORDER BY observed_at) AS grp FROM t),
runs AS (SELECT grp, EXTRACT(epoch FROM max(observed_at)-min(observed_at))+10 AS secs FROM s WHERE bad GROUP BY grp)
SELECT count(*) AS transient_episodes, round(avg(secs)) AS mean_s,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY secs) AS p50,
  percentile_disc(0.9) WITHIN GROUP (ORDER BY secs) AS p90,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY secs) AS p95,
  percentile_disc(0.99) WITHIN GROUP (ORDER BY secs) AS p99, max(secs) AS max_s,
  count(*) FILTER (WHERE secs < 60) AS held_at_60,
  count(*) FILTER (WHERE secs < 300) AS held_at_300,
  count(*) FILTER (WHERE secs < 600) AS held_at_600
FROM runs;

-- Hard chain-fault episodes; pause allowances do not cover these.
WITH t AS (
  SELECT observed_at, EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(reasons) x(v)
    WHERE x.v NOT IN ('recovery_hysteresis','reference_count_below_quorum','reference_hash_quorum_unavailable',
      'private_probe_failed','private_reports_syncing','private_confirmed_anchor_unavailable',
      'private_block_lag_soft','private_time_lag_soft','private_latency_soft')) AS bad
  FROM rpc_health_samples
  WHERE observed_at BETWEEN :'from_at'::timestamptz AND :'through_at'::timestamptz),
s AS (SELECT observed_at, bad,
  row_number() OVER (ORDER BY observed_at) - row_number() OVER (PARTITION BY bad ORDER BY observed_at) AS grp FROM t),
runs AS (SELECT grp, EXTRACT(epoch FROM max(observed_at)-min(observed_at))+10 AS secs FROM s WHERE bad GROUP BY grp)
SELECT count(*) AS hard_episodes, percentile_disc(0.5) WITHIN GROUP (ORDER BY secs) AS p50,
  percentile_disc(0.9) WITHIN GROUP (ORDER BY secs) AS p90, max(secs) AS max_s FROM runs;

-- Risk producer cadence inside the same frozen interval.
WITH observations AS (
  SELECT observed_at FROM risk_snapshot_runs
  WHERE observed_at BETWEEN :'from_at'::timestamptz AND :'through_at'::timestamptz),
gaps AS (SELECT EXTRACT(epoch FROM observed_at - lag(observed_at) OVER (ORDER BY observed_at)) AS gap
  FROM observations)
SELECT count(gap) AS intervals, round(percentile_disc(0.5) WITHIN GROUP (ORDER BY gap)) AS p50,
  round(percentile_disc(0.9) WITHIN GROUP (ORDER BY gap)) AS p90,
  round(percentile_disc(0.99) WITHIN GROUP (ORDER BY gap)) AS p99, round(max(gap)) AS max_s,
  count(*) FILTER (WHERE gap > 30) AS over_30s,
  count(*) FILTER (WHERE gap > 60) AS over_60s,
  count(*) FILTER (WHERE gap > 180) AS over_180s
FROM gaps;

-- Exact health-reason counts in the frozen interval.
SELECT reason, count(*) AS samples
FROM rpc_health_samples CROSS JOIN LATERAL jsonb_array_elements_text(reasons) AS item(reason)
WHERE observed_at BETWEEN :'from_at'::timestamptz AND :'through_at'::timestamptz
GROUP BY reason ORDER BY samples DESC, reason;
