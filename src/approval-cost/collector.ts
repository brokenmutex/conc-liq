import type { RawActionTransaction } from "../action-cost/domain.js";
import { RpcHealthCircuitOpenError } from "../rpc-health/store.js";
import { sanitizeRiskError } from "../risk/evaluate.js";
import type {
  ApprovalAllowanceState,
  ApprovalCostObservation,
  ApprovalCostRun,
  ApprovalCostUniverse,
  ApprovalTransactionReader,
} from "./domain.js";
import { evaluateApprovalCost, summarizeApprovalCosts } from "./evaluate.js";
import {
  groupApprovalEvents,
  selectApprovalCandidates,
  ViemApprovalCostReader,
} from "./reader.js";

function findCircuitError(error: unknown): RpcHealthCircuitOpenError | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (current instanceof RpcHealthCircuitOpenError) return current;
    seen.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { readonly cause?: unknown }).cause
      : null;
  }
  return null;
}

async function safeAllowance(
  reader: ViemApprovalCostReader,
  input: Parameters<ViemApprovalCostReader["readAllowance"]>[0],
): Promise<{ readonly error: string | null; readonly value: bigint | null }> {
  try {
    return { error: null, value: await reader.readAllowance(input) };
  } catch (error) {
    const circuit = findCircuitError(error);
    if (circuit !== null) throw circuit;
    return { error: sanitizeRiskError(error), value: null };
  }
}

async function readAllowanceState(
  reader: ViemApprovalCostReader,
  candidate: ApprovalCostRun["source"]["candidates"][number],
): Promise<ApprovalAllowanceState> {
  const approval = candidate.approvals.length === 1 ? candidate.approvals[0]! : null;
  if (approval === null || candidate.blockNumber === 0n) {
    const error = approval === null
      ? "Allowance state requires one approval event"
      : "Allowance before genesis is unavailable";
    return {
      after: null,
      afterReadError: error,
      before: null,
      beforeReadError: error,
    };
  }
  const before = await safeAllowance(reader, {
    blockNumber: candidate.blockNumber - 1n,
    owner: approval.owner,
    spender: approval.spender,
    token: approval.tokenAddress,
  });
  const after = await safeAllowance(reader, {
    blockNumber: candidate.blockNumber,
    owner: approval.owner,
    spender: approval.spender,
    token: approval.tokenAddress,
  });
  return {
    after: after.value,
    afterReadError: after.error,
    before: before.value,
    beforeReadError: before.error,
  };
}

async function fetchAllEvents(input: {
  readonly initialChunkSize: number;
  readonly minChunkSize: number;
  readonly reader: ViemApprovalCostReader;
  readonly source: ApprovalCostUniverse;
}) {
  let chunkSize = input.initialChunkSize;
  let nextBlock = input.source.fromBlock;
  const events = [];
  while (nextBlock <= input.source.toBlock) {
    const toBlock = nextBlock + BigInt(chunkSize) - 1n < input.source.toBlock
      ? nextBlock + BigInt(chunkSize) - 1n
      : input.source.toBlock;
    try {
      events.push(...await input.reader.fetchEvents({
        fromBlock: nextBlock,
        positionManager: input.source.positionManager,
        toBlock,
        tokens: input.source.tokens,
      }));
      nextBlock = toBlock + 1n;
      chunkSize = Math.min(input.initialChunkSize, chunkSize * 2);
    } catch (error) {
      const circuit = findCircuitError(error);
      if (circuit !== null) throw circuit;
      if (chunkSize <= input.minChunkSize) throw error;
      chunkSize = Math.max(input.minChunkSize, Math.floor(chunkSize / 2));
    }
  }
  return events;
}

export async function collectApprovalCostRun(input: {
  readonly initialChunkSize: number;
  readonly interCandidateDelayMs: number;
  readonly maxPerToken: number;
  readonly minChunkSize: number;
  readonly receiptReader: ApprovalTransactionReader;
  readonly reader: ViemApprovalCostReader;
  readonly source: ApprovalCostUniverse;
}): Promise<ApprovalCostRun> {
  for (const [name, value] of [
    ["initial chunk size", input.initialChunkSize],
    ["minimum chunk size", input.minChunkSize],
    ["per-token limit", input.maxPerToken],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Approval ${name} must be a positive safe integer`);
    }
  }
  if (input.minChunkSize > input.initialChunkSize) {
    throw new Error("Approval minimum chunk size exceeds initial chunk size");
  }
  if (
    !Number.isSafeInteger(input.interCandidateDelayMs) ||
    input.interCandidateDelayMs < 0
  ) {
    throw new Error("Approval candidate delay must be a nonnegative safe integer");
  }
  const [chainId, sourceBlock] = await Promise.all([
    input.reader.getChainId(),
    input.reader.getBlock(input.source.toBlock),
  ]);
  if (chainId !== input.source.chainId) {
    throw new Error(`Approval source chain ${input.source.chainId} != RPC chain ${chainId}`);
  }
  if (
    sourceBlock.number !== input.source.toBlock ||
    sourceBlock.hash.toLowerCase() !== input.source.toBlockHash.toLowerCase()
  ) {
    throw new Error("Approval source terminal block is no longer canonical");
  }
  const events = await fetchAllEvents({
    initialChunkSize: input.initialChunkSize,
    minChunkSize: input.minChunkSize,
    reader: input.reader,
    source: input.source,
  });
  const eligible = groupApprovalEvents(events);
  const candidates = selectApprovalCandidates(eligible, input.maxPerToken);
  const capturedAt = new Date().toISOString();
  const observations: ApprovalCostObservation[] = [];
  for (const candidate of candidates) {
    const raw: RawActionTransaction = await input.receiptReader.read(
      candidate.transactionHash,
    );
    if (raw.chainId !== input.source.chainId) {
      throw new Error(`Approval transaction ${raw.transactionHash} has wrong chain ID`);
    }
    const allowance = await readAllowanceState(input.reader, candidate);
    observations.push(evaluateApprovalCost({
      allowance,
      candidate,
      observedAt: capturedAt,
      positionManager: input.source.positionManager,
      raw,
    }));
    if (input.interCandidateDelayMs > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, input.interCandidateDelayMs)
      );
    }
  }
  const symbolsByAddress = new Map(input.source.tokens.map((token) => [
    token.address.toLowerCase(),
    token.symbol,
  ]));
  return {
    capturedAt,
    executionEligible: false,
    maxPerToken: input.maxPerToken,
    methodology: "direct_position_manager_approval_cost_v1",
    observations,
    schemaVersion: 1,
    source: {
      ...input.source,
      candidates,
      eligibleCandidates: eligible.length,
    },
    summary: summarizeApprovalCosts(observations, symbolsByAddress),
  };
}
