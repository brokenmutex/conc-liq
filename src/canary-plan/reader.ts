import {
  decodeFunctionResult,
  getAddress,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { factoryAbi, poolAbi } from "../abi.js";
import type { RobinhoodClient } from "../client.js";
import {
  NONFUNGIBLE_POSITION_MANAGER,
  UNISWAP_V3_FACTORY,
  USDG,
} from "../constants.js";
import { sanitizeRiskError } from "../risk/evaluate.js";
import { guardedCanaryErc20Abi, guardedCanaryPositionManagerAbi } from "./abi.js";
import type {
  GuardedCanaryChainState,
  GuardedCanaryGasEstimate,
  GuardedCanarySimulation,
  GuardedCanarySource,
} from "./domain.js";

async function requireCode(
  client: RobinhoodClient,
  address: Address,
  blockNumber: bigint,
  label: string,
): Promise<Hex> {
  const code = await client.getBytecode({ address, blockNumber });
  if (code === undefined || code === "0x") {
    throw new Error(`${label} has no code at ${address}`);
  }
  return code;
}

async function tokenState(input: {
  readonly blockNumber: bigint;
  readonly client: RobinhoodClient;
  readonly operator: Address;
  readonly token: Address;
}) {
  const [allowance, balance, decimals, symbol] = await Promise.all([
    input.client.readContract({
      abi: guardedCanaryErc20Abi,
      address: input.token,
      args: [input.operator, NONFUNGIBLE_POSITION_MANAGER],
      blockNumber: input.blockNumber,
      functionName: "allowance",
    }),
    input.client.readContract({
      abi: guardedCanaryErc20Abi,
      address: input.token,
      args: [input.operator],
      blockNumber: input.blockNumber,
      functionName: "balanceOf",
    }),
    input.client.readContract({
      abi: guardedCanaryErc20Abi,
      address: input.token,
      blockNumber: input.blockNumber,
      functionName: "decimals",
    }),
    input.client.readContract({
      abi: guardedCanaryErc20Abi,
      address: input.token,
      blockNumber: input.blockNumber,
      functionName: "symbol",
    }),
  ]);
  return {
    address: getAddress(input.token),
    allowance,
    balance,
    decimals,
    symbol,
  };
}

export class ViemGuardedCanaryReader {
  public constructor(private readonly client: RobinhoodClient) {}

  public async readState(input: {
    readonly operator: Address;
    readonly source: GuardedCanarySource;
  }): Promise<GuardedCanaryChainState> {
    const blockNumber = input.source.blockNumber;
    const [chainId, block] = await Promise.all([
      this.client.getChainId(),
      this.client.getBlock({ blockNumber }),
    ]);
    const [factoryCode, managerCode, poolCode, rwaCode, usdgCode] =
      await Promise.all([
        requireCode(this.client, UNISWAP_V3_FACTORY, blockNumber, "V3 factory"),
        requireCode(
          this.client,
          NONFUNGIBLE_POSITION_MANAGER,
          blockNumber,
          "V3 position manager",
        ),
        requireCode(this.client, input.source.poolAddress, blockNumber, "canary pool"),
        requireCode(this.client, input.source.rwaAddress, blockNumber, "NVDA token"),
        requireCode(this.client, USDG, blockNumber, "USDG token"),
      ]);
    // Force the deployment/code checks to remain part of every preflight even
    // though the hashes are not yet contract allowlist inputs.
    for (const code of [factoryCode, managerCode, poolCode, rwaCode, usdgCode]) {
      void keccak256(code);
    }
    const [
      factoryPool,
      managerFactory,
      token0,
      token1,
      fee,
      tickSpacing,
      liquidity,
      slot0,
      nativeBalance,
      gasPriceWei,
    ] = await Promise.all([
      this.client.readContract({
        abi: factoryAbi,
        address: UNISWAP_V3_FACTORY,
        args: [input.source.rwaAddress, USDG, input.source.fee],
        blockNumber,
        functionName: "getPool",
      }),
      this.client.readContract({
        abi: guardedCanaryPositionManagerAbi,
        address: NONFUNGIBLE_POSITION_MANAGER,
        blockNumber,
        functionName: "factory",
      }),
      this.client.readContract({
        abi: poolAbi,
        address: input.source.poolAddress,
        blockNumber,
        functionName: "token0",
      }),
      this.client.readContract({
        abi: poolAbi,
        address: input.source.poolAddress,
        blockNumber,
        functionName: "token1",
      }),
      this.client.readContract({
        abi: poolAbi,
        address: input.source.poolAddress,
        blockNumber,
        functionName: "fee",
      }),
      this.client.readContract({
        abi: poolAbi,
        address: input.source.poolAddress,
        blockNumber,
        functionName: "tickSpacing",
      }),
      this.client.readContract({
        abi: poolAbi,
        address: input.source.poolAddress,
        blockNumber,
        functionName: "liquidity",
      }),
      this.client.readContract({
        abi: poolAbi,
        address: input.source.poolAddress,
        blockNumber,
        functionName: "slot0",
      }),
      this.client.getBalance({ address: input.operator, blockNumber }),
      this.client.getGasPrice(),
    ]);
    const [state0, state1] = await Promise.all([
      tokenState({
        blockNumber,
        client: this.client,
        operator: input.operator,
        token: getAddress(token0),
      }),
      tokenState({
        blockNumber,
        client: this.client,
        operator: input.operator,
        token: getAddress(token1),
      }),
    ]);
    if (!isAddressEqual(state0.address, token0) || !isAddressEqual(state1.address, token1)) {
      throw new Error("Token-state order disagrees with pool identity");
    }
    return {
      blockHash: block.hash,
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
      chainId,
      factoryPool: getAddress(factoryPool),
      gasPriceWei,
      managerFactory: getAddress(managerFactory),
      nativeBalance,
      pool: {
        address: input.source.poolAddress,
        fee,
        liquidity,
        sqrtPriceX96: slot0[0],
        tick: slot0[1],
        tickSpacing,
        token0: getAddress(token0),
        token1: getAddress(token1),
        unlocked: slot0[6],
      },
      token0: state0,
      token1: state1,
    };
  }

  public async simulate(input: {
    readonly blockNumber: bigint;
    readonly calldata: Hex;
    readonly operator: Address;
  }): Promise<GuardedCanarySimulation> {
    try {
      const result = await this.client.call({
        account: input.operator,
        blockNumber: input.blockNumber,
        data: input.calldata,
        to: NONFUNGIBLE_POSITION_MANAGER,
        value: 0n,
      });
      if (result.data === undefined) throw new Error("Mint simulation returned no data");
      const decoded = decodeFunctionResult({
        abi: guardedCanaryPositionManagerAbi,
        data: result.data,
        functionName: "mint",
      });
      return {
        amount0: decoded[2].toString(),
        amount1: decoded[3].toString(),
        error: null,
        liquidity: decoded[1].toString(),
        returnData: result.data,
        succeeded: true,
        tokenId: decoded[0].toString(),
      };
    } catch (error) {
      return {
        amount0: "0",
        amount1: "0",
        error: sanitizeRiskError(error),
        liquidity: "0",
        returnData: null,
        succeeded: false,
        tokenId: "0",
      };
    }
  }

  public async estimateGas(input: {
    readonly blockNumber: bigint;
    readonly calldata: Hex;
    readonly operator: Address;
  }): Promise<GuardedCanaryGasEstimate> {
    try {
      const gas = await this.client.estimateGas({
        account: input.operator,
        blockNumber: input.blockNumber,
        data: input.calldata,
        to: NONFUNGIBLE_POSITION_MANAGER,
        value: 0n,
      });
      return { error: null, gas: gas.toString(), succeeded: true };
    } catch (error) {
      return {
        error: sanitizeRiskError(error),
        gas: null,
        succeeded: false,
      };
    }
  }
}
