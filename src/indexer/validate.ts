import { isAddressEqual } from "viem";
import { factoryAbi, poolAbi } from "../abi.js";
import type { RobinhoodClient } from "../client.js";
import {
  ROBINHOOD_CHAIN_ID,
  UNISWAP_V3_FACTORY,
  USDG,
} from "../constants.js";
import type { PoolManifest, V3PoolTarget } from "./domain.js";
import { poolCreatedEvent } from "./abi.js";

function pairMatches(
  target: V3PoolTarget,
  token0: `0x${string}`,
  token1: `0x${string}`,
): boolean {
  return (
    (isAddressEqual(token0, target.rwaAddress) && isAddressEqual(token1, USDG)) ||
    (isAddressEqual(token0, USDG) && isAddressEqual(token1, target.rwaAddress))
  );
}

async function validateTarget(
  client: RobinhoodClient,
  target: V3PoolTarget,
  blockNumber: bigint,
): Promise<void> {
  const [code, token0, token1, fee, factoryPool] = await Promise.all([
    client.getBytecode({ address: target.address, blockNumber }),
    client.readContract({
      abi: poolAbi,
      address: target.address,
      blockNumber,
      functionName: "token0",
    }),
    client.readContract({
      abi: poolAbi,
      address: target.address,
      blockNumber,
      functionName: "token1",
    }),
    client.readContract({
      abi: poolAbi,
      address: target.address,
      blockNumber,
      functionName: "fee",
    }),
    client.readContract({
      abi: factoryAbi,
      address: UNISWAP_V3_FACTORY,
      args: [target.rwaAddress, USDG, target.fee],
      blockNumber,
      functionName: "getPool",
    }),
  ]);

  if (code === undefined || code === "0x") {
    throw new Error(`Configured pool has no code: ${target.address}`);
  }
  if (!pairMatches(target, token0, token1)) {
    throw new Error(`Configured pool has unexpected tokens: ${target.address}`);
  }
  if (fee !== target.fee) {
    throw new Error(`Configured pool has unexpected fee: ${target.address}`);
  }
  if (!isAddressEqual(factoryPool, target.address)) {
    throw new Error(`Factory does not map to configured pool: ${target.address}`);
  }

  const creationLogs = await client.getLogs({
    address: UNISWAP_V3_FACTORY,
    event: poolCreatedEvent,
    fromBlock: target.createdBlock,
    strict: true,
    toBlock: target.createdBlock,
  });
  if (!creationLogs.some((entry) => isAddressEqual(entry.args.pool, target.address))) {
    throw new Error(
      `PoolCreated evidence missing at configured block ${target.createdBlock} for ${target.address}`,
    );
  }
}

export async function validatePoolManifest(
  client: RobinhoodClient,
  manifest: PoolManifest,
  blockNumber: bigint,
  beforeRpc?: () => Promise<void>,
): Promise<void> {
  await beforeRpc?.();
  const chainId = await client.getChainId();
  if (chainId !== ROBINHOOD_CHAIN_ID || manifest.chainId !== chainId) {
    throw new Error(
      `Indexer chain mismatch: RPC=${chainId}, manifest=${manifest.chainId}, expected=${ROBINHOOD_CHAIN_ID}`,
    );
  }

  for (const target of manifest.pools) {
    await beforeRpc?.();
    await validateTarget(client, target, blockNumber);
  }
}
