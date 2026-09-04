import type {
  AccountingRunReference,
  PoolIntervalInput,
  PositionIntervalInput,
  StableFeeBaseline,
  StableFeePoolBaseline,
} from "./domain.js";

function poolKey(address: string): string {
  return address.toLowerCase();
}

function requireNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
}

function validateRunOrder(
  from: AccountingRunReference,
  to: AccountingRunReference,
): number {
  if (from.blockNumber >= to.blockNumber) {
    throw new Error("Baseline accounting runs must be strictly block-ordered");
  }
  const fromTimestamp = Date.parse(from.blockTimestamp);
  const toTimestamp = Date.parse(to.blockTimestamp);
  if (
    !Number.isFinite(fromTimestamp) ||
    !Number.isFinite(toTimestamp) ||
    toTimestamp < fromTimestamp
  ) {
    throw new Error("Baseline accounting runs have invalid block timestamps");
  }
  return Math.floor((toTimestamp - fromTimestamp) / 1_000);
}

export function buildStableFeeBaseline(input: {
  readonly from: AccountingRunReference;
  readonly pools: readonly PoolIntervalInput[];
  readonly positions: readonly PositionIntervalInput[];
  readonly streamKey: string;
  readonly to: AccountingRunReference;
}): StableFeeBaseline {
  const elapsedSeconds = validateRunOrder(input.from, input.to);
  const poolsByAddress = new Map<string, StableFeePoolBaseline>();
  for (const pool of input.pools) {
    requireNonnegativeInteger(
      pool.activePositionsFrom,
      `${pool.poolAddress} activePositionsFrom`,
    );
    requireNonnegativeInteger(
      pool.activePositionsTo,
      `${pool.poolAddress} activePositionsTo`,
    );
    const key = poolKey(pool.poolAddress);
    if (poolsByAddress.has(key)) {
      throw new Error(`Duplicate baseline pool ${pool.poolAddress}`);
    }
    poolsByAddress.set(key, {
      accrued0: "0",
      accrued1: "0",
      activePositionsFrom: pool.activePositionsFrom,
      activePositionsTo: pool.activePositionsTo,
      enteredPositions: 0,
      exitedPositions: 0,
      fee: pool.fee,
      pairedActivePositions: 0,
      poolAddress: pool.poolAddress,
      rwaSymbol: pool.rwaSymbol,
      stablePositions: 0,
      token0: pool.token0,
      token1: pool.token1,
      touchedPositions: 0,
    });
  }

  for (const position of input.positions) {
    const key = poolKey(position.poolAddress);
    const pool = poolsByAddress.get(key);
    if (pool === undefined) {
      throw new Error(`Position references unknown baseline pool ${position.poolAddress}`);
    }
    if (position.liquidityFrom <= 0n || position.liquidityTo <= 0n) {
      throw new Error("Baseline position pairs must be active at both endpoints");
    }
    const pairedActivePositions = pool.pairedActivePositions + 1;
    if (position.touched) {
      poolsByAddress.set(key, {
        ...pool,
        pairedActivePositions,
        touchedPositions: pool.touchedPositions + 1,
      });
      continue;
    }
    if (position.liquidityFrom !== position.liquidityTo) {
      throw new Error(
        `Untouched position liquidity changed for ${position.poolAddress}:` +
        `${position.ownerAddress}:${position.tickLower}:${position.tickUpper}`,
      );
    }
    if (
      position.feeGrowthInside0LastFromX128 !==
        position.feeGrowthInside0LastToX128 ||
      position.feeGrowthInside1LastFromX128 !==
        position.feeGrowthInside1LastToX128
    ) {
      throw new Error(
        `Untouched position checkpoint changed for ${position.poolAddress}:` +
        `${position.ownerAddress}:${position.tickLower}:${position.tickUpper}`,
      );
    }
    if (
      position.pending0To < position.pending0From ||
      position.pending1To < position.pending1From
    ) {
      throw new Error(
        `Untouched position pending fees decreased for ${position.poolAddress}:` +
        `${position.ownerAddress}:${position.tickLower}:${position.tickUpper}`,
      );
    }
    poolsByAddress.set(key, {
      ...pool,
      accrued0: (
        BigInt(pool.accrued0) + position.pending0To - position.pending0From
      ).toString(),
      accrued1: (
        BigInt(pool.accrued1) + position.pending1To - position.pending1From
      ).toString(),
      pairedActivePositions,
      stablePositions: pool.stablePositions + 1,
    });
  }

  const pools = [...poolsByAddress.values()].map((pool) => {
    if (
      pool.pairedActivePositions > pool.activePositionsFrom ||
      pool.pairedActivePositions > pool.activePositionsTo ||
      pool.stablePositions + pool.touchedPositions !== pool.pairedActivePositions
    ) {
      throw new Error(`Baseline position coverage is inconsistent for ${pool.poolAddress}`);
    }
    return {
      ...pool,
      enteredPositions: pool.activePositionsTo - pool.pairedActivePositions,
      exitedPositions: pool.activePositionsFrom - pool.pairedActivePositions,
    };
  });
  const totals = pools.reduce(
    (total, pool) => ({
      enteredPositions: total.enteredPositions + pool.enteredPositions,
      exitedPositions: total.exitedPositions + pool.exitedPositions,
      pairedActivePositions:
        total.pairedActivePositions + pool.pairedActivePositions,
      stablePositions: total.stablePositions + pool.stablePositions,
      touchedPositions: total.touchedPositions + pool.touchedPositions,
    }),
    {
      enteredPositions: 0,
      exitedPositions: 0,
      pairedActivePositions: 0,
      stablePositions: 0,
      touchedPositions: 0,
    },
  );
  return {
    blockDelta: (input.to.blockNumber - input.from.blockNumber).toString(),
    computedAt: new Date().toISOString(),
    elapsedSeconds,
    executionEligible: false,
    from: input.from,
    limitations: [
      "stable_positions_only",
      "mint_or_burn_touched_positions_excluded",
      "not_total_pool_fee_revenue",
      "core_position_keys_not_nft_attribution",
      "raw_token_units_no_usd_value_or_pnl",
    ],
    methodology: "stable_core_position_pending_delta",
    pools,
    schemaVersion: 1,
    streamKey: input.streamKey,
    to: input.to,
    totals,
  };
}
