import type { PaperRoundTrip } from "./execution.js";
import type { PaperExitSimulation, PaperExitInventory } from "./execution-exit.js";
import type { OracleRiskSnapshot, SourceEvidence } from "../risk/domain.js";
import type { PaperReferenceEvidence } from "./reference.js";
import type { PaperUsdgOracle } from "./usdg-oracle.js";
import type { PaperRecenterQuote, PaperRecenterSimulation } from './execution-recenter.js';
import type { BoundaryFeeProof } from './boundary-fees.js';
export interface PaperEntryQuote {
  sourceBlock: string; sourceHash: string; quotedAt: string;
  tickLower: number; tickUpper: number; swapAmountQuote: string; minRwaOut: string;
  referenceEvidence?: {before:PaperReferenceEvidence|null;after:PaperReferenceEvidence|null};
}
export interface PaperGasValuation {
  sourceBlock: string; sourceHash: string; computedAt: string;
  ethUsdAnswer: string; ethUsdDecimals: number; quoteUsdAnswer: string; quoteUsdDecimals: number;
  oracleEvidence?: { eth: OracleRiskSnapshot; quote: PaperUsdgOracle; directory: SourceEvidence };
}
export interface PaperExecutionInput {
  available: boolean;
  quote?: PaperEntryQuote;
  entry?: { runId: string; result: PaperRoundTrip; valuation: PaperGasValuation };
  exit?: { runId: string; result: PaperExitSimulation; valuation: PaperGasValuation };
  recenterQuote?: PaperRecenterQuote;
  recenter?: { runId: string; result: PaperRecenterSimulation; valuation: PaperGasValuation; boundaryFees: BoundaryFeeProof };
  error?: string;
}
export interface PaperExecutionLedger {
  intent: PaperEntryQuote | null;
  entryRunId: string | null; exitRunId: string | null;
  gasSpentWei: string; holdGasQuote: string; exitReserveWei: string;
  allowances: PaperExitInventory["allowances"];
  earnedFee0: string; earnedFee1: string;
  lastValuation: PaperGasValuation | null;
  recenterIntent?: PaperRecenterQuote | null;
  recenterRunIds?: string[];
}
