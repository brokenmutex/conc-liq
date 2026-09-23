import pg from 'pg';
import {contentHash} from '../deployments/contracts.js';
import {marketProfileEvidenceSchema,marketProfileSchema,referenceProofHash} from '../deployments/market-profile.js';

const {Pool}=pg;
export interface ResearchPoolProfile {id:string;chainId:4663;pool:string;token0:string;token1:string;
 decimals0:number;decimals1:number;quoteToken:0|1;fee:number;tickSpacing:number;reference0:string;reference1:string;
 verifiedAt:string;source:{block:string;hash:string;timestamp:number};draftAvailable:true;deploymentAvailable:false;
 reason:'fresh_preflight_and_execution_unavailable'}
export interface ResearchPoolProfilePage {profiles:ResearchPoolProfile[];hasMore:boolean}
export interface VerifiedResearchProfile {id:string;profileHash:string;profile:unknown;evidence:unknown;registryEnabled:true}
type ProfileIdentity={chain_id:number;pool_address:string;token0_address:string;token1_address:string;
 token0_decimals:number;token1_decimals:number;quote_token:number;fee:number;tick_spacing:number;
 profile:unknown;evidence:unknown;profile_hash:string};
type ProfileRow=ProfileIdentity & {id:string;verified_at:Date;retired_at:Date|null;indexed:boolean};
type CurrentProfileRow=Omit<ProfileRow,'verified_at'|'indexed'> & {registry_enabled:boolean};

function checkedProfile(row:ProfileIdentity):{profile:ReturnType<typeof marketProfileSchema.parse>;
 evidence:ReturnType<typeof marketProfileEvidenceSchema.parse>}|null{
 const profile=marketProfileSchema.safeParse(row.profile),evidence=marketProfileEvidenceSchema.safeParse(row.evidence);
 if(!profile.success||!evidence.success)return null;
 const p=profile.data.pool;
 if(p.chainId!==row.chain_id||p.pool.toLowerCase()!==row.pool_address.toLowerCase()||
  p.token0.toLowerCase()!==row.token0_address.toLowerCase()||p.token1.toLowerCase()!==row.token1_address.toLowerCase()||
  p.decimals0!==row.token0_decimals||p.decimals1!==row.token1_decimals||p.quoteToken!==row.quote_token||
  p.fee!==row.fee||p.tickSpacing!==row.tick_spacing||
  contentHash(profile.data)!==row.profile_hash||
  referenceProofHash(evidence.data.referenceProof)!==evidence.data.references.proofHash||
  !(['poolCodeHash','token0CodeHash','token1CodeHash','managerCodeHash','quoterCodeHash'] as const)
   .every(key=>profile.data.pool[key].toLowerCase()===evidence.data.contractHashes[key].toLowerCase()))return null;
 return {profile:profile.data,evidence:evidence.data};
}

/** Read-only Research access to saved profiles and the indexer registry.
 * Candidate frames and economics remain unavailable until separate historical
 * evidence queries can prove exact source/reference/fee/cost coverage. */
export class PostgresResearchCandidateStore {
 private readonly pool:InstanceType<typeof Pool>;
 constructor(connectionString:string){this.pool=new Pool({connectionString,max:1});}
 async close(){await this.pool.end();}

 async listCurrentProfiles():Promise<ResearchPoolProfilePage>{
  const rows=(await this.pool.query<ProfileRow>(`SELECT p.id,p.chain_id,p.pool_address,p.token0_address,p.token1_address,
   p.token0_decimals,p.token1_decimals,p.quote_token,p.fee,p.tick_spacing,p.profile,p.evidence,p.profile_hash,
   p.verified_at,p.retired_at,true AS indexed
   FROM deployment_market_profiles p
   WHERE p.retired_at IS NULL AND EXISTS(
    SELECT 1 FROM indexer_pools i WHERE i.stream_key=p.evidence->>'streamKey'
     AND lower(i.pool_address)=lower(p.pool_address) AND i.chain_id=p.chain_id AND i.fee=p.fee
     AND i.enabled AND i.target_set_hash=(p.evidence->>'indexerTargetSetHash')
     AND lower(i.rwa_address)=lower(CASE WHEN p.quote_token=0 THEN p.token1_address ELSE p.token0_address END))
   ORDER BY p.verified_at DESC,p.id LIMIT 101`)).rows;
  const result:ResearchPoolProfile[]=[];
  const hasMore=rows.length>100;
  for(const row of rows.slice(0,100)){
   const checked=checkedProfile(row);if(!checked)continue;
   const p=checked.profile.pool,s=checked.evidence.source;
   result.push({id:row.id,chainId:4663,pool:p.pool,token0:p.token0,token1:p.token1,
    decimals0:p.decimals0,decimals1:p.decimals1,quoteToken:p.quoteToken,fee:p.fee,tickSpacing:p.tickSpacing,
    reference0:p.reference0,reference1:p.reference1,verifiedAt:row.verified_at.toISOString(),source:s,
    draftAvailable:true,deploymentAvailable:false,reason:'fresh_preflight_and_execution_unavailable'});
  }
  return {profiles:result,hasMore};
 }

 async loadCurrentProfile(id:string):Promise<VerifiedResearchProfile|null>{
  const row=(await this.pool.query<CurrentProfileRow>(`SELECT p.id,p.chain_id,p.pool_address,p.token0_address,p.token1_address,
   p.token0_decimals,p.token1_decimals,p.quote_token,p.fee,p.tick_spacing,p.profile,p.evidence,p.profile_hash,
   p.retired_at,COALESCE(i.enabled AND i.target_set_hash=(p.evidence->>'indexerTargetSetHash')
    AND lower(i.rwa_address)=lower(CASE WHEN p.quote_token=0 THEN p.token1_address ELSE p.token0_address END),false)
    AS registry_enabled
   FROM deployment_market_profiles p LEFT JOIN indexer_pools i
    ON i.stream_key=p.evidence->>'streamKey' AND lower(i.pool_address)=lower(p.pool_address)
     AND i.chain_id=p.chain_id AND i.fee=p.fee
   WHERE p.id=$1 LIMIT 1`,[id])).rows[0];
  if(!row||row.retired_at||!row.registry_enabled)return null;
  const checked=checkedProfile(row);
  if(!checked)return null;
  return {id:row.id,profileHash:row.profile_hash,profile:checked.profile,evidence:checked.evidence,registryEnabled:true};
 }
}
