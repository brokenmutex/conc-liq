import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createRobinhoodClient} from '../../src/client.ts';
import {parseRangeKeeperConfig} from '../../src/strategy/rangekeeper/config.ts';
import {rangeKeeperConfirmedSource} from '../../src/strategy/rangekeeper/source.ts';
import {RangeKeeperChain} from '../../src/strategy/rangekeeper/chain.ts';
import {readCanonicalPaperOpenFrame} from '../../src/deployments/paper-preview.ts';
import {liveSetupEvidenceHash} from '../../src/deployments/rangekeeper-live-setup-simulation.ts';
import {simulateRangeKeeperLiveStage,consumeRangeKeeperLiveStageProof} from '../../src/deployments/rangekeeper-live-stage-proof.ts';
import {contentHash} from '../../src/deployments/contracts.ts';

// Explicit opt-in canonical reads and owned-fork mutations only. This script
// loads public policy metadata; it never loads a private key or live publisher.
try{
 const env=parseEnv(readFileSync(process.argv[2]??'.env','utf8')),rpcUrl=env.RH_ARCHIVE_RPC_URL;
 assert(rpcUrl,'Archive RPC unavailable');
 const config=parseRangeKeeperConfig({...JSON.parse(readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8')),
  signer:null,broadcastEnabled:false});
 const client=createRobinhoodClient(rpcUrl,15000,{retryCount:0,beforeRequest:async()=>{}});
 const source=await rangeKeeperConfirmedSource(client),profile={pool:config.pool,referencePolicy:config.referencePolicy};
 const frame=await readCanonicalPaperOpenFrame(client,profile,{block:String(source.block),hash:source.hash,timestamp:source.timestamp});
 assert(frame.referenceEligible&&frame.price0&&frame.price1&&frame.nativePrice,'Independent references unavailable');
 const before=await new RangeKeeperChain(client,config.pool,config.zeroAllowances).snapshot(source,config.operator,null);
 assert(before.wallet0>=1n&&before.nativeWei>0n,'Fixture needs canonical liquid token/native funds');
 const allocation={campaignId:'fork-campaign',liquidByTokenAddress:{[config.pool.token0.toLowerCase()]:1n,
  [config.pool.token1.toLowerCase()]:0n},nativeSpendWei:before.nativeWei/2n,exitReserveWei:before.nativeWei/4n,nftTokenIds:[]};
 const request={campaignId:allocation.campaignId,allocationId:'fork-allocation',revision:1,stage:'approve-mint-token0',
  buildId:'b'.repeat(64),profileHash:contentHash(profile),allocationHash:liveSetupEvidenceHash(allocation),
  config,source,beforePool:before,allocation,prices:{price0:frame.price0,price1:frame.price1,nativePrice:frame.nativePrice},
  referenceProofHash:frame.referenceProofHash,plan:{kind:'approve',token:0,spender:'positionManager',amount:1n}};
 const capability=await simulateRangeKeeperLiveStage(request,{client,rpcUrl,
  anvilBinary:env.ANVIL_BINARY??'/root/.foundry/bin/anvil'});
 assert.throws(()=>consumeRangeKeeperLiveStageProof(capability,{...request,stage:'wrong-stage'}),/binding changed/);
 const evidence=consumeRangeKeeperLiveStageProof(capability,request);
 assert(BigInt(evidence.gasUsed)>0n&&BigInt(evidence.gasUnitsBound)>=BigInt(evidence.gasUsed));
 assert.equal(evidence.syntheticNativeFunding,true);
 assert.throws(()=>consumeRangeKeeperLiveStageProof(capability,request),/already consumed/);
 console.log(JSON.stringify({event:'owned_live_stage_verified',source:evidence.source,
  gasUsed:evidence.gasUsed,gasUnitsBound:evidence.gasUnitsBound,stageGasWei:evidence.stageGasWei,
  configHash:evidence.configHash,planHash:evidence.planHash,evidenceHash:evidence.evidenceHash,
  callerReportRejected:true,oneUseCapability:true,upstreamMutations:0}));
}catch(error){
 console.error((error instanceof Error?error.message:'Owned stage verification failed')
  .replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,260));process.exitCode=1;
}
