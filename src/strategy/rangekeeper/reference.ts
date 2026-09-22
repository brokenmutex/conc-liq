import type {Address} from 'viem';
import {USDG} from '../../constants.js';
import {regularEquitySession} from '../../canary-plan/entry-readiness.js';
import {latestEquitySessionStart} from '../../paper/reference.js';
import {evaluateOracleRisk} from '../../risk/evaluate.js';
import type {AssetRiskSnapshot,OracleRiskSnapshot,RiskSnapshot} from '../../risk/domain.js';
import {loadRiskConfig} from '../../risk/config.js';
import {ViemRiskChainReader} from '../../risk/reader.js';
import {collectRiskSnapshot} from '../../risk/runner.js';
import {fetchFeedDirectory,selectOracleFeed} from '../../risk/source.js';
import type {RobinhoodClient} from '../../client.js';
import type {RangeKeeperConfig} from './config.js';
import type {RangeKeeperSource} from './chain.js';

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const price=(o:OracleRiskSnapshot)=>o.state?BigInt(o.state.answer)*10n**18n/10n**BigInt(o.state.decimals):null;
export interface RangeKeeperReferenceMark {
 source:{block:string;hash:string;timestamp:string};price0:bigint|null;price1:bigint|null;nativePrice:bigint|null;
 eligible:boolean;reasons:string[];proof:{token0:unknown;token1:unknown;native:unknown;registry:unknown;feedDirectory:unknown};
}

/** Consume independently collected registry, token-risk, and on-chain feed
 * evidence. A pool mark is never substituted for an unavailable oracle. */
export function evaluateRangeKeeperReferences(snapshot:RiskSnapshot,native:OracleRiskSnapshot|null,
 config:Pick<RangeKeeperConfig,'pool'|'referencePolicy'>):RangeKeeperReferenceMark {
 const source={block:snapshot.blockNumber,hash:snapshot.blockHash,timestamp:snapshot.blockTimestamp};
 const reasons:string[]=[];
 if(snapshot.chainId!==config.pool.chainId||snapshot.schemaVersion!==2)reasons.push('risk_source_identity');
 if(!snapshot.marketSession.executionEligible||snapshot.marketSession.status!=='open_24_7')reasons.push('market_session_unverified');
 const blockTime=BigInt(Math.floor(Date.parse(snapshot.blockTimestamp)/1000));
 const token=(address:Address,identity:string,policy:RangeKeeperConfig['referencePolicy']['token0'],label:string)=>{
  let oracle:OracleRiskSnapshot|null=null,asset:AssetRiskSnapshot|null=null;
  if(policy.kind==='stablecoin'){
   if(!same(address,USDG)||identity!=='USDG/USD'||policy.session!=='verified_24_7')reasons.push(`${label}_unsupported_stablecoin`);
   oracle=snapshot.quoteOracle;
  }else{
   asset=snapshot.assets.find(a=>same(a.registry.address,address))??null;
   if(!asset||identity!==`${asset.registry.symbol}/USD`||policy.session!=='latest_equity_session')reasons.push(`${label}_asset_identity`);
   if(asset){
    const f=asset.flags;
    if(!asset.onchain||asset.onchain.oraclePaused||!f.registryActive||!f.multiplierConsistent||f.corporateActionPending
     ||!f.tradingCapabilitiesComplete||!f.tradingCapabilitiesTradable)reasons.push(`${label}_asset_health`);
    oracle=asset.oracle;
   }
  }
  if(!oracle?.state){reasons.push(`${label}_oracle_missing`);return {value:null,proof:{asset,oracle}};}
  if(oracle.feed.baseAsset.toUpperCase()!==identity.split('/')[0]?.toUpperCase()||oracle.feed.quoteAsset.toUpperCase()!=='USD')reasons.push(`${label}_oracle_identity`);
  const reevaluated=evaluateOracleRisk({feed:oracle.feed,state:oracle.state,blockTimestamp:blockTime,maxPriceAgeSeconds:policy.maxAgeSeconds});
  const structural=reevaluated.reasons.filter(r=>r!=='oracle_price_stale');
  if(structural.length)reasons.push(...structural.map(r=>`${label}_${r}`));
  let held=false;
  if(policy.kind==='stock_token'&&policy.session==='latest_equity_session'){
   const since=latestEquitySessionStart(snapshot.blockTimestamp);
   held=regularEquitySession(snapshot.blockTimestamp)==='closed'&&since!==null&&
    Number(oracle.state.updatedAt)*1000>=since&&reevaluated.priceAgeSeconds!==null&&
    reevaluated.priceAgeSeconds<=policy.maxAgeSeconds;
  }
  if(!reevaluated.executionEligible&&!held)reasons.push(`${label}_reference_age_unacceptable`);
  return {value:reevaluated.state&&BigInt(reevaluated.state.answer)>0n?price(reevaluated):null,
   proof:{asset,oracle:reevaluated,basis:reevaluated.executionEligible?'heartbeat_valid':held?'held_equity_reference':'unavailable'}};
 };
 const t0=token(config.pool.token0,config.pool.reference0,config.referencePolicy.token0,'token0');
 const t1=token(config.pool.token1,config.pool.reference1,config.referencePolicy.token1,'token1');
 let nativeValue:bigint|null=null,nativeProof:unknown=native;
 if(!native?.state||native.feed.baseAsset.toUpperCase()!=='ETH'||native.feed.quoteAsset.toUpperCase()!=='USD')reasons.push('native_oracle_missing');
 else{
  const n=evaluateOracleRisk({feed:native.feed,state:native.state,blockTimestamp:blockTime,maxPriceAgeSeconds:config.referencePolicy.nativeMaxAgeSeconds});
  nativeProof=n;if(n.executionEligible)nativeValue=price(n);else reasons.push(...n.reasons.map(r=>`native_${r}`));
 }
 if(t0.value===null||t1.value===null||nativeValue===null)reasons.push('reference_value_unavailable');
 return {source,price0:reasons.some(r=>r.startsWith('token0_'))?null:t0.value,
  price1:reasons.some(r=>r.startsWith('token1_'))?null:t1.value,nativePrice:nativeValue,
  eligible:reasons.length===0,reasons:[...new Set(reasons)],proof:{token0:t0.proof,token1:t1.proof,native:nativeProof,
   registry:snapshot.registry,feedDirectory:snapshot.feedDirectory}};
}

export async function readRangeKeeperReferences(client:RobinhoodClient,source:RangeKeeperSource,
 config:Pick<RangeKeeperConfig,'pool'|'referencePolicy'>){
 const symbols=[config.pool.reference0,config.pool.reference1].filter(identity=>identity!=='USDG/USD').map(identity=>identity.split('/')[0]!);
 const riskConfig={...loadRiskConfig(),symbols};
 const reader=new ViemRiskChainReader(client);
 const [snapshot,directory]=await Promise.all([
  collectRiskSnapshot({blockNumber:source.block,config:riskConfig,reader}),
  fetchFeedDirectory(riskConfig.feedDirectoryUrl,riskConfig.httpTimeoutMs),
 ]);
 if(snapshot.blockHash.toLowerCase()!==source.hash.toLowerCase()||Math.floor(Date.parse(snapshot.blockTimestamp)/1000)!==source.timestamp)
  throw new Error('RangeKeeper reference source mismatch');
 const eth=selectOracleFeed(directory.payload,'ETH');
 const native=eth?evaluateOracleRisk({feed:eth,state:await reader.readOracle(eth.address,source.block),
  blockTimestamp:BigInt(source.timestamp),maxPriceAgeSeconds:config.referencePolicy.nativeMaxAgeSeconds}):null;
 const block=await client.getBlock({blockNumber:source.block});
 if(block.hash.toLowerCase()!==source.hash.toLowerCase())throw new Error('RangeKeeper reference source reorged');
 return evaluateRangeKeeperReferences(snapshot,native,config);
}
