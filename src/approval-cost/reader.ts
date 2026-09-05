import { getAddress, type Address, type Hash } from "viem";
import type { RobinhoodClient } from "../client.js";
import type {
  ApprovalCostCandidate,
  ApprovalTokenTarget,
  IndexedApprovalEvent,
} from "./domain.js";

export const approvalEventAbi = {
  anonymous: false,
  inputs: [
    { indexed: true, name: "owner", type: "address" },
    { indexed: true, name: "spender", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
  name: "Approval",
  type: "event",
} as const;

const allowanceAbi = [{
  inputs: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
  ],
  name: "allowance",
  outputs: [{ name: "", type: "uint256" }],
  stateMutability: "view",
  type: "function",
}] as const;

function requireField<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`Confirmed approval log is missing ${field}`);
  return value;
}

export class ViemApprovalCostReader {
  public constructor(private readonly client: RobinhoodClient) {}

  public async getBlock(blockNumber: bigint): Promise<{ readonly hash: Hash; readonly number: bigint }> {
    const block = await this.client.getBlock({ blockNumber });
    return { hash: block.hash, number: block.number };
  }

  public async getChainId(): Promise<number> {
    return this.client.getChainId();
  }

  public async fetchEvents(input: {
    readonly fromBlock: bigint;
    readonly positionManager: Address;
    readonly toBlock: bigint;
    readonly tokens: readonly ApprovalTokenTarget[];
  }): Promise<IndexedApprovalEvent[]> {
    const symbols = new Map(input.tokens.map((token) => [
      token.address.toLowerCase(),
      token.symbol,
    ]));
    const logs = await this.client.getLogs({
      address: input.tokens.map((token) => token.address),
      args: { spender: input.positionManager },
      event: approvalEventAbi,
      fromBlock: input.fromBlock,
      strict: true,
      toBlock: input.toBlock,
    });
    return logs.map((entry): IndexedApprovalEvent => {
      const tokenAddress = getAddress(entry.address);
      const tokenSymbol = symbols.get(tokenAddress.toLowerCase());
      if (tokenSymbol === undefined) throw new Error("Approval log token is outside source set");
      return {
        blockHash: requireField(entry.blockHash, "blockHash"),
        blockNumber: requireField(entry.blockNumber, "blockNumber"),
        logIndex: requireField(entry.logIndex, "logIndex"),
        owner: getAddress(entry.args.owner),
        spender: getAddress(entry.args.spender),
        tokenAddress,
        tokenSymbol,
        transactionHash: requireField(entry.transactionHash, "transactionHash"),
        transactionIndex: requireField(entry.transactionIndex, "transactionIndex"),
        value: entry.args.value,
      };
    });
  }

  public async readAllowance(input: {
    readonly blockNumber: bigint;
    readonly owner: Address;
    readonly spender: Address;
    readonly token: Address;
  }): Promise<bigint> {
    return this.client.readContract({
      abi: allowanceAbi,
      address: input.token,
      args: [input.owner, input.spender],
      blockNumber: input.blockNumber,
      functionName: "allowance",
    });
  }
}

export function groupApprovalEvents(
  events: readonly IndexedApprovalEvent[],
): ApprovalCostCandidate[] {
  const grouped = new Map<string, IndexedApprovalEvent[]>();
  for (const event of events) {
    const key = event.transactionHash.toLowerCase();
    const entries = grouped.get(key) ?? [];
    entries.push(event);
    grouped.set(key, entries);
  }
  const candidates = [...grouped.values()].map((approvals): ApprovalCostCandidate => {
    approvals.sort((left, right) => left.logIndex - right.logIndex);
    const first = approvals[0]!;
    if (approvals.some((entry) =>
      entry.blockNumber !== first.blockNumber ||
      entry.blockHash.toLowerCase() !== first.blockHash.toLowerCase() ||
      entry.transactionIndex !== first.transactionIndex
    )) {
      throw new Error(`Approval logs disagree on inclusion for ${first.transactionHash}`);
    }
    return {
      approvals,
      blockHash: first.blockHash,
      blockNumber: first.blockNumber,
      transactionHash: first.transactionHash,
      transactionIndex: first.transactionIndex,
    };
  });
  candidates.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber > right.blockNumber ? -1 : 1;
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return right.transactionIndex - left.transactionIndex;
    }
    return right.transactionHash.localeCompare(left.transactionHash);
  });
  return candidates;
}

export function selectApprovalCandidates(
  candidates: readonly ApprovalCostCandidate[],
  maxPerToken: number,
): ApprovalCostCandidate[] {
  if (!Number.isSafeInteger(maxPerToken) || maxPerToken <= 0) {
    throw new Error("Approval per-token limit must be a positive safe integer");
  }
  const counts = new Map<string, number>();
  return candidates.filter((candidate) => {
    const tokens = [...new Set(candidate.approvals.map((entry) =>
      entry.tokenAddress.toLowerCase()
    ))];
    if (!tokens.some((token) => (counts.get(token) ?? 0) < maxPerToken)) return false;
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return true;
  });
}
