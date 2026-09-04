import { getAddress, type Address } from "viem";
import { ROBINHOOD_CHAIN_ID, USDG } from "../constants.js";
import type { PoolManifest, V3PoolTarget } from "../indexer/domain.js";
import { evaluateOracleValuationMark } from "../oracle/evaluate.js";
import type { RiskSnapshot } from "../risk/domain.js";
import type {
  StrategyCheckpointSnapshot,
  StrategyPoolCheckpoint,
} from "./domain.js";
import type { StrategyCheckpointReader } from "./reader.js";

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function orderedTokens(rwaAddress: Address): readonly [Address, Address] {
  const addresses = [getAddress(USDG), getAddress(rwaAddress)]
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  return [addresses[0]!, addresses[1]!];
}

export async function collectStrategyCheckpoint(input: {
  readonly concurrency: number;
  readonly manifest: PoolManifest;
  readonly reader: StrategyCheckpointReader;
  readonly risk: RiskSnapshot;
  readonly streamKey: string;
}): Promise<StrategyCheckpointSnapshot> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency <= 0) {
    throw new Error("Strategy checkpoint concurrency must be positive");
  }
  if (
    input.risk.chainId !== ROBINHOOD_CHAIN_ID ||
    input.manifest.chainId !== input.risk.chainId
  ) {
    throw new Error("Strategy checkpoint chain ID does not match the manifest");
  }
  if (input.manifest.pools.length === 0) {
    throw new Error("Strategy checkpoint manifest has no pools");
  }

  const blockNumber = BigInt(input.risk.blockNumber);
  const assets = new Map(input.risk.assets.map((asset) => [
    asset.registry.symbol.toUpperCase(),
    asset,
  ]));
  const decimals = new Map<string, Promise<number>>();
  const readDecimals = (target: V3PoolTarget): Promise<number> => {
    const key = target.rwaAddress.toLowerCase();
    let pending = decimals.get(key);
    if (pending === undefined) {
      pending = input.reader.readTokenDecimals(target.rwaAddress, blockNumber);
      decimals.set(key, pending);
    }
    return pending;
  };

  const pools = await mapConcurrent(
    input.manifest.pools,
    input.concurrency,
    async (target): Promise<StrategyPoolCheckpoint> => {
      const asset = assets.get(target.rwaSymbol.toUpperCase());
      if (asset === undefined) {
        throw new Error(`Risk snapshot is missing ${target.rwaSymbol}`);
      }
      if (!sameAddress(asset.registry.address, target.rwaAddress)) {
        throw new Error(
          `Risk snapshot ${target.rwaSymbol} address does not match the manifest`,
        );
      }
      const [state, tokenDecimals] = await Promise.all([
        input.reader.readPool(target.address, blockNumber),
        readDecimals(target),
      ]);
      const [token0, token1] = orderedTokens(target.rwaAddress);
      const valuation = evaluateOracleValuationMark({
        blockNumber: input.risk.blockNumber,
        blockTimestamp: input.risk.blockTimestamp,
        quoteDecimals: 6,
        quoteOracle: input.risk.quoteOracle,
        quoteToken: USDG,
        rwaDecimals: asset.registry.decimals,
        rwaOracle: asset.oracle,
        sqrtPriceX96: state.sqrtPriceX96,
        token: asset.onchain,
        tokenDecimals,
        tokenDecimalsReadError: undefined,
        token0,
        token1,
        tokenReadError: asset.onchainReadError ?? undefined,
      });
      const reasons = [...valuation.reasons];
      if (state.liquidity <= 0n) reasons.push("pool_liquidity_zero");
      if (!state.unlocked) reasons.push("pool_locked");
      const uniqueReasons = [...new Set(reasons)];
      return {
        fee: target.fee,
        poolAddress: target.address,
        rwaAddress: target.rwaAddress,
        rwaSymbol: target.rwaSymbol,
        state: {
          feeGrowthGlobal0X128: state.feeGrowthGlobal0X128.toString(),
          feeGrowthGlobal1X128: state.feeGrowthGlobal1X128.toString(),
          liquidity: state.liquidity.toString(),
          sqrtPriceX96: state.sqrtPriceX96.toString(),
          tick: state.tick,
          unlocked: state.unlocked,
        },
        token0,
        token1,
        valuation: {
          ...valuation,
          reasons: uniqueReasons,
          status: uniqueReasons.length === 0 ? "valid" : "excluded",
        },
      };
    },
  );
  const validPools = pools.filter((pool) => pool.valuation.status === "valid").length;
  return {
    assumptions: [
      "risk and pool state are pinned to the same confirmation-safe block",
      "Chainlink token feeds are already UI-multiplier adjusted",
      "USDG/USD converts token feeds into USDG/RWA",
      "pool fee growth is observed without candidate self-dilution",
      "valid valuation marks are not execution authorization",
    ],
    blockHash: input.risk.blockHash,
    blockNumber: input.risk.blockNumber,
    blockTimestamp: input.risk.blockTimestamp,
    capturedAt: new Date().toISOString(),
    chainId: input.risk.chainId,
    excludedPools: pools.length - validPools,
    executionEligible: false,
    methodology: "synchronized_risk_pool_checkpoint_v1",
    pools,
    riskObservedAt: input.risk.observedAt,
    schemaVersion: 1,
    streamKey: input.streamKey,
    targetSetHash: input.manifest.targetSetHash,
    validPools,
  };
}
