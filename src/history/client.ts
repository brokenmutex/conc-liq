import { createRobinhoodClient } from "../client.js";
import { createHyperSyncFetch } from "./hypersync.js";

export const HISTORY_TRANSPORT_URL = "https://historical-data.invalid";

export interface HistoryConfig {
  readonly source: "legacy" | "envio" | "hypersync";
  readonly historyUrl?: string;
  readonly archiveUrl?: string;
  readonly requestIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly apiToken?: string;
}

function endpoint(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL`);
  }
}

export function loadHistoryConfig(
  liveRpcUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): HistoryConfig {
  const source = environment.HISTORY_SOURCE ?? "legacy";
  if (source === "legacy") return { source };
  if (source !== "envio" && source !== "hypersync") throw new Error("HISTORY_SOURCE must be legacy, envio, or hypersync");
  const token = environment.ENVIO_API_TOKEN?.trim();
  if (source === "hypersync" && !token) throw new Error("Native HyperSync requires ENVIO_API_TOKEN");
  const raw = source === "hypersync" ? environment.HYPERSYNC_URL ?? "https://4663.hypersync.xyz" : environment.RH_HISTORY_RPC_URL ?? (token
    ? `https://4663.rpc.hypersync.xyz/${encodeURIComponent(token)}`
    : undefined);
  if (!raw) throw new Error("Envio history requires ENVIO_API_TOKEN or RH_HISTORY_RPC_URL");
  const historyUrl = endpoint(raw, "RH_HISTORY_RPC_URL");
  const archiveUrl = environment.RH_ARCHIVE_RPC_URL
    ? endpoint(environment.RH_ARCHIVE_RPC_URL, "RH_ARCHIVE_RPC_URL")
    : undefined;
  const requestIntervalMs = Number(environment.HISTORY_REQUEST_INTERVAL_MS ?? "500");
  const timeoutMs = Number(environment.HISTORY_RPC_TIMEOUT_MS ?? "60000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("HISTORY_RPC_TIMEOUT_MS must be an integer from 1 to 300000");
  }
  if (!Number.isSafeInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 60_000) {
    throw new Error("HISTORY_REQUEST_INTERVAL_MS must be an integer from 0 to 60000");
  }
  const liveHost = new URL(liveRpcUrl).hostname;
  if ([historyUrl, archiveUrl].some((url) => url && new URL(url).hostname === liveHost)) {
    throw new Error("Historical providers must be separate from the live node host");
  }
  return { source, historyUrl, archiveUrl, requestIntervalMs, timeoutMs, apiToken: token };
}

const historyMethods = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_getBlockReceipts", "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex",
]);
const stateBlockParameter: Readonly<Record<string, number>> = {
  eth_call: 1, eth_getCode: 1, eth_getBalance: 1, eth_getStorageAt: 2,
};

export function historyRequestTarget(
  config: HistoryConfig,
  request: { readonly method: string; readonly params?: readonly unknown[] },
): string {
  if (config.source === "legacy" || !config.historyUrl) {
    throw new Error("Isolated historical transport is not configured");
  }
  if (historyMethods.has(request.method)) return config.historyUrl;
  const blockIndex = Object.hasOwn(stateBlockParameter, request.method)
    ? stateBlockParameter[request.method] : undefined;
  if (blockIndex === undefined) throw new Error("Unsupported historical RPC method");
  if (!config.archiveUrl) throw new Error("Historical state unavailable: RH_ARCHIVE_RPC_URL is required");
  const block = request.params?.[blockIndex];
  if (typeof block !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(block)) {
    throw new Error("Historical contract state requires an explicit block number");
  }
  return config.archiveUrl;
}

const providerQueues = new Map<string, Promise<void>>();
export async function pace(url: string, intervalMs: number, signal?: AbortSignal | null): Promise<void> {
  const preceding = providerQueues.get(url) ?? Promise.resolve();
  const turn = preceding.catch(() => {}).then(() => { signal?.throwIfAborted(); });
  const cooldown = turn.catch(() => {}).then(async () => {
    if (intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  });
  providerQueues.set(url, cooldown);
  void cooldown.then(() => { if (providerQueues.get(url) === cooldown) providerQueues.delete(url); });
  await turn;
}

/** The public transport URL and all errors omit provider credentials. No fallback. */
export function createHistoryFetch(config: HistoryConfig, fetcher: typeof fetch = fetch): typeof fetch {
  const verified = new Map<string, Promise<void>>();
  async function send(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      let attempts = 0;
      while (true) {
        await pace(url, config.requestIntervalMs ?? 0, init.signal);
        response = await fetcher(url, { ...init, redirect: "error" });
        if (response.status !== 429 || attempts >= 2) break;
        attempts += 1;
        const retryAfter = Number(response.headers.get("retry-after") ?? "5");
        const delay = Number.isFinite(retryAfter) ? Math.max(1000, Math.min(5000, retryAfter * 1000)) : 5000;
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, delay));
        init.signal?.throwIfAborted();
      }
    } catch {
      throw new Error("Historical provider transport failed");
    }
    if (!response.ok) throw new Error(`Historical provider HTTP ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch {
      throw new Error("Historical provider returned invalid JSON");
    }
    const responses = Array.isArray(body) ? body : [body];
    for (const entry of responses) {
      if (!entry || typeof entry !== "object") throw new Error("Malformed historical RPC response");
      if ("error" in entry) throw new Error("Historical provider returned a JSON-RPC error");
    }
    return body;
  }
  return async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("Historical RPC requires a JSON body");
    const body: unknown = JSON.parse(init.body);
    const requests = Array.isArray(body) ? body : [body];
    if (requests.length === 0) throw new Error("Empty historical RPC batch");
    const urls = requests.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("method" in entry) ||
          typeof entry.method !== "string") throw new Error("Malformed historical RPC request");
      return historyRequestTarget(config, entry as { method: string; params?: unknown[] });
    });
    const url = urls[0]!;
    if (urls.some((other) => other !== url)) throw new Error("Mixed historical and archive RPC batch");
    if (!verified.has(url)) {
      const check = (async () => {
        const result = await send(url, {
          ...init,
          body: JSON.stringify({ jsonrpc: "2.0", id: "history-chain", method: "eth_chainId", params: [] }),
        }) as { result?: unknown };
        if (result.result !== "0x1237") throw new Error("Historical provider chain ID mismatch");
      })();
      verified.set(url, check);
      check.catch(() => { verified.delete(url); });
    }
    await verified.get(url);
    const result = await send(url, init);
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  };
}

export function createHistoricalClient(
  liveRpcUrl: string,
  timeoutMs: number,
  options: Parameters<typeof createRobinhoodClient>[2] = {},
) {
  const config = loadHistoryConfig(liveRpcUrl);
  if (config.source === "legacy") return createRobinhoodClient(liveRpcUrl, timeoutMs, options);
  return createRobinhoodClient(HISTORY_TRANSPORT_URL, config.timeoutMs!, {
    fetchFn: config.source === "hypersync" ? createHyperSyncFetch(config) : createHistoryFetch(config),
    retryCount: 0,
  });
}
