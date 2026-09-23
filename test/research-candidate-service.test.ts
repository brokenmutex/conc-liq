import assert from 'node:assert/strict';
import test from 'node:test';
import {listResearchCandidatePools,loadResearchCandidate} from '../src/research/candidate-service.js';
import type {PostgresResearchCandidateStore,ResearchPoolProfile,VerifiedResearchProfile} from '../src/research/postgres-candidate-store.js';

const id='00000000-0000-4000-8000-000000000001';
const pool:ResearchPoolProfile={id,chainId:4663,pool:'0x8000000000000000000000000000000000000001',
 token0:'0x1000000000000000000000000000000000000001',token1:'0x7000000000000000000000000000000000000001',
 decimals0:6,decimals1:18,quoteToken:0,fee:3000,tickSpacing:60,reference0:'USDG/USD',reference1:'TOKEN/USD',
 verifiedAt:'2026-09-23T10:00:00Z',source:{block:'100',hash:`0x${'1'.repeat(64)}`,timestamp:1_790_146_800},
 draftAvailable:true,deploymentAvailable:false,reason:'fresh_preflight_and_execution_unavailable'};
const request={schemaVersion:1 as const,strategyId:'static_manual_v1' as const,windowSeconds:900,
 capitalQuoteRaw:'100000000',range:{tickLower:-60,tickUpper:60}};
const store=(overrides:Partial<PostgresResearchCandidateStore>={})=>({
 listCurrentProfiles:async()=>({profiles:[pool],hasMore:false}),loadCurrentProfile:async()=>null,...overrides,
}) as PostgresResearchCandidateStore;

test('Research pool listing uses only the checked registry-backed store projection',async()=>{
 const listing=await listResearchCandidatePools(store());
 assert.equal(listing.status,'available');
 assert.deepEqual(listing.profiles,[pool]);
});

test('truncated registry pages stay explicitly unavailable',async()=>{
 const listing=await listResearchCandidatePools(store({listCurrentProfiles:async()=>({profiles:[pool],hasMore:true})}));
 assert.equal(listing.status,'unavailable');
 assert.equal(listing.missing[0],'registry_profile_listing_truncated');
 assert.deepEqual(listing.profiles,[pool]);
});

test('saved profile loading remains read-only while historical candidate evidence is unavailable',async()=>{
 const saved={id,profileHash:'a'.repeat(64),profile:{},evidence:{},registryEnabled:true} as VerifiedResearchProfile;
 const loaded=await loadResearchCandidate({profileId:id,request,store:store({
  loadCurrentProfile:async()=>saved,
 })});
 assert.equal(loaded.status,'unavailable');
 assert.equal(loaded.profileId,null); // malformed profile bytes never cross the service boundary
 assert.equal(loaded.replay.status,'unavailable');
 assert.equal(loaded.replay.draftCreationAvailable,false);
 assert.equal(loaded.draftBindingAvailable,false);
 assert.equal(loaded.missing[0],'registered_market_profile_unavailable');
});

test('a current saved profile still cannot be promoted without historical source and cost readers',async()=>{
 const saved={id,profileHash:'a'.repeat(64),profile:{pool:{}},evidence:{},registryEnabled:true} as VerifiedResearchProfile;
 const loaded=await loadResearchCandidate({profileId:id,request,store:store({loadCurrentProfile:async()=>saved})});
 assert.equal(loaded.status,'unavailable');
 assert.equal(loaded.missing[0],'registered_market_profile_unavailable');
});

test('missing registry profile returns unavailable with no draft binding',async()=>{
 const loaded=await loadResearchCandidate({profileId:id,request,store:store({
  loadCurrentProfile:async()=>null,
 })});
 assert.equal(loaded.status,'unavailable');
 assert.equal(loaded.missing[0],'registered_market_profile_unavailable');
 assert.equal(loaded.draftBindingAvailable,false);
});
