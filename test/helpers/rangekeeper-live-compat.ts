import {rangeKeeperConfigHash} from '../../src/strategy/rangekeeper/config.js';

/** Persisted-identity fields a build-compatible RangeKeeper live campaign fixture must carry: a config that hashes to the
 * campaign's config hash, the strategy/state versions and a policy state that parses under the current source tree. */
export function compatibleCampaignIdentity(config:Record<string,unknown>,openBuildId:string,policyOverrides:Record<string,unknown>={}){
 const frozen={strategyVersion:'1.0.0',...config} as any,configHash=rangeKeeperConfigHash(frozen);
 return {config:frozen,configHash,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
  policy:{schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',configHash,buildId:openBuildId,
   lastEligible:null,exit:null,confirmation:null,...policyOverrides} as any};
}
