#!/bin/bash
P="postgresql://root@localhost/conc_liq?host=/var/run/postgresql"
OUT=/tmp/claude-0/-root-conc-liq/27645be2-9153-4f46-babe-3cbb77288733/scratchpad/cursor-probe.log
: > $OUT
for i in $(seq 1 600); do
  psql "$P" -At -F'|' -c "SELECT now(), next_block, last_scanned_block, updated_at, txid_current_snapshot() FROM indexer_cursors WHERE stream_key='robinhood-v3-rwa-usdg-v1';" >> $OUT 2>&1
done
echo DONE >> $OUT
