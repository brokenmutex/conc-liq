import { validateAccountingRun } from "../backtest/canonical.js";
import type { RobinhoodClient } from "../client.js";
import type {
  CanonicalRangePolicyReplaySource,
  RangePolicyReplaySource,
} from "./domain.js";

export async function validateRangePolicyReplaySource(input: {
  readonly client: RobinhoodClient;
  readonly source: RangePolicyReplaySource;
}): Promise<CanonicalRangePolicyReplaySource> {
  if (input.source.checkpoints.length < 2) {
    throw new Error("Policy replay requires at least two checkpoints");
  }
  const chainId = input.source.checkpoints[0]!.run.chainId;
  if (input.source.checkpoints.some((checkpoint) =>
    checkpoint.run.chainId !== chainId
  )) {
    throw new Error("Policy replay checkpoints have different chain IDs");
  }
  const rpcChainId = await input.client.getChainId();
  if (rpcChainId !== chainId) {
    throw new Error(
      `Policy replay RPC chain ID ${rpcChainId} does not match ` +
      `accounting source ${chainId}`,
    );
  }
  const checkpoints = await Promise.all(input.source.checkpoints.map(
    async (checkpoint) => ({
      ...checkpoint,
      run: await validateAccountingRun(input.client, checkpoint.run),
    }),
  ));
  return { ...input.source, checkpoints };
}
