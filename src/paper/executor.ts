import assert from "node:assert/strict";
import pg from "pg";
import { parseAbi, type Address } from "viem";
import { createRobinhoodClient } from "../client.js";
import { USDG } from "../constants.js";
import { loadIndexerConfig } from "../indexer/config.js";
import { loadRiskConfig } from "../risk/config.js";
import { fetchFeedDirectory, selectOracleFeed } from "../risk/source.js";
import { evaluateOracleRisk } from "../risk/evaluate.js";
import { evaluatePaperUsdgOracle } from "./usdg-oracle.js";
import { ViemRiskChainReader } from "../risk/reader.js";
import { readRiskGate } from "../risk/gate.js";
import { PostgresRpcHealthGate } from "../rpc-health/store.js";
import { PostgresRiskStore } from "../risk/store.js";
import { refreshRiskEvidence } from "../risk/refresh.js";
import type { RpcHealthEvaluation } from "../rpc-health/domain.js";
import { evaluateCanaryEntryReadiness } from "../canary-plan/entry-readiness.js";
import { centeredRange, sizeLiquidityForQuoteBudget } from "../simulator/math.js";
import { PAPER_NVDA, PAPER_POOL, paperEntryRange, type PaperCheckpoint, type TransactionPaperPolicy } from "./engine.js";
import { boundaryInside, type BoundaryFeeProof } from "./boundary-fees.js";
import type { PaperEntryQuote, PaperGasValuation } from "./execution-domain.js";
import { simulatePaperRoundTrip } from "./execution.js";
import { simulatePaperExit, type PaperExitInventory } from "./execution-exit.js";
import { openPaperFork } from "./fork.js";
import { paperTradingWindow } from './trading-hours.js';
import { PAPER_QUOTER, paperQuoterAbi } from "./execution-abi.js";
import { readPaperReferenceGate, PaperReferenceGateError, type PaperReferenceEvidence } from "./reference.js";
import { quotePaperRecenter, simulatePaperRecenter, type PaperRecenterQuote } from './execution-recenter.js';
import { sqrtRatioAtTick } from '../backtest/principal.js';

export interface PaperExecutor {
  quoteRecenter?(cp:PaperCheckpoint,policy:TransactionPaperPolicy,inventory:PaperExitInventory):Promise<PaperRecenterQuote>;
  recenter?(cp:PaperCheckpoint,policy:TransactionPaperPolicy,inventory:PaperExitInventory,intent:PaperRecenterQuote):Promise<{
    result:Awaited<ReturnType<typeof simulatePaperRecenter>>;valuation:PaperGasValuation;boundaryFees:BoundaryFeeProof;
  }>;
  refreshRisk?(riskRunId: string | null, validationOnly: boolean): Promise<void>;
  boundaryFees?(cp: PaperCheckpoint, range: {tickLower:number;tickUpper:number}): Promise<BoundaryFeeProof>;
  quote(cp: PaperCheckpoint, policy: TransactionPaperPolicy): Promise<PaperEntryQuote>;
  enter(cp: PaperCheckpoint, policy: TransactionPaperPolicy, intent: PaperEntryQuote): Promise<{
    result: Awaited<ReturnType<typeof simulatePaperRoundTrip>>; valuation: PaperGasValuation;
  }>;
  exit(cp: PaperCheckpoint, policy: TransactionPaperPolicy, inventory: PaperExitInventory): Promise<{
    result: Awaited<ReturnType<typeof simulatePaperExit>>; valuation: PaperGasValuation;
  }>;
}

export class NitroPaperExecutor implements PaperExecutor {
  private readonly config = loadIndexerConfig();
  private readonly riskConfig = loadRiskConfig();
  private readonly gate: PostgresRpcHealthGate;
  private readonly database: pg.Pool;
  private readonly riskStore: PostgresRiskStore;
  private feedDirectory: Awaited<ReturnType<typeof fetchFeedDirectory>> | undefined;
  constructor(connectionString: string) {
    this.gate = new PostgresRpcHealthGate({ connectionString, enabled: true, cacheMs: 2000, maxSampleAgeSeconds: 30 });
    this.database = new pg.Pool({ connectionString, max: 1, statement_timeout: 10000 });
    this.riskStore = new PostgresRiskStore(connectionString);
  }
  async refreshRisk(riskRunId: string | null, validationOnly: boolean): Promise<void> {
    await refreshRiskEvidence({config:this.config,riskConfig:this.riskConfig,gate:this.gate,
      store:this.riskStore,riskRunId,validationOnly});
  }

  private client() {
    let requests = 0;
    return createRobinhoodClient(this.config.rpcUrl, this.config.rpcTimeoutMs, {
      beforeRequest: async () => {
        assert(++requests <= 32, "Paper preflight read cap exceeded");
        await this.gate.assertBulkAllowed();
      }, retryCount: 0,
    });
  }
  async boundaryFees(cp: PaperCheckpoint, range: {tickLower:number;tickUpper:number}): Promise<BoundaryFeeProof> {
    const client=this.client(),abi=parseAbi(['function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)']);
    const read=async(tick:number)=>{const t=await client.readContract({address:PAPER_POOL as Address,abi,functionName:'ticks',args:[tick],blockNumber:BigInt(cp.block)});
      assert(t[7]&&t[0]>0n,'Paper fee boundary is not initialized');return {gross:String(t[0]),outside0:String(t[2]),outside1:String(t[3])};};
    const lower=await read(range.tickLower),upper=await read(range.tickUpper);
    assert.equal((await client.getBlock({blockNumber:BigInt(cp.block)})).hash.toLowerCase(),cp.hash.toLowerCase());
    const proof={block:cp.block,hash:cp.hash,tickLower:range.tickLower,tickUpper:range.tickUpper,lower,upper};boundaryInside(cp,proof);return proof;
  }
  private async check(cp: PaperCheckpoint, policy: TransactionPaperPolicy, entering: boolean) {
    let referenceEvidence: PaperReferenceEvidence | null = null;
    const now = new Date().toISOString();
    if(entering&&policy.tradingHours)assert(paperTradingWindow(now,policy.tradingHours).entryAllowed&&
      paperTradingWindow(cp.blockTimestamp,policy.tradingHours).entryAllowed,'Paper off-hours entry window is closed');
    const age = (Date.parse(now) - Date.parse(cp.blockTimestamp)) / 1000;
    assert(Number.isFinite(age) && age >= 0 && age <= policy.maxSourceAgeSeconds, "Paper execution source is stale");
    const client = await this.database.connect();
    try {
      const samples = await client.query<{ id: string; snapshot: RpcHealthEvaluation }>(
        "SELECT id::text,snapshot FROM rpc_health_samples WHERE observed_at >= NOW()-INTERVAL '6 minutes' ORDER BY observed_at DESC,id DESC LIMIT 128");
      const readiness = evaluateCanaryEntryReadiness({ now, sourceBlock: BigInt(cp.block), samples: samples.rows });
      assert(readiness.chainEligible, "Paper chain recovery is not continuously healthy");
      if (entering && policy.mode === "guarded") {
        if (policy.referencePolicy) {
          const reference = await readPaperReferenceGate(client, cp, policy.referencePolicy, now);
          if (!reference.eligible) throw new PaperReferenceGateError(reference);
          referenceEvidence = reference.evidence;
        } else {
        assert(readiness.session === "regular_session", readiness.reasons.join(", "));
        const risk = await readRiskGate(client, this.config.streamKey, 180, 30, "NVDA");
        const reasons = risk.reasons.filter(reason => reason !== "sequencer_feed_unavailable");
        assert(reasons.length === 0, `Paper current risk gate: ${reasons.join(", ")}`);
        }
      }
    } finally { client.release(); }
    await this.gate.assertBulkAllowed();
    assert((Date.now()-Date.parse(cp.blockTimestamp))/1000 <= policy.maxSourceAgeSeconds, "Paper source aged out during preflight");
    return referenceEvidence;
  }
  private async valuation(cp: PaperCheckpoint, policy: TransactionPaperPolicy): Promise<PaperGasValuation> {
    this.feedDirectory ??= await fetchFeedDirectory(this.riskConfig.feedDirectoryUrl, this.riskConfig.httpTimeoutMs);
    const ethFeed = selectOracleFeed(this.feedDirectory.payload, "ETH");
    const quoteFeed = selectOracleFeed(this.feedDirectory.payload, "USDG");
    assert(ethFeed && quoteFeed, "Paper gas valuation feeds are unavailable");
    const reader = new ViemRiskChainReader(this.client());
    const blockTimestamp = BigInt(Math.floor(Date.parse(cp.blockTimestamp) / 1000));
    const maxPriceAgeSeconds = policy.referencePolicy?.maxGasPriceAgeSeconds ?? this.riskConfig.maxPriceAgeSeconds;
    const eth = evaluateOracleRisk({ feed: ethFeed, blockTimestamp, maxPriceAgeSeconds,
      state: await reader.readOracle(ethFeed.address, BigInt(cp.block)) });
    const quote = evaluatePaperUsdgOracle({ feed: quoteFeed, blockTimestamp, maxPriceAgeSeconds,
      state: await reader.readOracle(quoteFeed.address, BigInt(cp.block)) }, policy.referencePolicy?.usdgHeartbeatGraceSeconds);
    assert(eth.executionEligible && eth.state, `Paper ETH gas valuation unavailable: ${eth.reasons.join(", ")}`);
    assert(quote.executionEligible && quote.state, `Paper USDG gas valuation unavailable: ${quote.reasons.join(", ")}`);
    return { sourceBlock: cp.block, sourceHash: cp.hash, computedAt: new Date().toISOString(),
      ethUsdAnswer: eth.state.answer, ethUsdDecimals: eth.state.decimals, quoteUsdAnswer: quote.state.answer, quoteUsdDecimals: quote.state.decimals,
      oracleEvidence: { eth, quote, directory: this.feedDirectory.evidence } };
  }
  async quote(cp: PaperCheckpoint, policy: TransactionPaperPolicy): Promise<PaperEntryQuote> {
    const before = await this.check(cp, policy, true);
    const range = paperEntryRange(cp,policy);
    if(policy.feeAccounting)await this.boundaryFees(cp,range);
    const lpBudget=BigInt(policy.budgetQuote)*BigInt(policy.lpAllocationPpm??1000000)/1000000n;
    const sized = sizeLiquidityForQuoteBudget({ budgetQuote: lpBudget, quoteToken: USDG, token0: USDG, token1: PAPER_NVDA, sqrtPriceX96: BigInt(cp.sqrtPriceX96), ...range });
    const amountIn = lpBudget - sized.amount0 - sized.idleQuote;
    assert(amountIn > 0n && amountIn < BigInt(policy.budgetQuote));
    const client = this.client();
    assert.equal(await client.getChainId(), 4663);
    const quoted = await client.simulateContract({ address: PAPER_QUOTER, abi: paperQuoterAbi, blockNumber: BigInt(cp.block),
      functionName: "quoteExactInputSingle", args: [{ tokenIn: USDG, tokenOut: PAPER_NVDA as Address, amountIn, fee: 500, sqrtPriceLimitX96: 0n }] });
    const minimum = quoted.result[0] * (10000n - BigInt(policy.maxSlippageBps)) / 10000n;
    assert(minimum > 0n, "Paper minimum swap output is zero");
    assert.equal((await client.getBlock({ blockNumber: BigInt(cp.block) })).hash.toLowerCase(), cp.hash.toLowerCase());
    const after = await this.check(cp, policy, true);
    return { ...range, sourceBlock: cp.block, sourceHash: cp.hash, quotedAt: new Date().toISOString(), swapAmountQuote: String(amountIn), minRwaOut: String(minimum), referenceEvidence:{before,after} };
  }
  private async simulate<T>(cp: PaperCheckpoint, policy: TransactionPaperPolicy, entering: boolean,
    operation: (fork: Awaited<ReturnType<typeof openPaperFork>>) => Promise<T>) {
    const before = await this.check(cp, policy, entering);
    const valuation = await this.valuation(cp, policy);
    const client = this.client();
    assert.equal(await client.getChainId(), 4663);
    const block = await client.getBlock({ blockNumber: BigInt(cp.block) });
    assert.equal(block.hash.toLowerCase(), cp.hash.toLowerCase());
    const fork = await openPaperFork({ source: { number: block.number, hash: block.hash, timestamp: block.timestamp },
      rpcUrl: this.config.rpcUrl, beforeRead: () => this.gate.assertBulkAllowed().then(() => {}) });
    try {
      const result = await operation(fork);
      const after = await this.check(cp, policy, entering);
      return { result, valuation, referenceEvidence:{before,after} };
    } finally { await fork.close(); }
  }
  enter(cp: PaperCheckpoint, policy: TransactionPaperPolicy, intent: PaperEntryQuote) {
    return this.simulate(cp, policy, true, fork => simulatePaperRoundTrip(fork, policy, undefined, intent));
  }
  exit(cp: PaperCheckpoint, policy: TransactionPaperPolicy, inventory: PaperExitInventory) {
    return this.simulate(cp, policy, false, fork => simulatePaperExit(fork, policy, inventory));
  }
  private async recenterRange(cp:PaperCheckpoint,policy:TransactionPaperPolicy,range:{tickLower:number;tickUpper:number}) {
    assert(policy.recenter&&policy.referencePolicy&&policy.tradingHours);
    assert.equal(range.tickUpper-range.tickLower,policy.halfWidthSpacings*20);
    const boundaryFees=await this.boundaryFees(cp,range);
    const client=await this.database.connect();
    try {
      const gate=await readPaperReferenceGate(client,cp,policy.referencePolicy,new Date().toISOString());
      assert(gate.eligible&&gate.reference?.referencePriceX18,'Recenter reference unavailable');
      const reference=BigInt(gate.reference.referencePriceX18),bound=BigInt(policy.referencePolicy.maxDeviationPpm);
      for(const tick of [range.tickLower,range.tickUpper]){
        const price=(1n<<192n)*10n**30n/sqrtRatioAtTick(tick)**2n;
        assert(price*1000000n>=reference*(1000000n-bound)&&price*1000000n<=reference*(1000000n+bound),'Recenter range exceeds true-price band');
      }
    } finally {client.release();}
    return boundaryFees;
  }
  async quoteRecenter(cp:PaperCheckpoint,policy:TransactionPaperPolicy,inventory:PaperExitInventory) {
    await this.recenterRange(cp,policy,paperEntryRange(cp,policy));
    return (await this.simulate(cp,policy,true,fork=>quotePaperRecenter(fork,policy,inventory))).result;
  }
  async recenter(cp:PaperCheckpoint,policy:TransactionPaperPolicy,inventory:PaperExitInventory,intent:PaperRecenterQuote) {
    assert(policy.recenter);
    assert(BigInt(cp.block)>BigInt(intent.sourceBlock)&&Date.parse(cp.blockTimestamp)>Date.parse(intent.quotedAt),'Recenter needs a later execution source');
    assert(Date.now()-Date.parse(intent.quotedAt)<=policy.recenter.maxQuoteAgeSeconds*1000,'Recenter quote expired');
    const boundaryFees=await this.recenterRange(cp,policy,intent);
    const result=await this.simulate(cp,policy,true,fork=>simulatePaperRecenter(fork,policy,inventory,intent));
    assert(Date.now()-Date.parse(intent.quotedAt)<=policy.recenter.maxQuoteAgeSeconds*1000,'Recenter quote expired during preflight');
    return {...result,boundaryFees};
  }
  async close() { await this.gate.close(); await this.database.end(); await this.riskStore.close(); }
}
