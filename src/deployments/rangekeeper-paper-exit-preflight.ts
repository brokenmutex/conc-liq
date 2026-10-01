import {DeploymentConflict,type DeploymentStore} from './store.js';
import {contentHash,rangeKeeperParameters} from './contracts.js';
import {referenceProofHash} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {RangeKeeperPaperDraft} from './rangekeeper-paper-open-model.js';
import {rangeKeeperPaperConvertQuoteContent,rangeKeeperPaperConvertQuoteHash,
 rangeKeeperPaperConvertQuoteSchema,type RangeKeeperPaperExitModel} from './rangekeeper-paper-exit-model.js';

type AnchorVerifier=(chainId:number,sources:readonly PaperOpenFrame['source'][])=>Promise<void>;

/** The window a RangeKeeper exit preview is trusted for. Mirrors
 * rangekeeper-paper-open-preflight.ts exactly: `recordPreview` refuses
 * anything beyond 120s, and the canonical source is itself only accepted for
 * 180s, so whichever bound is tighter governs. */
const PREVIEW_WINDOW_MS=120_000;
const SOURCE_WINDOW_MS=180_000;
const rawId=/^(0|[1-9][0-9]*)$/;
const hash64=/^[0-9a-f]{64}$/;

/** Persists the trusted `deployment_previews` row of kind `close_retain` or
 * `close_convert` that a RangeKeeper exit acceptance needs and that nothing
 * previously wrote. Mirrors `persistTrustedRangeKeeperPaperOpenPreview`: it
 * refuses to persist anything an acceptance or the worker would later reject,
 * so a rejected preview fails here with a precise reason instead of as an
 * opaque failure once accepted.
 *
 * The caller supplies `kind` explicitly (rather than it being derived solely
 * from `model.exitKind`) because one function serves both exit kinds and the
 * two must be checked against each other, not merely trusted to agree.
 *
 * For a convert exit, `proposal.rangekeeperPaperConvertQuote` is also
 * persisted — this is what the convert-exit gas sampler later reads instead
 * of trusting anything self-reported. Its `quoteHash` is independently
 * recomputed here, over the model's own conversion fields, before it is
 * ever written. */
export async function persistTrustedRangeKeeperPaperExitPreview(input:{store:DeploymentStore;
 draft:RangeKeeperPaperDraft;model:RangeKeeperPaperExitModel;kind:'close_retain'|'close_convert';
 verifyAnchors:AnchorVerifier;now?:number}){
 const {store,draft,model,kind}=input,now=input.now??Date.now();
 if(draft.strategyId!=='rangekeeper_v1')
  throw new DeploymentConflict('rangekeeper_exit_preview_strategy_unavailable');
 const expectedExitKind=kind==='close_retain'?'retain':'convert';
 if(model.exitKind!==expectedExitKind)
  throw new DeploymentConflict('rangekeeper_exit_preview_kind_mismatch');
 // Only a complete, costed, kernel-indicative model is worth binding an
 // operation to. A blocked model has an explicit reason the operator should
 // see instead, and persisting it would let acceptance bind evidence the
 // exit builder itself refused.
 if(model.status!=='indicative'||!model.costs||model.costs.status!=='provisional')
  throw new DeploymentConflict('rangekeeper_exit_costed_model_unavailable');
 if(model.campaignId!==draft.id||model.revision!==draft.revision||
  model.draftConfigHash!==draft.configHash||model.profileHash!==draft.profileHash)
  throw new DeploymentConflict('rangekeeper_exit_preview_draft_binding_invalid');
 if(contentHash(draft.profile)!==draft.profileHash)
  throw new DeploymentConflict('rangekeeper_exit_preview_profile_hash_mismatch');
 // These three identities are what the open mark, the booked worker branch,
 // and the convert gas sampler all key off of. A blank or malformed one would
 // bind a preview nothing downstream could actually resolve.
 if(!rawId.test(model.openMarkId)||!hash64.test(model.openModelHash)||!hash64.test(model.candidateHash))
  throw new DeploymentConflict('rangekeeper_exit_preview_mark_identity_unavailable');
 if(!model.reference.proof||Object.keys(model.reference.proof).length===0||
  referenceProofHash(model.reference.proof)!==model.reference.proofHash)
  throw new DeploymentConflict('rangekeeper_exit_preview_reference_unavailable');
 const sourceAgeMs=now-model.source.timestamp*1000;
 if(!Number.isSafeInteger(model.source.timestamp)||sourceAgeMs<0||sourceAgeMs>SOURCE_WINDOW_MS)
  throw new DeploymentConflict('rangekeeper_exit_preview_source_stale');
 let convertQuote:ReturnType<typeof rangeKeeperPaperConvertQuoteSchema.parse>|null=null;
 if(model.exitKind==='convert'){
  if(!model.conversion)
   throw new DeploymentConflict('rangekeeper_exit_preview_convert_quote_unavailable');
  let parsedQuote;
  try{parsedQuote=rangeKeeperPaperConvertQuoteSchema.parse(model.conversion);}
  catch{throw new DeploymentConflict('rangekeeper_exit_preview_convert_quote_unavailable');}
  // The slippage floor that produced this quote is policy, not something the
  // quote carries itself — pull it straight from the draft's own parameters,
  // the same source the exit model builder priced it against.
  const parsedParams=rangeKeeperParameters.safeParse(draft.parameters);
  if(!parsedParams.success||!parsedParams.data.limits)
   throw new DeploymentConflict('rangekeeper_exit_preview_convert_quote_unavailable');
  const p=draft.profile.pool;
  const content=rangeKeeperPaperConvertQuoteContent({candidateHash:model.candidateHash,source:model.source,
   pool:{pool:p.pool,router:p.router,quoter:p.quoter,fee:p.fee},inputToken:parsedQuote.inputToken,
   outputToken:parsedQuote.outputToken,inputAmount:BigInt(parsedQuote.inputAmount),
   expectedOutput:BigInt(parsedQuote.expectedOutput),minimumOutput:BigInt(parsedQuote.minimumOutput),
   feeValue:BigInt(parsedQuote.feeValue),shortfallValue:BigInt(parsedQuote.shortfallValue),
   maxSlippageBps:parsedParams.data.limits.maxSlippageBps});
  // Never trust the quote's own self-reported `quoteHash`: recompute it from
  // the pinned candidate/source/pool and the quote's own priced fields, and
  // only persist on an exact match.
  if(rangeKeeperPaperConvertQuoteHash(content)!==parsedQuote.quoteHash)
   throw new DeploymentConflict('rangekeeper_exit_preview_convert_quote_hash_mismatch');
  convertQuote=parsedQuote;
 }
 // The preview can never outlive its own canonical source, whichever bound
 // bites first. Both are checked again on read, so a clock skew here fails
 // closed.
 const expiresAt=new Date(Math.min(model.source.timestamp*1000+SOURCE_WINDOW_MS,
  now+PREVIEW_WINDOW_MS));
 if(expiresAt.getTime()<=now)
  throw new DeploymentConflict('rangekeeper_exit_preview_expired');
 try{await input.verifyAnchors(draft.profile.pool.chainId,[model.source]);}
 catch{throw new DeploymentConflict('rangekeeper_exit_preview_source_not_canonical');}
 const proposal:Record<string,unknown>={rangekeeperPaperExitModel:model,
  rangekeeperPaperExitModelHash:contentHash(model)};
 if(convertQuote)proposal.rangekeeperPaperConvertQuote=convertQuote;
 const saved=await store.recordPreview({campaignId:draft.id,expectedRevision:draft.revision,kind,
  request:{kind,strategyId:'rangekeeper_v1',profileHash:draft.profileHash,configHash:draft.configHash,
   openMarkId:model.openMarkId,candidateHash:model.candidateHash,exitKind:model.exitKind},
  proposal,
  evidence:{verificationClass:'canonical_rangekeeper_paper_exit_model_v1',
   classification:'paper_model_provisional',source:model.source,profileHash:model.profileHash,
   referenceProofHash:model.reference.proofHash,inventoryHash:model.inventoryProofHash,
   costEvidenceClass:'fork_estimated',paidCostsAvailable:false,feeAccrualAvailable:false},
  expiresAt});
 return {...saved,modelHash:contentHash(model),expectedRevision:draft.revision};
}
