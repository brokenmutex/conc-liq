import type {Pool} from 'pg';
import type {RobinhoodClient} from '../client.js';
import type {AcceptInput} from './contracts.js';
import type {PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import {readStaticPaperCloseConvertFeeContext} from './paper-close-convert-fee-reader.js';
import {replayEphemeralStaticPaperCloseConvertFees} from './paper-close-convert-ephemeral-fees.js';
import {buildProspectivePaperCloseConvertPrestateGasProfiles} from
 './paper-close-convert-prestate-gas-profiles.js';
import {selectPaperCloseConvertPrestateCostsV1} from './paper-close-convert-prestate-costs.js';
import {samplePaperCloseConvertPrestate} from './paper-close-convert-prestate-sampler.js';
import {verifyPaperStaticCloseConvertTerminalForWorker} from
 './paper-close-convert-terminal-replay-verifier.js';
import type {DeploymentStore} from './store.js';

/** Builds the source-exact V3 verifier callback used by the specialized static
 * command route. Preview and operation acceptance remain separate: this only
 * admits the persisted close operation after replaying every bound source. */
export function createStaticPaperCloseConvertAcceptance(input:{store:DeploymentStore;
 client:RobinhoodClient;indexer:Pool;rpcUrl:string;
 verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>}){
 const {store,client,indexer,rpcUrl,verifyAnchors}=input;
 return async(campaignId:string,request:AcceptInput,actor:string)=>{
  try{
   const assertPreparationLease=async()=>{
    if(!await store.staticPaperCloseConvertPreparationReady(campaignId))
     throw new Error('paper_close_convert_preparation_lease_lost');
   };
   await assertPreparationLease();
   return await store.acceptStaticPaperCloseConvertV3Operation(campaignId,request,actor,
    async model=>{
     await assertPreparationLease();
     const verified=await verifyPaperStaticCloseConvertTerminalForWorker({store,campaignId,
      revision:model.revision,rawModel:model,client,indexer,verifyAnchors,
      replayGasStages:async({model:terminal,frame})=>{
       const context=await readStaticPaperCloseConvertFeeContext({store,campaignId,
        revision:terminal.revision,verifyAnchors}),feeReplay=
        await replayEphemeralStaticPaperCloseConvertFees({context,client,indexer,frame}),
        report=await samplePaperCloseConvertPrestate({rpcUrl,
         openModel:context.state.openModel,openMarkId:context.state.openMarkId,
         profile:context.state.profile,frame,previous:{markId:context.state.previous.markId,
          source:context.state.previous.source},route:terminal.conversionRoute,
         feeCarry:feeReplay.feeCarry,feeReplay,
         verifyPersistedContext:()=>context.verifyPersistedContext({state:context.state,
          feeCarry:context.feeCarry,feeEvidence:context.feeEvidence,source:frame.source}),
         verifyAnchors,beforeRead:async()=>{},deterministicClock:true,
         sampledAt:terminal.prestateReport.gasStages[0]!.source.estimatedAt}),
        sizeBand=buildProspectivePaperCloseConvertPrestateGasProfiles(report).sizeBand,
        rows=await store.staticPaperCloseConvertPrestateGasProfiles({
         chainId:context.state.profile.pool.chainId,
         poolAddress:context.state.profile.pool.pool,sizeBand,reportHash:report.reportHash}),
        costs=selectPaperCloseConvertPrestateCostsV1({report,rows,
         gasPriceWei:BigInt(terminal.costs.gasPriceWei),
         gasPriceObservedAt:terminal.costs.gasPriceObservedAt});
       return {reportHash:report.reportHash,scopeHash:costs.scopeHash,
        sequenceHash:costs.sequenceHash,source:frame.source,costs,
        stages:costs.stages.map((stage,stageIndex)=>({stage:stage.stage,
         profileId:stage.profileId,version:stage.version,callHash:stage.source.callHash,
         sourceHash:stage.sourceHash,expectedGasUnits:stage.expectedGasUnits,
         boundGasUnits:stage.boundGasUnits,scopeHash:stage.scopeHash,
         sequenceHash:stage.sequenceHash,stageIndex,stageCount:costs.stages.length,
         source:stage.source}))};
      }});
     await assertPreparationLease();return verified;
    },verifyAnchors);
  }finally{
   // Acceptance callback completion consumes this exact review lease. A lost
   // response is reconciled by operation idempotency before this gate on retry.
   await store.releaseStaticPaperCloseConvertPreparationLease(campaignId).catch(()=>{});
  }
 };
}
