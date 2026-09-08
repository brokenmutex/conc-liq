import type { RpcHealthMonitorConfig } from "./config.js";
import type {
  RpcEndpointProbe,
  RpcHealthEvaluation,
  RpcHealthPreviousStatus,
} from "./domain.js";
import { evaluateRpcHealth } from "./policy.js";

interface RpcResponse {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
  readonly result?: unknown;
}

interface ParsedBlock {
  readonly hash: string;
  readonly number: bigint;
  readonly timestamp: bigint;
}

interface EndpointTarget {
  readonly name: string;
  readonly role: "private" | "reference";
  readonly url: string;
}

function sanitizedError(error: unknown): string {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return raw
    .replace(/https?:\/\/[^\s]+/gu, "<rpc-url>")
    .replace(/[A-Za-z0-9_-]{24,}/gu, "<redacted>")
    .slice(0, 500);
}

async function rpcCall(
  url: string,
  method: string,
  parameters: readonly unknown[],
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(url, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params: parameters }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = await response.json() as RpcResponse;
  if (body.error !== undefined) {
    const code = typeof body.error.code === "number" ? body.error.code : "unknown";
    const message = typeof body.error.message === "string"
      ? body.error.message
      : "JSON-RPC error";
    throw new Error(`JSON-RPC ${code}: ${message}`);
  }
  if (!("result" in body)) {
    throw new Error("JSON-RPC response has no result");
  }
  return body.result;
}

function hexQuantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value)) {
    throw new Error(`Invalid ${field} quantity`);
  }
  return BigInt(value);
}

function parseBlock(value: unknown): ParsedBlock {
  if (value === null || typeof value !== "object") {
    throw new Error("RPC returned no block");
  }
  const block = value as Record<string, unknown>;
  if (typeof block.hash !== "string" || !/^0x[0-9a-f]{64}$/iu.test(block.hash)) {
    throw new Error("RPC block has an invalid hash");
  }
  return {
    hash: block.hash,
    number: hexQuantity(block.number, "block number"),
    timestamp: hexQuantity(block.timestamp, "block timestamp"),
  };
}

function emptyProbe(target: EndpointTarget): RpcEndpointProbe {
  return {
    anchorBlock: null,
    anchorError: null,
    anchorHash: null,
    chainId: null,
    error: null,
    headBlock: null,
    headHash: null,
    headTimestamp: null,
    latencyMs: 0,
    name: target.name,
    role: target.role,
    syncing: null,
    syncingError: null,
  };
}

async function probeLatest(input: {
  readonly expectedChainId: number;
  readonly target: EndpointTarget;
  readonly timeoutMs: number;
}): Promise<RpcEndpointProbe> {
  const startedAt = Date.now();
  const chainPromise = rpcCall(
    input.target.url,
    "eth_chainId",
    [],
    input.timeoutMs,
  );
  const blockPromise = rpcCall(
    input.target.url,
    "eth_getBlockByNumber",
    ["latest", false],
    input.timeoutMs,
  );
  const syncingPromise = input.target.role === "private"
    ? rpcCall(input.target.url, "eth_syncing", [], input.timeoutMs)
    : Promise.resolve(undefined);
  const [chainResult, blockResult, syncingResult] = await Promise.allSettled([
    chainPromise,
    blockPromise,
    syncingPromise,
  ]);
  const latencyMs = Date.now() - startedAt;
  let chainId: number | null = null;
  let block: ParsedBlock | null = null;
  const errors: string[] = [];
  if (chainResult.status === "fulfilled") {
    try {
      const parsed = hexQuantity(chainResult.value, "chain ID");
      if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Chain ID exceeds the safe integer range");
      }
      chainId = Number(parsed);
      if (chainId !== input.expectedChainId) {
        errors.push(`chain_id_mismatch:${chainId}`);
      }
    } catch (error) {
      errors.push(sanitizedError(error));
    }
  } else {
    errors.push(sanitizedError(chainResult.reason));
  }
  if (blockResult.status === "fulfilled") {
    try {
      block = parseBlock(blockResult.value);
    } catch (error) {
      errors.push(sanitizedError(error));
    }
  } else {
    errors.push(sanitizedError(blockResult.reason));
  }
  let syncing: boolean | null = null;
  let syncingError: string | null = null;
  if (input.target.role === "private") {
    if (syncingResult.status === "fulfilled") {
      if (typeof syncingResult.value === "boolean") {
        syncing = syncingResult.value;
      } else if (
        syncingResult.value !== null &&
        typeof syncingResult.value === "object"
      ) {
        syncing = true;
      } else {
        syncingError = "Invalid eth_syncing response";
      }
    } else {
      syncingError = sanitizedError(syncingResult.reason);
    }
  }
  return {
    ...emptyProbe(input.target),
    chainId,
    error: errors.length === 0 ? null : errors.join("; "),
    headBlock: block?.number ?? null,
    headHash: block?.hash ?? null,
    headTimestamp: block?.timestamp ?? null,
    latencyMs,
    syncing,
    syncingError,
  };
}

function quantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

export function calculateReferenceAnchorBlock(
  heads: readonly bigint[],
  confirmationDepth: number,
): bigint | null {
  if (heads.length === 0) return null;
  const lowest = heads.reduce((result, head) => head < result ? head : result);
  const highest = heads.reduce((result, head) => head > result ? head : result);
  const depth = BigInt(confirmationDepth);

  // If the slowest reference is already at least `depth` behind the fastest,
  // its latest block is itself confirmed by the faster reference. Reusing the
  // returned latest hash also supports head-only public endpoints.
  if (highest - lowest >= depth) return lowest;
  return lowest > depth ? lowest - depth : 0n;
}

/** Keep the full confirmation depth on every node during an ordinary small lag.
 * Bound the adjustment: a badly lagging private node cannot drag public reads
 * arbitrarily far into history. Larger lag keeps the reference-derived anchor.
 */
export function calculateMonitorAnchorBlock(
  referenceHeads: readonly bigint[], confirmationDepth: number, privateHead: bigint | null,
): bigint | null {
  const referenceAnchor = calculateReferenceAnchorBlock(referenceHeads, confirmationDepth);
  if (referenceAnchor === null || privateHead === null) return referenceAnchor;
  const highest = referenceHeads.reduce((a, b) => a > b ? a : b);
  if (highest - privateHead > 10n) return referenceAnchor;
  const privateAnchor = privateHead > BigInt(confirmationDepth) ? privateHead - BigInt(confirmationDepth) : 0n;
  return privateAnchor < referenceAnchor ? privateAnchor : referenceAnchor;
}

async function probeAnchor(input: {
  readonly anchorBlock: bigint;
  readonly latest: RpcEndpointProbe;
  readonly target: EndpointTarget;
  readonly timeoutMs: number;
}): Promise<RpcEndpointProbe> {
  if (input.latest.error !== null) {
    return {
      ...input.latest,
      anchorBlock: input.anchorBlock,
      anchorError: "Latest probe unavailable",
    };
  }
  if (
    input.latest.headBlock === input.anchorBlock &&
    input.latest.headHash !== null
  ) {
    return {
      ...input.latest,
      anchorBlock: input.anchorBlock,
      anchorHash: input.latest.headHash,
    };
  }
  try {
    const block = parseBlock(await rpcCall(
      input.target.url,
      "eth_getBlockByNumber",
      [quantity(input.anchorBlock), false],
      input.timeoutMs,
    ));
    if (block.number !== input.anchorBlock) {
      throw new Error(
        `RPC returned anchor ${block.number} for ${input.anchorBlock}`,
      );
    }
    return {
      ...input.latest,
      anchorBlock: input.anchorBlock,
      anchorHash: block.hash,
    };
  } catch (error) {
    return {
      ...input.latest,
      anchorBlock: input.anchorBlock,
      anchorError: sanitizedError(error),
    };
  }
}

export async function runRpcHealthProbe(input: {
  readonly config: RpcHealthMonitorConfig;
  readonly previous: RpcHealthPreviousStatus | null;
}): Promise<RpcHealthEvaluation> {
  const targets: EndpointTarget[] = [
    { name: "private", role: "private", url: input.config.privateUrl },
    ...input.config.referenceUrls.map((url, index) => ({
      name: `reference_${index + 1}`,
      role: "reference" as const,
      url,
    })),
  ];
  let probes = await Promise.all(targets.map((target) => probeLatest({
    expectedChainId: input.config.expectedChainId,
    target,
    timeoutMs: input.config.requestTimeoutMs,
  })));
  // Allow at most ten blocks of private lag without losing confirmation depth.
  // Larger delays retain the reference anchor and existing readiness checks.
  const usableReferenceHeads = probes
    .filter((probe) =>
      probe.role === "reference" && probe.error === null &&
      probe.chainId === input.config.expectedChainId && probe.headBlock !== null
    )
    .map((probe) => probe.headBlock!);
  const privateProbe = probes.find(probe => probe.role === "private");
  const anchorBlock = calculateMonitorAnchorBlock(
    usableReferenceHeads,
    input.config.confirmationDepth,
    privateProbe?.error === null && privateProbe.chainId === input.config.expectedChainId && privateProbe.syncing === false
      ? privateProbe.headBlock : null,
  );
  if (anchorBlock !== null) {
    probes = await Promise.all(probes.map((latest, index) => probeAnchor({
      anchorBlock,
      latest,
      target: targets[index]!,
      timeoutMs: input.config.requestTimeoutMs,
    })));
  }
  return evaluateRpcHealth({
    config: input.config,
    observedAt: new Date().toISOString(),
    previous: input.previous,
    probes,
  });
}
