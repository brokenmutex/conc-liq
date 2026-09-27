# Operator Funnel replacement — 2026-09-27

## Current state: no password sign-in

The operator explicitly requested removing the password feature. `/operator`
now connects automatically; there are no password, sign-in or sign-out controls.
Anyone who can reach the public Funnel URL can use the paper controls. The
automatic HttpOnly/SameSite cookie and exact-origin/CSRF checks are request
protection, not an access-control boundary. Live execution remains unavailable.

Source `d7ee27fd7bd7f8d707efc89e17b6f713aabfa8f1` produced sealed build
`ddc543b96077eb30aa791fc32e78e878133680ecaf0ba8f678dd6c7542d262f3`. Both the
command and read-only dashboard services use this build so their shared UI
assets agree. The command uses `data/static-paper-mvp-operator.env`, SHA-256
`48f3e5ffda382ac7e8bb1131ba596a14f346b9d764c448613e435ee1ee3ea35b`, with no
password setting. The dashboard keeps its previous environment. The worker,
database schema, registered profile and Funnel route configuration are unchanged.
`/prototype` remains removed (404); `/operator` and the session module return 200.

Session bootstrap is an empty JSON POST and reuses a valid browser session,
so another tab does not rotate its token. An expired session is renewed after
an explicit 401, retrying the original serialized request once. Network errors,
403s and 5xx responses are not automatically retried. The public root dashboard
does not bootstrap an operator session. Profiles and saved drafts load after
session readiness; connection failure offers a bounded manual retry.

Validation: typecheck, four command-server tests (including origin/CSRF,
session reuse and expiry), eleven focused dashboard/session checks, and 39
mock-backend browser assertions passed. The clean full suite passed 885/886;
its sole failure was an absent ignored historical competitor fixture. After
linking that existing checksum-verified input into the isolated checkout, all
four tests in the affected file passed without source changes. The sealed
build passed and both deployed web processes were verified active with zero
automatic restarts. Evidence includes `passwordless-unit-tests.log`,
`passwordless-fixture-recheck.log`, `passwordless-release-build.log`, and
`passwordless-runtime-identities.json` under the cutover execution directory.

Public browser verification passed for fresh access, reload and a second tab
without credentials or password/sign-in/sign-out controls. Profile reads returned
200 with the registered profile; the session cookie was Secure, HttpOnly and
SameSite=Strict. The root remained read-only with no session bootstrap, and
`/prototype` returned 404. No browser exceptions or economic calls occurred.
Completed evidence is `passwordless-public-operator-recheck-20260927.json` and
the independent `passwordless-minimal-browser.json` in the same execution
directory. The earlier partial report is preserved: its reporter failed while
assembling evidence, with no observed application assertion failure. Browser
processes and temporary profiles were cleaned up after verification.

The earlier rollout history below preserves its original password/redirect
checks; those descriptions are superseded by the current state above.

## Earlier rollout history

Final update: the operator subsequently requested removing `/prototype`
completely. Its Funnel mount and application redirect were removed. Public
`/prototype` and `/prototype/` now return 404; `/operator` returns 200. Command
source `d4eddd785fae46b2cfeb8a197334e6b1237763e0` is deployed as sealed build
`2b50a18a772d9938e03d058aabc39e17750e9009f27a724b2784c95f81afa88e`.
Only `dist/src/deployments/server.js` differs from the earlier Funnel build.
The four command-server tests and sealed compilation passed. The command
environment, password and remaining routes are unchanged. Final route evidence
is `execution/funnel-operator-only.json`; the build log is
`execution/operator-only-release-build.log`, both under the cutover directory.
The rest of this record describes the initial redirect rollout and its checks.

The operator explicitly requested replacing the obsolete public `/prototype`
Funnel route with the real operator app. This supersedes the previous
loopback-only access decision for this paper command surface. It does not
authorize live execution, signing, funding or any campaign operation.

`https://dear-foxhound.tail106f9e.ts.net/prototype` now redirects to `/operator`.
The root route still serves the existing read-only dashboard on port 4173.
The prototype source files remain in the repository but are no longer served
by Funnel.

## Scoped runtime update

Source `6d99bc51d3824d0753ebcd9eb797d5e4614b2e0a` produced sealed build
`cf731d0e5a0f7ac96536e9bcfe73ce3b44d407582ab63c4a318c3f8633861908`.
Only the command service was moved to this build. Its private configuration
is `data/static-paper-mvp-funnel.env`, SHA-256
`9fd2262071ea54b22fe5b1605f85bf35427ea28ecee5e0eea447a623fd10bde2`.
Other services and the paper worker retain the reviewed d507 build and their
existing environments. No schema or profile change was needed.

Compared with d507, the artifact changes only the command entrypoint, command
server, dashboard HTML and tab script. The HTML/script changes remove obsolete
loopback-only wording. The server accepts the additional exact configured
`DEPLOYMENT_PUBLIC_ORIGIN=https://dear-foxhound.tail106f9e.ts.net` while still
binding to loopback. It never derives trust from forwarded headers. External
sessions use Secure, HttpOnly, SameSite=Strict cookies; password authentication,
exact-origin validation and CSRF checks remain enforced. Local access remains
available, and external-origin support is disabled unless explicitly configured.

Four command-server tests passed, including external-origin opt-in, malformed
configuration rejection, spoofed forwarding-header and wrong-origin rejection,
authentication, CSRF, cookie attributes, logout revocation and local access.
The clean worktree typecheck and sealed build passed. The deployed command
process was checked against the new executable, launcher and environment paths,
and was active with zero automatic restarts.

## Funnel mapping

| Public path | Backend |
| --- | --- |
| `/` | `http://127.0.0.1:4173` |
| `/prototype/` | `http://127.0.0.1:4174/prototype/` (redirects to `/operator`) |
| `/operator/` | `http://127.0.0.1:4174/operator/` |
| `/api/` | `http://127.0.0.1:4174/api/` |
| `/tabs.js` | `http://127.0.0.1:4174/tabs.js` |

This installed Tailscale proxy removes the mount prefix; each upstream target
therefore includes the corresponding path. The initial bare targets returned
401 and were corrected before acceptance. Root dashboard assets other than
the updated tab script remain byte-identical across these two releases.
The [Tailscale Funnel CLI reference](https://tailscale.com/docs/reference/tailscale-cli/funnel)
documents the path mounts and upstream URL configuration.

## Evidence and recovery

Evidence lives in `data/static-paper-mvp-cutover-20260927/execution/`:
`funnel-before.json`, `funnel-after.json`, `command-unit-before-funnel.service`,
`funnel-release-build.log`, and `funnel-runtime-identity.json`.
The previous command unit/configuration and route configuration are preserved.
To undo this exposure, first remove the added operator/API/tab mounts and
restore the previous prototype route, then restore the captured command unit.
The d507 worker and database remain compatible; no database rollback is needed.
No secret, cookie value or CSRF token is recorded in this report.

Authenticated browser verification passed through the public HTTPS hostname
at 08:29:48 UTC. `/prototype` returned 308 to `/operator`, whose final response
was 200. Login loaded the expected AAPL profile. The browser confirmed Secure,
HttpOnly, SameSite=Strict cookies that JavaScript could not read. Logout revoked
the session; the following profile request returned 401. An unapproved Origin
was rejected with `origin_mismatch` through the public route.

Research, dashboard and Positions APIs returned 200, with 15 pools and 14
historical position records. Desktop and mobile rendered without horizontal
overflow or browser exceptions. Browser mutations were limited to session login
and logout; no campaign or operation was created. Sanitized results and four
screenshots are stored as `funnel-public-readonly-verification-20260927.json`
and `funnel-public-*-20260927.png` in the execution evidence directory. The first
verifier invocation failed a local syntax check before any network request;
the corrected browser run is the acceptance evidence.
