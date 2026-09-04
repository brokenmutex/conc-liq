import { getAddress, type Address } from "viem";
import { validateAccountingRun } from "../backtest/canonical.js";
import type { RobinhoodClient } from "../client.js";
import {
  NONFUNGIBLE_POSITION_MANAGER,
  UNISWAP_V3_FACTORY,
} from "../constants.js";
import { erc20DecimalsAbi, nonfungiblePositionManagerReadAbi } from "./abi.js";
import type { AccountingRunReference } from "../backtest/domain.js";
import type {
  NftPositionSnapshot,
  NftPositionState,
  NftSourceInput,
} from "./domain.js";
import { evaluateNftPosition } from "./evaluate.js";

async function readPosition(input: {
  readonly client: RobinhoodClient;
  readonly manager: Address;
  readonly run: AccountingRunReference;
  readonly source: NftSourceInput;
  readonly tokenId: bigint;
  readonly tokenDecimals: (token: Address) => Promise<number>;
}): Promise<NftPositionSnapshot> {
  const [ownerAddress, result] = await Promise.all([
    input.client.readContract({
      abi: nonfungiblePositionManagerReadAbi,
      address: input.manager,
      args: [input.tokenId],
      blockNumber: input.source.run.blockNumber,
      functionName: "ownerOf",
    }),
    input.client.readContract({
      abi: nonfungiblePositionManagerReadAbi,
      address: input.manager,
      args: [input.tokenId],
      blockNumber: input.source.run.blockNumber,
      functionName: "positions",
    }),
  ]);
  const token0 = getAddress(result[2]);
  const token1 = getAddress(result[3]);
  const [token0Decimals, token1Decimals] = await Promise.all([
    input.tokenDecimals(token0),
    input.tokenDecimals(token1),
  ]);
  const position: NftPositionState = {
    fee: result[4],
    feeGrowthInside0LastX128: result[8],
    feeGrowthInside1LastX128: result[9],
    liquidity: result[7],
    nonce: result[0],
    operator: getAddress(result[1]),
    ownerAddress: getAddress(ownerAddress),
    tickLower: result[5],
    tickUpper: result[6],
    token0,
    token1,
    tokenId: input.tokenId,
    tokensOwed0: result[10],
    tokensOwed1: result[11],
  };
  return evaluateNftPosition({
    pools: input.source.pools,
    position,
    positionManager: input.manager,
    run: input.run,
    streamKey: input.source.streamKey,
    ticks: input.source.ticks,
    token0Decimals,
    token1Decimals,
  });
}

export async function collectNftPositionSnapshots(input: {
  readonly client: RobinhoodClient;
  readonly manager?: Address;
  readonly source: NftSourceInput;
  readonly tokenIds: readonly bigint[];
}): Promise<NftPositionSnapshot[]> {
  if (input.tokenIds.length === 0) {
    throw new Error("At least one NFT token ID is required");
  }
  const uniqueTokenIds = new Set(input.tokenIds.map((tokenId) => tokenId.toString()));
  if (
    uniqueTokenIds.size !== input.tokenIds.length ||
    input.tokenIds.some((tokenId) => tokenId <= 0n)
  ) {
    throw new Error("NFT token IDs must be unique positive integers");
  }
  const manager = input.manager ?? NONFUNGIBLE_POSITION_MANAGER;
  const chainId = await input.client.getChainId();
  if (chainId !== input.source.run.chainId) {
    throw new Error(
      `NFT RPC chain ID ${chainId} does not match accounting source ` +
      `${input.source.run.chainId}`,
    );
  }
  const [run, bytecode, factory] = await Promise.all([
    validateAccountingRun(input.client, input.source.run),
    input.client.getBytecode({
      address: manager,
      blockNumber: input.source.run.blockNumber,
    }),
    input.client.readContract({
      abi: nonfungiblePositionManagerReadAbi,
      address: manager,
      blockNumber: input.source.run.blockNumber,
      functionName: "factory",
    }),
  ]);
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`Position Manager ${manager} has no bytecode`);
  }
  if (getAddress(factory) !== UNISWAP_V3_FACTORY) {
    throw new Error(`Position Manager ${manager} has an unexpected factory`);
  }
  const decimals = new Map<string, Promise<number>>();
  const tokenDecimals = (token: Address): Promise<number> => {
    const key = token.toLowerCase();
    let pending = decimals.get(key);
    if (pending === undefined) {
      pending = input.client.readContract({
        abi: erc20DecimalsAbi,
        address: token,
        blockNumber: input.source.run.blockNumber,
        functionName: "decimals",
      });
      decimals.set(key, pending);
    }
    return pending;
  };
  const snapshots = await Promise.all(input.tokenIds.map((tokenId) =>
    readPosition({
      client: input.client,
      manager,
      run,
      source: input.source,
      tokenDecimals,
      tokenId,
    })
  ));
  const finalRun = await validateAccountingRun(input.client, input.source.run);
  if (
    finalRun.blockHash.toLowerCase() !== run.blockHash.toLowerCase() ||
    snapshots.some((snapshot) =>
      snapshot.run.blockHash.toLowerCase() !== run.blockHash.toLowerCase()
    )
  ) {
    throw new Error("NFT source block changed during collection");
  }
  return snapshots;
}
