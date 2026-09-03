import { createPublicClient, http } from "viem";
import { robinhoodChain } from "./constants.js";

export function createRobinhoodClient(rpcUrl: string, timeoutMs: number) {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(rpcUrl, {
      retryCount: 2,
      retryDelay: 300,
      timeout: timeoutMs,
    }),
  });
}

export type RobinhoodClient = ReturnType<typeof createRobinhoodClient>;
