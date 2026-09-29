// Synthetic persisted paper-accounting fixture for dashboard usability and
// render-scaling harnesses. It creates no campaign or database writes itself;
// callers persist the returned mark fields, then use that mark's ID here.
import {contentHash} from '../../../src/deployments/contracts.ts';
import {paperAccountingSchema,PAPER_ACCOUNTING_POLICY} from '../../../src/deployments/paper-accounting.ts';

const WAD=10n**18n;
const raw=value=>String(value);
const hash64=/^[0-9a-f]{64}$/i;
const sourceHash=/^0x[0-9a-f]{64}$/i;
const nonnegative=value=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value);
const value=(amount,price,decimals)=>BigInt(amount)*BigInt(price)/10n**BigInt(decimals);
const signed=value=>String(value);

/**
 * Return a schema-valid persisted provisional paper-accounting snapshot for a
 * mark. All amounts are raw token units; quote economics are 18-decimal USDG.
 * The default scenario starts with 250 USDG of tokens plus 0.002 native units,
 * records 3 USDG of modeled fees, 1 USDG of modeled gas, and leaves 256 USDG
 * NAV. Prices, balances and mark time can be varied independently by callers.
 */
export function buildDashboardAccountingFixture({campaignId,sourceMarkId,source,profile,
 markIndex=0,allocation={token0Raw:'125000000',token1Raw:'125000000',nativeWei:'2000000000000000'},
 principalToken0Raw=allocation.token0Raw,principalToken1Raw=allocation.token1Raw,
 feeToken0Raw=String(1_000_000n*BigInt(markIndex+1)),feeToken1Raw=String(2_000_000n*BigInt(markIndex+1)),
 nativeWeiRemaining='1500000000000000',cumulativeGasWei='500000000000000',
 intervalFeeAccrualQuote=null,markGasExpenseQuote=null,
 reference={price0:raw(WAD),price1:raw(WAD),nativePrice:raw(2000n*WAD)},
 openModelHash=contentHash({campaignId,profileId:profile?.pool?.pool,fixture:'dashboard-paper-accounting'}),
 markKind=markIndex===0?'open':'valuation'}={}){
 if(!campaignId||!sourceMarkId||!profile)throw Error('dashboard_accounting_fixture_identity_required');
 if(!source||!/^([1-9][0-9]*)$/.test(String(source.block))||!sourceHash.test(source.hash)||
  !Number.isSafeInteger(source.timestamp)||source.timestamp<=0)throw Error('dashboard_accounting_fixture_source_invalid');
 if(!Number.isSafeInteger(markIndex)||markIndex<0)throw Error('dashboard_accounting_fixture_mark_index_invalid');
 const p=profile.pool;
 const inputs=[allocation.token0Raw,allocation.token1Raw,allocation.nativeWei,principalToken0Raw,
  principalToken1Raw,feeToken0Raw,feeToken1Raw,nativeWeiRemaining,cumulativeGasWei,
  reference.price0,reference.price1,reference.nativePrice];
 if(!inputs.every(nonnegative)||!hash64.test(openModelHash)||
  !['open','valuation','close_retain'].includes(markKind))throw Error('dashboard_accounting_fixture_amount_invalid');
 if(BigInt(nativeWeiRemaining)+BigInt(cumulativeGasWei)!==BigInt(allocation.nativeWei))
  throw Error('dashboard_accounting_fixture_native_balance_invalid');
 const fees=[
  value(feeToken0Raw,reference.price0,p.decimals0),
  value(feeToken1Raw,reference.price1,p.decimals1),
 ],feeValue=fees[0]+fees[1];
 const gasValue=value(cumulativeGasWei,reference.nativePrice,18);
 const intervalFees=intervalFeeAccrualQuote===null?raw(feeValue):intervalFeeAccrualQuote;
 const markGas=markGasExpenseQuote===null?raw(gasValue):markGasExpenseQuote;
 const initial=value(allocation.token0Raw,reference.price0,p.decimals0)+
  value(allocation.token1Raw,reference.price1,p.decimals1)+
  value(allocation.nativeWei,reference.nativePrice,18);
 const nav=value(String(BigInt(principalToken0Raw)+BigInt(feeToken0Raw)),reference.price0,p.decimals0)+
  value(String(BigInt(principalToken1Raw)+BigInt(feeToken1Raw)),reference.price1,p.decimals1)+
  value(nativeWeiRemaining,reference.nativePrice,18);
 const passive=value(allocation.token0Raw,reference.price0,p.decimals0)+
  value(allocation.token1Raw,reference.price1,p.decimals1)+
  value(allocation.nativeWei,reference.nativePrice,18);
 const accounting=paperAccountingSchema.parse({policyVersion:PAPER_ACCOUNTING_POLICY,
  classification:'provisional_paper_scenario',campaignId,sourceMarkId:String(sourceMarkId),markKind,
  source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},reference,
  profileHash:contentHash(profile),openModelHash,closeModelHash:null,feeEvidence:null,gasProfiles:[],
  inventory:{token0Raw:String(BigInt(principalToken0Raw)+BigInt(feeToken0Raw)),
   token1Raw:String(BigInt(principalToken1Raw)+BigInt(feeToken1Raw)),nativeWei:nativeWeiRemaining,
   principal0Raw:principalToken0Raw,principal1Raw:principalToken1Raw,
   fee0Raw:feeToken0Raw,fee1Raw:feeToken1Raw,cumulativeGasWei,
   hasLiquidity:BigInt(principalToken0Raw)+BigInt(principalToken1Raw)>0n},
  economics:{initialCapitalQuote:raw(initial),netNavQuote:raw(nav),passiveQuote:raw(passive),
   absolutePnlQuote:signed(nav-initial),alphaQuote:signed(nav-passive),
   cumulativeFeeValueQuote:raw(feeValue),cumulativeGasExpenseQuote:raw(gasValue),
   intervalFeeAccrualQuote:intervalFees,markGasExpenseQuote:markGas},
  flows:[{kind:'modeled_fee',asset:'token0',amountRaw:feeToken0Raw,valueQuote:raw(fees[0])},
   {kind:'modeled_fee',asset:'token1',amountRaw:feeToken1Raw,valueQuote:raw(fees[1])},
   {kind:'modeled_gas',asset:'native',amountRaw:cumulativeGasWei,valueQuote:raw(gasValue)}],
  limitations:['fixed_observed_flow_counterfactual','lower_integer_allocation_point',
   'execution_delay_unmodeled','failure_expense_unmodeled','close_convert_unavailable']});
 const snapshotHash=contentHash(accounting);
 const economics={netNav:raw(nav),principalOnlyValue:raw(
  value(principalToken0Raw,reference.price0,p.decimals0)+
  value(principalToken1Raw,reference.price1,p.decimals1))};
 const provenance={classification:'paper_model_provisional',source:{...source},
  reference:{...reference},poolState:{tick:0,sqrtPriceX96:'79228162514264337593543950336'},
  modeledCosts:{closeRetain:{boundValue:'1200000000000000000'}}};
 return {snapshot:accounting,snapshotHash,economics,provenance,
  expected:{initialCapitalQuote:raw(initial),netNavQuote:raw(nav),absolutePnlQuote:raw(nav-initial),
   cumulativeFeeValueQuote:raw(feeValue),cumulativeGasExpenseQuote:raw(gasValue),passiveQuote:raw(passive)}};
}
