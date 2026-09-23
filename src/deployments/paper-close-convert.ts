import type {DeploymentStore} from './store.js';
import {verifyCanonicalPaperCloseConvertAnchors,
 verifyCanonicalPaperCloseConvertQuote} from './paper-close-convert-model.js';
import type {RobinhoodClient} from '../client.js';

/** Internal static/manual adapter. It records a modeled terminal mark only
 * after canonical source checks; it does not accept HTTP commands or schedule
 * worker activity. */
export async function prepareCanonicalPaperCloseConvertMark(store:DeploymentStore,
 client:RobinhoodClient,operationId:string,workerId:string){
 return store.prepareTrustedPaperCloseConvert(operationId,workerId,
  (chainId,sources)=>verifyCanonicalPaperCloseConvertAnchors(client,chainId,sources));
}

/** Finalization is intentionally separate from mark production. The store
 * requires adjacent fee evidence and an already persisted v2 scenario, then
 * replays its exact Quoter input and rechecks anchors before closing. */
export async function completeCanonicalPaperCloseConvert(store:DeploymentStore,
 client:RobinhoodClient,operationId:string,workerId:string){
 return store.completeTrustedPaperCloseConvert(operationId,workerId,
  (chainId,sources)=>verifyCanonicalPaperCloseConvertAnchors(client,chainId,sources),
  async(chainId,model,inputAmountRaw)=>{
   if(chainId!==4663)throw new Error('paper_close_convert_chain_unsupported');
   return verifyCanonicalPaperCloseConvertQuote(client,model,inputAmountRaw);
  });
}
