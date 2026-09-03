import { keccak256, type Address, type Hash, type Hex } from "viem";
import type { RobinhoodClient } from "../client.js";
import { aggregatorV3Abi, stockTokenRiskAbi } from "./abi.js";
import type { OracleRoundState, TokenRiskState } from "./domain.js";

export interface RiskBlock {
  readonly hash: Hash;
  readonly number: bigint;
  readonly timestamp: bigint;
}

export interface RiskChainReader {
  getBlock(blockNumber: bigint): Promise<RiskBlock>;
  getChainId(): Promise<number>;
  readOracle(address: Address, blockNumber: bigint): Promise<OracleRoundState>;
  readToken(address: Address, blockNumber: bigint): Promise<TokenRiskState>;
}

async function requireCode(
  client: RobinhoodClient,
  address: Address,
  blockNumber: bigint,
): Promise<Hex> {
  const code = await client.getBytecode({ address, blockNumber });
  if (code === undefined || code === "0x") {
    throw new Error(`Contract has no code at ${address}`);
  }
  return code;
}

export class ViemRiskChainReader implements RiskChainReader {
  public constructor(private readonly client: RobinhoodClient) {}

  public async getBlock(blockNumber: bigint): Promise<RiskBlock> {
    const block = await this.client.getBlock({ blockNumber });
    return {
      hash: block.hash,
      number: block.number,
      timestamp: block.timestamp,
    };
  }

  public async getChainId(): Promise<number> {
    return this.client.getChainId();
  }

  public async readOracle(
    address: Address,
    blockNumber: bigint,
  ): Promise<OracleRoundState> {
    const [code, decimals, description, round] = await Promise.all([
      requireCode(this.client, address, blockNumber),
      this.client.readContract({
        abi: aggregatorV3Abi,
        address,
        blockNumber,
        functionName: "decimals",
      }),
      this.client.readContract({
        abi: aggregatorV3Abi,
        address,
        blockNumber,
        functionName: "description",
      }),
      this.client.readContract({
        abi: aggregatorV3Abi,
        address,
        blockNumber,
        functionName: "latestRoundData",
      }),
    ]);
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = round;
    return {
      answer: answer.toString(),
      answeredInRound: answeredInRound.toString(),
      codeHash: keccak256(code),
      decimals,
      description,
      roundId: roundId.toString(),
      startedAt: startedAt.toString(),
      updatedAt: updatedAt.toString(),
    };
  }

  public async readToken(
    address: Address,
    blockNumber: bigint,
  ): Promise<TokenRiskState> {
    const [code, uiMultiplier, newUIMultiplier, effectiveAt, oraclePaused] =
      await Promise.all([
        requireCode(this.client, address, blockNumber),
        this.client.readContract({
          abi: stockTokenRiskAbi,
          address,
          blockNumber,
          functionName: "uiMultiplier",
        }),
        this.client.readContract({
          abi: stockTokenRiskAbi,
          address,
          blockNumber,
          functionName: "newUIMultiplier",
        }),
        this.client.readContract({
          abi: stockTokenRiskAbi,
          address,
          blockNumber,
          functionName: "effectiveAt",
        }),
        this.client.readContract({
          abi: stockTokenRiskAbi,
          address,
          blockNumber,
          functionName: "oraclePaused",
        }),
      ]);
    return {
      codeHash: keccak256(code),
      effectiveAt: effectiveAt.toString(),
      newUIMultiplier: newUIMultiplier.toString(),
      oraclePaused,
      uiMultiplier: uiMultiplier.toString(),
    };
  }
}
