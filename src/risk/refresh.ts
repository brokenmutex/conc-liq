import assert from 'node:assert/strict';
import {createRobinhoodClient} from '../client.js';
import type {IndexerConfig} from '../indexer/config.js';
import type {RiskConfig} from './config.js';
import type {PostgresRpcHealthGate} from '../rpc-health/store.js';
import {PostgresRiskStore,collectAndSaveRiskSnapshot} from './store.js';
import {ViemRiskChainReader} from './reader.js';
import {collectRiskSnapshot} from './runner.js';

/** Bounded, read-only refresh shared by independently running LP workers. */
export async function refreshRiskEvidence(input:{
 config:Pick<IndexerConfig,'rpcUrl'|'rpcTimeoutMs'>;riskConfig:RiskConfig;
 gate:Pick<PostgresRpcHealthGate,'assertBulkAllowed'>;store:PostgresRiskStore;
 riskRunId:string|null;validationOnly:boolean;
}) {
 const {config,riskConfig,gate,store,riskRunId,validationOnly}=input;
 const deadline=Date.now()+20000;let requests=0;
 const client=createRobinhoodClient(config.rpcUrl,Math.min(config.rpcTimeoutMs,5000),{
  beforeRequest:async()=>{
   assert(Date.now()<deadline&&++requests<=256,'Risk retry budget exhausted');
   await gate.assertBulkAllowed();
  },retryCount:0,
 });
 await gate.assertBulkAllowed();const reader=new ViemRiskChainReader(client);
 if(validationOnly&&riskRunId)await store.validateRunCanonical(riskRunId,n=>reader.getBlock(n));
 else {
  const blockNumber=await client.getBlockNumber()-64n;
  assert(blockNumber>=0n,'Risk retry has no confirmed source');
  await collectAndSaveRiskSnapshot({blockNumber,store,
   collect:()=>collectRiskSnapshot({blockNumber,config:{...riskConfig,httpTimeoutMs:5000},reader})});
  await store.validateLatestCanonical(n=>reader.getBlock(n));
 }
}
