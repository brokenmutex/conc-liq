import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import pg from "pg";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { evaluateCanaryEntryReadiness } from "./canary-plan/entry-readiness.js";
import { ExperimentMarket, type ExperimentEvent, type MarketSeed } from "./experiment/market.js";
import { loadRuntimeIdentity, assertRuntimeMatches, type RuntimeIdentity } from "./runtime/identity.js";
import { marketValue, type PaperMarket } from "./paper/market.js";
import { sourceSql } from "./paper/store.js";
import { readPaperReferenceGate } from "./paper/reference.js";
import { AdaptiveLpReplay, type AdaptivePolicy, type ResearchLpCosts } from "./research/adaptive-lp.js";
import { agileForecastStats } from "./research/agile-forecast.js";
import type { ForecastSample } from "./research/adaptive-forecast.js";
import type { RpcHealthEvaluation } from "./rpc-health/domain.js";

const envSchema = z.object({ DATABASE_URL: z.string().min(1) });
const marketSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9.]+$/),
  rwa: z.string().refine(isAddress).transform(value=>getAddress(value)),
  pool: z.string().refine(isAddress).transform(value=>getAddress(value)),
  fee: z.literal(500), tickSpacing: z.literal(10), rwaDecimals: z.literal(18),
});
const costsSchema = z.object({ entry:z.string().regex(/^\d+$/), recenter:z.string().regex(/^\d+$/),
  exit:z.string().regex(/^\d+$/), hold:z.string().regex(/^\d+$/), holdExit:z.string().regex(/^\d+$/) });
const configSchema = z.object({
  version:z.literal("adaptive_paper_60m_v1"), streamKey:z.string().min(1), budgetQuote:z.string().regex(/^[1-9]\d*$/),
  halfWidthsTicks:z.array(z.number().int().positive()).min(2), decisionMs:z.literal(30000), quoteTtlMs:z.literal(90000),
  horizonMs:z.literal(600000), slippageBps:z.literal(50), costBufferPpm:z.literal(500000), feeBufferPpm:z.literal(250000),
  forecast:z.object({lookbackMs:z.literal(3600000),minimumSpanMs:z.literal(2400000),minimumSamples:z.literal(40)}).strict(),
  assets:z.array(z.object({market:marketSchema,costs:costsSchema,evidence:z.record(z.string(),z.string())}).strict()).length(3),
}).strict();
type Config=z.infer<typeof configSchema>;

interface SourceRow {
  checkpoint:{id:string;block:string;hash:string;blockTimestamp:string;capturedAt:string;tick:number;sqrtPriceX96:string;liquidity:string;feeGrowth0:string;feeGrowth1:string;targetSetHash:string};
  risk_run_id:string;token0:string;token1:string;token_decimals:number|null;pool_unlocked:boolean;status:string;reasons:string[];
  canonical:boolean;covered:boolean;coverage_identity_valid:boolean;asset_reasons:string[]|null;asset_eligible:boolean|null;deviation_ppm:string|null;
}
interface AssetState {
  symbol:string; market:PaperMarket; costs:ResearchLpCosts; seed:MarketSeed; last:SourceRow["checkpoint"];
  samples:ForecastSample[]; lastSampleAt:number; growth0:bigint; growth1:bigint;
  model:Record<string,unknown>; status:"running"|"invalid"; reason?:string; blocked:Record<string,number>;
  decisions:number; forecastAvailable:number; forecastUnavailable:number;
}
interface State {
  version:1; createdAt:string; config:Config; configHash:string; runtime:RuntimeIdentity; assets:AssetState[]; lastPollAt:string;
  executionEligible:false; broadcastsEnabled:false;
}
const json=(value:unknown)=>JSON.stringify(value,(_key,item)=>typeof item==="bigint"?{bigint:String(item)}:item,2)+"\n";
const parse=(value:string)=>JSON.parse(value,(_key,item)=>item&&typeof item==="object"&&Object.keys(item).length===1&&typeof item.bigint==="string"?BigInt(item.bigint):item);
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
async function atomic(path:string,value:unknown){await writeFile(path+".tmp",json(value));await rename(path+".tmp",path);}
const count=(state:AssetState,reason:string)=>{state.blocked[reason]=(state.blocked[reason]??0)+1;};
const policy=(config:Config):AdaptivePolicy=>({name:"rolling_60m_plus_10",halfWidthsTicks:config.halfWidthsTicks,adaptive:true,economicGate:true,
  budget:BigInt(config.budgetQuote),decisionMs:config.decisionMs,quoteTtlMs:config.quoteTtlMs,horizonMs:config.horizonMs,
  slippageBps:config.slippageBps,costBufferPpm:config.costBufferPpm,feeBufferPpm:config.feeBufferPpm,gasMultiplier:1,feePpm:1000000,failEveryRecenter:0});
const costs=(input:z.infer<typeof costsSchema>):ResearchLpCosts=>Object.fromEntries(Object.entries(input).map(([key,value])=>[key,BigInt(value)])) as unknown as ResearchLpCosts;

class Source {
  readonly db:pg.Client;
  constructor(readonly connectionString:string,readonly streamKey:string){this.db=new pg.Client({connectionString,application_name:"adaptive_paper_60m",options:"-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=3000"});}
  async connect(){await this.db.connect();}
  async close(){await this.db.end();}
  async rows(market:PaperMarket,afterBlock?:string,from?:string){
    const suffix=afterBlock!==undefined?" AND c.block_number>$4":" AND c.block_timestamp>=$4";
    const raw=(await this.db.query<SourceRow>(sourceSql+suffix+" ORDER BY c.block_number,c.id",[this.streamKey,market.rwa.toLowerCase(),market.pool.toLowerCase(),afterBlock??from])).rows
      .filter(row=>row.canonical===true&&row.covered===true&&row.coverage_identity_valid===true);
    const unique:SourceRow[]=[];
    for(const row of raw){const prior=unique.at(-1);if(prior?.checkpoint.block===row.checkpoint.block)unique[unique.length-1]=row;else unique.push(row);}
    return unique;
  }
  async events(market:PaperMarket,from:string,to:string):Promise<ExperimentEvent[]> {
    return (await this.db.query(`SELECT block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,event_name AS name,event_args AS args
      FROM v3_pool_events WHERE stream_key=$1 AND LOWER(pool_address)=$2 AND block_number>$3 AND block_number<=$4
      ORDER BY block_number,transaction_index,log_index`,[this.streamKey,market.pool.toLowerCase(),from,to])).rows;
  }
  async seed(market:PaperMarket,row:SourceRow):Promise<MarketSeed>{
    const events=(await this.db.query(`SELECT event_name,event_args FROM v3_pool_events WHERE stream_key=$1 AND LOWER(pool_address)=$2
      AND block_number<=$3 AND event_name IN ('Mint','Burn','SetFeeProtocol') ORDER BY block_number,transaction_index,log_index`,
      [this.streamKey,market.pool.toLowerCase(),row.checkpoint.block])).rows;
    const ticks=new Map<number,{gross:bigint;net:bigint}>();let protocol0=0,protocol1=0;
    for(const event of events){const args=event.event_args;
      if(event.event_name==="SetFeeProtocol"){protocol0=Number(args.feeProtocol0New);protocol1=Number(args.feeProtocol1New);continue;}
      const change=BigInt(args.amount)*(event.event_name==="Burn"?-1n:1n);
      for(const [tick,sign] of [[Number(args.tickLower),1n],[Number(args.tickUpper),-1n]] as const){const item=ticks.get(tick)??{gross:0n,net:0n};item.gross+=change;item.net+=change*sign;assert(item.gross>=0n);
        if(item.gross===0n){assert.equal(item.net,0n);ticks.delete(tick);}else ticks.set(tick,item);}
    }
    const cp=row.checkpoint;return {price:cp.sqrtPriceX96,tick:cp.tick,liquidity:cp.liquidity,global0:cp.feeGrowth0,global1:cp.feeGrowth1,protocol0,protocol1,
      ticks:[...ticks].map(([tick,item])=>({tick,gross:String(item.gross),net:String(item.net)}))};
  }
  async decisionGate(row:SourceRow,market:PaperMarket){
    const now=new Date().toISOString(),samples=(await this.db.query<{id:string;snapshot:RpcHealthEvaluation}>("SELECT id::text,snapshot FROM rpc_health_samples WHERE observed_at>=NOW()-INTERVAL '6 minutes' ORDER BY observed_at DESC,id DESC LIMIT 128")).rows;
    const readiness=evaluateCanaryEntryReadiness({now,sourceBlock:BigInt(row.checkpoint.block),samples});
    const gate=await readPaperReferenceGate(this.db,{...row.checkpoint,market},{kind:"continuous_bounded_v1",maxHeldAgeSeconds:345600,maxDeviationPpm:50000,maxGasPriceAgeSeconds:86400,usdgHeartbeatGraceSeconds:1800},now);
    return {chainEligible:readiness.chainEligible,reference:gate.reference,reasons:[...readiness.reasons.filter(reason=>!reason.startsWith("equity_session_")),...gate.reasons]};
  }
}

function sourceReasons(row:SourceRow,gate:{chainEligible:boolean;reasons:readonly string[]},now:number){
  const reasons:string[]=[];const cp=row.checkpoint,age=now-Date.parse(cp.blockTimestamp);
  if(row.canonical!==true)reasons.push("checkpoint_not_canonical");if(row.covered!==true||row.coverage_identity_valid!==true)reasons.push("event_coverage_unavailable");
  if(!row.pool_unlocked)reasons.push("pool_locked");reasons.push(...gate.reasons);
  if(!gate.chainEligible)reasons.push("chain_recovery_unproven");if(age<0||age>180000)reasons.push("source_stale");
  return [...new Set(reasons)];
}
function restoreModel(asset:AssetState,config:Config){const model=new AdaptiveLpReplay(asset.market,asset.costs,policy(config));Object.assign(model,asset.model);return model;}
function snapshotModel(model:AdaptiveLpReplay){return Object.fromEntries(Object.entries(model).filter(([key])=>!["market","costs","policy"].includes(key)));}
function sample(asset:AssetState,market:ExperimentMarket,at:number){
  if(at-asset.lastSampleAt<60000)return;asset.samples.push({at,price:market.price,growth0:asset.growth0,growth1:asset.growth1});asset.lastSampleAt=at;
  while(asset.samples.length>1&&asset.samples[1]!.at<at-7200000)asset.samples.shift();
}
async function advanceAsset(source:Source,asset:AssetState,config:Config,rows:SourceRow[],allowDecisions:boolean){
  if(asset.status==="invalid"||!rows.length)return;const market=new ExperimentMarket(asset.seed),model=restoreModel(asset,config);
  const events=await source.events(asset.market,asset.last.block,rows.at(-1)!.checkpoint.block);let eventIndex=0;
  try{
    for(const row of rows){const cp=row.checkpoint;if(cp.targetSetHash!==asset.last.targetSetHash)throw new Error("target_set_changed");
      while(eventIndex<events.length&&BigInt(events[eventIndex]!.block)<=BigInt(cp.block))for(const {segment,protocol} of market.apply(events[eventIndex++]!)){
        const growth=segment.liquidity?(segment.fee-(protocol?segment.fee/BigInt(protocol):0n))*(1n<<128n)/segment.liquidity:0n;
        if(segment.token===0)asset.growth0+=growth;else asset.growth1+=growth;model.accrue(segment,protocol);
      }
      market.verify({price:cp.sqrtPriceX96,tick:cp.tick,liquidity:cp.liquidity,global0:cp.feeGrowth0,global1:cp.feeGrowth1});
      const at=Date.parse(cp.blockTimestamp);sample(asset,market,at);
      if(allowDecisions){const stats=agileForecastStats(asset.samples,at,config.forecast),gate=await source.decisionGate(row,asset.market),reasons=sourceReasons(row,gate,Date.now());
        if(reasons.length===0){if(stats)asset.forecastAvailable++;else asset.forecastUnavailable++;await model.step({...market.source(),at,block:cp.block},stats);asset.decisions++;}
        else {model.mark({...market.source(),at,block:cp.block});for(const reason of reasons)count(asset,reason);}}
      asset.last=cp;
    }
    assert.equal(eventIndex,events.length);asset.seed=market.seed();asset.model=snapshotModel(model);
  }catch(error){asset.status="invalid";asset.reason=error instanceof Error?error.message:"adaptive_paper_reconstruction_failed";}
}
function report(state:State){return {version:state.config.version,createdAt:state.createdAt,updatedAt:state.lastPollAt,executionEligible:false,broadcastsEnabled:false,
  policy:{lookbackMinutes:60,minimumSpanMinutes:40,minimumSamples:40,halfWidthsTicks:state.config.halfWidthsTicks,economicGate:true,outOfRangeTrigger:true},
  assets:state.assets.map(asset=>{const model=restoreModel(asset,state.config),market=new ExperimentMarket(asset.seed),balances=model.balances(market.source()),nav=marketValue(asset.market,market.price,balances.amount0,balances.amount1)-model.gas;
    return {symbol:asset.symbol,status:asset.status,reason:asset.reason??null,sourceAt:asset.last.blockTimestamp,sourceBlock:asset.last.block,navQuote:String(nav),pnlQuote:String(nav-BigInt(state.config.budgetQuote)),
      entries:model.entries,recenters:model.recenters,pending:model.pending?.kind??null,currentRange:model.position?{tickLower:model.position.tickLower,tickUpper:model.position.tickUpper}:null,
      gasQuote:String(model.gas),fees0:String(model.fees0),fees1:String(model.fees1),decisions:asset.decisions,forecastAvailable:asset.forecastAvailable,forecastUnavailable:asset.forecastUnavailable,rejected:model.rejected,blocked:asset.blocked};})};
}
async function persist(path:string,state:State){state.lastPollAt=new Date().toISOString();await atomic(path,state);await atomic(path+".status.json",report(state));}
async function start(source:Source,config:Config,path:string){
  const createdAt=new Date().toISOString(),runtime=loadRuntimeIdentity();assertRuntimeMatches(runtime??null,runtime);assert(runtime);
  const state:State={version:1,createdAt,config,configHash:digest(json(config)),runtime,assets:[],lastPollAt:createdAt,executionEligible:false,broadcastsEnabled:false};
  for(const item of config.assets){const rows=await source.rows(item.market,undefined,new Date(Date.now()-75*60000).toISOString());assert(rows.length>=2,`${item.market.symbol} forecast warmup checkpoints unavailable`);
    const first=rows[0]!,seed=await source.seed(item.market,first),market=new ExperimentMarket(seed);market.verify({price:first.checkpoint.sqrtPriceX96,tick:first.checkpoint.tick,liquidity:first.checkpoint.liquidity,global0:first.checkpoint.feeGrowth0,global1:first.checkpoint.feeGrowth1});
    const model=new AdaptiveLpReplay(item.market,costs(item.costs),policy(config));const asset:AssetState={symbol:item.market.symbol,market:item.market,costs:costs(item.costs),seed,last:first.checkpoint,samples:[],lastSampleAt:-Infinity,growth0:0n,growth1:0n,model:snapshotModel(model),status:"running",blocked:{},decisions:0,forecastAvailable:0,forecastUnavailable:0};
    sample(asset,market,Date.parse(first.checkpoint.blockTimestamp));await advanceAsset(source,asset,config,rows.slice(1),false);assert(asset.status==="running",`${asset.symbol} warmup failed: ${asset.reason}`);state.assets.push(asset);
  }
  await persist(path,state);return state;
}
async function tick(source:Source,path:string){const state:State=parse(await readFile(path,"utf8"));assert.equal(state.version,1);assert.equal(state.configHash,digest(json(state.config)),"Adaptive paper configuration changed");assertRuntimeMatches(state.runtime,loadRuntimeIdentity());
  for(const asset of state.assets){const rows=await source.rows(asset.market,asset.last.block);await advanceAsset(source,asset,state.config,rows,true);}await persist(path,state);return state;}
async function main(){const [command,...args]=process.argv.slice(2);if(!["start","tick","watch","status"].includes(command??""))throw new Error("Usage: adaptive-paper start CONFIG STATE | tick STATE | watch STATE | status STATE");
  if(command==="status"){console.log(await readFile(args[0]!+".status.json","utf8"));return;}
  const config=command==="start"?configSchema.parse(JSON.parse(await readFile(args[0]!,"utf8"))):null,path=command==="start"?args[1]!:args[0]!;assert(path);
  const source=new Source(envSchema.parse(process.env).DATABASE_URL,(config??(parse(await readFile(path,"utf8")) as State).config).streamKey);await source.connect();
  try{if(command==="start"){const state=await start(source,config!,path);console.log(JSON.stringify(report(state)));return;}
    do{const state=await tick(source,path);console.log(JSON.stringify(report(state)));if(command==="tick")break;await new Promise(resolve=>setTimeout(resolve,15000));}while(true);
  }finally{await source.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.stack??error.message:"Adaptive paper failed");process.exitCode=1;});
