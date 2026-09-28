# Dashboard usability feedback — September 28, 2026

The operator reported five issues after trying `/operator`: Research was the initial tab; Review setup replaced AAPL with a hex address; the wallet was blank; drafts accumulated without deletion or a creation timezone; and saved drafts showed addresses and raw token integers.

## Implementation

Three parallel Luna assignments cover the setup/draft UI, protected draft deletion, and public wallet defaults. Positions is selected on initial load. Registered profile references preserve readable pair names through profile refreshes. Saved allocation amounts use registered token decimals and symbols; Created uses America/New_York with EDT/EST.

The paper service accepts only the public `DEPLOYMENT_OPERATOR_WALLET_ADDRESS` as a setup default. The existing `.env` wallet identity was derived offline and staged as a public address in a new shared command/worker environment. The paper services do not receive a private key, and operator edits and pending request recovery take precedence over the default.

Delete draft requires inline confirmation. The store locks the campaign and allows only pristine, unaccepted revision-one static/manual paper drafts without prior ownership or accounting. It records a closed tombstone while retaining revisions, previews and admission idempotency. Deleted drafts disappear from saved drafts and position history; actual closed campaigns remain visible. Operation acceptance uses the same campaign lock. The endpoint retains exact-origin, session and CSRF checks. No database migration is required.

## Validation and rollout

Pending final clean-source validation and sealed release checks. Browser validation uses an isolated database and synthetic canonical frames; no operator drafts are deleted during testing. Production rollout requires no active campaigns or pending operations, preserves both existing drafts and closed history, and applies the same sealed release/configuration to command and worker.

The separately recorded native-allocation headroom issue remains MVP-6 and is outside these five requested fixes.
