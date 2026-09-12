import assert from 'node:assert/strict';
import type {RobinhoodClient} from '../client.js';
import {loadRiskConfig} from '../risk/config.js';
import {fetchFeedDirectory,selectOracleFeed} from '../risk/source.js';
import {ViemRiskChainReader} from '../risk/reader.js';
import {evaluateOracleRisk} from '../risk/evaluate.js';
import {evaluatePaperUsdgOracle} from '../paper/usdg-oracle.js';
import type {LivePilotConfig} from './config.js';
import type {PilotSource} from './chain.js';

/** Full receipt gas is converted once at its own block, without adding L1 fees again. */
export function pilotGasValuer(client:RobinhoodClient,config:LivePilotConfig) {
 const risk=loadRiskConfig(),reader=new ViemRiskChainReader(client);
 let directory:Awaited<ReturnType<typeof fetchFeedDirectory>>|undefined;
 return async(source:PilotSource,wei:string)=>{
  if(!directory||Date.now()-Date.parse(directory.evidence.fetchedAt)>3600000)
   directory=await fetchFeedDirectory(risk.feedDirectoryUrl,risk.httpTimeoutMs);
  const proof=[];
  for(const symbol of ['ETH','USDG']){
   const feed=selectOracleFeed(directory.payload,symbol);assert(feed,`${symbol} feed missing`);
   const state=await reader.readOracle(feed.address,BigInt(source.block));
   const input={feed,state,blockTimestamp:BigInt(source.timestamp),maxPriceAgeSeconds:config.strategy.referencePolicy!.maxGasPriceAgeSeconds};
   const evaluated=symbol==='USDG'?evaluatePaperUsdgOracle(input,config.strategy.referencePolicy!.usdgHeartbeatGraceSeconds):evaluateOracleRisk(input);
   assert(evaluated.executionEligible&&evaluated.state,`${symbol} valuation unavailable`);proof.push(evaluated);
  }
  assert((await client.getBlock({blockNumber:BigInt(source.block)})).hash.toLowerCase()===source.hash.toLowerCase());
  const eth=proof[0]!.state!,usd=proof[1]!.state!;
  const quote=BigInt(wei)*BigInt(eth.answer)*10n**BigInt(usd.decimals)*1000000n/(10n**18n*BigInt(usd.answer)*10n**BigInt(eth.decimals));
  return {quote:String(quote),proof:{source,directory:directory.evidence,oracles:proof,basis:'receipt_block_eth_usdg'}};
 };
}
