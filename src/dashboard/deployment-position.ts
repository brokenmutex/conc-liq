import type {PoolClient} from 'pg';
import {allocationSchema} from '../deployments/contracts.js';
import {marketProfileSchema,type MarketProfile} from '../deployments/market-profile.js';
import {sqrtRatioAtTick} from '../backtest/principal.js';
import {positionWindow,type PositionPoint} from './position-performance.js';

const WAD=10n**18n,Q192=1n<<192n;
const micro=(value:string|null)=>value===null?null:String(BigInt(value)/10n**12n);
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&
 !Array.isArray(value)?value as Record<string,unknown>:{};
const decimal=(value:unknown):string|null=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)?value:null;
const sourceTime=(provenance:unknown):string|null=>{
 const n=record(record(provenance).source).timestamp;
 return typeof n==='number'&&Number.isSafeInteger(n)&&n>0?new Date(n*1000).toISOString():null;
};
const symbol=(reference:string)=>reference.split('/')[0]??reference;

interface DeploymentRow {
 id:string;mode:'paper'|'live';lifecycle:string;range_state:string;current_revision:number;created_at:Date;
 closed_at:Date|null;allocation:unknown;profile:unknown;strategy_id:string;config:unknown;
 mark_id:string|null;mark_at:Date|null;source_block:string|null;source_hash:string|null;
 inventory:unknown;economics:unknown;provenance:unknown;initial_value:string|null;
}
interface DeploymentMark {
 id:string;at:Date;source_block:string|null;source_hash:string|null;
 inventory:unknown;economics:unknown;provenance:unknown;
}
const key=(mode:string,id:string)=>`${mode}-dep-${id}`;
const parseKey=(id:string)=>{
 const match=/^(paper|live)-dep-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(id);
 return match?{mode:match[1]!,id:match[2]!}:null;
};
const poolPrice=(sqrt:bigint,p:MarketProfile['pool'])=>{
 if(sqrt<=0n)return null;
 const n=p.quoteToken===0?Q192*10n**BigInt(p.decimals1)*WAD:
  sqrt*sqrt*10n**BigInt(p.decimals0)*WAD;
 const d=p.quoteToken===0?sqrt*sqrt*10n**BigInt(p.decimals0):
  Q192*10n**BigInt(p.decimals1);
 return String(n/d);
};
const rangePrices=(lower:number,upper:number,p:MarketProfile['pool'])=>
 [poolPrice(sqrtRatioAtTick(lower),p),poolPrice(sqrtRatioAtTick(upper),p)]
  .filter((v):v is string=>v!==null).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
const markPoolState=(provenance:unknown)=>record(record(provenance).poolState);
const referencePrice=(provenance:unknown,p:MarketProfile['pool'])=>{
 const reference=record(record(provenance).reference),risk=decimal(p.quoteToken===0?reference.price1:reference.price0),
  quote=decimal(p.quoteToken===0?reference.price0:reference.price1);
 return risk!==null&&quote!==null&&BigInt(quote)>0n?String(BigInt(risk)*WAD/BigInt(quote)):null;
};
const tokenReferenceValue=(amount0:string|null,amount1:string|null,provenance:unknown,
 p:MarketProfile['pool'])=>{
 const reference=record(record(provenance).reference),price0=decimal(reference.price0),
  price1=decimal(reference.price1);
 if(amount0===null||amount1===null||price0===null||price1===null)return null;
 return String(BigInt(amount0)*BigInt(price0)/10n**BigInt(p.decimals0)+
  BigInt(amount1)*BigInt(price1)/10n**BigInt(p.decimals1));
};
const principalValue=(inventory:Record<string,unknown>,economics:Record<string,unknown>,
 provenance:unknown,p:MarketProfile['pool'])=>{
 const recorded=decimal(economics.principalOnlyValue);
 if(recorded!==null)return recorded;
 const lower=record(inventory.knownLowerBound),retained=record(inventory.retainedPrincipalLowerBound);
 return tokenReferenceValue(decimal(lower.token0Raw)??decimal(retained.token0Raw),
  decimal(lower.token1Raw)??decimal(retained.token1Raw),provenance,p);
};

/** Older dashboard databases may not have the new ledger migration. */
export async function readDeploymentRows(db:PoolClient):Promise<DeploymentRow[]>{
 const present=(await db.query<{present:string|null}>(
  "SELECT to_regclass('deployment_campaigns')::text AS present")).rows[0]?.present;
 if(!present)return [];
 const rows=(await db.query<DeploymentRow>(`
  SELECT c.id,c.mode,c.lifecycle,c.range_state,c.current_revision,c.created_at,c.closed_at,c.allocation,
   p.profile,r.strategy_id,r.config,m.id::text AS mark_id,m.at AS mark_at,
   m.source_block::text,m.source_hash,m.inventory,m.economics,m.provenance,
   capital.initial_value
  FROM deployment_campaigns c JOIN deployment_market_profiles p ON p.id=c.market_profile_id
  JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
  LEFT JOIN LATERAL (SELECT id,at,source_block,source_hash,inventory,economics,provenance
   FROM deployment_marks WHERE campaign_id=c.id ORDER BY id DESC LIMIT 1) m ON TRUE
  LEFT JOIN LATERAL (SELECT sum(value_raw)::text AS initial_value FROM deployment_ledger
   WHERE campaign_id=c.id AND kind='capital_in') capital ON TRUE
  WHERE c.lifecycle<>'draft' ORDER BY c.created_at DESC,c.id LIMIT 1001`)).rows;
 if(rows.length>1000)throw Error('Deployment position overview exceeds bounded row limit');
 return rows;
}

export function deploymentPosition(row:DeploymentRow){
 const profile=marketProfileSchema.parse(row.profile),p=profile.pool;
 const allocation=allocationSchema.parse(row.allocation),inventory=record(row.inventory),
  provenance=record(row.provenance),economics=record(row.economics),state=markPoolState(provenance);
 const riskIndex=p.quoteToken===0?1:0,reference=riskIndex===0?p.reference0:p.reference1,
  quoteRef=p.quoteToken===0?p.reference0:p.reference1;
 const tokens=[{address:p.token0,symbol:symbol(p.reference0),decimals:p.decimals0,
  allocatedRaw:allocation.token0Raw,amountRaw:decimal(inventory.token0Raw),
  lowerBoundRaw:decimal(record(inventory.knownLowerBound).token0Raw)??
   decimal(record(inventory.retainedPrincipalLowerBound).token0Raw)},
  {address:p.token1,symbol:symbol(p.reference1),decimals:p.decimals1,
   allocatedRaw:allocation.token1Raw,amountRaw:decimal(inventory.token1Raw),
   lowerBoundRaw:decimal(record(inventory.knownLowerBound).token1Raw)??
    decimal(record(inventory.retainedPrincipalLowerBound).token1Raw)}];
 const position=record(inventory.position),liquidity=decimal(position.liquidity),
  tickLower=typeof position.tickLower==='number'?position.tickLower:null,
  tickUpper=typeof position.tickUpper==='number'?position.tickUpper:null,
  hasLiquidity=liquidity!==null&&BigInt(liquidity)>0n;
 const tick=typeof state.tick==='number'?state.tick:null,
  sqrt=decimal(state.sqrtPriceX96),sourceAt=sourceTime(provenance);
 const status=row.lifecycle==='closed'?'closed':row.lifecycle==='closing'?'exiting':
  row.lifecycle==='paused'||row.lifecycle==='blocked'||hasLiquidity&&row.range_state==='outside'?'paused':
  hasLiquidity?'open':'waiting';
 const reasons:string[]=[];
 if(!row.mark_id)reasons.push('first_model_mark_unavailable');
 if(hasLiquidity&&row.range_state==='outside')reasons.push('outside_range_manual_hold');
 if(sourceAt&&Date.now()-Date.parse(sourceAt)>180000)reasons.push('source_stale');
 if(row.lifecycle==='blocked')reasons.push('operation_blocked');
 if(economics.netNav===undefined||economics.netNav===null)reasons.push('net_economics_unavailable');
 const costs=record(provenance.modeledCosts),close=record(costs.closeRetain);
 const lowerBoundValue=principalValue(inventory,economics,provenance,p),
  passiveTokenValue=tokenReferenceValue(allocation.token0Raw,allocation.token1Raw,provenance,p);
 return {id:key(row.mode,row.id),label:`${row.strategy_id==='rangekeeper_v1'?'RK':'Manual'}-${row.id.slice(0,8)}`,
  mode:row.mode,asset:symbol(reference),quote:symbol(quoteRef),fee:p.fee,
  quoteIsToken0:p.quoteToken===0,hasLiquidity,status,history:row.lifecycle==='closed',
  initialQuote:micro(row.initial_value),navQuote:null,holdQuote:null,feesQuote:null,gasQuote:null,
  swapQuote:null,exitEstimateQuote:micro(decimal(close.boundValue)),drawdownPpm:null,
  createdAt:row.created_at.toISOString(),endedAt:row.closed_at?.toISOString()??null,
  sourceAt,heartbeatAt:row.mark_at?.toISOString()??null,reasons,invalidatedAt:null,
  reserveQuote:null,strategy:{...record(row.config),live:row.mode==='live'},
  range:hasLiquidity&&tickLower!==null&&tickUpper!==null?rangePrices(tickLower,tickUpper,p):null,
  priceQuoteX18:sqrt?poolPrice(BigInt(sqrt),p):null,
  referencePriceQuoteX18:referencePrice(provenance,p),
  inventory:{tokens,exposurePpm:null,nativeWei:decimal(inventory.nativeWei),
   principalOnlyValue:micro(lowerBoundValue),passiveTokenValue:micro(passiveTokenValue)},
  tokenId:null,accounting:'unavailable',nextAction:row.lifecycle==='closed'?null:
   'Reference-valued principal is recorded; fee and paid-cost evidence is pending',
  deployment:{campaignId:row.id,chainId:p.chainId,pool:p.pool,strategyId:row.strategy_id,
   lifecycle:row.lifecycle,rangeState:row.range_state,revision:row.current_revision,
   sourceBlock:row.source_block,sourceHash:row.source_hash,
   token0:tokens[0],token1:tokens[1],poolTick:tick,
   lowerBoundValue:micro(lowerBoundValue),passiveTokenValue:micro(passiveTokenValue),
   unavailable:['fee_capture','paid_gas','net_nav','alpha']}};
}

const point=(mark:DeploymentMark,profile:MarketProfile,allocation:{token0Raw:string;token1Raw:string}):PositionPoint=>{
 const inv=record(mark.inventory),prov=record(mark.provenance),economics=record(mark.economics),
  sourceAt=sourceTime(prov),state=markPoolState(prov),sqrt=decimal(state.sqrtPriceX96),
  position=record(inv.position),lower=typeof position.tickLower==='number'?position.tickLower:null,
  upper=typeof position.tickUpper==='number'?position.tickUpper:null,
  tick=typeof state.tick==='number'?state.tick:null;
 if(!sourceAt||!mark.source_block||!mark.source_hash)throw Error('Deployment mark source unavailable');
 const kind=prov.classification,action=kind==='paper_model_provisional'?'enter':
  kind==='paper_model_partial_close'?'exit':'mark';
 if(!['paper_model_provisional','paper_model_principal_valuation','paper_model_partial_close'].includes(String(kind)))
  throw Error('Deployment mark classification unavailable');
 return {id:mark.id,sourceAt,observedAt:mark.at.toISOString(),block:mark.source_block,
  action,status:action==='exit'?'closed':'open',economicNavQuote:null,holdQuote:null,
  priceQuoteX18:sqrt?poolPrice(BigInt(sqrt),profile.pool):null,
  referencePriceQuoteX18:referencePrice(prov,profile.pool),
  exposurePpm:null,inRange:tick!==null&&lower!==null&&upper!==null&&tick>=lower&&tick<upper,
  tickLower:lower,tickUpper:upper,
  rangeQuoteX18:lower!==null&&upper!==null?rangePrices(lower,upper,profile.pool):null,
  tokenBalances:[{address:profile.pool.token0,amountRaw:decimal(inv.token0Raw),
   lowerBoundRaw:decimal(record(inv.knownLowerBound).token0Raw)??
    decimal(record(inv.retainedPrincipalLowerBound).token0Raw)},
   {address:profile.pool.token1,amountRaw:decimal(inv.token1Raw),
    lowerBoundRaw:decimal(record(inv.knownLowerBound).token1Raw)??
     decimal(record(inv.retainedPrincipalLowerBound).token1Raw)}],
  principalOnlyValue:micro(principalValue(inv,economics,prov,profile.pool)),
  passiveTokenValue:micro(tokenReferenceValue(allocation.token0Raw,allocation.token1Raw,prov,profile.pool)),
  feesThisIntervalQuote:null,gasThisMarkQuote:null,swapThisMarkQuote:null,
  swapsThisMark:0,drawdownPpm:null};
};

export async function readDeploymentDetail(db:PoolClient,row:DeploymentRow,hours:number){
 const position=deploymentPosition(row),cutoff=Math.floor((Date.now()-hours*3600000)/1000),
  profile=marketProfileSchema.parse(row.profile),allocation=allocationSchema.parse(row.allocation);
 const marks=(await db.query<DeploymentMark>(`
  SELECT id::text,at,source_block::text,source_hash,inventory,economics,provenance
  FROM deployment_marks WHERE campaign_id=$1 AND
   (provenance->'source'->>'timestamp')::bigint >= $2
  ORDER BY id LIMIT 30001`,[row.id,cutoff])).rows;
 if(marks.length>30000)throw Error('Deployment mark history exceeds bounded window limit');
 const points=marks.map(mark=>point(mark,profile,allocation));
 const baseline=position.initialQuote??'0';
 const window=positionWindow(points,hours,Date.now(),baseline,position.createdAt);
 const performance={...window,rows:window.rows.map(row=>({...row,netPnlQuote:null,alphaQuote:null,
  feeIncomeQuote:null,gasQuote:null,swapCostQuote:null,returnBpsPerHour:null}))};
 const events=(await db.query<{id:string;at:Date;kind:string;status:string;stage:string;reason:string|null;
  source_block:string|null}>(`
  SELECT o.id::text,o.created_at AS at,o.kind,o.status,o.stage,o.reason,
   m.source_block::text FROM deployment_operations o LEFT JOIN LATERAL
    (SELECT source_block FROM deployment_marks WHERE campaign_id=o.campaign_id
     AND provenance->>'operationId'=o.id::text ORDER BY id DESC LIMIT 1) m ON TRUE
  WHERE o.campaign_id=$1 AND o.created_at>=$2 ORDER BY o.created_at DESC,o.id LIMIT 1001`,
  [row.id,new Date(Date.now()-hours*3600000)])).rows;
 if(events.length>1000)throw Error('Deployment activity exceeds bounded window limit');
 const activity=[...events.map(event=>({id:event.id,
  at:event.at.toISOString(),action:event.kind,status:event.status,stage:event.stage,
  reason:event.reason,block:event.source_block,hash:null,
  scope:'deployment_paper_model'})),...marks.filter(mark=>
   record(mark.provenance).classification==='paper_model_principal_valuation').map(mark=>({
   id:`mark-${mark.id}`,at:mark.at.toISOString(),action:'valuation',status:'recorded',
   stage:'principal_only',reason:null,block:mark.source_block,hash:null,
   scope:'deployment_paper_model'}))].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
 return {position,performance,events:activity,
  counts:{recenters:0,recenterAttempts:0,swaps:0},
  limitations:['Principal and idle tokens use recorded independent references. Earned fees, paid gas, native balance, net NAV and alpha are unavailable.',
   'Value and inventory charts leave incomplete series blank. Source gaps are not interpolated.',
   'Provisional fork gas is an estimate, not an expense that was paid.']};
}

export async function readDeploymentByKey(db:PoolClient,keyValue:string):Promise<DeploymentRow|null>{
 const parsed=parseKey(keyValue);if(!parsed)return null;
 const rows=await readDeploymentRows(db);
 return rows.find(row=>row.id===parsed.id&&row.mode===parsed.mode)??null;
}
