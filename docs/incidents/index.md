# Incident and correction register

Detailed dated records remain in `notes/` during migration. This index captures
the durable invariant that must survive their removal.

| Incident/correction | Durable invariant | Current disposition |
| --- | --- | --- |
| Paper source changed after successful local simulation | Persisted success cannot be replayed as a second economic action; recover from saved evidence after revalidation. | Regression coverage retained |
| Narrow-range mint composition failure | Bound entry/recenter by executable liquidity and transaction limits, not unstable per-token minima from an earlier checkpoint. | Corrected and tested |
| Native ETH credit during live campaign | External funding is neither profit nor unexplained strategy inventory; reconcile it explicitly without resetting capital or cost history. | Closed campaign evidence retained |
| Reverted live replacement mint | A completed preceding swap must never be repeated. Recovery requires canonical receipt, nonce and custody continuity. | Recovery path retained |
| Withdrawal reconciliation stall | Keep the signed hash and reconcile the canonical receipt before taking another custody action. | Recovery path retained |
| Persistent approvals and repeated approval gas | Allowance optimization must preserve token/spender bounds and explicit cleanup; cost reduction does not weaken authorization. | Historical evidence retained |
| Coverage cursor regression | Persist the actual covered-through boundary; deferred checkpoints remain visible and re-offerable. | Corrected and monitored |
| HyperSync throttling | Reset-aware retry changes failure behavior, not provider capacity. Tail and bulk/action-cost admission require separate budgets. | Tail prioritized; action-cost capacity unresolved |
| Runtime/schema upgrade | Saved state must migrate with exact build, config and Node provenance; old state is never silently relabeled. | Guarded migration retained |

An incident can leave this register only when its invariant is represented by a
maintained runbook or automated regression and its detailed evidence has a
verified archive manifest.
