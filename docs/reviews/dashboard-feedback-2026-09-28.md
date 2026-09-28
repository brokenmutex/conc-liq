# Dashboard usability feedback — September 28, 2026

The operator reported five issues after trying `/operator`: Research was the initial tab; Review setup replaced AAPL with a hex address; the wallet was blank; drafts accumulated without deletion or a creation timezone; and saved drafts showed addresses and raw token integers.

## Implementation

Three parallel Luna assignments cover the setup/draft UI, protected draft deletion, and public wallet defaults. Positions is selected on initial load. Registered profile references preserve readable pair names through profile refreshes. Saved allocation amounts use registered token decimals and symbols; Created uses America/New_York with EDT/EST.

The paper service accepts only the public `DEPLOYMENT_OPERATOR_WALLET_ADDRESS` as a setup default. The existing `.env` wallet identity was derived offline and staged as a public address in a new shared command/worker environment. The paper services do not receive a private key, and operator edits and pending request recovery take precedence over the default.

Delete draft requires inline confirmation. The store locks the campaign and allows only pristine, unaccepted revision-one static/manual paper drafts without prior ownership or accounting. It records a closed tombstone while retaining revisions, previews and admission idempotency. Deleted drafts disappear from saved drafts and position history; actual closed campaigns remain visible. Operation acceptance uses the same campaign lock. The endpoint retains exact-origin, session and CSRF checks. No database migration is required.

## Validation and rollout

Source commit `27690c9844da3905cd6a931ffef3478f9fec66a9` passed clean `npm run check`: 909 tests, repository checks and TypeScript. The isolated real-browser lifecycle and deletion test passed from the same clean checkout. The separate deletion integration covers repeat deletion, protected active/paused/blocked/history records, and a concurrent acceptance winning the campaign lock. HTTP tests cover origin/CSRF and missing-draft 404.

The sealed candidate is `376dc50b509a276dd3ce61ef95228effd6fc0ce3f2174c6869e8eebfb58f2a85`, Node v24.20.0. Its manifest differs from the previous `bf4dcea9…` in exactly eight runtime files: three dashboard assets and five deployment/dashboard JavaScript modules. The same artifact passed canonical interrupted conversion plus backup/restore, retain-close, ordinary conversion, and changed-anchor rejection (all four exit code 0). Browser validation uses an isolated database and synthetic canonical frames; no operator drafts are deleted during testing. The application-only rollout completed after verifying zero active campaigns and zero nonterminal operations, then stopping command ingress and repeating that check. Command, worker and dashboard now run this release; the existing tail release `cda961d0…` is unchanged. The worker acquired its readiness lease before command ingress resumed. Process executable, cwd, arguments, installed unit hashes and environment file hashes were checked.

Command and worker both use `data/static-paper-mvp-dashboard-feedback-2026-09-28.env`, file SHA256 `63c5748a0a3230662227e1c2231110aec4329fdc8169e17a4e269b317fe9712d`, runtime config hash `efd838c07c244bfd827909093ca3333e82dc928d4aa4a1a88c453d652f19e1c4`. The only addition to the prior shared configuration is `DEPLOYMENT_OPERATOR_WALLET_ADDRESS`; no private key was added.

The before/after production counts remained three campaigns (two drafts, one closed), four operations and three marks. Both existing drafts and closed history were preserved. No production setup, open or delete request was used for validation. The isolated review databases were removed after checking their OIDs, schema contents and zero connections.

The separately recorded native-allocation headroom issue remains MVP-6 and is outside these five requested fixes.


Evidence is retained privately under `data/dashboard-feedback-2026-09-28/`: `clean-check.log`, `clean-browser.log`, `clean-draft-delete.log`, `focused-final.log`, `build.log`, the four canonical gate logs and `gate-results.json`. Staged/previous unit files and environment metadata retain rollback inputs. The fixture databases are isolated from production; canonical source tables are exposed read-only through FDW.


Public read-only smoke checks passed on desktop (1440px) and mobile (390px):
Positions selected initially, configured public wallet matched, AAPL / USDG
pool labels and saved drafts rendered, explicit EDT timezone and delete controls
were present, no horizontal overflow, and no browser exceptions. All four API
reads and command health returned 200. The only observed browser mutation was
the empty session handshake; the optional favicon returned 404. Screenshots and
`readonly-20260928T083653Z.json` retain the evidence. All four relevant services
were active with zero automatic restarts. Exact production campaign IDs,
lifecycles and creation/closure timestamps matched the pre-rollout snapshot.
