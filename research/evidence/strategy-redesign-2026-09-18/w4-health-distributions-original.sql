-- W4.3 evidence. Read-only. Run against the conc_liq database.
--
-- Episode = a run of consecutive rpc_health_samples carrying at least one
-- fault of the class in question. Samples arrive every ~10 s, so +10 is added
-- to each run so a single-sample episode counts as its own interval rather
-- than zero.

\set transient '''reference_count_below_quorum'',''reference_hash_quorum_unavailable'',''private_probe_failed'',''private_reports_syncing'',''private_confirmed_anchor_unavailable'',''private_block_lag_soft'',''private_time_lag_soft'',''private_latency_soft'''

-- 1. Transient chain faults: the class chainSince tracks and chainPauseSeconds bounds.
WITH t AS (
  SELECT observed_at, EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(reasons) x(v)
    WHERE x.v IN ('reference_count_below_quorum','reference_hash_quorum_unavailable','private_probe_failed',
      'private_reports_syncing','private_confirmed_anchor_unavailable','private_block_lag_soft',
      'private_time_lag_soft','private_latency_soft')) AS bad
  FROM rpc_health_samples),
s AS (SELECT observed_at, bad,
   row_number() OVER (ORDER BY observed_at) - row_number() OVER (PARTITION BY bad ORDER BY observed_at) AS grp FROM t),
runs AS (SELECT grp, EXTRACT(epoch FROM max(observed_at)-min(observed_at))+10 AS secs FROM s WHERE bad GROUP BY grp)
SELECT count(*) AS episodes, round(avg(secs)) AS mean_s,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY secs) AS p50,
  percentile_disc(0.9) WITHIN GROUP (ORDER BY secs) AS p90,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY secs) AS p95,
  percentile_disc(0.99) WITHIN GROUP (ORDER BY secs) AS p99, max(secs) AS max_s,
  count(*) FILTER (WHERE secs < 60) AS held_at_60,
  count(*) FILTER (WHERE secs < 300) AS held_at_300,
  count(*) FILTER (WHERE secs < 600) AS held_at_600
FROM runs;

-- 2. Hard chain faults: no pause budget covers these.
WITH t AS (
  SELECT observed_at, EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(reasons) x(v)
    WHERE x.v NOT IN ('recovery_hysteresis','reference_count_below_quorum','reference_hash_quorum_unavailable',
      'private_probe_failed','private_reports_syncing','private_confirmed_anchor_unavailable',
      'private_block_lag_soft','private_time_lag_soft','private_latency_soft')) AS bad
  FROM rpc_health_samples),
s AS (SELECT observed_at, bad,
   row_number() OVER (ORDER BY observed_at) - row_number() OVER (PARTITION BY bad ORDER BY observed_at) AS grp FROM t),
runs AS (SELECT grp, EXTRACT(epoch FROM max(observed_at)-min(observed_at))+10 AS secs FROM s WHERE bad GROUP BY grp)
SELECT count(*) AS episodes, percentile_disc(0.5) WITHIN GROUP (ORDER BY secs) AS p50,
  percentile_disc(0.9) WITHIN GROUP (ORDER BY secs) AS p90, max(secs) AS max_s FROM runs;

-- 3. The risk producer's own cadence, which riskPauseSeconds must sit above.
WITH g AS (SELECT EXTRACT(epoch FROM observed_at - lag(observed_at) OVER (ORDER BY observed_at)) AS gap
  FROM risk_snapshot_runs)
SELECT count(*) AS intervals, round(percentile_disc(0.5) WITHIN GROUP (ORDER BY gap)) AS p50,
  round(percentile_disc(0.9) WITHIN GROUP (ORDER BY gap)) AS p90,
  round(percentile_disc(0.99) WITHIN GROUP (ORDER BY gap)) AS p99, round(max(gap)) AS max_s,
  count(*) FILTER (WHERE gap > 30) AS over_30s, count(*) FILTER (WHERE gap > 180) AS over_180s FROM g;

-- 4. The same two, restricted to the live pilot's own window.
WITH t AS (
  SELECT observed_at, EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(reasons) x(v)
    WHERE x.v IN ('reference_count_below_quorum','reference_hash_quorum_unavailable','private_probe_failed',
      'private_reports_syncing','private_confirmed_anchor_unavailable','private_block_lag_soft',
      'private_time_lag_soft','private_latency_soft')) AS bad
  FROM rpc_health_samples
  WHERE observed_at BETWEEN '2026-09-12T14:24:00Z' AND '2026-09-15T06:00:00Z'),
s AS (SELECT observed_at, bad,
   row_number() OVER (ORDER BY observed_at) - row_number() OVER (PARTITION BY bad ORDER BY observed_at) AS grp FROM t),
runs AS (SELECT grp, EXTRACT(epoch FROM max(observed_at)-min(observed_at))+10 AS secs FROM s WHERE bad GROUP BY grp)
SELECT count(*) AS episodes_in_pilot_window, round(max(secs)) AS longest_s,
  count(*) FILTER (WHERE secs > 60) AS over_the_deployed_budget FROM runs;

WITH g AS (SELECT EXTRACT(epoch FROM observed_at - lag(observed_at) OVER (ORDER BY observed_at)) AS gap
  FROM risk_snapshot_runs WHERE observed_at BETWEEN '2026-09-12T14:24:00Z' AND '2026-09-15T06:00:00Z')
SELECT count(*) AS intervals, count(*) FILTER (WHERE gap > 30) AS over_30s,
  count(*) FILTER (WHERE gap > 60) AS over_60s, count(*) FILTER (WHERE gap > 180) AS over_180s,
  round(max(gap)) AS max_s FROM g;
