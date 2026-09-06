import { encodeFunctionData, decodeFunctionResult, getAddress, isAddressEqual, parseAbi, type Address } from "viem";
import { principalAmounts } from "../backtest/principal.js";
import { NONFUNGIBLE_POSITION_MANAGER, USDG } from "../constants.js";
import type { RobinhoodClient } from "../client.js";
import { nonfungiblePositionManagerReadAbi } from "../nft/abi.js";
import type { GuardedCanarySource } from "./domain.js";

export const canaryExitAbi = parseAbi([
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint256 amount0,uint256 amount1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns (uint256 amount0,uint256 amount1)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const UINT128_MAX = (1n << 128n) - 1n;

export function buildCanaryExit(input: {
  readonly operator: Address;
  readonly owner: Address;
  readonly tokenId: bigint;
  readonly source: Pick<GuardedCanarySource, "rwaSymbol" | "rwaAddress" | "fee" | "token0" | "token1">;
  readonly position: { readonly token0: Address; readonly token1: Address; readonly fee: number; readonly tickLower: number; readonly tickUpper: number; readonly liquidity: bigint };
  readonly sqrtPriceX96: bigint;
  readonly blockTimestamp: bigint;
  readonly slippageBps: number;
  readonly ttlSeconds: number;
}) {
  const { position, source } = input;
  if (!isAddressEqual(input.operator, input.owner)) throw new Error("Canary exit requires NFT ownership");
  if (input.tokenId <= 0n || position.liquidity <= 0n) throw new Error("Canary exit requires a nonempty position");
  if (source.rwaSymbol !== "NVDA" || source.fee !== 500 || position.fee !== 500 ||
      !isAddressEqual(position.token0, source.token0) || !isAddressEqual(position.token1, source.token1) ||
      ![position.token0, position.token1].some((token) => isAddressEqual(token, USDG)) ||
      ![position.token0, position.token1].some((token) => isAddressEqual(token, source.rwaAddress))) {
    throw new Error("Canary exit position is not the selected NVDA/USDG pool");
  }
  if (!Number.isSafeInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 500 ||
      !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 1800) {
    throw new Error("Invalid canary exit slippage or deadline");
  }
  const principal = principalAmounts({ ...position, sqrtPriceX96: input.sqrtPriceX96 });
  const haircut = 10_000n - BigInt(input.slippageBps);
  const amount0Min = principal.amount0 * haircut / 10_000n;
  const amount1Min = principal.amount1 * haircut / 10_000n;
  const deadline = input.blockTimestamp + BigInt(input.ttlSeconds);
  const calls = [
    encodeFunctionData({ abi: canaryExitAbi, functionName: "decreaseLiquidity", args: [{
      tokenId: input.tokenId, liquidity: position.liquidity, amount0Min, amount1Min, deadline,
    }] }),
    encodeFunctionData({ abi: canaryExitAbi, functionName: "collect", args: [{
      tokenId: input.tokenId, recipient: getAddress(input.operator), amount0Max: UINT128_MAX, amount1Max: UINT128_MAX,
    }] }),
  ];
  return { to: NONFUNGIBLE_POSITION_MANAGER, value: 0n,
    calldata: encodeFunctionData({ abi: canaryExitAbi, functionName: "multicall", args: [calls] }),
    tokenId: input.tokenId, liquidity: position.liquidity, recipient: getAddress(input.operator),
    amount0Min, amount1Min, deadline, expectedPrincipal0: principal.amount0, expectedPrincipal1: principal.amount1 };
}

export async function readCanaryPosition(client: RobinhoodClient, tokenId: bigint, blockNumber: bigint) {
  const [owner, position] = await Promise.all([
    client.readContract({ address: NONFUNGIBLE_POSITION_MANAGER, abi: nonfungiblePositionManagerReadAbi, functionName: "ownerOf", args: [tokenId], blockNumber }),
    client.readContract({ address: NONFUNGIBLE_POSITION_MANAGER, abi: nonfungiblePositionManagerReadAbi, functionName: "positions", args: [tokenId], blockNumber }),
  ]);
  return { owner, token0: position[2], token1: position[3], fee: position[4], tickLower: position[5], tickUpper: position[6], liquidity: position[7], tokensOwed0: position[10], tokensOwed1: position[11] };
}

export function decodeCanaryExit(data: `0x${string}`) {
  const results = decodeFunctionResult({ abi: canaryExitAbi, functionName: "multicall", data });
  if (results.length !== 2) throw new Error("Canary exit returned an unexpected result count");
  const decreased = decodeFunctionResult({ abi: canaryExitAbi, functionName: "decreaseLiquidity", data: results[0]! });
  const collected = decodeFunctionResult({ abi: canaryExitAbi, functionName: "collect", data: results[1]! });
  if (collected[0] < decreased[0] || collected[1] < decreased[1]) throw new Error("Canary exit did not collect the decreased principal");
  return { decreased0: decreased[0], decreased1: decreased[1], collected0: collected[0], collected1: collected[1] };
}
