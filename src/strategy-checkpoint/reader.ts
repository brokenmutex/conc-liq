import type { Address } from "viem";
import { erc20Abi } from "../abi.js";
import type { RobinhoodClient } from "../client.js";
import { replayPoolStateAbi } from "../replay/abi.js";

export interface RawStrategyPoolState {
  readonly feeGrowthGlobal0X128: bigint;
  readonly feeGrowthGlobal1X128: bigint;
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly unlocked: boolean;
}

export interface StrategyCheckpointReader {
  readPool(address: Address, blockNumber: bigint): Promise<RawStrategyPoolState>;
  readTokenDecimals(address: Address, blockNumber: bigint): Promise<number>;
}

export class ViemStrategyCheckpointReader implements StrategyCheckpointReader {
  public constructor(private readonly client: RobinhoodClient) {}

  public async readPool(
    address: Address,
    blockNumber: bigint,
  ): Promise<RawStrategyPoolState> {
    const [slot0, liquidity, feeGrowthGlobal0X128, feeGrowthGlobal1X128] =
      await Promise.all([
        this.client.readContract({
          abi: replayPoolStateAbi,
          address,
          blockNumber,
          functionName: "slot0",
        }),
        this.client.readContract({
          abi: replayPoolStateAbi,
          address,
          blockNumber,
          functionName: "liquidity",
        }),
        this.client.readContract({
          abi: replayPoolStateAbi,
          address,
          blockNumber,
          functionName: "feeGrowthGlobal0X128",
        }),
        this.client.readContract({
          abi: replayPoolStateAbi,
          address,
          blockNumber,
          functionName: "feeGrowthGlobal1X128",
        }),
      ]);
    return {
      feeGrowthGlobal0X128,
      feeGrowthGlobal1X128,
      liquidity,
      sqrtPriceX96: slot0[0],
      tick: slot0[1],
      unlocked: slot0[6],
    };
  }

  public async readTokenDecimals(
    address: Address,
    blockNumber: bigint,
  ): Promise<number> {
    return this.client.readContract({
      abi: erc20Abi,
      address,
      blockNumber,
      functionName: "decimals",
    });
  }
}
