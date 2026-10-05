/** v15: the RPC health circuit may run with an operator-configured quorum of
 * one reference (the official public RPC). The private-node anchor must still
 * match an agreeing reference; failing or disagreeing extra references stay
 * warnings. Only the stored minimum changes; no row is rewritten. */
export const RPC_HEALTH_SINGLE_REFERENCE_QUORUM_SQL = `
ALTER TABLE rpc_health_samples DROP CONSTRAINT rpc_health_samples_check2;
ALTER TABLE rpc_health_samples ADD CONSTRAINT rpc_health_samples_check2 CHECK (
  reference_count >= 0 AND reference_quorum >= 1 AND
  consecutive_healthy >= 0 AND consecutive_unhealthy >= 0
);
`;
