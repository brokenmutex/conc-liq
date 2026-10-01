import assert from 'node:assert/strict';
import {decodeFunctionResult,encodeFunctionData,toHex,type Address,type Hash} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {createRobinhoodClient} from '../client.js';
import {poolAbi} from '../abi.js';
import {guardedCanaryPositionManagerAbi} from '../canary-plan/abi.js';
import {readCanaryPosition} from '../canary-plan/exit.js';
import {principalAmounts} from '../backtest/principal.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {encodeRangeKeeperTx,type RangeKeeperTxPlan} from '../strategy/rangekeeper/calldata.js';
import {nextRangeKeeperStage} from '../strategy/rangekeeper/live-stage.js';
import type {RangeKeeperCandidate,RangeKeeperLimits} from '../strategy/rangekeeper/domain.js';
import type {RangeKeeperConfig} from '../strategy/rangekeeper/config.js';
import type {RangeKeeperLiveState} from '../strategy/rangekeeper/live-domain.js';
import type {RangeKeeperPaperLoadedExitContext} from './rangekeeper-paper-context.js';
import {readRangeKeeperReferences} from '../strategy/rangekeeper/reference.js';
import type {RangeKeeperPaperGasProbeRequest,RangeKeeperPaperGasStageSample} from './rangekeeper-paper-gas-evidence.js';
import {openPaperFork,type ForkReadDiagnostics,type ForkReadHint,type PaperFork} from '../paper/fork.js';
import {localReceipt,prestateOverrides,simulatePaperTransaction,type PaperTransaction} from '../paper/execution-gas.js';
import {PAPER_ACCOUNT,paperRouterAbi,paperTokenAbi,PAPER_ROUTER,PAPER_QUOTER} from '../paper/execution-abi.js';
import {NONFUNGIBLE_POSITION_MANAGER,USDG} from '../constants.js';
import {restorePaperPosition,type PaperExitInventory} from '../paper/execution-exit.js';
import {replayPaperMint} from '../v3/position-math.js';
import {contentHash} from './contracts.js';
import {RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH} from './rangekeeper-paper-cost.js';
import {rangeKeeperPaperConvertQuoteContent,rangeKeeperPaperConvertQuoteHash,
 type RangeKeeperPaperConvertQuote} from './rangekeeper-paper-exit-model.js';
import {referenceProofHash,type MarketProfile} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';

const donor='0x00000000000000000000000000000000f17E0001' as Address;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const PPM=10_000n;

/** Replays the frozen swap against trusted draft allocation and proves the
 * candidate mint amounts fit the resulting inventory, including idle tokens. */
export function rangeKeeperPaperCandidateFunding(candidate:RangeKeeperCandidate,
 initial:readonly [bigint,bigint]){
 assert(initial[0]>=0n&&initial[1]>=0n&&(initial[0]>0n||initial[1]>0n),
  'Trusted RangeKeeper draft allocation is empty or invalid');
 const after=[initial[0],initial[1]] as [bigint,bigint];
 if(candidate.swap){
  const input=candidate.swap.token,acquired=(1-input) as 0|1;
  assert(after[input]>=candidate.swap.amountIn,'Trusted draft allocation cannot fund frozen swap input');
  after[input]-=candidate.swap.amountIn;after[acquired]+=candidate.swap.quotedOut;
 }
 assert(candidate.amount0Desired<=after[0]&&candidate.amount1Desired<=after[1],
  'Trusted draft allocation cannot fund frozen mint candidate');
 return [after[0],after[1]] as const;
}

function serializeCandidate(c:RangeKeeperCandidate){return {kind:c.kind,range:c.range,
 swap:c.swap?{token:c.swap.token,amountIn:String(c.swap.amountIn),quotedOut:String(c.swap.quotedOut),
  minOut:String(c.swap.minOut),priceAfter:String(c.swap.priceAfter),feeValue:String(c.swap.feeValue),
  shortfallValue:String(c.swap.shortfallValue)}:null,amount0Desired:String(c.amount0Desired),
 amount1Desired:String(c.amount1Desired),amount0Min:String(c.amount0Min),amount1Min:String(c.amount1Min),
 liquidity:String(c.liquidity),deployedValue:String(c.deployedValue),sourceBlock:String(c.sourceBlock),
 sourceHash:c.sourceHash,expiresAt:c.expiresAt};}
const rawValue=(amount:bigint,price:bigint,decimals:number)=>amount*price/10n**BigInt(decimals);

export function rangeKeeperPaperWithdrawalMinimum(amount:bigint,maxSlippageBps:number){
 assert(amount>=0n&&Number.isSafeInteger(maxSlippageBps)&&maxSlippageBps>=0&&maxSlippageBps<=10_000,
  'RangeKeeper withdrawal slippage input is invalid');
 return amount*(10_000n-BigInt(maxSlippageBps))/10_000n;
}

/** V3 decrease+collect leaves the ERC-721 owned with zero liquidity; this
 * is the retired-position state RangeKeeper records until explicit burn. */
export function assertRangeKeeperPaperRetiredPosition(input:{nftCount:bigint;owner:string;
 liquidity:bigint;tokensOwed0:bigint;tokensOwed1:bigint},expectedOwner:string=PAPER_ACCOUNT){
 assert.equal(input.nftCount,1n,'Owned-fork withdrawal must retain its one zero-liquidity NFT');
 assert(same(input.owner,expectedOwner),'Owned-fork withdrawal changed NFT owner');
 assert.equal(input.liquidity,0n);assert.equal(input.tokensOwed0,0n);assert.equal(input.tokensOwed1,0n);
}

/** Require exact current reference values while allowing only the explicitly
 * volatile external-source fetch timestamps to change across a fork reread. */
export function assertRangeKeeperTerminalReferenceMatch(frame:PaperOpenFrame,reference:{eligible:boolean;
 price0:bigint|null;price1:bigint|null;nativePrice:bigint|null;proof:unknown}){
 assert(reference.eligible&&reference.price0!==null&&reference.price0>0n&&
  reference.price1!==null&&reference.price1>0n&&reference.nativePrice!==null&&reference.nativePrice>0n&&
  String(reference.price0)===String(frame.price0)&&
  String(reference.price1)===String(frame.price1)&&String(reference.nativePrice)===String(frame.nativePrice),
  'Terminal fork reference values mismatch');
 assert(frame.referenceProof, 'Terminal source reference proof unavailable');
 assertSameRangeKeeperPinnedReferenceProof(frame.referenceProof,reference.proof);
}

/** HTTP source acquisition time changes on each pinned-frame reread. Treat
 * that transport timestamp as audit metadata, while requiring identical URL,
 * exact response bytes, and every on-chain/reference fact in the proof. */
export function assertSameRangeKeeperPinnedReferenceProof(expected:unknown,actual:unknown){
 assert(expected&&typeof expected==='object'&&!Array.isArray(expected));
 assert(actual&&typeof actual==='object'&&!Array.isArray(actual));
 const expectedProof={...(expected as Record<string,unknown>)},actualProof={...(actual as Record<string,unknown>)};
 const source=(value:unknown)=>{
  assert(value&&typeof value==='object'&&!Array.isArray(value),'Pinned source evidence malformed');
  const row=value as Record<string,unknown>;
  assert.deepEqual(Object.keys(row).sort(),['fetchedAt','sha256','url']);
  assert(typeof row.fetchedAt==='string'&&Number.isFinite(Date.parse(row.fetchedAt)));
  assert(typeof row.sha256==='string'&&/^sha256:[0-9a-f]{64}$/.test(row.sha256));
  assert(typeof row.url==='string'&&URL.canParse(row.url));
  return {sha256:row.sha256,url:row.url};
 };
 for(const key of ['registry','feedDirectory'] as const){
  const left=source(expectedProof[key]),right=source(actualProof[key]);
  assert.deepEqual(right,left,`Pinned ${key} source bytes or URL changed`);
  delete expectedProof[key];delete actualProof[key];
 }
 assert.equal(contentHash(actualProof),contentHash(expectedProof),
  'Pinned oracle, selected feed, round, or chain reference proof changed');
}

/** Reconstructs the exact post-mint idle balances and retained approvals from
 * the trusted draft allocation and saved open model. */
export function rangeKeeperPaperTerminalAllowances(input:{candidate:RangeKeeperCandidate;
 allocation:{token0Raw:string;token1Raw:string};openSqrtPriceX96:bigint;openPrice0:bigint;openPrice1:bigint;
 decimals0:number;decimals1:number;maxDeploymentValue:bigint}){
 const allocated=[BigInt(input.allocation.token0Raw),BigInt(input.allocation.token1Raw)] as const,
  available=[allocated[0],allocated[1]] as [bigint,bigint],manager=[allocated[0],allocated[1]] as [bigint,bigint],
  router=[0n,0n] as [bigint,bigint],c=input.candidate;
 if(c.swap){
  const token=c.swap.token,acquired=(1-token) as 0|1;
  assert(available[token]>=c.swap.amountIn,'Persisted draft cannot fund saved entry swap');
  const acquiredPrice=acquired===0?input.openPrice0:input.openPrice1,
   acquiredDecimals=acquired===0?input.decimals0:input.decimals1;
  assert(acquiredPrice>0n);
  const acquiredCap=input.maxDeploymentValue*10n**BigInt(acquiredDecimals)/acquiredPrice;
  manager[acquired]=allocated[acquired]>acquiredCap?allocated[acquired]:acquiredCap;
  router[token]=allocated[token];available[token]-=c.swap.amountIn;available[acquired]+=c.swap.quotedOut;
 }
 const mint=replayPaperMint(input.openSqrtPriceX96,c.range,c.amount0Desired,c.amount1Desired,0n);
 assert(mint.liquidity===c.liquidity,'Saved open candidate no longer replays to its recorded liquidity');
 assert(available[0]>=mint.amount0&&available[1]>=mint.amount1,
  'Persisted draft cannot fund the saved open mint');
 const idle0=available[0]-mint.amount0,idle1=available[1]-mint.amount1;
 assert(manager[0]>=mint.amount0&&manager[1]>=mint.amount1,'Saved entry approvals cannot cover the mint');
 if(c.swap)router[c.swap.token]-=c.swap.amountIn;
 return {idle0,idle1,manager0:manager[0]-mint.amount0,manager1:manager[1]-mint.amount1,
  router0:router[0],router1:router[1],minted0:mint.amount0,minted1:mint.amount1};
}

export function assertRangeKeeperPaperTerminalInventory(context:RangeKeeperPaperLoadedExitContext,
 candidate:RangeKeeperCandidate,frame:PaperOpenFrame,idle:{idle0:bigint;idle1:bigint}){
 const principal=principalAmounts({liquidity:candidate.liquidity,tickLower:candidate.range.tickLower,
  tickUpper:candidate.range.tickUpper,sqrtPriceX96:frame.sqrtPriceX96});
 assert.equal(idle.idle0,BigInt(context.previous.idle.token0),'Replayed terminal idle token0 differs from saved mark');
 assert.equal(idle.idle1,BigInt(context.previous.idle.token1),'Replayed terminal idle token1 differs from saved mark');
 assert.equal(context.kernel.wallet0,idle.idle0,'Kernel wallet token0 differs from saved mark');
 assert.equal(context.kernel.wallet1,idle.idle1,'Kernel wallet token1 differs from saved mark');
 assert.equal(context.kernel.released0,principal.amount0,'Kernel release token0 differs from current principal');
 assert.equal(context.kernel.released1,principal.amount1,'Kernel release token1 differs from current principal');
}

export function terminalInventoryHash(context:RangeKeeperPaperLoadedExitContext,
 candidate:RangeKeeperCandidate,frame:PaperOpenFrame){
 const k=context.kernel;
 const principal=principalAmounts({liquidity:candidate.liquidity,tickLower:candidate.range.tickLower,
  tickUpper:candidate.range.tickUpper,sqrtPriceX96:frame.sqrtPriceX96});
 return contentHash({kind:'range_keeper_paper_terminal_inventory_v1',candidateHash:context.openModel.candidateHash,
  source:frame.source,inventoryProofHash:k.inventoryProofHash,wallet0:String(k.wallet0),wallet1:String(k.wallet1),
  released0:String(k.released0),released1:String(k.released1),nativeWei:String(k.nativeWei),
  position:{tickLower:candidate.range.tickLower,tickUpper:candidate.range.tickUpper,
   liquidity:String(candidate.liquidity)},principal0:String(principal.amount0),principal1:String(principal.amount1),
  idle0:context.previous.idle.token0,idle1:context.previous.idle.token1,
  terminal0:String(k.wallet0+k.released0),terminal1:String(k.wallet1+k.released1)});
}

/** Shared source/candidate/inventory identity checks for any terminal
 * (post-open) RangeKeeper paper probe, regardless of exit kind. */
function validateExitProbeIdentity(request:RangeKeeperPaperGasProbeRequest,
 context:RangeKeeperPaperLoadedExitContext,limits:RangeKeeperLimits){
 const p=context.draft.profile.pool,k=context.kernel,c=request.candidate,open=context.openModel;
 assert.equal(request.openMarkId,context.openMarkId);assert.equal(request.openModelHash,contentHash(open));
 assert.equal(request.candidateHash,open.candidateHash);assert.equal(contentHash(serializeCandidate(c)),contentHash(open.candidate));
 assert.equal(contentHash(request.profile),contentHash(context.draft.profile));
 assert.equal(contentHash(request.candidateSource),contentHash(open.source));
 assert.equal(request.candidateReferenceProofHash,open.reference.proofHash);
 assert.equal(k.source.block,request.frame.source.block);assert(same(k.source.hash,request.frame.source.hash));
 assert.equal(request.scope.inventoryHash,terminalInventoryHash(context,c,request.frame));
 const principal=principalAmounts({liquidity:c.liquidity,tickLower:c.range.tickLower,
  tickUpper:c.range.tickUpper,sqrtPriceX96:request.frame.sqrtPriceX96});
 assertRangeKeeperPaperTerminalInventory(context,c,request.frame,
  {idle0:BigInt(context.previous.idle.token0),idle1:BigInt(context.previous.idle.token1)});
 assert.equal(request.scope.deployedValue,rawValue(principal.amount0,request.frame.price0!,p.decimals0)+
  rawValue(principal.amount1,request.frame.price1!,p.decimals1));
 assert.equal(request.scope.sharePpm,c.liquidity*1_000_000n/(request.frame.poolLiquidity+c.liquidity));
 assert.equal(request.scope.range.tickLower,c.range.tickLower);assert.equal(request.scope.range.tickUpper,c.range.tickUpper);
 assert.equal(request.scope.swapKind,c.swap?'direct_pool_exact_input':'none');
 assert.equal(request.scope.profileHash,context.draft.profileHash);assert.equal(request.scope.candidateHash,open.candidateHash);
 assert.equal(request.scope.poolAddress,p.pool);assert(Number.isInteger(limits.maxSlippageBps)&&
  limits.maxSlippageBps>0&&limits.maxSlippageBps<=50);
}

function validateTerminalProbe(request:RangeKeeperPaperGasProbeRequest,
 context:RangeKeeperPaperLoadedExitContext,limits:RangeKeeperLimits){
 assert(request.kind==='retain_exit','Convert-exit probes must use validateConvertTerminalProbe');
 validateExitProbeIdentity(request,context,limits);
}

/** Checks that a persisted conversion quote is bound to this exact
 * candidate, source, pool and trusted terminal input amount, and that its
 * minimum/shortfall match policy. Deliberately decoupled from the full
 * probe-identity checks (it only needs the context's pool/kernel/candidate
 * hash and the probe's source) so it can be unit-tested with a minimal
 * fixture. It does not prove `expectedOutput` is still the live market
 * price — the sampler reproves that separately, by calling the real quoter
 * on its own pinned fork and requiring an exact match before it replays
 * the swap. */
export function validateRangeKeeperPaperConvertQuoteBinding(input:{
 context:RangeKeeperPaperLoadedExitContext;source:PaperOpenFrame['source'];
 quote:RangeKeeperPaperConvertQuote;limits:RangeKeeperLimits}){
 const {context,source,quote,limits}=input,p=context.draft.profile.pool,k=context.kernel,open=context.openModel;
 const inputToken:0|1=p.quoteToken===0?1:0,outputToken:0|1=p.quoteToken;
 const inputAmount=inputToken===0?k.wallet0+k.released0:k.wallet1+k.released1;
 assert.equal(quote.pathVersion,RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH);
 assert.equal(quote.inputToken,inputToken);assert.equal(quote.outputToken,outputToken);
 assert.equal(BigInt(quote.inputAmount),inputAmount,
  'Persisted conversion quote input differs from trusted terminal inventory');
 assert(BigInt(quote.expectedOutput)>0n&&BigInt(quote.minimumOutput)>0n,
  'Persisted conversion quote output is empty');
 assert.equal(BigInt(quote.minimumOutput),BigInt(quote.expectedOutput)*(10_000n-BigInt(limits.maxSlippageBps))/10_000n,
  'Persisted conversion minimum output differs from the policy slippage floor');
 assert(BigInt(quote.shortfallValue)<=limits.maxSwapShortfallValue,
  'Persisted conversion shortfall exceeds the policy limit');
 const content=rangeKeeperPaperConvertQuoteContent({candidateHash:open.candidateHash!,source,
  pool:{pool:p.pool,router:p.router,quoter:p.quoter,fee:p.fee},inputToken,outputToken,
  inputAmount:BigInt(quote.inputAmount),expectedOutput:BigInt(quote.expectedOutput),
  minimumOutput:BigInt(quote.minimumOutput),feeValue:BigInt(quote.feeValue),
  shortfallValue:BigInt(quote.shortfallValue),maxSlippageBps:limits.maxSlippageBps});
 assert.equal(quote.quoteHash,rangeKeeperPaperConvertQuoteHash(content),
  'Persisted conversion quote hash does not match this exact candidate, source, pool and terminal input amount');
}

/** Validates a convert-exit probe's identity plus its persisted conversion
 * quote's binding (see validateRangeKeeperPaperConvertQuoteBinding). The
 * quote is supplied by the caller, never by request JSON. */
function validateConvertTerminalProbe(request:RangeKeeperPaperGasProbeRequest,
 context:RangeKeeperPaperLoadedExitContext,quote:RangeKeeperPaperConvertQuote,limits:RangeKeeperLimits){
 assert(request.kind==='convert_exit','Retain-exit probes must use validateTerminalProbe');
 validateExitProbeIdentity(request,context,limits);
 validateRangeKeeperPaperConvertQuoteBinding({context,source:request.frame.source,quote,limits});
}

async function fundFixture(fork:Awaited<ReturnType<typeof openPaperFork>>,client:RobinhoodClient,
 token:Address,pool:Address,amount:bigint){
 const balance=(owner:Address)=>client.readContract({address:token,abi:paperTokenAbi,functionName:'balanceOf',args:[owner]});
 assert.equal(await balance(PAPER_ACCOUNT),0n,'Paper fixture account is not empty');
 if(amount===0n)return;
 const trace=async(owner:Address)=>{
  const data=encodeFunctionData({abi:paperTokenAbi,functionName:'balanceOf',args:[owner]});
  const overrides=prestateOverrides(await fork.rpc('debug_traceCall',[
   {to:token,data},'latest',{tracer:'prestateTracer'}]));
  const storage=Object.entries(overrides).find(([address])=>same(address,token))?.[1].stateDiff;
  assert(storage,'Token balance getter storage unavailable');return storage;
 };
 const donorStorage=await trace(donor),poolStorage=await trace(pool);
 const slots=Object.keys(donorStorage).filter(slot=>!(slot in poolStorage));
 assert.equal(slots.length,1,'Token balance slot is ambiguous');
 await fork.rpc('anvil_setStorageAt',[token,slots[0]!,toHex(amount,{size:32})]);
 assert.equal(await balance(donor),amount,'Token fixture getter mismatch');
 await fork.rpc('anvil_impersonateAccount',[donor]);
 await fork.rpc('anvil_setBalance',[donor,toHex(10n**18n)]);
 const data=encodeFunctionData({abi:paperTokenAbi,functionName:'transfer',args:[PAPER_ACCOUNT,amount]});
 const hash=await fork.rpc<Hash>('eth_sendTransaction',[{from:donor,to:token,data,gas:'0x7a1200'}]);
 assert.equal((await localReceipt(fork,hash)).status,'0x1','Fixture transfer reverted');
 assert.equal(await balance(PAPER_ACCOUNT),amount,'Paper fixture funding mismatch');
}

/** Executes the full frozen candidate entry and retain-exit path on a fresh,
 * pinned Anvil fork. It is a probe only: the only send-capable RPC is the
 * owned local Anvil endpoint created by openPaperFork. */
export async function sampleRangeKeeperPaperGasStages(request:RangeKeeperPaperGasProbeRequest,input:{
 rpcUrl:string;beforeRead:()=>Promise<void>;maxRequests?:number;timeoutMs?:number;
 onReadDiagnostics?:(diagnostics:ForkReadDiagnostics)=>void;
 prefetchHints?:readonly ForkReadHint[];onReadHints?:(hints:readonly ForkReadHint[])=>void;
 /** Internal-only already-open fork capability consumed by the confirmation runner. */
 preparedFork?:PaperFork;
 limits:RangeKeeperLimits;initialBalances?:readonly [bigint,bigint];
 terminalContext?:RangeKeeperPaperLoadedExitContext;
 /** Trusted, hash-bound conversion quote for a convert-exit probe. It is a
  * caller-supplied attestation produced earlier (e.g. by the exit model's
  * terminalQuote), never request JSON; see validateConvertTerminalProbe. */
 conversionQuote?:RangeKeeperPaperConvertQuote;
}):Promise<readonly RangeKeeperPaperGasStageSample[]>{
 if(input.preparedFork){
  try{
   assert(request.kind==='open'&&input.initialBalances,
    'Prepared fork can only be consumed by a complete RangeKeeper open simulation');
   assert(input.rpcUrl.length>0&&Number.isSafeInteger(input.maxRequests??1600)&&
    (input.maxRequests??1600)>0&&(input.maxRequests??1600)<=2000&&
    Number.isSafeInteger(input.timeoutMs??300_000)&&(input.timeoutMs??300_000)>0&&
    (input.timeoutMs??300_000)<=300_000&&input.limits.maxSlippageBps>=1&&
    input.limits.maxSlippageBps<=50,'RangeKeeper owned-fork probe budget or policy invalid');
   assert.equal(request.profile.pool.chainId,4663);
   assert(request.frame.referenceEligible&&request.frame.referenceProof&&
    referenceProofHash(request.frame.referenceProof)===request.frame.referenceProofHash);
   assert.equal(request.candidateSource.block,request.frame.source.block);
   assert(same(request.candidateSource.hash,request.frame.source.hash));
   assert.equal(input.preparedFork.source.number,BigInt(request.frame.source.block));
   assert.equal(input.preparedFork.source.hash.toLowerCase(),request.frame.source.hash.toLowerCase());
   assert.equal(input.preparedFork.source.timestamp,BigInt(request.frame.source.timestamp));
  }catch(error){
   try{await input.preparedFork.close();}catch{/* Preserve the rejected context. */}
   throw error;
  }
 }
 if(request.kind==='convert_exit'){
  assert(input.terminalContext,'Convert-exit sampling requires trusted persisted mark and kernel context');
  assert(input.conversionQuote,'Convert-exit sampling requires a persisted conversion quote contract');
  validateConvertTerminalProbe(request,input.terminalContext,input.conversionQuote,input.limits);
  return sampleRangeKeeperPaperConvertExit(request,input.terminalContext,input.conversionQuote,input);
 }
 if(request.kind==='retain_exit'){
  assert(input.terminalContext,'Retain-exit sampling requires trusted persisted mark and kernel context');
  validateTerminalProbe(request,input.terminalContext,input.limits);
  return sampleRangeKeeperPaperRetainExit(request,input.terminalContext,input);
 }
 assert(request.kind==='open');
 assert(input.initialBalances,'Open sampling requires persisted draft allocation');
 assert(input.rpcUrl.length>0&&Number.isSafeInteger(input.maxRequests??1600)&&
  (input.maxRequests??1600)>0&&(input.maxRequests??1600)<=2000&&
  Number.isSafeInteger(input.timeoutMs??300_000)&&(input.timeoutMs??300_000)>0&&
  (input.timeoutMs??300_000)<=300_000&&input.limits.maxSlippageBps>=1&&
  input.limits.maxSlippageBps<=50,'RangeKeeper owned-fork probe budget or policy invalid');
 const {profile,frame,candidate}=request,p=profile.pool;
 assert.equal(p.chainId,4663,'RangeKeeper paper fork supports only the Robinhood chain');
 assert(frame.referenceEligible&&frame.referenceProof&&
  referenceProofHash(frame.referenceProof)===frame.referenceProofHash,'RangeKeeper probe reference proof invalid');
 assert.equal(request.candidateSource.block,frame.source.block);
 assert(same(request.candidateSource.hash,frame.source.hash));
 const source={number:BigInt(frame.source.block),hash:frame.source.hash as Hash,
  timestamp:BigInt(frame.source.timestamp)};
 const fork=input.preparedFork??await openPaperFork({source,rpcUrl:input.rpcUrl,beforeRead:input.beforeRead,
  maxRequests:input.maxRequests??1600,timeoutMs:input.timeoutMs??300_000,deterministicClock:true,
  prefetchHints:input.prefetchHints,onReadHints:input.onReadHints});
 try{
  assert.equal(fork.source.number,source.number,'Prepared owned fork block differs from candidate source');
  assert.equal(fork.source.hash.toLowerCase(),source.hash.toLowerCase(),
   'Prepared owned fork hash differs from candidate source');
  assert.equal(fork.source.timestamp,source.timestamp,'Prepared owned fork timestamp differs from candidate source');
  const local=createRobinhoodClient(fork.localUrl,30_000,{retryCount:0});
  const chain=new RangeKeeperChain(local,p);
  await chain.verify({block:source.number,hash:source.hash,timestamp:frame.source.timestamp});
  const reference=await readRangeKeeperReferences(local,{block:source.number,hash:source.hash,
   timestamp:frame.source.timestamp},profile);
  assert(reference.eligible&&reference.price0!==null&&reference.price1!==null&&reference.nativePrice!==null,
   'RangeKeeper owned-fork independent references unavailable');
  assert.equal(String(reference.price0),String(frame.price0));assert.equal(String(reference.price1),String(frame.price1));
  assert.equal(String(reference.nativePrice),String(frame.nativePrice));
  assertSameRangeKeeperPinnedReferenceProof(frame.referenceProof,reference.proof);
  const sourceSlot=await local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'slot0'});
  const sourceLiquidity=await local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'liquidity'});
  assert.equal(sourceSlot[1],frame.tick);assert.equal(String(sourceSlot[0]),String(frame.sqrtPriceX96));
  assert.equal(String(sourceLiquidity),String(frame.poolLiquidity),'RangeKeeper probe pool liquidity changed');
  const fixture=await chain.snapshot({block:source.number,hash:source.hash,timestamp:frame.source.timestamp},PAPER_ACCOUNT,null);
  assert.equal(fixture.wallet0,0n);assert.equal(fixture.wallet1,0n);assert.equal(fixture.nftCount,0n,
   'Paper fixture account contains a canonical NFT');
  assert(fixture.allowances.every(row=>row.amount===0n),'Paper fixture account contains a canonical core allowance');
  await fork.rpc('anvil_setBalance',[PAPER_ACCOUNT,toHex(10n**18n)]);
  await fork.rpc('anvil_impersonateAccount',[PAPER_ACCOUNT]);
  const initial=input.initialBalances,expectedAfterSwap=rangeKeeperPaperCandidateFunding(candidate,initial);
  await fundFixture(fork,local,p.token0 as Address,p.pool as Address,initial[0]);
  await fundFixture(fork,local,p.token1 as Address,p.pool as Address,initial[1]);
  const rows:PaperTransaction[]=[];
  const send=async(action:string,plan:RangeKeeperTxPlan)=>{
   const call=encodeRangeKeeperTx(p,PAPER_ACCOUNT,plan);
   const tx=await simulatePaperTransaction(fork,{action,to:call.to,calldata:call.data},PAPER_ACCOUNT);
   assert.equal(tx.sourceBlock,frame.source.block);assert(same(tx.sourceHash,frame.source.hash));
   assert(BigInt(tx.estimate.gas)>0n&&BigInt(tx.estimate.parentGas)<=BigInt(tx.estimate.gas));
   rows.push(tx);return tx;
  };
  const amounts=[candidate.amount0Desired,candidate.amount1Desired] as const;
  if(candidate.swap){
   const inputToken=candidate.swap.token,acquired=(1-inputToken) as 0|1;
   const acquiredPrice=acquired===0?frame.price0!:frame.price1!,acquiredDecimals=acquired===0?p.decimals0:p.decimals1;
   const acquiredCap=input.limits.maxDeploymentValue*10n**BigInt(acquiredDecimals)/acquiredPrice;
   const futureCap=initial[acquired]>acquiredCap?initial[acquired]:acquiredCap;
   await send('open_approve_manager_input',{kind:'approve',token:inputToken,spender:'positionManager',amount:initial[inputToken]});
   await send('open_approve_manager_acquired',{kind:'approve',token:acquired,spender:'positionManager',amount:futureCap});
   await send('open_approve_router_input',{kind:'approve',token:inputToken,spender:'router',amount:initial[inputToken]});
   const sourceQuote=await chain.quote({block:source.number,hash:source.hash,timestamp:frame.source.timestamp},
    inputToken,candidate.swap.amountIn,frame.price0!,frame.price1!);
   assert.equal(sourceQuote.amountOut,candidate.swap.quotedOut,'Frozen candidate swap quote differs at its source');
   assert.equal(candidate.swap.minOut,sourceQuote.amountOut*(10_000n-BigInt(input.limits.maxSlippageBps))/10_000n,
    'Frozen candidate swap minimum differs from policy');
   const swapBlock=await fork.rpc<{timestamp:`0x${string}`}>('eth_getBlockByNumber',['latest',false]);
   await send('open_swap',{kind:'swap',token:inputToken,amountIn:candidate.swap.amountIn,
    minOut:candidate.swap.minOut,deadline:BigInt(swapBlock.timestamp)+300n});
   const post0=await local.readContract({address:p.token0 as Address,abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_ACCOUNT]});
   const post1=await local.readContract({address:p.token1 as Address,abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_ACCOUNT]});
   assert.equal(post0,expectedAfterSwap[0]);assert.equal(post1,expectedAfterSwap[1],
    'Owned-fork swap inventory differs from trusted allocation replay');
  }else{
   await send('open_approve_manager_token0',{kind:'approve',token:0,spender:'positionManager',amount:initial[0]});
   await send('open_approve_manager_token1',{kind:'approve',token:1,spender:'positionManager',amount:initial[1]});
  }
  assert(amounts[0]<=expectedAfterSwap[0]&&amounts[1]<=expectedAfterSwap[1]);
  const latest=await fork.rpc<{number:`0x${string}`;hash:Hash;timestamp:`0x${string}`}>('eth_getBlockByNumber',['latest',false]);
  assert(latest.hash,'Owned-fork latest block hash unavailable');
  const snapshot=await chain.snapshot({block:BigInt(latest.number),hash:latest.hash,timestamp:Number(BigInt(latest.timestamp))},
   PAPER_ACCOUNT,null);
  const stageState={phase:'entry',candidate,swapDone:true,activeTokenId:null,reserve0:0n,
   reserve1:0n,reserveNativeWei:0n} as RangeKeeperLiveState;
  const stageConfig={pool:p,limits:input.limits,referencePolicy:profile.referencePolicy} as RangeKeeperConfig;
  const mintPlan=await nextRangeKeeperStage(stageState,snapshot,stageConfig,chain,
   {price0:frame.price0!,price1:frame.price1!});
  assert(mintPlan?.kind==='mint','Owned-fork candidate no longer has a mint stage');
  assert.deepEqual(mintPlan.candidate.range,candidate.range);
  for(const key of ['amount0Desired','amount1Desired','amount0Min','amount1Min','liquidity','deployedValue'] as const)
   assert.equal(mintPlan.candidate[key],candidate[key],`Owned-fork refreshed candidate changed ${key}`);
  const mint=await send('open_mint',mintPlan);
  const [tokenId,liquidity,minted0,minted1]=decodeFunctionResult({abi:guardedCanaryPositionManagerAbi,
   functionName:'mint',data:mint.returnData});
  assert(liquidity>=candidate.liquidity&&minted0<=candidate.amount0Desired&&minted1<=candidate.amount1Desired,
   'Owned-fork mint differs from frozen RangeKeeper candidate');
  let position=await readCanaryPosition(local,tokenId,await local.getBlockNumber({cacheTime:0}));
  assert(same(position.owner,PAPER_ACCOUNT)&&position.liquidity===liquidity&&
   position.tickLower===candidate.range.tickLower&&position.tickUpper===candidate.range.tickUpper);
  const slot=await local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'slot0'});
  const principal=principalAmounts({liquidity,tickLower:position.tickLower,tickUpper:position.tickUpper,sqrtPriceX96:slot[0]});
  const exitBlock=await fork.rpc<{timestamp:`0x${string}`}>('eth_getBlockByNumber',['latest',false]);
  await send('exit_withdraw_collect',{kind:'withdraw',tokenId,liquidity,
   min0:rangeKeeperPaperWithdrawalMinimum(principal.amount0,input.limits.maxSlippageBps),
   min1:rangeKeeperPaperWithdrawalMinimum(principal.amount1,input.limits.maxSlippageBps),
   deadline:BigInt(exitBlock.timestamp)+300n});
  for(const [stage,token] of [
   ['exit_cleanup_router_token0',0],['exit_cleanup_router_token1',1],
   ['exit_cleanup_manager_token0',0],['exit_cleanup_manager_token1',1],
  ] as const){
   await send(stage,{kind:'approve',token,spender:stage.includes('router')?'router':'positionManager',amount:0n});
  }
  for(const token of [p.token0,p.token1])for(const spender of [p.router,p.positionManager])
   assert.equal(await local.readContract({address:token as Address,abi:paperTokenAbi,
    functionName:'allowance',args:[PAPER_ACCOUNT,spender as Address]}),0n,
    'Owned-fork retain exit left a core allowance');
  position=await readCanaryPosition(local,tokenId,await local.getBlockNumber({cacheTime:0}));
  const terminalBlockNumber=await local.getBlockNumber({cacheTime:0}),terminalBlock=await local.getBlock({blockNumber:terminalBlockNumber});
  const terminalSnapshot=await chain.snapshot({block:terminalBlockNumber,hash:terminalBlock.hash!,
   timestamp:Number(terminalBlock.timestamp)},PAPER_ACCOUNT,null);
  assertRangeKeeperPaperRetiredPosition({nftCount:terminalSnapshot.nftCount,owner:position.owner,
   liquidity:position.liquidity,tokensOwed0:position.tokensOwed0,tokensOwed1:position.tokensOwed1});
  const pinned=await fork.read('eth_getBlockByNumber',[fork.blockTag,false]) as {hash:string};
  assert(same(pinned.hash,source.hash),'RangeKeeper owned-fork source block changed');
  const stageNames=rows.map(row=>row.action);
  assert.deepEqual(stageNames,request.stages);
  return rows.map(row=>({...row,stateOverrides:row.stateOverrides as Record<string,unknown>}));
 }finally{
  try{input.onReadDiagnostics?.({...fork.diagnostics,
   duplicateRequestsByMethod:{...fork.diagnostics.duplicateRequestsByMethod},
   duplicateImmutableReadsByMethod:{...fork.diagnostics.duplicateImmutableReadsByMethod}});}
  finally{await fork.close();}
 }
}

async function sampleRangeKeeperPaperRetainExit(request:RangeKeeperPaperGasProbeRequest,
 context:RangeKeeperPaperLoadedExitContext,input:{rpcUrl:string;beforeRead:()=>Promise<void>;
 maxRequests?:number;timeoutMs?:number;limits:RangeKeeperLimits;
 onReadDiagnostics?:(diagnostics:ForkReadDiagnostics)=>void}):Promise<readonly RangeKeeperPaperGasStageSample[]>{
 const {profile,frame,candidate}=request,p=profile.pool,k=context.kernel;
 assert(input.rpcUrl.length>0&&Number.isSafeInteger(input.maxRequests??1600)&&(input.maxRequests??1600)>0&&
  (input.maxRequests??1600)<=2000&&Number.isSafeInteger(input.timeoutMs??300_000)&&
  (input.timeoutMs??300_000)>0&&(input.timeoutMs??300_000)<=300_000,'Owned-fork request/time budget invalid');
 assert.equal(p.chainId,4663);assert(same(p.token0,USDG)||same(p.token1,USDG),
  'Retain-exit fixture supports only USDG paired markets');
 assert(same(p.router,PAPER_ROUTER)&&same(p.quoter,PAPER_QUOTER)&&same(p.positionManager,NONFUNGIBLE_POSITION_MANAGER),
  'Persisted market profile differs from audited local paper deployment');
 assert(frame.referenceEligible&&frame.referenceProof&&referenceProofHash(frame.referenceProof)===frame.referenceProofHash,
  'Terminal source reference proof unavailable');
 const source={number:BigInt(frame.source.block),hash:frame.source.hash as Hash,timestamp:BigInt(frame.source.timestamp)};
 const fork=await openPaperFork({source,rpcUrl:input.rpcUrl,beforeRead:input.beforeRead,
  maxRequests:input.maxRequests??1600,timeoutMs:input.timeoutMs??300_000,deterministicClock:true});
 try{
  const local=createRobinhoodClient(fork.localUrl,30_000,{retryCount:0}),chain=new RangeKeeperChain(local,p);
  await chain.verify({block:source.number,hash:source.hash,timestamp:frame.source.timestamp});
  const ref=await readRangeKeeperReferences(local,{block:source.number,hash:source.hash,
   timestamp:frame.source.timestamp},profile);
  assertRangeKeeperTerminalReferenceMatch(frame,ref);
  const slot=await local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'slot0'}),
   liq=await local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'liquidity'});
  assert.equal(slot[1],frame.tick);assert.equal(slot[0],frame.sqrtPriceX96);assert.equal(liq,frame.poolLiquidity);
  const empty=await chain.snapshot({block:source.number,hash:source.hash,timestamp:frame.source.timestamp},PAPER_ACCOUNT,null);
  assert(empty.wallet0===0n&&empty.wallet1===0n&&empty.nftCount===0n&&empty.allowances.every(x=>x.amount===0n),
   'Paper fixture account is not empty at pinned source');
  const allowance=rangeKeeperPaperTerminalAllowances({candidate,allocation:context.draft.allocation,
   openSqrtPriceX96:BigInt(context.openModel.poolState.sqrtPriceX96),openPrice0:BigInt(context.openModel.reference.price0!),
   openPrice1:BigInt(context.openModel.reference.price1!),decimals0:p.decimals0,decimals1:p.decimals1,
   maxDeploymentValue:input.limits.maxDeploymentValue});
  assertRangeKeeperPaperTerminalInventory(context,candidate,frame,allowance);
  const allowances=[
   {token:p.token0 as Address,spender:NONFUNGIBLE_POSITION_MANAGER,amount:String(allowance.manager0)},
   {token:p.token1 as Address,spender:NONFUNGIBLE_POSITION_MANAGER,amount:String(allowance.manager1)},
   {token:p.token0 as Address,spender:PAPER_ROUTER,amount:String(allowance.router0)},
   {token:p.token1 as Address,spender:PAPER_ROUTER,amount:String(allowance.router1)},
  ] as const;
  const policy={market:{symbol:'RangeKeeper',rwa:(same(p.token0,USDG)?p.token1:p.token0) as Address,
   pool:p.pool as Address,fee:p.fee,tickSpacing:p.tickSpacing,
   rwaDecimals:same(p.token0,USDG)?p.decimals1:p.decimals0},
   budgetQuote:'10000000000',halfWidthSpacings:1,maxLiquiditySharePpm:10_000,
   maxSlippageBps:input.limits.maxSlippageBps,transactionTtlSeconds:300};
  const inventory:PaperExitInventory={liquidity:String(candidate.liquidity),tickLower:candidate.range.tickLower,
   tickUpper:candidate.range.tickUpper,idle0:String(allowance.idle0),idle1:String(allowance.idle1),fee0:'0',fee1:'0',
   allowances,nativeBalanceWei:String(k.nativeWei)};
  const restored=await restorePaperPosition(fork,policy,inventory);
  assert.equal(restored.position.liquidity,candidate.liquidity);
  assert.equal(restored.before.quote,String(same(p.token0,USDG)?allowance.idle0:allowance.idle1));
  assert.equal(restored.before.rwa,String(same(p.token0,USDG)?allowance.idle1:allowance.idle0));
  const rows:PaperTransaction[]=[];
  const send=async(action:string,to:Address,data:`0x${string}`)=>{
   const tx=await simulatePaperTransaction(fork,{action,to,calldata:data},PAPER_ACCOUNT,{measuredGas:true});
   assert.equal(tx.sourceBlock,frame.source.block);assert(same(tx.sourceHash,frame.source.hash));rows.push(tx);return tx;
  };
  await fork.rpc('anvil_impersonateAccount',[PAPER_ACCOUNT]);
  const exit=encodeRangeKeeperTx(p,PAPER_ACCOUNT,{kind:'withdraw',tokenId:restored.tokenId,
   liquidity:candidate.liquidity,min0:restored.principal.amount0*(10_000n-BigInt(input.limits.maxSlippageBps))/10_000n,
   min1:restored.principal.amount1*(10_000n-BigInt(input.limits.maxSlippageBps))/10_000n,
   deadline:source.timestamp+300n});
  await send('exit_withdraw_collect',exit.to,exit.data);
  for(const [stage,token,spender] of [
   ['exit_cleanup_router_token0',p.token0,PAPER_ROUTER],['exit_cleanup_router_token1',p.token1,PAPER_ROUTER],
   ['exit_cleanup_manager_token0',p.token0,NONFUNGIBLE_POSITION_MANAGER],
   ['exit_cleanup_manager_token1',p.token1,NONFUNGIBLE_POSITION_MANAGER],
  ] as const){
   const data=encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[spender,0n]});
   await send(stage,token as Address,data);
  }
  assert.deepEqual(rows.map(x=>x.action),request.stages);
  const latest=await local.getBlockNumber({cacheTime:0}),latestBlock=await local.getBlock({blockNumber:latest});
  const end=await chain.snapshot({block:latest,hash:latestBlock.hash!,timestamp:Number(latestBlock.timestamp)},PAPER_ACCOUNT,null);
  assert(end.allowances.every(x=>x.amount===0n));
  const terminal=await readCanaryPosition(local,restored.tokenId,latest);
  assertRangeKeeperPaperRetiredPosition({nftCount:end.nftCount,owner:terminal.owner,
   liquidity:terminal.liquidity,tokensOwed0:terminal.tokensOwed0,tokensOwed1:terminal.tokensOwed1});
  const pinned=await fork.read('eth_getBlockByNumber',[fork.blockTag,false]) as {hash:string};
  assert(same(pinned.hash,source.hash),'Owned fork lost its pinned canonical source');
  return rows.map(row=>({...row,stateOverrides:row.stateOverrides as Record<string,unknown>}));
 }finally{
  try{input.onReadDiagnostics?.({...fork.diagnostics,
   duplicateRequestsByMethod:{...fork.diagnostics.duplicateRequestsByMethod},
   duplicateImmutableReadsByMethod:{...fork.diagnostics.duplicateImmutableReadsByMethod}});}
  finally{await fork.close();}
 }
}

/** Executes the frozen retain-exit withdrawal followed by a direct-pool
 * conversion swap of the risky leftover into the quote token, on a fresh,
 * pinned Anvil fork. `quote` must already be checked by
 * validateConvertTerminalProbe: its quoteHash binds it to this exact
 * candidate/source/pool/input-amount, but not to the live price — this
 * sampler re-derives the live quote on its own fork and requires an exact
 * match before it ever sends the swap, so a stale or mispriced quote cannot
 * silently pass through as gas evidence. */
async function sampleRangeKeeperPaperConvertExit(request:RangeKeeperPaperGasProbeRequest,
 context:RangeKeeperPaperLoadedExitContext,quote:RangeKeeperPaperConvertQuote,
 input:{rpcUrl:string;beforeRead:()=>Promise<void>;maxRequests?:number;timeoutMs?:number;
 limits:RangeKeeperLimits;onReadDiagnostics?:(diagnostics:ForkReadDiagnostics)=>void}
):Promise<readonly RangeKeeperPaperGasStageSample[]>{
 const {profile,frame,candidate}=request,p=profile.pool,k=context.kernel;
 assert(input.rpcUrl.length>0&&Number.isSafeInteger(input.maxRequests??1600)&&(input.maxRequests??1600)>0&&
  (input.maxRequests??1600)<=2000&&Number.isSafeInteger(input.timeoutMs??300_000)&&
  (input.timeoutMs??300_000)>0&&(input.timeoutMs??300_000)<=300_000,'Owned-fork request/time budget invalid');
 assert.equal(p.chainId,4663);assert(same(p.token0,USDG)||same(p.token1,USDG),
  'Convert-exit fixture supports only USDG paired markets');
 assert(same(p.router,PAPER_ROUTER)&&same(p.quoter,PAPER_QUOTER)&&same(p.positionManager,NONFUNGIBLE_POSITION_MANAGER),
  'Persisted market profile differs from audited local paper deployment');
 assert(frame.referenceEligible&&frame.referenceProof&&referenceProofHash(frame.referenceProof)===frame.referenceProofHash,
  'Terminal source reference proof unavailable');
 const source={number:BigInt(frame.source.block),hash:frame.source.hash as Hash,timestamp:BigInt(frame.source.timestamp)};
 const fork=await openPaperFork({source,rpcUrl:input.rpcUrl,beforeRead:input.beforeRead,
  maxRequests:input.maxRequests??1600,timeoutMs:input.timeoutMs??300_000,deterministicClock:true});
 try{
  const local=createRobinhoodClient(fork.localUrl,30_000,{retryCount:0}),chain=new RangeKeeperChain(local,p);
  await chain.verify({block:source.number,hash:source.hash,timestamp:frame.source.timestamp});
  const ref=await readRangeKeeperReferences(local,{block:source.number,hash:source.hash,
   timestamp:frame.source.timestamp},profile);
  assertRangeKeeperTerminalReferenceMatch(frame,ref);
  const slot=await local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'slot0'}),
   liq=await local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'liquidity'});
  assert.equal(slot[1],frame.tick);assert.equal(slot[0],frame.sqrtPriceX96);assert.equal(liq,frame.poolLiquidity);
  const empty=await chain.snapshot({block:source.number,hash:source.hash,timestamp:frame.source.timestamp},PAPER_ACCOUNT,null);
  assert(empty.wallet0===0n&&empty.wallet1===0n&&empty.nftCount===0n&&empty.allowances.every(x=>x.amount===0n),
   'Paper fixture account is not empty at pinned source');
  const allowance=rangeKeeperPaperTerminalAllowances({candidate,allocation:context.draft.allocation,
   openSqrtPriceX96:BigInt(context.openModel.poolState.sqrtPriceX96),openPrice0:BigInt(context.openModel.reference.price0!),
   openPrice1:BigInt(context.openModel.reference.price1!),decimals0:p.decimals0,decimals1:p.decimals1,
   maxDeploymentValue:input.limits.maxDeploymentValue});
  assertRangeKeeperPaperTerminalInventory(context,candidate,frame,allowance);
  const allowances=[
   {token:p.token0 as Address,spender:NONFUNGIBLE_POSITION_MANAGER,amount:String(allowance.manager0)},
   {token:p.token1 as Address,spender:NONFUNGIBLE_POSITION_MANAGER,amount:String(allowance.manager1)},
   {token:p.token0 as Address,spender:PAPER_ROUTER,amount:String(allowance.router0)},
   {token:p.token1 as Address,spender:PAPER_ROUTER,amount:String(allowance.router1)},
  ] as const;
  const policy={market:{symbol:'RangeKeeper',rwa:(same(p.token0,USDG)?p.token1:p.token0) as Address,
   pool:p.pool as Address,fee:p.fee,tickSpacing:p.tickSpacing,
   rwaDecimals:same(p.token0,USDG)?p.decimals1:p.decimals0},
   budgetQuote:'10000000000',halfWidthSpacings:1,maxLiquiditySharePpm:10_000,
   maxSlippageBps:input.limits.maxSlippageBps,transactionTtlSeconds:300};
  const inventory:PaperExitInventory={liquidity:String(candidate.liquidity),tickLower:candidate.range.tickLower,
   tickUpper:candidate.range.tickUpper,idle0:String(allowance.idle0),idle1:String(allowance.idle1),fee0:'0',fee1:'0',
   allowances,nativeBalanceWei:String(k.nativeWei)};
  const restored=await restorePaperPosition(fork,policy,inventory);
  assert.equal(restored.position.liquidity,candidate.liquidity);
  const rows:PaperTransaction[]=[];
  const send=async(action:string,to:Address,data:`0x${string}`)=>{
   const tx=await simulatePaperTransaction(fork,{action,to,calldata:data},PAPER_ACCOUNT,{measuredGas:true});
   assert.equal(tx.sourceBlock,frame.source.block);assert(same(tx.sourceHash,frame.source.hash));rows.push(tx);return tx;
  };
  await fork.rpc('anvil_impersonateAccount',[PAPER_ACCOUNT]);
  const exit=encodeRangeKeeperTx(p,PAPER_ACCOUNT,{kind:'withdraw',tokenId:restored.tokenId,
   liquidity:candidate.liquidity,min0:restored.principal.amount0*(10_000n-BigInt(input.limits.maxSlippageBps))/10_000n,
   min1:restored.principal.amount1*(10_000n-BigInt(input.limits.maxSlippageBps))/10_000n,
   deadline:source.timestamp+300n});
  await send('exit_withdraw_collect',exit.to,exit.data);
  const inputToken:0|1=p.quoteToken===0?1:0,outputToken:0|1=p.quoteToken,
   inputAmount=BigInt(quote.inputAmount),minOut=BigInt(quote.minimumOutput);
  const postWithdraw0=await local.readContract({address:p.token0 as Address,abi:paperTokenAbi,
   functionName:'balanceOf',args:[PAPER_ACCOUNT]});
  const postWithdraw1=await local.readContract({address:p.token1 as Address,abi:paperTokenAbi,
   functionName:'balanceOf',args:[PAPER_ACCOUNT]});
  const postWithdrawInput=inputToken===0?postWithdraw0:postWithdraw1,
   preSwapOutput=outputToken===0?postWithdraw0:postWithdraw1;
  assert.equal(postWithdrawInput,inputAmount,
   'Owned-fork post-withdraw inventory differs from the frozen conversion input amount');
  // Re-derive the live quote on this exact pinned fork. The persisted quote's
  // hash only binds its own fields together (see validateConvertTerminalProbe);
  // this is the ground-truth check that its expectedOutput still matches a
  // real quoter call at the exact candidate/source before any swap is sent.
  const sourceQuote=await chain.quote({block:source.number,hash:source.hash,timestamp:frame.source.timestamp},
   inputToken,inputAmount,frame.price0!,frame.price1!);
  assert.equal(sourceQuote.amountOut,BigInt(quote.expectedOutput),
   'Persisted conversion quote differs from the owned-fork quoter at its exact source');
  const approve=encodeRangeKeeperTx(p,PAPER_ACCOUNT,{kind:'approve',token:inputToken,spender:'router',amount:inputAmount});
  await send('exit_convert_approve_router_input',approve.to,approve.data);
  const swapBlock=await fork.rpc<{timestamp:`0x${string}`}>('eth_getBlockByNumber',['latest',false]);
  const swap=encodeRangeKeeperTx(p,PAPER_ACCOUNT,{kind:'swap',token:inputToken,amountIn:inputAmount,minOut,
   deadline:BigInt(swapBlock.timestamp)+300n});
  const swapTx=await send('exit_convert_swap',swap.to,swap.data);
  const swapReturns=decodeFunctionResult({abi:paperRouterAbi,functionName:'multicall',data:swapTx.returnData});
  assert.equal(swapReturns.length,1);
  assert.equal(decodeFunctionResult({abi:paperRouterAbi,functionName:'exactInputSingle',data:swapReturns[0]!}),
   BigInt(quote.expectedOutput),'Owned-fork conversion swap output differs from the exact source quote');
  const postSwap0=await local.readContract({address:p.token0 as Address,abi:paperTokenAbi,
   functionName:'balanceOf',args:[PAPER_ACCOUNT]});
  const postSwap1=await local.readContract({address:p.token1 as Address,abi:paperTokenAbi,
   functionName:'balanceOf',args:[PAPER_ACCOUNT]});
  const postSwapInput=inputToken===0?postSwap0:postSwap1,postSwapOutput=outputToken===0?postSwap0:postSwap1;
  assert.equal(postSwapInput,0n,'Owned-fork conversion left risky-token residue');
  assert.equal(postSwapOutput,preSwapOutput+BigInt(quote.expectedOutput),
   'Owned-fork conversion output differs from the exact quoted amount');
  for(const [stage,token,spender] of [
   ['exit_cleanup_router_token0',p.token0,PAPER_ROUTER],['exit_cleanup_router_token1',p.token1,PAPER_ROUTER],
   ['exit_cleanup_manager_token0',p.token0,NONFUNGIBLE_POSITION_MANAGER],
   ['exit_cleanup_manager_token1',p.token1,NONFUNGIBLE_POSITION_MANAGER],
  ] as const){
   const data=encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[spender,0n]});
   await send(stage,token as Address,data);
  }
  assert.deepEqual(rows.map(x=>x.action),request.stages);
  const latest=await local.getBlockNumber({cacheTime:0}),latestBlock=await local.getBlock({blockNumber:latest});
  const end=await chain.snapshot({block:latest,hash:latestBlock.hash!,timestamp:Number(latestBlock.timestamp)},PAPER_ACCOUNT,null);
  assert(end.allowances.every(x=>x.amount===0n));
  const terminal=await readCanaryPosition(local,restored.tokenId,latest);
  assertRangeKeeperPaperRetiredPosition({nftCount:end.nftCount,owner:terminal.owner,
   liquidity:terminal.liquidity,tokensOwed0:terminal.tokensOwed0,tokensOwed1:terminal.tokensOwed1});
  const pinned=await fork.read('eth_getBlockByNumber',[fork.blockTag,false]) as {hash:string};
  assert(same(pinned.hash,source.hash),'Owned fork lost its pinned canonical source');
  return rows.map(row=>({...row,stateOverrides:row.stateOverrides as Record<string,unknown>}));
 }finally{
  try{input.onReadDiagnostics?.({...fork.diagnostics,
   duplicateRequestsByMethod:{...fork.diagnostics.duplicateRequestsByMethod},
   duplicateImmutableReadsByMethod:{...fork.diagnostics.duplicateImmutableReadsByMethod}});}
  finally{await fork.close();}
 }
}
