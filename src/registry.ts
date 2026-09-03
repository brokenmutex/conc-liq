import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { ROBINHOOD_CHAIN_ID } from "./constants.js";
import type { CanonicalAsset } from "./domain.js";

const tradingCapabilitySchema = z.object({
  fractional: z.string().min(1),
  whole: z.string().min(1),
});

const tradingCapabilitiesSchema = z.object({
  extended: tradingCapabilitySchema.optional(),
  market: tradingCapabilitySchema.optional(),
  overnight: tradingCapabilitySchema.optional(),
});

const deploymentSchema = z.object({
  chainId: z.number().int(),
  contractAddress: z.string(),
  networkName: z.string(),
});

const assetSchema = z.object({
  currentMultiplier: z.string().min(1),
  deployments: z.array(deploymentSchema),
  id: z.string().min(1),
  isin: z.string().min(1).optional(),
  pendingMultiplier: z.string(),
  pendingMultiplierEffectiveTime: z.union([z.string(), z.number()]).nullish(),
  status: z.string().min(1),
  tokenDecimals: z.number().int().min(0).max(255),
  tokenName: z.string().min(1),
  tokenSymbol: z.string().min(1),
  tradingCapabilities: tradingCapabilitiesSchema.nullish(),
});

const registrySchema = z.object({
  assets: z.array(assetSchema),
});

export type RegistryPayload = z.infer<typeof registrySchema>;

export function parseRegistry(value: unknown): RegistryPayload {
  return registrySchema.parse(value);
}

export async function fetchRegistry(
  url: string,
  timeoutMs: number,
): Promise<RegistryPayload> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Robinhood asset registry returned HTTP ${response.status}`);
  }

  return parseRegistry(await response.json());
}

export function selectCanonicalAssets(
  registry: RegistryPayload,
  requestedSymbols: readonly string[],
  chainId: number = ROBINHOOD_CHAIN_ID,
): CanonicalAsset[] {
  const requested = new Set(requestedSymbols.map((symbol) => symbol.toUpperCase()));
  const selected = new Map<string, CanonicalAsset>();

  for (const asset of registry.assets) {
    const symbol = asset.tokenSymbol.toUpperCase();
    if (!requested.has(symbol)) {
      continue;
    }

    const deployment = asset.deployments.find((entry) => entry.chainId === chainId);
    if (deployment === undefined || !isAddress(deployment.contractAddress)) {
      continue;
    }

    if (selected.has(symbol)) {
      throw new Error(`Robinhood registry contains duplicate ${symbol} deployments on chain ${chainId}`);
    }

    selected.set(symbol, {
      address: getAddress(deployment.contractAddress) as Address,
      currentMultiplier: asset.currentMultiplier,
      decimals: asset.tokenDecimals,
      id: asset.id,
      isin: asset.isin ?? null,
      name: asset.tokenName,
      pendingMultiplier: asset.pendingMultiplier || null,
      pendingMultiplierEffectiveTime:
        asset.pendingMultiplierEffectiveTime === undefined ||
        asset.pendingMultiplierEffectiveTime === null
          ? null
          : String(asset.pendingMultiplierEffectiveTime),
      status: asset.status,
      symbol,
      tradingCapabilities: asset.tradingCapabilities ?? null,
    });
  }

  const missing = [...requested].filter((symbol) => !selected.has(symbol));
  if (missing.length > 0) {
    throw new Error(
      `Requested canonical assets are missing from Robinhood registry on chain ${chainId}: ${missing.join(", ")}`,
    );
  }

  return requestedSymbols.map((symbol) => {
    const asset = selected.get(symbol.toUpperCase());
    if (asset === undefined) {
      throw new Error(`Internal registry selection error for ${symbol}`);
    }
    return asset;
  });
}
