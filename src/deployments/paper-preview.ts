import {poolAbi} from '../abi.js';
import type {RobinhoodClient} from '../client.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {readRangeKeeperReferences} from '../strategy/rangekeeper/reference.js';
import {rangeKeeperConfirmedSource} from '../strategy/rangekeeper/source.js';
import {alignManualRange,decideStaticManual} from '../strategy/static-manual/planner.js';
import {contentHash,staticParameters} from './contracts.js';
import {referenceProofHash,type MarketProfile} from './market-profile.js';
import type {DeploymentStore} from './store.js';

export interface PaperOpenFrame {
 source:{block:string;hash:string;timestamp:number};
 tick:number;sqrtPriceX96:bigint;poolLiquidity:bigint;
 price0:bigint|null;price1:bigint|null;nativePrice:bigint|null;
 referenceEligible:boolean;referenceReasons:string[];referenceProofHash:string;
 referenceProof?:Record<string,unknown>;
}
export type PaperDraft=Awaited<ReturnType<DeploymentStore['paperDraft']>>;
export type PaperPreviewDraft=Pick<PaperDraft,'id'|'revision'|'profile'|'profileHash'|
 'configHash'|'strategyId'|'parameters'|'allocation'>;

/** Reads a confirmed pool state and independent references at one source.
 * The chain adapter has no signer or broadcast method. */
export async function readCanonicalPaperOpenFrame(client:RobinhoodClient,profile:MarketProfile):Promise<PaperOpenFrame>{
 const source=await rangeKeeperConfirmedSource(client),p=profile.pool;
 const chain=new RangeKeeperChain(client,p);
 await chain.verify(source);
 const [slot,poolLiquidity,references]=await Promise.all([
  client.readContract({address:p.pool,abi:poolAbi,functionName:'slot0',blockNumber:source.block}),
  client.readContract({address:p.pool,abi:poolAbi,functionName:'liquidity',blockNumber:source.block}),
  readRangeKeeperReferences(client,source,profile),
 ]);
 const end=await client.getBlock({blockNumber:source.block});
 if(end.hash.toLowerCase()!==source.hash.toLowerCase())throw Error('paper_source_reorged');
 const proof=JSON.parse(JSON.stringify(references.proof,(_,value)=>typeof value==='bigint'?String(value):value)) as Record<string,unknown>;
 return {source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
  tick:slot[1],sqrtPriceX96:slot[0],poolLiquidity,
  price0:references.price0,price1:references.price1,nativePrice:references.nativePrice,
  referenceEligible:references.eligible,referenceReasons:references.reasons,
  referenceProofHash:referenceProofHash(proof),referenceProof:proof};
}

/** A later paper mark must still descend from the stored canonical anchor.
 * Check the previous hash both before and after reading the new source. */
export async function readCanonicalPaperNextFrame(client:RobinhoodClient,profile:MarketProfile,
 previous:{sourceBlock:string;sourceHash:string}):Promise<PaperOpenFrame>{
 const check=async()=>{
  const block=await client.getBlock({blockNumber:BigInt(previous.sourceBlock)});
  if(block.hash.toLowerCase()!==previous.sourceHash.toLowerCase())throw Error('paper_prior_source_reorged');
 };
 await check();
 const frame=await readCanonicalPaperOpenFrame(client,profile);
 if(BigInt(frame.source.block)<=BigInt(previous.sourceBlock))throw Error('paper_next_source_not_later');
 await check();
 return frame;
}

/** A read-only paper candidate. It deliberately has no preview ID or operation
 * digest until a scoped execution-cost profile and paper fill adapter exist. */
export function buildIndicativePaperOpenPreview(draft:PaperPreviewDraft,frame:PaperOpenFrame,now=Date.now()){
 const p=draft.profile.pool;
 const base={kind:'open' as const,mode:'paper' as const,campaignId:draft.id,revision:draft.revision,
  strategyId:draft.strategyId,profileHash:draft.profileHash,configHash:draft.configHash,
  source:frame.source,referenceProofHash:frame.referenceProofHash,
  expiresAt:new Date(Math.min((frame.source.timestamp+180)*1000,now+120000)).toISOString(),
  actionAvailable:false,economics:null as null,
  admissionReasons:['paper_execution_adapter_unavailable','scoped_cost_profile_unavailable']};
 const unavailable=(reason:string)=>({...base,status:'unavailable' as const,reason,candidate:null});
 const age=Math.floor(now/1000)-frame.source.timestamp;
 if(age<0||age>180)return unavailable('source_stale');
 if(!frame.referenceEligible||!frame.price0||!frame.price1||!frame.nativePrice)
  return unavailable(`independent_reference_unavailable:${frame.referenceReasons.join(',')}`);
 if(frame.sqrtPriceX96<=0n)return unavailable('pool_price_unavailable');
 const poolPrice1=((1n<<192n)*10n**BigInt(p.decimals1)*frame.price0)/
  (frame.sqrtPriceX96*frame.sqrtPriceX96*10n**BigInt(p.decimals0));
 const deviation=poolPrice1>frame.price1?poolPrice1-frame.price1:frame.price1-poolPrice1;
 if(deviation*1_000_000n>frame.price1*BigInt(draft.profile.referencePolicy.maxPoolDeviationPpm))
  return unavailable('independent_price_band');
 if(draft.strategyId==='rangekeeper_v1')return unavailable('rangekeeper_paper_confirmation_and_cost_unavailable');
 const config=staticParameters.parse(draft.parameters);
 if(!config.limits)return unavailable('manual_limits_missing');
 let range;
 try{range=alignManualRange(config.tickLower,config.tickUpper,p.tickSpacing);}
 catch{return unavailable('manual_range_invalid_on_pool_grid');}
 const decision=decideStaticManual({continuity:'canonical',tick:frame.tick,sqrtPriceX96:frame.sqrtPriceX96,
  amount0:BigInt(draft.allocation.token0Raw),amount1:BigInt(draft.allocation.token1Raw),
  price0:frame.price0,price1:frame.price1,decimals0:p.decimals0,decimals1:p.decimals1,
  quoteToken:p.quoteToken,position:null,pending:false,entryAllowed:true,safetyExitRequired:false,
  expiryReached:config.limits.expiryAt?Date.parse(config.limits.expiryAt)<=now:false},
  range,{maxDeploymentValue:BigInt(config.limits.maxDeploymentValue),
   minDeploymentValue:BigInt(config.limits.minDeploymentValue),maxExposurePpm:config.limits.maxExposurePpm});
 if(decision.action!=='entry')return unavailable(decision.reason);
 const c=decision.candidate;
 const candidate={range,liquidity:String(c.liquidity),amount0Desired:String(c.amount0Desired),
  amount1Desired:String(c.amount1Desired),amount0Minted:String(c.amount0Minted),amount1Minted:String(c.amount1Minted),
  idle0:String(c.idle0),idle1:String(c.idle1),deployedValue:String(c.deployedValue),
  exposurePpm:String(c.exposurePpm),feeEarningAtEntry:c.feeEarningAtEntry,oneSided:c.oneSided,
  dilutedSharePpm:String(c.liquidity*1_000_000n/(frame.poolLiquidity+c.liquidity))};
 return {...base,status:'indicative' as const,reason:'manual_no_swap_candidate',candidate,
  candidateHash:contentHash({campaignId:draft.id,revision:draft.revision,profileHash:draft.profileHash,
   configHash:draft.configHash,source:frame.source,referenceProofHash:frame.referenceProofHash,candidate})};
}
