// Size-gradient gas experiment. Holds the canonical source frame, the pool and
// the tick range constant and varies ONLY deployed capital, so the measured
// spread is attributable to size rather than to pool state drifting between
// samples. Read-only: it samples on an owned fork and imports nothing.
import {createRobinhoodClient} from '/root/conc-liq/src/client.js';
import {DeploymentStore} from '/root/conc-liq/src/deployments/store.js';
import {readCanonicalPaperOpenFrame} from '/root/conc-liq/src/deployments/paper-preview.js';
import {buildStaticPaperSetupPreflight} from '/root/conc-liq/src/deployments/paper-setup-preflight.js';
import {verifyCanonicalPaperAnchors} from '/root/conc-liq/src/deployments/paper-canonical-anchors.js';
import {sampleStaticPaperGas} from '/root/conc-liq/src/deployments/paper-gas-sampler.js';
import {contentHash,staticManualParameters} from '/root/conc-liq/src/deployments/contracts.js';
import {randomUUID} from 'node:crypto';

const PROFILE='a8e7096f-17c3-452c-a72f-8fa962e586d2';
const HALF_WIDTH=60;
// 0.1x, 0.4x, 1x, 2x and 4x the 250 USDG the entire existing calibration set
// sits at, so the gradient spans an order of magnitude around the known point.
const CAPITALS=['25000000','100000000','250000000','500000000','1000000000'];

const limitsFor=(capitalQuoteRaw:string)=>{
 const usdX18=BigInt(capitalQuoteRaw)*10n**12n;
 return {maxDeploymentValue:String(usdX18),minDeploymentValue:'1000000000000000000',
  maxExposurePpm:950000,maxLossValue:String(usdX18/20n),maxDrawdownPpm:100000,
  maxActionCost:String(usdX18/20n),maxRollingCost:String(usdX18/10n),
  maxCampaignCost:String(usdX18*15n/100n),exitReserveWei:'1000000000000000',maxSlippageBps:50};
};

async function main(){
 const store=new DeploymentStore(process.env.DATABASE_URL!);
 const client=createRobinhoodClient(process.env.ROBINHOOD_READ_HTTP_URL!,20000);
 await store.assertReady();
 const registered=await store.paperSetupProfile(PROFILE);
 if(!registered)throw Error('profile unavailable');
 const profile:any=registered.profile;

 // One frame for every sample. Pool state, tick and references are therefore
 // identical across the gradient and cannot explain any spread we measure.
 const frame=await readCanonicalPaperOpenFrame(client,profile);
 const pinned=frame.source;
 // Freshness is evaluated against a fixed clock: the experiment deliberately
 // outlives the 180s window and creates no operation, preview or draft.
 const now=()=>pinned.timestamp*1000+30_000;
 console.log(`pinned source block ${pinned.block} tick ${frame.tick} poolLiquidity ${frame.poolLiquidity}`);
 console.log(`price0 ${frame.price0} price1 ${frame.price1}\n`);

 const results:any[]=[];
 for(const capitalQuoteRaw of CAPITALS){
  const limits=limitsFor(capitalQuoteRaw);
  const input:any={profileId:PROFILE,capitalQuoteRaw,halfWidthTicks:HALF_WIDTH,limits};
  const preflight:any=await buildStaticPaperSetupPreflight(input,{
   loadProfile:(id:string)=>store.paperSetupProfile(id),
   readFrame:async()=>frame,
   verifyCanonical:(chainId:number,source:any)=>verifyCanonicalPaperAnchors(client,chainId,[source]),
   readGasProfiles:async()=>[],readGasPrice:async()=>1n,now,
  } as any,pinned as any);
  if(!preflight.requirements){
   console.log(`${capitalQuoteRaw}: no requirements (${JSON.stringify(preflight.missing)})`);continue;
  }
  const config=staticManualParameters.parse({halfWidthTicks:HALF_WIDTH,limits});
  const strategyId='static_manual_v1',strategyVersion='1.0.0',stateSchemaVersion=1;
  const draft:any={id:randomUUID(),revision:1,profile,profileHash:registered.profileHash,
   configHash:contentHash({...config,strategyId,strategyVersion,stateSchemaVersion}),
   strategyId,strategyVersion,stateSchemaVersion,parameters:config,
   allocation:{token0Raw:preflight.requirements.token0Raw,
    token1Raw:preflight.requirements.token1Raw,nativeWei:limits.exitReserveWei}};
  const started=Date.now();
  let report:any;
  try{report=await sampleStaticPaperGas({rpcUrl:process.env.PAPER_FORK_RPC_URL!,draft,frame,
   beforeRead:async()=>{},maxRequests:2400,timeoutMs:240_000});}
  catch(error:any){console.log(`${capitalQuoteRaw}: SAMPLE FAILED ${error?.message}`);continue;}
  const stages:Record<string,number>={};
  for(const s of report.stageProfiles)stages[s.stage]=Number(s.model.gasUnitsExpected);
  const row={capitalUsdg:Number(capitalQuoteRaw)/1e6,
   deployedValue:report.candidate.deployedValue,sharePpm:Number(report.candidate.dilutedSharePpm),
   liquidity:report.candidate.liquidity,
   tickLower:report.candidate.range.tickLower,tickUpper:report.candidate.range.tickUpper,
   stages,total:Object.values(stages).reduce((a,b)=>a+b,0),elapsedMs:Date.now()-started};
  results.push(row);
  console.log(`${row.capitalUsdg} USDG -> share ${row.sharePpm}ppm  total ${row.total}  (${Math.round(row.elapsedMs/1000)}s)`);
 }

 console.log('\n=== size gradient, one pinned frame, identical range ===');
 const ranges=new Set(results.map(r=>`${r.tickLower}/${r.tickUpper}`));
 console.log(`distinct tick ranges across samples: ${ranges.size} (${[...ranges].join(', ')})`);
 const stageNames=Object.keys(results[0]?.stages??{});
 const header=['stage',...results.map(r=>`${r.capitalUsdg}`)].join('\t');
 console.log(header);
 for(const stage of stageNames){
  const vals=results.map(r=>r.stages[stage]);
  const min=Math.min(...vals),max=Math.max(...vals);
  console.log([stage,...vals,`spread ${(100*(max/min-1)).toFixed(1)}%`].join('\t'));
 }
 const totals=results.map(r=>r.total);
 console.log(`TOTAL\t${totals.join('\t')}\tspread ${(100*(Math.max(...totals)/Math.min(...totals)-1)).toFixed(1)}%`);
 console.log('\nJSON:');
 console.log(JSON.stringify({pinnedSource:pinned,tick:frame.tick,results},null,1));
 await store.close();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
