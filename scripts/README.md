# Script workflow registry

`workflows.json` classifies every legacy top-level script and pins its exact
bytes. The registry prevents cleanup or refactoring from silently invalidating
historical reproduction.

Lifecycle meanings:

- `supported_operations`: maintained release, dashboard or controller tooling;
- `frozen_reproduction`: retained at its current path until dependent studies
  pass the post-layout reproduction gate;
- `review_for_retirement`: no repository basename consumer was found during the
  cleanup inventory; this is a review queue, not deletion authorization.

Existing top-level research scripts intentionally stay in place. Moving them
would change recorded code paths and hashes before the restored-input replay.
New recurring tooling belongs in an owned directory:

- `scripts/maintenance/` for repository and provenance checks;
- a future `scripts/operations/` for new operator commands;
- a future `scripts/research/` for new supported research pipelines.

After a script is intentionally changed, run `npm run scripts:registry`, inspect
the registry diff, update affected research manifests and rerun
`npm run check`. Changing a hash does not establish research equivalence;
dependent studies still require their declared replay and compact-result
comparison.
