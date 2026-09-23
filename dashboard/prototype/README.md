# Dashboard feedback prototype

Open `https://dear-foxhound.tail106f9e.ts.net/prototype/` on the existing Tailscale Funnel. The prototype needs the dashboard on the same origin because it loads the current Research and Positions pages and their read-only APIs. The dashboard's normal information, charts, filters and history remain in those views.

The only additions are browser-only controls under the live and paper sections and a new-position setup form at the bottom of Positions. The controls start with one sample position in each mode because the current dashboard records may have no active positions; creating a demo position from the setup form adds another sample to its mode. Pause, resume, and both close choices update only browser memory. Refresh resets them. No signing, chain transaction, paper booking or deployment API call occurs.

The pool list comes from `/api/research`; each choice shows its fee tier. Half-width choices are multiples of the pool's tick spacing. The percentage in brackets is an approximate one-sided change implied by that tick distance, not a quote, range validation, or expected return. The setup preview shows unavailable economics as unavailable.
