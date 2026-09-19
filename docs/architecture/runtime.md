# Runtime architecture and refactoring boundary

## Current system

The repository contains four coupled capabilities:

1. event ingestion, canonicality and strategy checkpoints;
2. historical research and replay;
3. legacy and adaptive paper operation;
4. live custody/execution and dashboard projections.

Operational releases are immutable, checksummed and launched with a pinned Node
binary and private environment file. Persisted paper state records build,
environment-config and Node identities. A runtime mismatch fails closed.

That boundary must be preserved. A historical release referenced by saved state
or migration history is a recovery/audit dependency even when no installed
service uses it. It is not automatically a rollback release: compatibility
with the current database and persisted state must be demonstrated separately.

## Target modular monolith

```text
apps
  tail | paper | live | dashboard | research-cli
    -> application
       campaign lifecycle and use cases
         -> strategy
            pure policy, portfolio ledger, benchmark and v3 math
              -> domain
                 money, market, decision frame and evidence types

ports
  history | checkpoint | risk | reference | quote | executor | campaign store
    <- adapters
       PostgreSQL | HyperSync | RPC | legacy JSON import

projections
  bounded typed dashboard read models
```

Dependencies flow inward. Strategy code does not read PostgreSQL, files,
network providers, dashboard objects or live signers. Research and paper consume
the same typed decision frame and pure strategy kernel.

## Migration constraints

- Preserve exact bigint behavior with golden fixtures before extraction.
- Do not combine a structural refactor with a policy, signer or broadcast
  change.
- Keep live outbox, nonce, custody and no-swap-replay invariants stricter than
  model execution.
- Replace adaptive monolithic snapshots with bounded recoverable state plus an
  append-only ledger before the long paper run makes them expensive to rewrite.
- Move runtime DDL into checked migrations and introduce explicit schema
  compatibility ranges.
- Give tail ingestion reserved provider capacity; action-cost work has a
  separately admitted workload.
- Serve dashboard data through typed bounded projections, not direct note files
  or full JSONL history reads.

## Repository boundaries

Runtime code, tests and release construction may depend on named assets and
test fixtures, but never on `notes/` or `docs/`. Research manifests contain
exact paths and hashes; bulk evidence lives in a verified external archive.
The automated repository check enforces the runtime/documentation boundary.
