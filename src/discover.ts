import {
  getAddress,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi, factoryAbi, poolAbi } from "./abi.js";
import type { RobinhoodClient } from "./client.js";
import {
  NONFUNGIBLE_POSITION_MANAGER,
  ROBINHOOD_CHAIN_ID,
  UNISWAP_V3_FACTORY,
  USDG,
  ZERO_ADDRESS,
} from "./constants.js";
import type {
  CanonicalAsset,
  ObserverSnapshot,
  PoolSnapshot,
  VerifiedAsset,
} from "./domain.js";

async function requireContractCode(
  client: RobinhoodClient,
  address: Address,
  blockNumber: bigint,
  label: string,
): Promise<Hex> {
  const code = await client.getBytecode({ address, blockNumber });
  if (code === undefined || code === "0x") {
    throw new Error(`${label} has no contract code at ${address}`);
  }
  return code;
}

async function verifyAsset(
  client: RobinhoodClient,
  asset: CanonicalAsset,
  blockNumber: bigint,
): Promise<VerifiedAsset> {
  const [code, onchainSymbol, onchainDecimals] = await Promise.all([
    requireContractCode(client, asset.address, blockNumber, asset.symbol),
    client.readContract({
      abi: erc20Abi,
      address: asset.address,
      blockNumber,
      functionName: "symbol",
    }),
    client.readContract({
      abi: erc20Abi,
      address: asset.address,
      blockNumber,
      functionName: "decimals",
    }),
  ]);

  if (onchainSymbol.toUpperCase() !== asset.symbol) {
    throw new Error(
      `${asset.symbol} registry/on-chain symbol mismatch: ${onchainSymbol}`,
    );
  }
  if (onchainDecimals !== asset.decimals) {
    throw new Error(
      `${asset.symbol} registry/on-chain decimals mismatch: ${asset.decimals} != ${onchainDecimals}`,
    );
  }
  if (asset.status !== "ASSET_STATUS_ACTIVE") {
    throw new Error(`${asset.symbol} is not active in the Robinhood registry: ${asset.status}`);
  }

  return {
    ...asset,
    codeHash: keccak256(code),
    onchainDecimals,
    onchainSymbol,
  };
}

function validatePoolIdentity(
  pool: Address,
  asset: Address,
  token0: Address,
  token1: Address,
  expectedFee: number,
  actualFee: number,
): void {
  const expectedTokens = [asset, USDG].map((address) => address.toLowerCase()).sort();
  const actualTokens = [token0, token1].map((address) => address.toLowerCase()).sort();

  if (
    expectedTokens[0] !== actualTokens[0] ||
    expectedTokens[1] !== actualTokens[1]
  ) {
    throw new Error(`Factory-returned pool ${pool} has an unexpected token pair`);
  }
  if (actualFee !== expectedFee) {
    throw new Error(
      `Factory-returned pool ${pool} fee mismatch: ${actualFee} != ${expectedFee}`,
    );
  }
}

async function readPool(
  client: RobinhoodClient,
  address: Address,
  asset: VerifiedAsset,
  expectedFee: number,
  blockNumber: bigint,
): Promise<PoolSnapshot> {
  const [code, token0, token1, fee, tickSpacing, liquidity, slot0] = await Promise.all([
    requireContractCode(client, address, blockNumber, `${asset.symbol} pool`),
    client.readContract({ abi: poolAbi, address, blockNumber, functionName: "token0" }),
    client.readContract({ abi: poolAbi, address, blockNumber, functionName: "token1" }),
    client.readContract({ abi: poolAbi, address, blockNumber, functionName: "fee" }),
    client.readContract({ abi: poolAbi, address, blockNumber, functionName: "tickSpacing" }),
    client.readContract({ abi: poolAbi, address, blockNumber, functionName: "liquidity" }),
    client.readContract({ abi: poolAbi, address, blockNumber, functionName: "slot0" }),
  ]);

  validatePoolIdentity(address, asset.address, token0, token1, expectedFee, fee);

  const [
    sqrtPriceX96,
    tick,
    observationIndex,
    observationCardinality,
    observationCardinalityNext,
    feeProtocol,
    unlocked,
  ] = slot0;

  return {
    address: getAddress(address),
    codeHash: keccak256(code),
    fee,
    feeProtocol,
    liquidity: liquidity.toString(),
    observationCardinality,
    observationCardinalityNext,
    observationIndex,
    rwaSymbol: asset.symbol,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick,
    tickSpacing,
    token0: getAddress(token0),
    token1: getAddress(token1),
    unlocked,
  };
}

export async function observeAtLatestBlock(
  client: RobinhoodClient,
  canonicalAssets: readonly CanonicalAsset[],
  feeTiers: readonly number[],
): Promise<ObserverSnapshot> {
  const chainId = await client.getChainId();
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      `RPC chain ID mismatch: expected ${ROBINHOOD_CHAIN_ID}, received ${chainId}`,
    );
  }

  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;

  const [factoryCode, positionManagerCode, usdgCode, usdgSymbol, usdgDecimals] =
    await Promise.all([
      requireContractCode(client, UNISWAP_V3_FACTORY, blockNumber, "Uniswap v3 factory"),
      requireContractCode(
        client,
        NONFUNGIBLE_POSITION_MANAGER,
        blockNumber,
        "Uniswap v3 position manager",
      ),
      requireContractCode(client, USDG, blockNumber, "canonical USDG"),
      client.readContract({
        abi: erc20Abi,
        address: USDG,
        blockNumber,
        functionName: "symbol",
      }),
      client.readContract({
        abi: erc20Abi,
        address: USDG,
        blockNumber,
        functionName: "decimals",
      }),
    ]);

  // Reading code is an explicit deployment check even though only the factory
  // and USDG hashes are stored in this first schema.
  void positionManagerCode;

  if (usdgSymbol.toUpperCase() !== "USDG") {
    throw new Error(`Canonical USDG address reports unexpected symbol ${usdgSymbol}`);
  }

  const assets: VerifiedAsset[] = [];
  const pools: PoolSnapshot[] = [];

  for (const canonicalAsset of canonicalAssets) {
    const asset = await verifyAsset(client, canonicalAsset, blockNumber);
    assets.push(asset);

    for (const feeTier of feeTiers) {
      const address = await client.readContract({
        abi: factoryAbi,
        address: UNISWAP_V3_FACTORY,
        args: [asset.address, USDG, feeTier],
        blockNumber,
        functionName: "getPool",
      });

      if (!isAddressEqual(address, ZERO_ADDRESS)) {
        pools.push(await readPool(client, address, asset, feeTier, blockNumber));
      }
    }
  }

  return {
    assets,
    blockHash: block.hash,
    blockNumber: blockNumber.toString(),
    blockTimestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
    chainId,
    contracts: {
      factory: UNISWAP_V3_FACTORY,
      factoryCodeHash: keccak256(factoryCode),
      positionManager: NONFUNGIBLE_POSITION_MANAGER,
      usdg: USDG,
      usdgCodeHash: keccak256(usdgCode),
      usdgDecimals,
      usdgSymbol,
    },
    observedAt: new Date().toISOString(),
    pools,
    schemaVersion: 1,
  };
}
