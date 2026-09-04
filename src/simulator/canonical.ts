import { validateAccountingRun } from "../backtest/canonical.js";
import type { RobinhoodClient } from "../client.js";
import type {
  CanonicalRangeSimulationSource,
  RangeSimulationSource,
} from "./domain.js";

export async function validateRangeSimulationSource(input: {
  readonly client: RobinhoodClient;
  readonly source: RangeSimulationSource;
}): Promise<CanonicalRangeSimulationSource> {
  if (input.source.from.chainId !== input.source.to.chainId) {
    throw new Error("Simulation accounting runs have different chain IDs");
  }
  const chainId = await input.client.getChainId();
  if (chainId !== input.source.from.chainId) {
    throw new Error(
      `Simulation RPC chain ID ${chainId} does not match accounting source ` +
      `${input.source.from.chainId}`,
    );
  }
  const [from, to] = await Promise.all([
    validateAccountingRun(input.client, input.source.from),
    validateAccountingRun(input.client, input.source.to),
  ]);
  return { ...input.source, from, to };
}
