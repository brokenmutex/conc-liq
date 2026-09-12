const SVG_NS = "http://www.w3.org/2000/svg";
let refreshTimer;

function ageSeconds(value, now) {
  if (!value) return null;
  const age = (Date.parse(now) - Date.parse(value)) / 1000;
  return Number.isFinite(age) && age >= 0 ? Math.floor(age) : null;
}

function fresh(value, now, maxAge) {
  const age = ageSeconds(value, now);
  return age !== null && age <= maxAge;
}

function cursorSummary(overview) {
  const matches = overview.sync.blockLag === "0" && overview.sync.hashesMatch === true;
  const recent = fresh(overview.indexer.updatedAt, overview.serverTime, 180) &&
    fresh(overview.replay.updatedAt, overview.serverTime, 180);
  if (!recent) return "Stale or missing";
  return matches ? "Cursors aligned" : "Replay behind or mismatched";
}

function booleanStatus(value, whenTrue, whenFalse) {
  return value === null || value === undefined ? "Unknown" : value ? whenTrue : whenFalse;
}

// Display only. Never grants eligibility; the canary planner performs full preflight.
function focusRiskReasons(focus, now) {
  const recovery = focus.entryReadiness;
  const replacesFeed = recovery.chainEligible && fresh(recovery.evaluatedAt, now, 20);
  const reasons = focus.riskGate.reasons.filter((reason) => !(reason === "sequencer_feed_unavailable" && replacesFeed));
  if (!focus.riskGate.executionEligible && focus.riskGate.reasons.length === 0) reasons.push("risk_snapshot_ineligible");
  return reasons;
}

function element(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing dashboard element ${id}`);
  return node;
}

function setText(id, value) {
  element(id).textContent = value;
}

function compactInteger(value) {
  if (value === null || value === undefined) return "—";
  const number = BigInt(value);
  const units = [
    [1_000_000_000_000n, "T"],
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1_000n, "K"],
  ];
  for (const [divisor, suffix] of units) {
    if (number >= divisor) {
      const tenths = (number * 10n) / divisor;
      return `${tenths / 10n}.${tenths % 10n}${suffix}`;
    }
  }
  return number.toLocaleString("en-US");
}

function blockNumber(value) {
  return value === null ? "—" : BigInt(value).toLocaleString("en-US");
}

function shortAddress(value) {
  return value ? `${value.slice(0, 7)}…${value.slice(-5)}` : "—";
}

function duration(secondsValue) {
  if (secondsValue === null) return "—";
  const seconds = Number(secondsValue);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

function timeAgo(value, nowValue) {
  if (!value) return "—";
  const seconds = ageSeconds(value, nowValue);
  if (seconds === null) return "Invalid / future timestamp";
  return `${duration(String(seconds))} ago`;
}

function dated(value, now) {
  return value ? `${new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")} · ${timeAgo(value, now)}` : "No saved result";
}

function feeLabel(fee) {
  return `${(fee / 10_000).toFixed(fee % 10_000 === 0 ? 0 : 2)}%`;
}

function price(answer, decimals) {
  if (answer === null || decimals === null) return "Unavailable";
  const raw = BigInt(answer);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").slice(0, 4);
  return `$${whole.toLocaleString("en-US")}.${fraction}`;
}

function pill(label, tone = "neutral") {
  const node = document.createElement("span");
  node.className = `pill ${tone}`;
  node.textContent = label;
  return node;
}

function cell(value, className) {
  const node = document.createElement("td");
  if (value instanceof Node) node.append(value);
  else node.textContent = value;
  if (className) node.className = className;
  return node;
}

function rawAmount(value) {
  const node = document.createElement("span");
  node.className = "mono raw-amount";
  node.textContent = compactInteger(value);
  node.title = value;
  return node;
}

function displayTokenAmount(value, decimals, precision = 6) {
  const signed = BigInt(value);
  const negative = signed < 0n;
  const raw = negative ? -signed : signed;
  if (decimals === 0) {
    return `${negative ? "-" : ""}${raw.toLocaleString("en-US")}`;
  }
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0");
  const visible = fraction.slice(0, precision).replace(/0+$/, "");
  let displayed;
  if (visible.length === 0) {
    displayed = raw % scale === 0n
      ? whole.toLocaleString("en-US")
      : `< ${whole === 0n ? "0." : `${whole.toLocaleString("en-US")}.`}${"0".repeat(precision - 1)}1`;
  } else {
    displayed = `${whole.toLocaleString("en-US")}.${visible}`;
  }
  return negative ? `-${displayed}` : displayed;
}

function tokenAmount(value, decimals, symbol, detail) {
  const node = document.createElement("span");
  node.className = "mono raw-amount";
  node.textContent = `${displayTokenAmount(value, decimals)} ${symbol}`;
  node.title = `raw: ${value}${detail ? ` · ${detail}` : ""}`;
  return node;
}

function quoteAmount(value, decimals, showSignTone = false) {
  if (value === null) return document.createTextNode("—");
  const node = tokenAmount(value, decimals, "USDG");
  if (showSignTone) {
    const raw = BigInt(value);
    if (raw > 0n) node.classList.add("pnl-positive");
    if (raw < 0n) node.classList.add("pnl-negative");
  }
  return node;
}

function ppmPercent(value) {
  const ppm = BigInt(value);
  const whole = ppm / 10_000n;
  const fraction = (ppm % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}%`;
}

function signedPpmPercent(value) {
  if (value === null) return document.createTextNode("—");
  const raw = BigInt(value);
  const node = document.createElement("span");
  node.className = "mono raw-amount";
  node.textContent = `${raw > 0n ? "+" : raw < 0n ? "-" : ""}${ppmPercent(raw < 0n ? -raw : raw)}`;
  if (raw > 0n) node.classList.add("pnl-positive");
  if (raw < 0n) node.classList.add("pnl-negative");
  node.title = `${value} ppm`;
  return node;
}

function oraclePrice(value, symbol) {
  if (value === null) return document.createTextNode("—");
  const node = document.createElement("span");
  node.className = "mono raw-amount";
  node.textContent = `${displayTokenAmount(value, 18)} USDG/${symbol}`;
  node.title = `x18: ${value}`;
  return node;
}

function renderOverview(data) {
  const { overview, riskGate } = data;
  const exact = overview.sync.blockLag === "0" && overview.sync.hashesMatch === true;
  setText("sync-value", cursorSummary(overview));
  setText("sync-detail", exact ? "Block and hash agree; chain head is checked separately" : "Check replay cursor");
  setText("block-value", blockNumber(overview.indexer.block));
  setText("block-detail", `${timeAgo(overview.indexer.updatedAt, overview.serverTime)} · chain ${overview.chainId ?? "—"}`);
  setText("events-value", compactInteger(overview.indexedEvents));
  setText("events-detail", "Strictly replayed canonical events");
  setText("coverage-value", `${overview.poolCount} · ${compactInteger(overview.initializedTicks)} · ${compactInteger(overview.activePositions)}`);
  setText("coverage-detail", "Pools · initialized ticks · active positions");
  setText("risk-value", riskGate.executionEligible ? "Open" : "Closed");
  setText("risk-detail", `${riskGate.attemptStatus ?? "no attempt"} · ${timeAgo(riskGate.snapshotObservedAt, riskGate.evaluatedAt)}`);
  setText("stream-key", overview.streamKey);
  setText("gate-attempt", riskGate.attemptStatus ?? "Missing");
  setText(
    "gate-age",
    riskGate.snapshotAgeSeconds === null
      ? "Unavailable"
      : `${duration(String(riskGate.snapshotAgeSeconds))} / ${duration(String(riskGate.maxSnapshotAgeSeconds))}`,
  );
  setText(
    "gate-canonical",
    riskGate.blockCanonical === null
      ? "Unknown"
      : riskGate.blockCanonical
        ? `Hash verified · ${duration(String(riskGate.canonicalityAgeSeconds ?? 0))} ago`
        : "Mismatch",
  );
  setText("gate-session", data.sources.marketSession.status ?? "Unverified");

  const reasons = element("global-risk-reasons");
  reasons.replaceChildren();
  for (const reason of riskGate.reasons.filter((item) => !item.startsWith("asset_ineligible:"))) {
    const chip = document.createElement("span");
    chip.className = "reason-chip";
    chip.textContent = reason;
    reasons.append(chip);
  }
}

function renderFocus(data) {
  const { focus, overview } = data;
  const now = overview.serverTime;
  const { checkpoint, entryReadiness, rehearsal, lastPlan } = focus;
  const paperEntry = focus.paperEntry;
  setText("focus-session", paperEntry ? "24/7 entry evaluation" : entryReadiness.session === "regular_session" ? "Within entry window" : entryReadiness.session === "closed" ? "Closed for entry" : "Calendar unavailable");
  setText("focus-session-detail", paperEntry ? "Overnight, weekends and holidays included; reference and execution checks still apply." : "Legacy regular-equity-session entry policy.");
  setText("focus-chain", entryReadiness.chainEligible ? "Recovery observed" : "Not established");
  setText("focus-chain-detail", `${entryReadiness.sampleIds.length} samples · evaluated ${timeAgo(entryReadiness.evaluatedAt, now)} · RPC agreement is not L1 finality`);
  const riskReasons = paperEntry ? paperEntry.reasons : focusRiskReasons(focus, now);
  const nvda = data.riskAssets.find((asset) => asset.rwaSymbol === "NVDA");
  setText("focus-risk", riskReasons.length ? "Needs attention" : "No remaining findings");
  setText("focus-risk-detail", `Collector #${focus.riskGate.snapshotId ?? "—"} · ${timeAgo(focus.riskGate.snapshotObservedAt, now)}. NVDA price was ${duration(nvda?.oracleAgeSeconds ?? null)} old at collection. Recovery can cover only the missing sequencer feed.`);
  if (paperEntry) setText("focus-risk-detail", `Continuous paper policy · ${paperEntry.reference?.basis === "held_equity_reference" ? "held equity reference" : "feed reference"} · price age ${duration(paperEntry.reference?.ageSeconds === null || paperEntry.reference?.ageSeconds === undefined ? null : String(paperEntry.reference.ageSeconds))}. Pause, multiplier and canonicality checks remain active.`);
  const checkpointFresh = checkpoint && fresh(checkpoint.capturedAt, now, focus.checkpointMaxAgeSeconds) && fresh(checkpoint.blockTimestamp, now, focus.checkpointMaxAgeSeconds);
  const aligned = checkpoint && checkpoint.riskRunId === focus.riskGate.snapshotId;
  setText("focus-checkpoint", !checkpoint ? "Missing" : !checkpointFresh ? "Stale" : !aligned ? "Awaiting latest risk" : checkpoint.status === "valid" ? "Current · valid mark" : "Current · mark excluded");
  if (paperEntry && checkpointFresh) setText("focus-checkpoint", paperEntry.eligible ? "Current · paper checks pass" : "Current · see findings");
  element("focus-checkpoint").classList.toggle("attention", paperEntry ? !checkpointFresh || !paperEntry.eligible : !checkpointFresh || !aligned || checkpoint?.status !== "valid");
  element("focus-risk").classList.toggle("attention", riskReasons.length > 0);
  element("focus-session").classList.toggle("attention", !paperEntry && entryReadiness.session !== "regular_session");
  element("focus-chain").classList.toggle("attention", !entryReadiness.chainEligible);
  setText("focus-checkpoint-detail", checkpoint ? `#${checkpoint.id} · block ${blockNumber(checkpoint.block)} · ${dated(checkpoint.blockTimestamp, now)} · freshness limit ${focus.checkpointMaxAgeSeconds}s` : "No synchronized NVDA checkpoint");
  setText("focus-spot", checkpoint ? `${displayTokenAmount(checkpoint.poolPriceX18, 18)} USDG/NVDA` : "Unavailable");
  setText("focus-oracle", checkpoint?.oraclePriceX18 ? `${displayTokenAmount(checkpoint.oraclePriceX18, 18)} USDG/NVDA` : "Unavailable");
  setText("focus-deviation", checkpoint?.deviationPpm !== null && checkpoint?.deviationPpm !== undefined ? `${displayTokenAmount(checkpoint.deviationPpm, 4, 4)}%` : "Unavailable");
  setText("focus-reference-note", `${checkpoint?.status === "valid" && checkpointFresh && aligned ? "Valid at the stated checkpoint." : "Displayed marks are diagnostic; a stale or excluded mark cannot authorize entry."} Current preflight uses NVDA and USDG oracle checks. Hyperliquid remains research-only; a Nasdaq / last-close policy is not active.`);
  if (paperEntry) setText("focus-reference-note", `The paper policy permits ±${paperEntry.policy.maxDeviationPpm / 10000}% around the published token reference. Held prices retain their update time and must come from the most recent equity session, within ${paperEntry.policy.maxHeldAgeSeconds / 3600} hours. This is a reference bound, not an executable fill or a fresh Nasdaq quote.`);
  const paperRehearsal = data.paper?.execution?.rehearsal;
  setText("focus-rehearsal", paperRehearsal ? "Cash-to-cash calls verified" : rehearsal ? "LP calls verified on local fork" : "Evidence unavailable");
  setText("focus-rehearsal-detail", paperRehearsal
    ? `${dated(paperRehearsal.computedAt, now)} · source block ${blockNumber(paperRehearsal.block)} · swaps, LP calls and node gas estimates; no holding-period result`
    : rehearsal ? `${dated(rehearsal.completedAt, now)} · source block ${blockNumber(rehearsal.sourceBlock)} · no swaps or measured strategy profit` : "No validated local lifecycle artifact for this stream");
  setText("focus-plan", lastPlan ? `#${lastPlan.id} · ${lastPlan.status}` : "None saved");
  setText("focus-plan-detail", lastPlan ? `${dated(lastPlan.createdAt, now)} · historical result; rerun preflight before any approval` : "Wallet preflight is deferred until the paper session is reviewed. Live execution remains disabled.");
  setText("history-source", focus.historySource === "hypersync" ? "HyperSync" : "Legacy RPC history");
  setText("focus-index", cursorSummary(overview));
  setText("focus-index-detail", `Block ${blockNumber(overview.indexer.block)} · cursor updated ${timeAgo(overview.indexer.updatedAt, now)} · 180s freshness limit; not a head-lag measurement`);
  setText("accounting-mode", focus.fullAccountingEnabled ? "Enabled" : "Paused intentionally");
  setText("accounting-status-note", `${focus.fullAccountingEnabled ? "Full-universe snapshots enabled in configuration." : "Full-universe snapshots paused intentionally."} Saved capture: ${dated(data.accounting?.observedAt, now)}. These aggregate fees are not our earnings.`);
  const reasons = paperEntry ? [...paperEntry.reasons] : [...entryReadiness.reasons, ...riskReasons, ...(checkpoint?.reasons ?? ["checkpoint_missing"])];
  if (checkpoint && !checkpointFresh) reasons.push("checkpoint_stale");
  if (checkpoint && !aligned && !paperEntry) reasons.push("checkpoint_not_latest_risk_snapshot");
  element("focus-reasons").replaceChildren(...[...new Set(reasons)].map((reason) => {
    const node = document.createElement("span"); node.className = "reason-chip";
    node.textContent = reason.replaceAll("_", " "); node.title = reason; return node;
  }));
  for (const [key, result] of [["principal", data.principal], ["simulation", data.rangeSimulation], ["policy-replay", data.rangePolicyReplay], ["oracle-calibration", data.oracleCalibration], ["baseline", data.stableFeeBaseline]]) {
    setText(`${key}-date`, `Saved research result · ${dated(result?.computedAt, now)}`);
  }
}

function svgNode(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function renderActivity(rows) {
  const svg = element("activity-chart");
  svg.replaceChildren();
  element("activity-empty").classList.toggle("hidden", rows.length > 0);
  if (rows.length === 0) return;
  setText("activity-start", blockNumber(rows[0].blockStart));
  setText("activity-end", blockNumber(rows.at(-1).blockEnd));

  const width = 1_000;
  const height = 250;
  const top = 15;
  const bottom = 24;
  const plotHeight = height - top - bottom;
  const totals = rows.map((row) => Number(row.total));
  const max = Math.max(...totals, 1);
  for (let line = 0; line <= 4; line += 1) {
    const y = top + (plotHeight * line) / 4;
    svg.append(svgNode("line", {
      x1: 0, y1: y, x2: width, y2: y,
      stroke: "rgba(151,167,190,0.12)", "stroke-width": 1,
    }));
  }

  const slot = width / rows.length;
  const barWidth = Math.max(2, slot - Math.min(5, slot * 0.25));
  rows.forEach((row, index) => {
    const counts = [
      [Number(row.swap), "#46d7df"],
      [Number(row.mint), "#5fe0a5"],
      [Number(row.burn), "#ffbd62"],
      [Number(row.collect) + Number(row.flash) + Number(row.initialize), "#a684ff"],
    ];
    let cursorY = top + plotHeight;
    for (const [count, color] of counts) {
      const segmentHeight = (count / max) * plotHeight;
      if (segmentHeight <= 0) continue;
      cursorY -= segmentHeight;
      svg.append(svgNode("rect", {
        x: index * slot + (slot - barWidth) / 2,
        y: cursorY,
        width: barWidth,
        height: Math.max(segmentHeight, 1),
        rx: Math.min(2, barWidth / 3),
        fill: color,
        opacity: 0.82,
      }));
    }
    const hit = svgNode("rect", {
      x: index * slot,
      y: top,
      width: slot,
      height: plotHeight,
      fill: "transparent",
    });
    const title = svgNode("title");
    title.textContent = `Blocks ${blockNumber(row.blockStart)}–${blockNumber(row.blockEnd)} · ${Number(row.total).toLocaleString()} events · ${Number(row.swap).toLocaleString()} swaps`;
    hit.append(title);
    svg.append(hit);
  });
}

function renderPools(rows) {
  const body = element("pools-body");
  body.replaceChildren();
  for (const pool of rows) {
    const row = document.createElement("tr");
    row.append(
      cell(pool.rwaSymbol, "asset"),
      cell(feeLabel(pool.fee), "number"),
      cell(pool.tick === null ? "—" : pool.tick.toLocaleString(), "number mono"),
      cell(compactInteger(pool.liquidity), "number mono"),
      cell(compactInteger(pool.swapCount), "number"),
      cell(pool.activePositions, "number"),
      cell(pool.initializedTicks, "number"),
      cell(blockNumber(pool.lastEventBlock), "number mono"),
      cell(shortAddress(pool.poolAddress), "address"),
    );
    body.append(row);
  }
}

function renderAccounting(accounting, now) {
  const empty = accounting === null;
  element("accounting-empty").classList.toggle("hidden", !empty);
  element("accounting-table").classList.toggle("hidden", empty);
  element("accounting-audit").classList.toggle("hidden", empty);
  const body = element("accounting-body");
  body.replaceChildren();
  if (accounting === null) return;

  setText("accounting-run", `#${accounting.runId} · schema ${accounting.schemaVersion}`);
  setText("accounting-block", blockNumber(accounting.block));
  element("accounting-block").title = accounting.blockHash;
  setText("accounting-age", timeAgo(accounting.observedAt, now));
  setText(
    "accounting-coverage",
    `${accounting.poolCount} pools · ${compactInteger(accounting.tickCount)} ticks · ${compactInteger(accounting.positionCount)} positions`,
  );

  for (const pool of accounting.pools) {
    const row = document.createElement("tr");
    const token0 = document.createElement("span");
    token0.textContent = pool.token0Symbol;
    token0.title = pool.token0;
    const token1 = document.createElement("span");
    token1.textContent = pool.token1Symbol;
    token1.title = pool.token1;
    row.append(
      cell(`${pool.rwaSymbol} · ${feeLabel(pool.fee)}`, "asset"),
      cell(`${pool.activePositions} / ${pool.positions}`, "number"),
      cell(token0, "asset token-label"),
      cell(rawAmount(pool.tokensOwed0), "number"),
      cell(rawAmount(pool.pending0), "number"),
      cell(rawAmount(pool.claimable0), "number claimable"),
      cell(token1, "asset token-label"),
      cell(rawAmount(pool.tokensOwed1), "number"),
      cell(rawAmount(pool.pending1), "number"),
      cell(rawAmount(pool.claimable1), "number claimable"),
    );
    body.append(row);
  }
}

function renderAccountingHistory(rows, now) {
  const section = element("accounting-history");
  section.classList.toggle("hidden", rows.length === 0);
  const body = element("accounting-history-body");
  body.replaceChildren();
  rows.forEach((run, index) => {
    const older = rows[index + 1];
    const delta = older === undefined
      ? "—"
      : (BigInt(run.block) - BigInt(older.block)).toLocaleString("en-US");
    const block = document.createElement("span");
    block.className = "mono";
    block.textContent = blockNumber(run.block);
    block.title = run.blockHash;
    const row = document.createElement("tr");
    row.append(
      cell(`#${run.runId}`, "number mono"),
      cell(block, "number"),
      cell(delta, "number mono"),
      cell(timeAgo(run.observedAt, now), "number"),
      cell(run.poolCount, "number"),
      cell(compactInteger(run.tickCount), "number"),
      cell(compactInteger(run.positionCount), "number"),
    );
    body.append(row);
  });
}

function renderPrincipal(principal) {
  const empty = principal === null || principal === undefined;
  element("principal-empty").classList.toggle("hidden", !empty);
  element("principal-table").classList.toggle("hidden", empty);
  element("principal-audit").classList.toggle("hidden", empty);
  const body = element("principal-body");
  body.replaceChildren();
  if (empty) return;

  setText(
    "principal-run",
    `#${principal.principalRunId} · accounting #${principal.accountingRunId}`,
  );
  setText("principal-block", blockNumber(principal.block));
  element("principal-block").title = principal.blockHash;
  setText(
    "principal-positions",
    `${compactInteger(principal.positionCount)} across ${principal.poolCount} pools`,
  );
  setText(
    "principal-ranges",
    `${principal.belowRangePositions} below · ${principal.inRangePositions} in · ${principal.aboveRangePositions} above`,
  );
  for (const pool of principal.pools) {
    const row = document.createElement("tr");
    const token0 = document.createElement("span");
    token0.textContent = pool.token0Symbol;
    token0.title = pool.token0;
    const token1 = document.createElement("span");
    token1.textContent = pool.token1Symbol;
    token1.title = pool.token1;
    row.append(
      cell(`${pool.rwaSymbol} · ${feeLabel(pool.fee)}`, "asset"),
      cell(pool.positionCount, "number"),
      cell(pool.belowRangePositions, "number"),
      cell(pool.inRangePositions, "number"),
      cell(pool.aboveRangePositions, "number"),
      cell(token0, "asset token-label"),
      cell(rawAmount(pool.amount0), "number claimable"),
      cell(token1, "asset token-label"),
      cell(rawAmount(pool.amount1), "number claimable"),
    );
    body.append(row);
  }
}

function renderTrackedNftPositions(positions, now) {
  const empty = positions.length === 0;
  element("nft-empty").classList.toggle("hidden", !empty);
  element("nft-table").classList.toggle("hidden", empty);
  const body = element("nft-body");
  body.replaceChildren();
  for (const position of positions) {
    const id = document.createElement("span");
    id.className = "mono";
    id.textContent = `#${position.tokenId}`;
    id.title = `Accounting run #${position.accountingRunId}`;
    const owner = document.createElement("span");
    owner.className = "address";
    owner.textContent = shortAddress(position.ownerAddress);
    owner.title = position.ownerAddress;
    const sourceBlock = document.createElement("span");
    sourceBlock.className = "mono";
    sourceBlock.textContent = `${blockNumber(position.block)} · ${dated(position.computedAt, now)}`;
    sourceBlock.title = position.blockHash;
    const status = position.region === "in_range"
      ? pill("In range", "good")
      : position.region === "empty"
        ? pill("Empty", "neutral")
        : pill(position.region === "below_range" ? "Below" : "Above", "warn");
    const range = `${position.tickLower.toLocaleString()} → ${position.currentTick.toLocaleString()} → ${position.tickUpper.toLocaleString()}`;
    const pending0 = `pending raw: ${position.pending0}`;
    const pending1 = `pending raw: ${position.pending1}`;
    const row = document.createElement("tr");
    row.append(
      cell(id, "asset"),
      cell(`${position.rwaSymbol} · ${feeLabel(position.fee)}`, "asset"),
      cell(status),
      cell(range, "mono number"),
      cell(tokenAmount(position.principal0, position.token0Decimals, position.token0Symbol), "number"),
      cell(tokenAmount(position.claimable0, position.token0Decimals, position.token0Symbol, pending0), "number claimable"),
      cell(tokenAmount(position.principal1, position.token1Decimals, position.token1Symbol), "number"),
      cell(tokenAmount(position.claimable1, position.token1Decimals, position.token1Symbol, pending1), "number claimable"),
      cell(owner),
      cell(sourceBlock, "number"),
    );
    body.append(row);
  }
}

function renderRangeSimulation(simulation) {
  const empty = simulation === null || simulation === undefined;
  element("simulation-empty").classList.toggle("hidden", !empty);
  element("simulation-table").classList.toggle("hidden", empty);
  element("simulation-audit").classList.toggle("hidden", empty);
  const assumptions = element("simulation-assumptions");
  assumptions.classList.toggle("hidden", empty);
  assumptions.replaceChildren();
  const body = element("simulation-body");
  body.replaceChildren();
  if (empty) return;
  setText(
    "simulation-run",
    `#${simulation.simulationRunId} · ${simulation.rwaSymbol} ${feeLabel(simulation.fee)}`,
  );
  setText(
    "simulation-interval",
    `#${simulation.fromRunId} → #${simulation.toRunId}`,
  );
  element("simulation-interval").title =
    `Blocks ${blockNumber(simulation.fromBlock)} → ${blockNumber(simulation.toBlock)}`;
  setText(
    "simulation-capital",
    `${displayTokenAmount(simulation.budgetQuote, simulation.quoteDecimals)} USDG · ${displayTokenAmount(simulation.costQuote, simulation.quoteDecimals)} cost`,
  );
  setText(
    "simulation-path",
    `${simulation.pathMinTick.toLocaleString()} → ${simulation.pathMaxTick.toLocaleString()} · ${simulation.completedCandidates} completed / ${simulation.excludedCandidates} excluded`,
  );
  element("simulation-path").title = `${compactInteger(simulation.swapCount)} indexed swaps`;
  for (const assumption of simulation.assumptions) {
    const chip = document.createElement("span");
    chip.className = "reason-chip";
    chip.textContent = assumption;
    assumptions.append(chip);
  }
  for (const candidate of simulation.candidates) {
    const complete = candidate.status === "complete";
    const status = complete
      ? pill("Stayed in range", "neutral")
      : pill("Excluded", "warn");
    status.title = candidate.exclusionReason ?? "Observed path stayed inside range";
    const row = document.createElement("tr");
    row.append(
      cell(candidate.rank === null ? "—" : `#${candidate.rank}`, "number mono"),
      cell(`${candidate.halfWidthSpacings} × ${simulation.tickSpacing}`, "number mono"),
      cell(`${candidate.tickLower.toLocaleString()} → ${candidate.tickUpper.toLocaleString()}`, "mono number"),
      cell(status),
      cell(ppmPercent(candidate.liquiditySharePpm), "number"),
      cell(quoteAmount(candidate.feeValueQuote, simulation.quoteDecimals), "number claimable"),
      cell(quoteAmount(candidate.divergenceQuote, simulation.quoteDecimals, true), "number"),
      cell(quoteAmount(candidate.absolutePnlQuote, simulation.quoteDecimals, true), "number"),
      cell(quoteAmount(candidate.lpAlphaQuote, simulation.quoteDecimals, true), "number"),
      cell(quoteAmount(candidate.netEndValueQuote, simulation.quoteDecimals), "number"),
    );
    body.append(row);
  }
}

function renderRangePolicyReplay(replay) {
  const empty = replay === null || replay === undefined;
  element("policy-replay-empty").classList.toggle("hidden", !empty);
  element("policy-replay-table").classList.toggle("hidden", empty);
  element("policy-replay-audit").classList.toggle("hidden", empty);
  const assumptions = element("policy-replay-assumptions");
  assumptions.classList.toggle("hidden", empty);
  assumptions.replaceChildren();
  const body = element("policy-replay-body");
  body.replaceChildren();
  if (empty) return;
  setText(
    "policy-replay-run",
    `#${replay.replayRunId} · ${replay.rwaSymbol} ${feeLabel(replay.fee)}`,
  );
  setText(
    "policy-replay-interval",
    `#${replay.firstRunId} → #${replay.lastRunId} · ${replay.checkpointCount} points`,
  );
  element("policy-replay-interval").title =
    `Blocks ${blockNumber(replay.firstBlock)} → ${blockNumber(replay.lastBlock)}`;
  setText(
    "policy-replay-capital",
    `${displayTokenAmount(replay.budgetQuote, replay.quoteDecimals)} USDG · ${displayTokenAmount(replay.entryCostQuote, replay.quoteDecimals)} entry · ${displayTokenAmount(replay.rebalanceCostQuote, replay.quoteDecimals)} / recenter`,
  );
  setText(
    "policy-replay-trigger",
    `${replay.triggerPercent}% of half-width · ${replay.completedCandidates} complete / ${replay.excludedCandidates} excluded`,
  );
  for (const assumption of replay.assumptions) {
    const chip = document.createElement("span");
    chip.className = "reason-chip";
    chip.textContent = assumption;
    assumptions.append(chip);
  }
  for (const candidate of replay.candidates) {
    const complete = candidate.status === "complete";
    const status = complete
      ? pill("Complete", "good")
      : pill("Stopped", "warn");
    status.title = candidate.failureReason === null
      ? "All observed interval paths stayed in range"
      : `${candidate.failureReason} at checkpoint #${candidate.failureRunId}`;
    const row = document.createElement("tr");
    row.append(
      cell(candidate.rank === null ? "—" : `#${candidate.rank}`, "number mono"),
      cell(`${candidate.halfWidthSpacings} × ${replay.tickSpacing}`, "number mono"),
      cell(status),
      cell(`${candidate.completedIntervals} / ${replay.intervalCount}`, "number mono"),
      cell(candidate.rebalances.toLocaleString(), "number"),
      cell(quoteAmount(candidate.feeValueQuote, replay.quoteDecimals), "number claimable"),
      cell(quoteAmount(candidate.totalCostQuote, replay.quoteDecimals), "number"),
      cell(ppmPercent(candidate.maxDrawdownPpm), "number"),
      cell(quoteAmount(candidate.absolutePnlQuote, replay.quoteDecimals, true), "number"),
      cell(quoteAmount(candidate.lpAlphaQuote, replay.quoteDecimals, true), "number"),
      cell(quoteAmount(candidate.finalNavQuote, replay.quoteDecimals), "number"),
    );
    body.append(row);
  }
}

function renderOracleCalibration(calibration) {
  const empty = calibration === null || calibration === undefined;
  element("oracle-calibration-empty").classList.toggle("hidden", !empty);
  element("oracle-calibration-table").classList.toggle("hidden", empty);
  element("oracle-calibration-audit").classList.toggle("hidden", empty);
  const assumptions = element("oracle-calibration-assumptions");
  assumptions.classList.toggle("hidden", empty);
  assumptions.replaceChildren();
  const body = element("oracle-calibration-body");
  body.replaceChildren();
  if (empty) return;
  setText(
    "oracle-calibration-run",
    `#${calibration.calibrationRunId} · ${calibration.rwaSymbol} ${feeLabel(calibration.fee)}`,
  );
  setText(
    "oracle-calibration-window",
    `#${calibration.firstRunId} → #${calibration.lastRunId}`,
  );
  setText(
    "oracle-calibration-coverage",
    `${calibration.validMarks} valid / ${calibration.excludedMarks} excluded · max ${duration(String(calibration.maxPriceAgeSeconds))}`,
  );
  setText(
    "oracle-calibration-source",
    calibration.feedDirectorySha256.slice(0, 19),
  );
  element("oracle-calibration-source").title =
    `${calibration.feedDirectorySha256} · fetched ${calibration.feedDirectoryFetchedAt}`;
  for (const assumption of calibration.assumptions) {
    const chip = document.createElement("span");
    chip.className = "reason-chip";
    chip.textContent = assumption;
    assumptions.append(chip);
  }
  for (const mark of calibration.marks) {
    const stableMultiplier = mark.tokenUiMultiplier !== null &&
      mark.tokenUiMultiplier === mark.tokenNewUiMultiplier &&
      mark.oraclePaused === false;
    const guard = stableMultiplier
      ? pill("Stable", "good")
      : pill(mark.oraclePaused ? "Paused" : "Transition", "warn");
    guard.title = mark.tokenUiMultiplier === null
      ? "Token risk state unavailable"
      : `ui ${mark.tokenUiMultiplier} · next ${mark.tokenNewUiMultiplier}`;
    const status = mark.status === "valid"
      ? pill("Valid", "good")
      : pill("Excluded", "warn");
    status.title = mark.reasons.length === 0
      ? "Fresh, positive, complete oracle rounds"
      : mark.reasons.join(", ");
    const block = document.createElement("span");
    block.className = "mono";
    block.textContent = blockNumber(mark.blockNumber);
    block.title = mark.blockTimestamp;
    const row = document.createElement("tr");
    row.append(
      cell(`#${mark.accountingRunId}`, "number mono"),
      cell(block, "number"),
      cell(oraclePrice(mark.poolPriceX18, calibration.rwaSymbol), "number"),
      cell(oraclePrice(mark.oraclePriceX18, calibration.rwaSymbol), "number"),
      cell(signedPpmPercent(mark.deviationPpm), "number"),
      cell(mark.rwaOracleAgeSeconds === null ? "—" : duration(mark.rwaOracleAgeSeconds), "number"),
      cell(mark.quoteOracleAgeSeconds === null ? "—" : duration(mark.quoteOracleAgeSeconds), "number"),
      cell(guard),
      cell(status),
    );
    body.append(row);
  }
}

function renderStableFeeBaseline(baseline) {
  const empty = baseline === null || baseline === undefined;
  element("baseline-empty").classList.toggle("hidden", !empty);
  element("baseline-table").classList.toggle("hidden", empty);
  element("baseline-audit").classList.toggle("hidden", empty);
  const limitations = element("baseline-limitations");
  limitations.classList.toggle("hidden", empty);
  limitations.replaceChildren();
  const body = element("baseline-body");
  body.replaceChildren();
  if (empty) return;

  setText("baseline-runs", `#${baseline.fromRunId} → #${baseline.toRunId}`);
  setText(
    "baseline-interval",
    `${duration(baseline.elapsedSeconds)} · ${compactInteger(baseline.blockDelta)} blocks`,
  );
  setText(
    "baseline-coverage",
    `${baseline.stablePositions} / ${baseline.pairedActivePositions} paired`,
  );
  setText(
    "baseline-turnover",
    `${baseline.touchedPositions} touched · ${baseline.enteredPositions} in · ${baseline.exitedPositions} out`,
  );
  for (const limitation of baseline.limitations) {
    const chip = document.createElement("span");
    chip.className = "reason-chip";
    chip.textContent = limitation;
    limitations.append(chip);
  }
  for (const pool of baseline.pools) {
    const row = document.createElement("tr");
    const token0 = document.createElement("span");
    token0.textContent = pool.token0Symbol;
    token0.title = pool.token0;
    const token1 = document.createElement("span");
    token1.textContent = pool.token1Symbol;
    token1.title = pool.token1;
    row.append(
      cell(`${pool.rwaSymbol} · ${feeLabel(pool.fee)}`, "asset"),
      cell(`${pool.stablePositions} / ${pool.pairedActivePositions}`, "number"),
      cell(pool.touchedPositions, "number"),
      cell(pool.enteredPositions, "number"),
      cell(pool.exitedPositions, "number"),
      cell(token0, "asset token-label"),
      cell(rawAmount(pool.accrued0), "number claimable"),
      cell(token1, "asset token-label"),
      cell(rawAmount(pool.accrued1), "number claimable"),
    );
    body.append(row);
  }
}

function renderRisk(rows) {
  const body = element("risk-body");
  body.replaceChildren();
  for (const risk of rows) {
    const row = document.createElement("tr");
    const nonGlobalReasons = risk.reasons.filter((reason) =>
      reason !== "market_session_unverified" && reason !== "sequencer_feed_unavailable"
    );
    row.append(
      cell(risk.rwaSymbol, "asset"),
      cell(pill(risk.executionEligible ? "Open" : "Closed", risk.executionEligible ? "good" : "bad")),
      cell(price(risk.answer, risk.feedDecimals), "number"),
      cell(duration(risk.oracleAgeSeconds), "number"),
      cell(pill(booleanStatus(risk.tradingTradable, "Tradable", "Blocked"), risk.tradingTradable === true ? "good" : risk.tradingTradable === false ? "bad" : "warn")),
      cell(pill(booleanStatus(risk.multiplierConsistent, "Match", "Mismatch"), risk.multiplierConsistent === true ? "good" : risk.multiplierConsistent === false ? "bad" : "warn")),
      cell(pill(booleanStatus(risk.oraclePaused, "Paused", "No"), risk.oraclePaused === false ? "good" : risk.oraclePaused === true ? "bad" : "warn")),
      cell(pill(booleanStatus(risk.corporateActionPending, "Pending", "None"), risk.corporateActionPending === false ? "good" : "warn")),
      cell(nonGlobalReasons.length === 0 ? "Global gate only" : nonGlobalReasons.join(" · "), "reasons-cell"),
    );
    body.append(row);
  }
}

function renderPositions(rows) {
  const body = element("positions-body");
  body.replaceChildren();
  for (const position of rows) {
    const row = document.createElement("tr");
    const span = position.minTickLower === null
      ? "—"
      : `${position.minTickLower.toLocaleString()} → ${position.maxTickUpper.toLocaleString()}`;
    row.append(
      cell(`${position.rwaSymbol} · ${feeLabel(position.fee)}`, "asset"),
      cell(position.activePositions, "number"),
      cell(position.distinctOwners, "number"),
      cell(span, "mono"),
    );
    body.append(row);
  }
}

function renderAttempts(rows, now) {
  const list = element("attempts-list");
  list.replaceChildren();
  for (const attempt of rows) {
    const row = document.createElement("div");
    row.className = "attempt-row";
    const main = document.createElement("div");
    main.className = "attempt-main";
    const block = document.createElement("div");
    block.className = "attempt-block";
    block.textContent = attempt.block === null ? `Attempt #${attempt.id}` : `Block ${blockNumber(attempt.block)}`;
    const detail = document.createElement("div");
    detail.className = attempt.error ? "attempt-error" : "muted";
    detail.textContent = attempt.error ?? timeAgo(attempt.completedAt, now);
    main.append(block, detail);
    row.append(
      pill(attempt.status, attempt.status === "succeeded" ? "good" : attempt.status === "failed" ? "bad" : "warn"),
      main,
      document.createTextNode(attempt.executionEligible === true ? "gate open" : "gate closed"),
    );
    list.append(row);
  }
}

function renderSource(prefix, source, now) {
  const link = element(`${prefix}-url`);
  link.textContent = source.url ?? "Unavailable";
  if (source.url) link.href = source.url;
  else link.removeAttribute("href");
  setText(`${prefix}-hash`, source.sha256 ?? "—");
  setText(`${prefix}-time`, timeAgo(source.fetchedAt, now));
}

const sessionNames = {market:"Market",regular:"Market",premarket:"Premarket",non_market:"Non-market",afterhours:"After-hours",overnight:"Overnight",weekend:"Weekend",holiday:"Holiday",mixed_boundary:"Mixed boundary",unknown:"Unknown",calendar_unavailable:"Unknown calendar"};
const sessionColors = {market:"#46d7df",premarket:"#f6bb68",non_market:"#8a84ed",unknown:"#9c9c9c"};
function estimatedSessionApy(returnBpsPerHour) {
  if (returnBpsPerHour === null || returnBpsPerHour === undefined || !Number.isFinite(returnBpsPerHour)) return "—";
  const hourly = returnBpsPerHour / 10000;
  if (hourly < -1) return "—";
  const percent = hourly === -1 ? -100 : Math.expm1(8760 * Math.log1p(hourly)) * 100;
  if (!Number.isFinite(percent)) return "—";
  return `${Math.abs(percent) >= 1e6 ? percent.toExponential(2) : percent.toFixed(2)}%`;
}
function renderSessionPerformance(report, now) {
  const table=element("paper-session-totals"),boundaryTable=element("paper-session-boundaries"),chart=element("paper-session-chart");
  table.replaceChildren();boundaryTable.replaceChildren();chart.replaceChildren();
  element("paper-session-empty").classList.remove("hidden");
  setText("paper-session-reconciliation", "");setText("paper-session-chart-note", "");
  if(!report?.valid){setText("paper-session-status",report?.reason??"Session attribution is unavailable until campaign history is validated.");return;}
  const day=element("paper-session-day"),grouping=element("paper-session-grouping"),metric=element("paper-session-metric");
  const selectedDay=day.value||"all";
  const options=[{value:"all",label:"Whole campaign"},...report.days.filter(d=>d.day!=="mixed_boundary").map(d=>({value:d.day,label:d.day})).reverse()];
  day.replaceChildren(...options.map(o=>{const option=document.createElement("option");option.value=o.value;option.textContent=o.label;return option;}));
  day.value=options.some(o=>o.value===selectedDay)?selectedDay:"all";
  for(const control of [day,grouping,metric])control.onchange=()=>renderSessionPerformance(report,now);
  const money=v=>v===null||v===undefined?"—":displayTokenAmount(v,6,6);
  const selected=day.value==="all"?report:report.days.find(d=>d.day===day.value);
  const buckets=selected?.[grouping.value||"grouped"]??[];
  setText("paper-session-status",`${report.markCount.toLocaleString()} recorded marks · ${report.boundaryCount} session boundaries · through ${report.sourceThrough?dated(report.sourceThrough,now):"first mark pending"}. All session totals use the complete campaign history; chart points may be sampled.`);
  for(const b of buckets){
    const row=document.createElement("tr");
    row.append(cell(sessionNames[b.key]??b.key),cell(`${b.hours.toFixed(2)} / ${b.activeHours.toFixed(2)}`,"number"),cell(money(b.netPnlQuote),"number mono"),
      cell(money(b.alphaQuote),"number mono"),cell(money(b.feeIncomeQuote),"number mono"),cell(money(b.gasQuote),"number mono"),cell(money(b.swapCostVsSpotQuote),"number mono"),
      cell(money(b.pnlPerHourQuote),"number mono"),cell(estimatedSessionApy(b.returnBpsPerHour),"number"),
      cell(`${b.recenters} / ${b.swaps}`,"number"),cell(b.sampledInRangePercent===null?"—":`${b.sampledInRangePercent.toFixed(1)}%`,"number"));
    if(b.key==="mixed_boundary")row.className="attention";table.append(row);
  }
  const mixed=report.grouped.find(b=>b.key==="mixed_boundary");
  setText("paper-session-reconciliation",`Campaign reconciliation: ${money(report.netPnlQuote)} USDG net P&L − ${money(report.exitReserveQuote)} USDG exit reserve = ${money(report.navPnlQuote)} USDG dashboard P&L. Mixed-boundary contribution: ${money(mixed?.netPnlQuote)} USDG. Rates use observed hours and capital; sparse sessions are not rankings.`);
  const ny=at=>new Date(at).toLocaleString("en-GB",{timeZone:"America/New_York",hour12:false});
  const ticks=p=>p.tickLower===null||p.tickLower===undefined?"Cash":`${p.tickLower}–${p.tickUpper}`;
  const exposure=p=>p.exposurePpm===undefined?"—":`${(Number(p.exposurePpm)/10000).toFixed(1)}%`;
  for(const b of report.boundaries.filter(b=>day.value==="all"||b.from.day===day.value||b.to.day===day.value).slice(-30).reverse()){
    const row=document.createElement("tr");row.append(cell(ny(b.at)),cell(`${sessionNames[b.from.regime]} → ${sessionNames[b.to.regime]}`),
      cell(`${new Date(b.before.sourceAt).toISOString().slice(11,19)} → ${new Date(b.after.sourceAt).toISOString().slice(11,19)}`),
      cell(`${money(b.before.navQuote)} → ${money(b.after.navQuote)}`,"number mono"),cell(`${exposure(b.before)} → ${exposure(b.after)}`),cell(`${ticks(b.before)} → ${ticks(b.after)}`));
    row.title=`Bracketed marks, not exact boundary values. Before: ${b.before.sourceAt}; after: ${b.after.sourceAt}`;boundaryTable.append(row);
  }
  const points=report.timeline.filter(p=>day.value==="all"||p.day===day.value);
  if(!points.length){setText("paper-session-chart-note","No marked observations for this period yet.");return;}
  element("paper-session-empty").classList.add("hidden");
  const mode=metric.value||"value",width=Math.max(chart.clientWidth,300),height=280;
  chart.setAttribute("viewBox",`0 0 ${width} ${height}`);
  const first=Date.parse(points[0].sourceAt),last=Date.parse(points.at(-1).sourceAt),span=Math.max(last-first,1);
  const x=at=>75+(Date.parse(at)-first)/span*(width-95);
  const fields=mode==="value"?[["navQuote","#5fe0a5"],["holdQuote","#46d7df"]]:mode==="inventory"?[["exposurePpm","#f6bb68"]]:[["tick","#f6bb68"],["tickLower","#8a84ed"],["tickUpper","#8a84ed"]];
  const scale=mode==="value"?1e6:mode==="inventory"?1e4:1;
  const values=points.flatMap(p=>fields.map(([key])=>p[key])).filter(v=>v!==null&&v!==undefined).map(v=>Number(v)/scale);
  const low=mode==="inventory"?0:Math.min(...values),high=mode==="inventory"?100:Math.max(...values),spread=Math.max(high-low,mode==="range"?10:.01);
  const y=v=>195-((Number(v)/scale-low)+spread*.1)/(spread*1.2)*170;
  for(let i=0;i<points.length-1;i++){
    const p=points[i],next=points[i+1];chart.append(svgNode("rect",{x:x(p.sourceAt),y:20,width:Math.max(0,x(next.sourceAt)-x(p.sourceAt)),height:180,fill:sessionColors[p.group]??"#9c9c9c",opacity:.07}));
  }
  for(const mark of [low,high]){const label=svgNode("text",{x:0,y:y(mark*scale),fill:"#8592a5","font-size":12});label.textContent=mode==="range"?Math.round(mark).toString():mark.toFixed(2);chart.append(label);}
  const timeTicks = last > first ? Math.max(2, Math.min(6, Math.floor((width - 95) / 135))) : 0;
  const timeLabel = new Intl.DateTimeFormat("en-GB", {timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
  const dateLabel = new Intl.DateTimeFormat("en-GB", {timeZone:"America/New_York",month:"short",day:"2-digit"});
  chart.append(svgNode("line", {x1:75,x2:width-20,y1:205,y2:205,stroke:"#8592a5",opacity:.6}));
  for(let i=0;i<=timeTicks;i++){
    const at=first+(last-first)*(timeTicks ? i/timeTicks : 0),position=x(new Date(at).toISOString());
    const anchor=i===0?"start":i===timeTicks?"end":"middle";
    chart.append(svgNode("line",{x1:position,x2:position,y1:205,y2:211,stroke:"#8592a5"}));
    for(const [y,text] of [[228,timeLabel.format(at)],[244,dateLabel.format(at)]]){
      const label=svgNode("text",{x:position,y,fill:"#8592a5","font-size":11,"text-anchor":anchor,"data-time-axis":"true"});
      label.textContent=text;chart.append(label);
    }
  }
  const axisLabel=svgNode("text",{x:(width+55)/2,y:270,fill:"#8592a5","font-size":11,"text-anchor":"middle"});
  axisLabel.textContent="Source time · New York (ET)";chart.append(axisLabel);
  for(const [field,color] of fields){
    let line=[],previousPoint=null;const flush=()=>{if(line.length)chart.append(svgNode("polyline",{points:line.join(" "),stroke:color,"stroke-width":2,fill:"none"}));line=[];previousPoint=null;};
    for(const p of points){if(p[field]===null||p[field]===undefined){flush();continue;}if(mode==="range"&&field!=="tick"&&previousPoint)line.push(`${x(p.sourceAt)},${y(previousPoint[field])}`);line.push(`${x(p.sourceAt)},${y(p[field])}`);previousPoint=p;}
    flush();
  }
  for(const b of report.boundaries){const at=Date.parse(b.at);if(at<first||at>last)continue;
    const line=svgNode("line",{x1:x(b.at),x2:x(b.at),y1:15,y2:200,stroke:"#8592a5","stroke-dasharray":"3 4",opacity:.8});
    const title=svgNode("title");title.textContent=`${ny(b.at)} New York · ${sessionNames[b.from.regime]} → ${sessionNames[b.to.regime]} · bracketed values`;line.append(title);chart.append(line);
  }
  for(const p of points){
    const field=fields[0][0];if(p[field]===null||p[field]===undefined)continue;
    const dot=svgNode("circle",{cx:x(p.sourceAt),cy:y(p[field]),r:p.action==="recenter"?4:2,fill:p.action==="recenter"?"#ff8290":fields[0][1]});
    const title=svgNode("title");title.textContent=`${ny(p.sourceAt)} New York · ${sessionNames[p.regime]} · ${p.action}\nNAV ${money(p.navQuote)} USDG · USDG tokens ${money(p.usdg)} · NVDA ${displayTokenAmount(p.nvda,18,6)}\nNVDA exposure ${exposure(p)} · range ${ticks(p)} · pool tick ${p.tick}\nPool price ${displayTokenAmount(p.priceQuoteX18,18,4)} USDG/NVDA · block ${p.block}\nFees in interval ${money(p.feesThisIntervalQuote)} USDG · gas at mark ${money(p.gasThisMarkQuote)} USDG · ${p.attribution}`;
    dot.append(title);chart.append(dot);
  }
  setText("paper-session-chart-note",`${new Date(first).toISOString()} → ${new Date(last).toISOString()}. ${mode==="range"?"Orange: pool tick; purple: LP range. Tick prices move inversely to USDG/NVDA; hover for the quoted price.":mode==="inventory"?"NVDA share of gross token inventory (%).":"Green: NAV after exit reserve; cyan: original passive holdings."} Background: cyan market, amber premarket, purple non-market. Dashed lines: session boundaries. Red points: recenter. Hover over points for balances and costs.${report.chartSampled?" Chart sampled; all marks remain in the database and totals.":""}`);
}

function renderPaper(paper, now) {
  renderSessionPerformance(paper?.performance, now);
  setText("paper-liquidity-share", "");setText("paper-fee-model", "");
  const repair=paper?.state?.boundaryRepair;
  setText("paper-repair-note",repair?`Accounting reconciled at ${new Date(repair.at).toISOString()} for ${repair.inputs.map(i=>new Date(i.checkpoint.blockTimestamp).toISOString()).join(" → ")}. The position stayed in range; no trades were added. The original interruption record is retained for audit.`:"");
  const periods=paper?.performance?.feePeriods??[];
  setText("paper-session-fee-basis",periods.length>1?`Fee accounting changed during this campaign: ${periods.map(p=>`${p.kind==="diluted_segments_v1"?"added-liquidity adjustment":"original observed-growth estimate"} from ${new Date(p.fromSourceAt).toISOString()}`).join("; ")}. P&L and APY retain the fee basis used at each mark.`:periods[0]?.kind==="diluted_segments_v1"?"Fees include the added-liquidity adjustment on the recorded market path.":"");
  element("paper-execution-runs").replaceChildren();
  setText("paper-execution-proof", "No transaction simulation evidence available.");
  setText("paper-reference", "No paper reference decision recorded yet.");
  setText("paper-lifecycle", "Entry → holding period → withdrawal and sale back to USDG");
  setText("paper-campaign", "");
  setText("paper-pnl-note", "Unavailable until fills and costs have evidence");
  const receiptCosts = element("paper-receipt-costs");
  receiptCosts.replaceChildren();
  element("paper-receipt-empty").classList.remove("hidden");
  setText("paper-cost-status", "Awaiting transaction simulation");
  const journal = element("paper-journal");
  journal.replaceChildren();
  for (const key of ["nav", "pnl", "alpha", "hold", "fees", "costs", "drawdown", "budget", "coverage"]) setText(`paper-${key}`, "—");
  element("paper-reasons").replaceChildren();
  if (!paper) {
    setText("paper-status", "No paper session has been started.");
    setText("paper-freshness", "No performance evidence yet");
    setText("paper-policy", "Paper fills require transaction simulation and evidence for execution costs.");
    return;
  }
  const { state, policy } = paper;
  const amount = value => value === null ? "—" : `${displayTokenAmount(value, 6)} USDG`;
  if (policy.reentry) {
    const c = paper.campaign;
    const automation = state.reentryStoppedAt || state.status === "invalid" ? "Automatic reentry stopped" : `Automatic reentry enabled · ${policy.reentry.cooldownSeconds / 60} min cooldown after exit; fresh entry checks required`;
    setText("paper-campaign", c?.valid
      ? `${automation}. Experiment from session #${c.rootSessionId} · ${c.sessionIds.length} sessions · cumulative P&L ${amount(c.pnlQuote)} · alpha versus original passive holdings ${amount(c.alphaQuote)} · total estimated gas ${amount(c.costsPaidQuote)}. Marks as of ${c.sourceAt ? dated(c.sourceAt, now) : "entry pending"}. Figures below cover this session.`
      : `${automation}. Cumulative performance unavailable: prior session evidence is invalid.`);
  }
  const needsSimulation = policy.executionBasis === "transaction_simulation";
  const usesTransactions = policy.executionBasis === "nitro_fork_v1";
  const rehearsal = paper.execution?.rehearsal;
  if (rehearsal) setText("paper-execution-proof", `Execution rehearsal: ${rehearsal.transactions} calls verified at block ${blockNumber(rehearsal.block)} · ${dated(rehearsal.computedAt, now)}. Cash change ${displayTokenAmount(rehearsal.cashDeltaQuote, 6)} USDG before ${displayTokenAmount(rehearsal.totalGasWei, 18, 9)} ETH estimated gas. This immediate round trip is not forward strategy performance.`);
  for (const run of paper.execution?.runs ?? []) {
    const row = document.createElement("tr");
    row.append(cell(run.action), cell(run.status), cell(run.gasWei === null ? "—" : displayTokenAmount(run.gasWei, 18, 9), "number mono"),
      cell(blockNumber(run.block), "mono"), cell(dated(run.observedAt, now)));
    if (run.error) row.title = run.error;
    element("paper-execution-runs").append(row);
  }
  for (const cost of paper.receiptCosts ?? []) {
    const row = document.createElement("tr");
    row.append(cell(cost.actionClass.replaceAll("_", " ")),
      cell(compactInteger(cost.transactions), "number"),
      cell(`${displayTokenAmount(cost.minFeeWei, 18)} – ${displayTokenAmount(cost.maxFeeWei, 18)}`, "number mono"),
      cell(`${blockNumber(cost.firstBlock)}–${blockNumber(cost.lastBlock)}`, "mono"),
      cell(dated(cost.collectedAt, now)));
    receiptCosts.append(row);
  }
  element("paper-receipt-empty").classList.toggle("hidden", receiptCosts.children.length > 0);
  element("paper-policy").title = `Policy SHA-256 ${paper.policyHash} · started ${paper.createdAt}`;
  const labels = { waiting: "Waiting for eligible live inputs", entry_pending: "Entry signaled · waiting for a later checkpoint", open: "Paper position open", exit_pending: "Exit signaled · waiting for a later checkpoint", closed: "Paper position closed", invalid: "Performance incomplete · session stopped" };
  const statusLabel = needsSimulation && state.status === "waiting"
    ? "Observing live inputs · transaction simulator not implemented" : labels[state.status];
  setText("paper-status", `Session #${paper.id} · ${statusLabel} · ${policy.mode === "guarded" ? "intended live entry gates" : "continuous research; may be ineligible live"}`);
  const terminal = state.status === "closed" || state.status === "invalid";
  const heartbeatFresh = fresh(paper.heartbeatAt, now, 60);
  setText("paper-freshness", `${terminal ? "Session finished" : heartbeatFresh ? "Paper worker responding" : "Paper worker stale or unavailable"} · last heartbeat ${timeAgo(paper.heartbeatAt, now)} · ${state.last ? `valuation/source block ${blockNumber(state.last.block)} at ${dated(state.last.blockTimestamp, now)}` : "awaiting first checkpoint captured after session start"}`);
  element("paper-freshness").classList.toggle("attention", (!terminal && !heartbeatFresh) || state.status === "invalid" || (state.last && !fresh(state.last.blockTimestamp, now, policy.maxSourceAgeSeconds)));
  setText("paper-nav", state.navQuote === null && !state.position && state.status !== "invalid" ? amount(policy.budgetQuote) : amount(state.navQuote));
  setText("paper-budget", `Initial paper budget ${amount(policy.budgetQuote)}${state.position ? "" : " · uninvested"}`);
  setText("paper-pnl", amount(state.pnlQuote));
  if (state.position) {
    const holding = policy.maxHoldingSeconds === null ? (policy.tradingHours?.kind === "continuous_v1" ? "continuous operation; no scheduled cash exit or routine timeout" : "scheduled cash exit before excluded US market hours; no routine holding timeout")
      : `holding time limit ${new Date(Date.parse(state.position.enteredAt) + policy.maxHoldingSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}; an exit condition may trigger earlier`;
    setText("paper-lifecycle", `Entry source ${new Date(state.position.enteredAt).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")} · ${terminal ? "session finished" : holding}. ${state.status === "exit_pending" ? "Exit requested; awaiting its simulation." : ""}`);
    setText("paper-pnl-note", state.status === "invalid" ? "Performance unavailable; source or coverage invalidated" : state.status === "closed" ? "Simulated cash result; includes estimated LP fee income" : "Simulated NAV; includes estimated LP fees and an exit gas reserve");
  }
  setText("paper-alpha", amount(state.alphaQuote));
  setText("paper-hold", state.holdQuote === null ? "Benchmark starts at paper entry" : `Passive holdings ${amount(state.holdQuote)}`);
  setText("paper-fees", amount(state.feeValueQuote));
  setText("paper-costs", needsSimulation ? "Unavailable" : usesTransactions && !state.position ? "No trades yet" : `${amount(state.costsPaidQuote)} / ${amount(state.exitReserveQuote)}`);
  setText("paper-cost-status", needsSimulation
    ? "Missing swap, transaction gas and exit simulation; no fixed fallback"
    : usesTransactions ? state.execution?.entryRunId
      ? `Estimated gas debited: ${displayTokenAmount(state.execution.gasSpentWei, 18, 9)} ETH · exit reserve replaced at exit`
      : "Gas from the intended calls; slippage is an order limit, not a flat charge"
    : "Legacy illustrative charges; not transaction measurements");
  setText("paper-drawdown", state.navQuote === null ? "—" : ppmPercent(state.maxDrawdownPpm));
  setText("paper-coverage", `${state.intervals} holding intervals · ${compactInteger(state.observedSwaps)} observed swaps`);
  const costPolicy = needsSimulation
    ? "No paper fills until the intended swaps and LP transactions can be simulated against current chain state. Gas and exit costs must have evidence; slippage must come from executable quotes. The current worker records input readiness only."
    : usesTransactions ? `Swap quote and range fixed before a later fill; ${policy.maxSlippageBps / 100}% maximum swap slippage. Inventory purchase, LP entry and cash exit use actual contract calls in simulation. Gas is estimated on the node and charged separately to the LP allocation. LP fee income remains an estimate from observed growth.`
    : `Legacy illustration: ${amount(policy.entryCostQuote)} entry + ${policy.slippageBps} bps inventory haircut; ${amount(policy.exitCostQuote)} exit. These assumed costs and spot-price fills are unsuitable for trade-performance validation.`;
  const capacity=state.liquidityShare;
  const inRange=state.position&&BigInt(state.position.liquidity)>0n&&state.last&&state.last.tick>=state.position.tickLower&&state.last.tick<state.position.tickUpper;
  if(policy.liquidityShareMode==="warn_v1") {
    const share=inRange&&capacity?`${capacity.ratioToExistingPpm===null?"Unavailable":ppmPercent(capacity.ratioToExistingPpm)} of existing active liquidity; ${capacity.shareAfterDepositPpm===null?"unavailable":ppmPercent(capacity.shareAfterDepositPpm)} of the total after adding ours.`:state.position&&!inRange?"Position is out of range: no active fee share.":"Waiting for a liquidity-share mark.";
    setText("paper-liquidity-share",`${share} ${policy.maxLiquiditySharePpm/10000}% is a warning threshold; it does not block entry or recentering.${inRange&&capacity?.exceedsThreshold?" Above threshold: greater influence on pool liquidity.":""}`);
  }
  const fm=paper.feeAccounting;
  if(policy.feeAccounting==="diluted_segments_v1")setText("paper-fee-model",fm?`Fees adjusted for our added liquidity from ${new Date(fm.fromSourceAt).toISOString()} (block ${fm.fromBlock}). Since then: ${amount(fm.adjustedQuote)} credited versus ${amount(fm.undilutedQuote)} without dilution, a ${amount(fm.reductionQuote)} reduction. Earlier estimated fees (${amount(fm.legacyQuote)} at current prices) are carried unchanged. This uses recorded flow and prices; it does not simulate how our presence changes future trading.`:"Added-liquidity fee accounting begins with the next verified fee interval.");
  const referencePolicy = policy.referencePolicy;
  const hours = policy.tradingHours?.kind === "continuous_v1" ? "24/7 operation across all market sessions. " : policy.tradingHours ? "After-hours, overnight and weekends only; premarket excluded. " : referencePolicy ? "24/7 evaluation. " : "";
  const management = policy.recenter ? `Recenter when outside range, using only the net swap required; ${state.execution?.recenterRunIds?.length ?? 0} completed moves.` : "No recentering.";
  const holdingLimit = policy.maxHoldingSeconds === null ? (policy.tradingHours?.kind === "continuous_v1" ? "No scheduled exit or routine timeout." : "Scheduled window exit; no routine timeout.") : `Holding limit ${duration(String(policy.maxHoldingSeconds))}.`;
  const allocation = usesTransactions ? ` Target allocation ${(policy.lpAllocationPpm ?? 1000000) / 10000}%; ${policy.inventoryExitPpm ? `NVDA inventory exit at ${policy.inventoryExitPpm / 10000}%` : "no inventory cap"}.` : "";
  setText("paper-policy", `${hours}Range ±${policy.halfWidthSpacings * 10} raw ticks${state.position ? ` · ticks ${state.position.tickLower}–${state.position.tickUpper}` : ""}. ${management}${allocation} ${holdingLimit} ${costPolicy} Pool checkpoints arrive about every minute.`);
  if (referencePolicy) setText("paper-reference", state.reference
    ? `${state.reference.basis === "held_equity_reference" ? "Held equity reference" : "Feed reference"}: ${state.reference.referencePriceX18 === null ? "Unavailable" : displayTokenAmount(state.reference.referencePriceX18, 18)} USDG/NVDA · updated ${dated(state.reference.referenceUpdatedAt, now)}. Pool deviation ${state.reference.deviationPpm === null ? "unavailable" : ppmPercent(state.reference.deviationPpm)}; permitted band ±${referencePolicy.maxDeviationPpm / 10000}%. Gas conversion uses each feed's heartbeat, capped at ${referencePolicy.maxGasPriceAgeSeconds / 3600}h.`
    : `Awaiting reference evaluation. Permitted band ±${referencePolicy.maxDeviationPpm / 10000}%; a held equity reference must update during the latest equity session and be no older than ${referencePolicy.maxHeldAgeSeconds / 3600}h.`);
  const reasons = [...new Set([...state.reasons, ...paper.monitorReasons])];
  element("paper-reasons").replaceChildren(...reasons.map(reason => {
    const node = document.createElement("span"); node.className = "reason-chip"; node.textContent = reason.replaceAll("_", " "); node.title = reason; return node;
  }));
  for (const point of paper.points.slice(-12).reverse()) {
    const row = document.createElement("tr");
    row.append(cell(dated(point.observedAt, now)), cell(blockNumber(point.block), "mono"), cell(point.action.replaceAll("_", " ")), cell(amount(point.navQuote), "number"), cell(point.reasons.join(" · "), "reasons-cell"));
    journal.append(row);
  }

}

function render(data) {
  renderPaper(data.paper, data.overview.serverTime);
  renderFocus(data);
  renderOverview(data);
  renderActivity(data.activity);
  renderPools(data.pools);
  renderAccounting(data.accounting, data.overview.serverTime);
  renderAccountingHistory(data.accountingHistory ?? [], data.overview.serverTime);
  renderPrincipal(data.principal);
  renderTrackedNftPositions(data.trackedNftPositions ?? [], data.overview.serverTime);
  renderRangeSimulation(data.rangeSimulation);
  renderRangePolicyReplay(data.rangePolicyReplay);
  renderOracleCalibration(data.oracleCalibration);
  renderStableFeeBaseline(data.stableFeeBaseline);
  renderRisk(data.riskAssets);
  renderPositions(data.positions);
  renderAttempts(data.attempts, data.overview.serverTime);
  renderSource("registry", data.sources.registry, data.overview.serverTime);
  renderSource("feed", data.sources.feedDirectory, data.overview.serverTime);
  renderSource("session", data.sources.marketSession, data.overview.serverTime);
}

async function refreshLivePilot() {
  const amount=value=>value==null?'—':`${displayTokenAmount(value,6)} USDG`;
  try {
    const response=await fetch('/api/live-pilot',{cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('Live pilot API unavailable');
    const {pilot}=await response.json(),state=pilot?.campaign?.state;
    if(!state){setText('live-pilot-status','No live pilot has been initialized.');return;}
    const age=Date.now()-Date.parse(pilot.campaign.heartbeat_at),mark=pilot.marks?.[0]?.snapshot;
    const retryAt=state.phase==='closed'&&state.desired==='running'&&state.closedAt?new Date(Date.parse(state.closedAt)+600000):null;
    const phase=retryAt?`WAITING FOR RE-ENTRY · Eligible after ${retryAt.toLocaleTimeString()}, subject to admission`:state.phase.toUpperCase();
    const labels={awaiting_receipt_confirmation_depth:'Waiting for receipt confirmation',awaiting_transaction_receipt:'Waiting for transaction receipt',initial_approval_waiting_for_lower_gas:'Waiting for lower gas fees',initial_approval_waiting_for_admission:'Waiting for entry admission',closed:state.desired==='running'?'Automatic re-entry enabled':'Trading stopped'};
    const reasons=pilot.campaign.monitor.map(r=>labels[r]??r.replaceAll('_',' ')).join(' · ');
    setText('live-pilot-status',`${age>30000?'STALE STATUS · ':''}${phase} · ${pilot.broadcastEnabled?'Execution enabled':'Broadcast disabled'} · ${reasons||'No active blocker'} · updated ${new Date(pilot.computedAt).toLocaleTimeString()}`);
    setText('live-pilot-nav',amount(mark?.netNavQuote??null));
    setText('live-pilot-nav-note',mark?`Valued at ${new Date(Number(mark.snapshot.timestamp)*1000).toLocaleString()}; future exit costs excluded`:'Awaiting a valued receipt or position mark');
    setText('live-pilot-gas',amount(state.gasSpentQuote));
    setText('live-pilot-native',`${displayTokenAmount(state.gasSpentWei,18)} ETH charged by receipts`);
    setText('live-pilot-reserve',amount(state.reserveUsdg));
    setText('live-pilot-nft',state.tokenId?`Owned NFT #${state.tokenId}`:'No active liquidity NFT');
    const actions=element('live-pilot-actions');actions.replaceChildren();
    for(const a of (pilot.actions??[]).slice(0,20)){
      const row=document.createElement('tr');row.append(cell(a.kind),cell(a.status),cell(a.hash??'Unsigned intent','mono'),cell(a.gas_wei===null?'—':displayTokenAmount(a.gas_wei,18),'number'));actions.append(row);
    }
    const marks=element('live-pilot-marks');marks.replaceChildren();
    for(const {snapshot:m} of (pilot.marks??[]).slice(0,12)){
      const p=m.snapshot.position,row=document.createElement('tr');row.append(cell(new Date(Number(m.snapshot.timestamp)*1000).toLocaleString()),cell(m.marketSession?.regime??'Unknown'),cell(`${m.phase}${p?' / #'+p.tokenId:''}`),cell(`${m.snapshot.tick}${p?' / '+p.tickLower+'–'+p.tickUpper:''}`),cell(amount(m.netNavQuote),'number'));marks.append(row);
    }
  } catch {setText('live-pilot-status','Live pilot status unavailable; displayed values may be stale.');}
  finally {setTimeout(refreshLivePilot,10000);}
}

async function refresh() {
  try {
    const response = await fetch("/api/dashboard", { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
    const data = await response.json();
    render(data);
    element("connection-dot").className = "status-dot live";
    setText("connection-label", "Dashboard connected");
    setText("last-refresh", `API refreshed ${new Date().toLocaleTimeString()} · source ages shown below`);
    element("error-banner").classList.add("hidden");
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, data.refreshMs);
  } catch (error) {
    element("connection-dot").className = "status-dot error";
    setText("connection-label", "Data unavailable");
    const banner = element("error-banner");
    banner.textContent = `${error instanceof Error ? error.message : "Dashboard refresh failed"}. Displayed values are from the last successful response and are no longer current.`;
    banner.classList.remove("hidden");
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 10_000);
  }
}

refresh();

refreshLivePilot();
