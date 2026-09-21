import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {getAddress,isAddress,zeroAddress,type Hex} from 'viem';
import {z} from 'zod';
import type {RangeKeeperLimits,RangeKeeperPool,RangeKeeperState} from './domain.js';

const address=z.string().refine(isAddress).transform(value=>getAddress(value));
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value=>value as Hex);
const positive=z.string().regex(/^[1-9][0-9]*$/).transform(BigInt);
const ppm=z.number().int().min(0).max(1_000_000);
const profileSchema=z.object({
 chainId:z.number().int().positive(),factory:address,pool:address,token0:address,token1:address,
 quoteToken:z.union([z.literal(0),z.literal(1)]),decimals0:z.number().int().min(0).max(36),decimals1:z.number().int().min(0).max(36),
 fee:z.number().int().positive(),tickSpacing:z.number().int().positive(),positionManager:address,router:address,quoter:address,
 poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:hash,quoterCodeHash:hash,
 reference0:z.string().min(1),reference1:z.string().min(1),nativeReference:z.string().min(1),numeraire:z.string().min(1),
}).strict();
const limitsSchema=z.object({
 fullWidthSpacings:z.number().int().positive().max(200).refine(n=>n%2===0),
 maxDeploymentValue:positive,minDeploymentPpm:ppm.refine(n=>n>0),
 maxSwapInputValue:positive,maxSwapInputPpm:ppm.refine(n=>n>0),maxSwapShortfallValue:positive,
 maxSlippageBps:z.number().int().positive().max(50),
 maxActionCost:positive,maxRollingCost:positive,maxCampaignCost:positive,
 maxExposurePpm:ppm.refine(n=>n>0),maxLossValue:positive,maxDrawdownPpm:ppm.refine(n=>n>0),
 maxRecenters:z.number().int().positive(),maxLiquiditySharePpm:ppm.refine(n=>n>0),
 maxObservationGapSeconds:z.number().int().min(30).max(90),exitReserveWei:positive,
}).strict();
export const rangeKeeperConfigSchema=z.object({
 schemaVersion:z.literal(1),policyId:z.literal('rangekeeper_v1'),strategyVersion:z.literal('1.0.0'),
 broadcastEnabled:z.boolean(),operator:address.nullable(),pool:profileSchema,limits:limitsSchema,
 signer:z.object({kind:z.literal('env_file'),reference:z.string().min(1),variable:z.string().regex(/^[A-Z][A-Z0-9_]*$/)}).strict().nullable().default(null),
 walletCode:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('eoa')}).strict(),
  z.object({kind:z.literal('eip7702'),delegate:address,delegateCodeHash:hash}).strict(),
 ]).default({kind:'eoa'}),
 zeroAllowances:z.array(z.object({token:address,spender:address}).strict()).default([]),
 legacyRetiredTokenIds:z.array(z.string().regex(/^[1-9][0-9]*$/)).default([]),
 campaignScope:z.object({maxDurationSeconds:z.number().int().positive().max(86400),
  maxEconomicActions:z.number().int().positive().max(10)}).default({maxDurationSeconds:43200,maxEconomicActions:2}),
 referencePolicy:z.object({
  token0:z.object({kind:z.enum(['stablecoin','stock_token']),maxAgeSeconds:z.number().int().positive(),
   session:z.enum(['verified_24_7','latest_equity_session']),corporateAction:z.literal('reject_pending')}).strict(),
  token1:z.object({kind:z.enum(['stablecoin','stock_token']),maxAgeSeconds:z.number().int().positive(),
   session:z.enum(['verified_24_7','latest_equity_session']),corporateAction:z.literal('reject_pending')}).strict(),
  nativeMaxAgeSeconds:z.number().int().positive(),maxPoolDeviationPpm:ppm.refine(n=>n>0),
 }).strict(),
 campaignValue:positive,strategyFundingValue:positive,nativeFundingValue:positive,
}).strict().superRefine((p,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(p.pool.token0.toLowerCase()>=p.pool.token1.toLowerCase())fail('Pool tokens must be in canonical address order');
 if([p.pool.factory,p.pool.pool,p.pool.token0,p.pool.token1,p.pool.positionManager,p.pool.router,p.pool.quoter].some(a=>a===zeroAddress))fail('Zero contract address');
 if(p.pool.reference0===p.pool.reference1)fail('Token references must be distinct');
 if(p.strategyFundingValue+p.nativeFundingValue>p.campaignValue)fail('Funding exceeds aggregate campaign cap');
 if(p.limits.maxDeploymentValue>p.strategyFundingValue)fail('Deployment exceeds strategy allocation');
 if(p.limits.maxSwapInputValue>p.strategyFundingValue)fail('Swap input exceeds strategy allocation');
 if(p.limits.maxRollingCost>p.limits.maxCampaignCost)fail('Rolling cost exceeds campaign cost');
 if(new Set(p.legacyRetiredTokenIds).size!==p.legacyRetiredTokenIds.length)fail('Repeated legacy NFT ID');
 if(new Set(p.zeroAllowances.map(a=>`${a.token.toLowerCase()}:${a.spender.toLowerCase()}`)).size!==p.zeroAllowances.length)
  fail('Repeated guarded allowance pair');
 if(p.zeroAllowances.some(a=>a.token.toLowerCase()!==p.pool.token0.toLowerCase()&&a.token.toLowerCase()!==p.pool.token1.toLowerCase()))
  fail('Guarded allowance token is outside the configured pool');
 if(p.legacyRetiredTokenIds.length&&!p.operator)fail('Legacy NFT proof requires a selected operator');
 if(p.broadcastEnabled&&(!p.operator||!p.signer))fail('Live execution requires a frozen operator and signer reference');
});
export type RangeKeeperConfig=z.infer<typeof rangeKeeperConfigSchema>;

export function parseRangeKeeperConfig(raw:unknown,options:{allowBroadcast?:boolean}={}):RangeKeeperConfig {
 const config=rangeKeeperConfigSchema.parse(raw);
 assert(!config.broadcastEnabled||options.allowBroadcast===true,
  'RangeKeeper broadcast requires the explicit live-controller parser');
 return config;
}
export function rangeKeeperConfigHash(config:RangeKeeperConfig):Hex {
 return `0x${createHash('sha256').update(JSON.stringify(config,(_,v)=>typeof v==='bigint'?String(v):v)).digest('hex')}`;
}
export function initialRangeKeeperState(config:RangeKeeperConfig,buildId:string):RangeKeeperState {
 assert(buildId.length>0,'Build ID required');
 return {schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',configHash:rangeKeeperConfigHash(config),buildId,lastEligible:null,exit:null,confirmation:null};
}
export function assertRangeKeeperState(state:RangeKeeperState,config:RangeKeeperConfig,buildId:string){
 assert.equal(state.schemaVersion,1);assert.equal(state.policyId,'rangekeeper_v1');assert.equal(state.strategyVersion,'1.0.0');
 assert.equal(state.configHash,rangeKeeperConfigHash(config),'Campaign configuration changed');assert.equal(state.buildId,buildId,'Campaign build changed');
}
export function rangeKeeperPool(config:RangeKeeperConfig):RangeKeeperPool{return config.pool;}
export function rangeKeeperLimits(config:RangeKeeperConfig):RangeKeeperLimits{return config.limits;}
