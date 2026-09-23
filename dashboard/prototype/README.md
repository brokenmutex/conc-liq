# Research → Positions feedback prototype

Open `index.html` in a browser, or serve the `dashboard` directory locally:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dashboard
```

Then visit `http://127.0.0.1:8765/prototype/`. The page has no API calls, database, wallet, signer, or persistence. It resets on refresh and is separate from the deployed dashboard server.

Walk one static/manual and one RangeKeeper paper demo from Research through preview, open, pause/resume, both close choices, and position history. Switch to Live preview to assess the planned screen with execution disabled. Values marked unavailable are intentionally absent; pool identities and lifecycle actions are fixture content, not chain observations or booked paper activity.

Feedback to collect: missing information at each decision, confusing labels or controls, whether the position history answers operational questions, and what should change before wiring real paper commands.
