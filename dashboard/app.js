const SVG_NS = "http://www.w3.org/2000/svg";
let refreshTimer;

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
  const seconds = Math.max(0, Math.floor((new Date(nowValue) - new Date(value)) / 1_000));
  return `${duration(String(seconds))} ago`;
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

function renderOverview(data) {
  const { overview, riskGate } = data;
  const exact = overview.sync.blockLag === "0" && overview.sync.hashesMatch === true;
  setText("sync-value", exact ? "Exact" : overview.sync.blockLag === null ? "Unknown" : `Lag ${overview.sync.blockLag}`);
  setText("sync-detail", exact ? "Block and hash agree" : "Check replay cursor");
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
      cell(pill(risk.tradingTradable ? "Tradable" : "Blocked", risk.tradingTradable ? "good" : "bad")),
      cell(pill(risk.multiplierConsistent ? "Match" : "Mismatch", risk.multiplierConsistent ? "good" : "bad")),
      cell(pill(risk.oraclePaused ? "Paused" : "No", risk.oraclePaused ? "bad" : "good")),
      cell(pill(risk.corporateActionPending ? "Pending" : "None", risk.corporateActionPending ? "warn" : "good")),
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

function render(data) {
  renderOverview(data);
  renderActivity(data.activity);
  renderPools(data.pools);
  renderAccounting(data.accounting, data.overview.serverTime);
  renderAccountingHistory(data.accountingHistory ?? [], data.overview.serverTime);
  renderPrincipal(data.principal);
  renderStableFeeBaseline(data.stableFeeBaseline);
  renderRisk(data.riskAssets);
  renderPositions(data.positions);
  renderAttempts(data.attempts, data.overview.serverTime);
  renderSource("registry", data.sources.registry, data.overview.serverTime);
  renderSource("feed", data.sources.feedDirectory, data.overview.serverTime);
  renderSource("session", data.sources.marketSession, data.overview.serverTime);
}

async function refresh() {
  try {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok) throw new Error(`Dashboard API returned ${response.status}`);
    const data = await response.json();
    render(data);
    element("connection-dot").className = "status-dot live";
    setText("connection-label", "Live data");
    setText("last-refresh", `Updated ${new Date().toLocaleTimeString()}`);
    element("error-banner").classList.add("hidden");
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, data.refreshMs);
  } catch (error) {
    element("connection-dot").className = "status-dot error";
    setText("connection-label", "Data unavailable");
    const banner = element("error-banner");
    banner.textContent = error instanceof Error ? error.message : "Dashboard refresh failed";
    banner.classList.remove("hidden");
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 10_000);
  }
}

refresh();
