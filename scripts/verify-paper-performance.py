"""Independent integer checks of a frozen paper audit.

No database access, runtime imports, or writes except the requested new output.
Usage: python3 scripts/verify-paper-performance.py SOURCE METRICS OUTPUT
"""
import hashlib
import json
import statistics
import sys
from datetime import datetime


def milliseconds(at):
    return round(datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp() * 1000)


def marked_value(amount0, amount1, checkpoint):
    return int(amount0) + int(amount1) * 2**192 // int(checkpoint["sqrtPriceX96"])**2


def gas_value(wei, valuation):
    numerator = int(wei) * int(valuation["ethUsdAnswer"]) * 10**(valuation["quoteUsdDecimals"] + 6)
    denominator = 10**(18 + valuation["ethUsdDecimals"]) * int(valuation["quoteUsdAnswer"])
    return (numerator + denominator - 1) // denominator


source_path, metrics_path, output_path = sys.argv[1:]
raw = open(source_path, "rb").read()
source_hash = hashlib.sha256(raw).hexdigest()
assert source_hash == open(source_path + ".sha256").read().strip()
d = json.loads(raw)
audit = json.load(open(metrics_path))
assert source_hash == audit["sourceSha256"]
sessions = [s for s in d["sessions"] if s["id"] in d["selectedIds"]]
closed = [s for s in sessions if s["status"] == "closed"]
runs = {r["id"]: r for r in d["executions"]}
metrics = {s["id"]: s for s in audit["sessions"]}
checks, overlaps = [], []
groups = {"inventory": [], "chain": [], "risk_reference": [], "unclassified": []}
entry_actions = {"approve_entry_swap", "buy_nvda", "approve_mint_usdg", "approve_mint_nvda", "mint"}
for index, session in enumerate(sessions):
    sid, state = session["id"], session["state"]
    if index:
        assert session["policy"]["reentry"]["previousSessionId"] == sessions[index-1]["id"]
        assert session["policy"]["budgetQuote"] == sessions[index-1]["state"]["navQuote"]
    entry_run_id = (state.get("execution") or {}).get("entryRunId")
    if entry_run_id is None:
        assert session["status"] in ("waiting", "entry_pending") and state["position"] is None
        assert int(state["costsPaidQuote"]) == int(state["exitReserveQuote"]) == 0
        assert state["navQuote"] in (None, session["policy"]["budgetQuote"])
        assert not any(r["session_id"] == sid and r["action"] == "entry" and r["status"] == "succeeded" for r in d["executions"])
        checks.append({"session": sid, "status": session["status"], "carriedCashRaw": session["policy"]["budgetQuote"], "gasRaw": "0"})
        continue
    entry_run = runs[entry_run_id]
    entry_result = entry_run["snapshot"]["result"]
    entry_txs = [t for t in entry_result["transactions"] if t["action"] in entry_actions]
    entry_wei = sum(int(t["estimate"]["totalFeeWei"]) for t in entry_txs)
    assert entry_wei == int(entry_result["entryGasWei"])
    paid = gas_value(entry_wei, entry_run["snapshot"]["valuation"])
    if session["status"] == "closed":
        exit_run = runs[state["execution"]["exitRunId"]]
        exit_result = exit_run["snapshot"]["result"]
        exit_wei = sum(int(t["estimate"]["totalFeeWei"]) for t in exit_result["transactions"])
        assert exit_wei == int(exit_result["totalGasWei"])
        paid += gas_value(exit_wei, exit_run["snapshot"]["valuation"])
        assert int(exit_result["balances"]["afterExit"]["quote"]) - paid == int(state["navQuote"])
        assert exit_result["balances"]["afterExit"]["rwa"] == "0"
        assert state["exitReserveQuote"] == "0"
    assert paid == int(state["costsPaidQuote"]) == int(metrics[sid]["costs"])
    assert int(state["navQuote"]) - int(session["policy"]["budgetQuote"]) == int(state["pnlQuote"])
    assert int(state["navQuote"]) - int(state["holdQuote"]) == int(state["alphaQuote"])
    fees = marked_value(state["execution"]["earnedFee0"], state["execution"]["earnedFee1"], state["last"])
    assert fees == int(state["feeValueQuote"]) == int(metrics[sid]["fees"])
    entry = next(o for o in d["observations"] if o["session_id"] == sid and o["action"] == "enter")
    allocation = marked_value(entry_result["minted0"], entry_result["minted1"], entry["state"]["last"]) * 1_000_000 // int(session["policy"]["budgetQuote"])
    # Minted amounts round up; withdrawable principal rounds down.
    assert abs(allocation - metrics[sid]["entryLpAllocationPpm"]) <= 1
    checks.append({"session": sid, "gasRaw": str(paid), "feesRaw": str(fees),
                   "mintedAllocationPpm": allocation, "entryBaseFeeWei": entry_txs[0]["estimate"]["baseFeeWei"]})
    signals = [o for o in d["observations"] if o["session_id"] == sid and o["action"] == "signal_exit"]
    if not signals:
        continue
    signal = signals[0]
    reasons = signal["state"]["reasons"]
    group = "inventory" if "paper_inventory_threshold_exit_to_cash" in reasons else "chain" if any(r.startswith("chain_") for r in reasons) else "risk_reference" if reasons else "unclassified"
    groups[group].append(sid)
    if "paper_current_risk_evidence_unavailable" in reasons:
        now = milliseconds(signal["state"]["pendingSince"])
        attempt = max((a for a in d["attempts"] if milliseconds(a["attempted_at"]) <= now), key=lambda a: (milliseconds(a["attempted_at"]), int(a["id"])))
        prior = max((a for a in d["attempts"] if a["status"] == "succeeded" and milliseconds(a["completed_at"]) <= now), key=lambda a: (milliseconds(a["attempted_at"]), int(a["id"])))
        delay = milliseconds(attempt["completed_at"]) - now if attempt["completed_at"] else None
        # A current-risk failure can be a stale canonical validation rather
        # than an overlapping refresh. Preserve the saved predicate instead
        # of assuming every newer session repeats the original six races.
        overlaps.append({"session": sid, "attempt": attempt["id"], "completionAfterDecisionMs": delay,
                         "completionOverlap": delay is not None and delay > 0,
                         "savedFailedChecks": signal["state"].get("referenceEvidence", {}).get("current", {}).get("failedChecks"),
                         "priorSnapshotAgeMs": now - milliseconds(prior["snapshot_observed_at"]),
                         "soleExitReason": len(reasons) == 1})

totals = {k: str(sum(int(s["state"][field]) for s in closed)) for k, field in
          [("pnl", "pnlQuote"), ("fees", "feeValueQuote"), ("gas", "costsPaidQuote")]}
assert all(totals[k] == audit["totals"][k] for k in totals)
assert int(totals["pnl"]) == int(closed[-1]["state"]["navQuote"]) - int(closed[0]["policy"]["budgetQuote"])
root, last = sessions[0]["state"], sessions[-1]["state"]
mark = next(s["state"]["last"] for s in reversed(sessions) if s["state"]["last"] is not None)
nav = last["navQuote"] if last["navQuote"] is not None else sessions[-1]["policy"]["budgetQuote"]
holding = marked_value(root["position"]["hold0"], root["position"]["hold1"], mark) - int(root["execution"]["holdGasQuote"])
assert holding == int(audit["campaign"]["holdQuote"])
assert int(nav) - holding == int(audit["campaign"]["alphaQuote"])
anchors = []
for sample_id in ["35807", "39062"]:
    sample = next(h["snapshot"] for h in d["health"] if h["id"] == sample_id)
    old = int(sample["anchorBlock"])
    heads = {p["name"]: int(p["headBlock"]) for p in sample["probes"]}
    proposed = min(heads.values()) - 64
    depths = {name: head - old for name, head in heads.items()}
    assert depths["reference_1"] == 0 and sample["state"] == "healthy"
    anchors.append({"sample": sample_id, "privateLagBlocks": sample["lagBlocks"], "recordedDepths": depths,
                    "proposedAnchorGeometry": str(proposed), "proposedDepths": {name: head - proposed for name, head in heads.items()},
                    "proposedHistoricalHashProof": "unavailable; geometry does not prove canonicality"})

result = {"scope": "Independent integer verification of frozen audit; no runtime accounting imports",
          "asOf": d["asOf"], "sourceSha256": source_hash,
          "verifierSha256": hashlib.sha256(open(__file__, "rb").read()).hexdigest(),
          "sessionsChecked": len(sessions), "closedSessionsChecked": len(closed), "closedTotalsRaw": totals,
          "campaignHoldRaw": str(holding), "campaignAlphaRaw": str(int(nav) - holding),
          "primaryExitGroups": groups, "riskRefreshOverlaps": overlaps, "anchorFindings": anchors,
          "entryBaseFeeMedianWei": statistics.median(int(c["entryBaseFeeWei"]) for c in checks[:len(closed)]),
          "sessionChecks": checks,
          "limits": ["Does not independently repeat boundary fee-growth accrual or v3 principal decomposition",
                     "DB completed_at is a transaction timestamp, not a precise commit visibility timestamp",
                     "Mutable prior canonical validation timestamps prevent proving every historical fallback admissible",
                     "All returns remain paper estimates, not broadcast transaction proceeds"]}
with open(output_path, "x") as output:
    json.dump(result, output, indent=2)
    output.write("\n")
print(json.dumps({k: result[k] for k in ["sessionsChecked", "closedSessionsChecked", "closedTotalsRaw", "campaignAlphaRaw", "primaryExitGroups"]}, indent=2))
