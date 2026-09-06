import { createPublicClient, http } from "viem";
import { robinhoodChain } from "./constants.js";

export function createRobinhoodClient(
  rpcUrl: string,
  timeoutMs: number,
  options: {
    readonly beforeRequest?: () => Promise<void>;
    readonly fetchFn?: typeof fetch;
    readonly retryCount?: number;
  } = {},
) {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(rpcUrl, {
      fetchFn: options.fetchFn,
      onFetchRequest: options.beforeRequest === undefined
        ? undefined
        : async () => options.beforeRequest!(),
      retryCount: options.retryCount ?? 2,
      retryDelay: 300,
      timeout: timeoutMs,
    }),
  });
}

export type RobinhoodClient = ReturnType<typeof createRobinhoodClient>;
