import type { RobinhoodClient } from "../client.js";
import type {
  AccountingRunReference,
  AccountingRunSource,
  PoolIntervalInput,
  PositionIntervalInput,
} from "./domain.js";

export interface BaselineSourceInput {
  readonly from: AccountingRunSource;
  readonly pools: readonly PoolIntervalInput[];
  readonly positions: readonly PositionIntervalInput[];
  readonly streamKey: string;
  readonly to: AccountingRunSource;
}

export interface CanonicalBaselineInput {
  readonly from: AccountingRunReference;
  readonly pools: readonly PoolIntervalInput[];
  readonly positions: readonly PositionIntervalInput[];
  readonly streamKey: string;
  readonly to: AccountingRunReference;
}

async function validateRun(
  client: RobinhoodClient,
  run: AccountingRunSource,
): Promise<AccountingRunReference> {
  const block = await client.getBlock({ blockNumber: run.blockNumber });
  if (
    block.number !== run.blockNumber ||
    block.hash.toLowerCase() !== run.blockHash.toLowerCase()
  ) {
    throw new Error(
      `Accounting run ${run.runId} block ${run.blockNumber}:${run.blockHash} ` +
      "is not canonical",
    );
  }
  return {
    ...run,
    blockTimestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
  };
}

export async function validateBaselineSource(input: {
  readonly client: RobinhoodClient;
  readonly source: BaselineSourceInput;
}): Promise<CanonicalBaselineInput> {
  if (input.source.from.chainId !== input.source.to.chainId) {
    throw new Error("Baseline accounting runs have different chain IDs");
  }
  const chainId = await input.client.getChainId();
  if (chainId !== input.source.from.chainId) {
    throw new Error(
      `Baseline RPC chain ID ${chainId} does not match accounting source ` +
      `${input.source.from.chainId}`,
    );
  }
  const [from, to] = await Promise.all([
    validateRun(input.client, input.source.from),
    validateRun(input.client, input.source.to),
  ]);
  return { ...input.source, from, to };
}
