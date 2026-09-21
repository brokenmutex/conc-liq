import assert from 'node:assert/strict';
import {principalAmounts} from '../../backtest/principal.js';
import {canaryExitAbi} from '../../canary-plan/exit.js';
import {strategyBalances} from './funding.js';
import {rawValue} from './planner.js';
import type {RangeKeeperChain} from './chain.js';
import type {RangeKeeperConfig} from './config.js';
import type {RangeKeeperLiveState,RangeKeeperSnapshot} from './live-domain.js';

export async function markRangeKeeper(state:RangeKeeperLiveState,s:RangeKeeperSnapshot,
 chain:RangeKeeperChain,config:RangeKeeperConfig,prices:{price0:bigint;price1:bigint}){
 const p=config.pool;
 const funds=strategyBalances(s,{reserve0:state.reserve0,reserve1:state.reserve1,reserveNativeWei:state.reserveNativeWei});
 let principal0=0n,principal1=0n,uncollected0=0n,uncollected1=0n;
 const position=s.position;
 if(position&&position.liquidity>0n){
  const amounts=principalAmounts({...position,sqrtPriceX96:s.sqrtPriceX96});
  principal0=amounts.amount0;principal1=amounts.amount1;
  const result=await chain.client.simulateContract({account:s.operator,address:p.positionManager,abi:canaryExitAbi,
   functionName:'collect',blockNumber:s.source.block,args:[{tokenId:position.tokenId!,recipient:s.operator,
    amount0Max:(1n<<128n)-1n,amount1Max:(1n<<128n)-1n}]});
  [uncollected0,uncollected1]=result.result;
 }
 const inventory0=funds.amount0+principal0+uncollected0,inventory1=funds.amount1+principal1+uncollected1;
 const nav=rawValue(inventory0,prices.price0,p.decimals0)+rawValue(inventory1,prices.price1,p.decimals1);
 const gasValues=state.costEvents.map(e=>e.gasValue);
 const gasValue=gasValues.every(v=>v!==null)?gasValues.reduce<bigint>((sum,v)=>sum+(v??0n),0n):null;
 const netPnl=gasValue===null?null:nav-state.initialStrategyValue-gasValue;
 const riskValue=p.quoteToken===0?rawValue(inventory1,prices.price1,p.decimals1):rawValue(inventory0,prices.price0,p.decimals0);
 const exposurePpm=nav>0n?Number(riskValue*1_000_000n/nav):0;
 assert(exposurePpm>=0&&exposurePpm<=1_000_000);
 return {source:s.source,phase:state.phase,inventory0,inventory1,principal0,principal1,
  wallet0:funds.amount0,wallet1:funds.amount1,uncollected0,uncollected1,
  grossFee0:state.collectedFee0+uncollected0,grossFee1:state.collectedFee1+uncollected1,
  nav,netPnl,gasSpentWei:state.gasSpentWei,gasValue,exposurePpm,
  activeSeconds:state.activeSeconds,outsideSeconds:state.outsideSeconds,
  recenterCount:state.recenters,economicActions:state.economicActions,
  poolPriceTick:s.tick,activeTokenId:state.activeTokenId};
}
