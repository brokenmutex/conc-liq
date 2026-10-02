import assert from 'node:assert/strict';
import test from 'node:test';
import {principalAmounts,Q96} from '../src/backtest/principal.js';
import {contentHash} from '../src/deployments/contracts.js';
import {terminalInventoryHash,validateRangeKeeperPaperExitProbeIdentity} from
 '../src/deployments/rangekeeper-paper-gas-sampler.js';
import {replayPaperMint} from '../src/v3/position-math.js';
import type {RangeKeeperLimits} from '../src/strategy/rangekeeper/domain.js';
import type {RangeKeeperPaperLoadedExitContext} from '../src/deployments/rangekeeper-paper-context.js';

const address=(d:string)=>`0x${d.repeat(40)}`;
const hash=(d:string)=>`0x${d.repeat(64)}`;
const source=(block:string,d:string,timestamp:number)=>({block,hash:hash(d),timestamp});

function fixture(){
 const range={tickLower:-60,tickUpper:60},desired=10n**18n,
  minted=replayPaperMint(Q96,range,desired,desired,0n),
  inventory={position:{...range,liquidity:String(minted.liquidity)},idle:{
   token0:String(desired-minted.amount0),token1:String(desired-minted.amount1)}},
  principal=principalAmounts({liquidity:minted.liquidity,...range,sqrtPriceX96:Q96}),
  candidate={kind:'entry' as const,range,swap:null,amount0Desired:desired,amount1Desired:desired,
   amount0Min:minted.amount0,amount1Min:minted.amount1,liquidity:minted.liquidity,
   deployedValue:2n*desired,sourceBlock:100n,sourceHash:hash('1') as `0x${string}`,expiresAt:1_090},
  candidateSource=source('100','1',1_000),frame={source:source('101','2',1_010),tick:0,sqrtPriceX96:Q96,
   poolLiquidity:10n**24n,price0:10n**18n,price1:10n**18n,nativePrice:2_000n*10n**18n,
   referenceEligible:true,referenceReasons:[],referenceProofHash:'d'.repeat(64),referenceProof:{fixture:true}},
  profile={pool:{pool:address('3'),router:address('4'),quoter:address('5'),fee:3_000,
   decimals0:18,decimals1:18,quoteToken:0}},profileHash='e'.repeat(64),
  epoch={epoch:0,markId:'50',markHash:'f'.repeat(64),source:candidateSource,candidate,
   candidateHash:'a'.repeat(64),candidateReferenceProofHash:'d'.repeat(64),inventory,
   kernelSnapshot:{} as any,mintSqrtPriceX96:Q96,fundingBeforeSwap:{token0:String(desired),token1:String(desired)},
   allowancesCleared:false,reference:{price0:10n**18n,price1:10n**18n,nativePrice:2_000n*10n**18n,
    proofHash:'d'.repeat(64),proof:{fixture:true}}},
  openModel={kind:'rangekeeper_paper_open_model',candidateHash:'a'.repeat(64),revision:1},
  context={status:'available',draft:{profile,profileHash},openMarkId:'10',openModel,currentEpoch:epoch,
   previous:{id:'51',source:frame.source,candidateHash:epoch.candidateHash,
    position:inventory.position,idle:inventory.idle},
   kernel:{source:frame.source,inventoryProofHash:'b'.repeat(64),wallet0:BigInt(inventory.idle.token0),
    wallet1:BigInt(inventory.idle.token1),released0:principal.amount0,released1:principal.amount1,
    nativeWei:10n**18n},readGasProfiles:async()=>[],snapshotHash:'c'.repeat(64),actionAvailable:false} as
    unknown as RangeKeeperPaperLoadedExitContext,
  limits={maxSlippageBps:20} as RangeKeeperLimits,
  principalValue=principal.amount0+principal.amount1,
  request={kind:'retain_exit' as const,profile,frame,candidate,candidateSource,
   candidateReferenceProofHash:epoch.candidateReferenceProofHash,candidateHash:epoch.candidateHash,
   openMarkId:context.openMarkId,openModelHash:contentHash(openModel),
   scope:{poolAddress:profile.pool.pool,profileHash,candidateHash:epoch.candidateHash,
    deployedValue:principal.amount0*frame.price0/10n**18n+principal.amount1*frame.price1/10n**18n,
    sharePpm:candidate.liquidity*1_000_000n/
     (frame.poolLiquidity+candidate.liquidity),range,swapKind:'none' as const,
    inventoryHash:terminalInventoryHash(context,candidate,frame)},pathVersion:'retain-v1',
   stages:[],openModelHashPlaceholder:null};
 return {context,limits,request};
}

test('valid terminal retain probe binds serialized bigint candidate and loaded open model before any fork',()=>{
 const {context,limits,request}=fixture();
 assert.doesNotThrow(()=>validateRangeKeeperPaperExitProbeIdentity(request as any,context,limits));
});

test('terminal retain probe rejects candidate and source identity drift',()=>{
 const {context,limits,request}=fixture();
 assert.throws(()=>validateRangeKeeperPaperExitProbeIdentity({...request,candidateHash:'9'.repeat(64)} as any,
  context,limits));
 assert.throws(()=>validateRangeKeeperPaperExitProbeIdentity({...request,candidateSource:source('99','9',990)} as any,
  context,limits));
});
