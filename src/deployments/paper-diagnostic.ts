const paperFeeDiagnosticCodes=new Map<string,string>([
 ['Local paper eth_sendTransaction: Insufficient funds for gas * price + value',
  'paper_local_send_insufficient_funds'],
 ['Paper fee source anchor invalid','paper_fee_source_anchor_invalid'],
 ['Paper fee source reorged','paper_fee_source_reorged'],
 ['Paper fee source timestamp changed','paper_fee_source_timestamp_changed'],
 ['Paper fee snapshot tick mismatch','paper_fee_snapshot_tick_mismatch'],
 ['Paper fee snapshot price mismatch','paper_fee_snapshot_price_mismatch'],
 ['Paper fee snapshot liquidity mismatch','paper_fee_snapshot_liquidity_mismatch'],
 ['Paper fee replay coverage unavailable','paper_fee_replay_coverage_unavailable'],
 ['Paper fee replay cursor has an incomplete later block',
  'paper_fee_replay_cursor_incomplete_later_block'],
 ['Paper fee replay cursor has not covered the interval end',
  'paper_fee_replay_cursor_interval_end_uncovered'],
 ['Paper fee replay cursor hash mismatch','paper_fee_replay_cursor_hash_mismatch'],
 ['Paper fee replay cursor settle timeout','paper_fee_replay_cursor_settle_timeout'],
 ['Paper fee interval is not later','paper_fee_interval_not_later'],
 ['Paper fee interval anchors invalid','paper_fee_interval_anchors_invalid'],
 ['Paper fee interval coverage invalid','paper_fee_interval_coverage_invalid'],
 ['Paper fee chain anchors were not rechecked','paper_fee_chain_anchors_not_rechecked'],
]);

/** Converts provider/assertion failures to stable codes or safe error classes.
 * Only exact known assertion messages are mapped; arbitrary message text,
 * URLs, response bodies, and nested errors are never returned. */
export function safePaperDiagnosticFailure(error:unknown):string{
 if(error!==null&&typeof error==='object'&&'code' in error&&
  typeof error.code==='string'&&/^(?:paper|rangekeeper)_[a-z0-9_]{1,100}$/.test(error.code))
  return error.code;
 if(!(error instanceof Error))return 'unknown';
 const firstLine=error.message.split('\n',1)[0]??'';
 if(/^(?:paper|rangekeeper)_[a-z0-9_]{1,100}$/.test(firstLine))return firstLine;
 const known=paperFeeDiagnosticCodes.get(firstLine);
 if(known)return known;
 return /^[A-Za-z][A-Za-z0-9]{0,30}Error$/.test(error.name)?error.name:'Error';
}
