import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseAbi,decodeEventLog,keccak256,toEventSelector} from 'viem';
import {createRobinhoodClient} from '../src/client.ts';
import {loadHistoryConfig,createHistoryFetch,HISTORY_TRANSPORT_URL} from '../src/history/client.ts';
import {ViemRiskChainReader} from '../src/risk/reader.ts';
import {aggregatorV3Abi} from '../src/risk/abi.ts';
import {historicalReferenceAt} from '../src/research/historical-reference.ts';

process.loadEnvFile('.env');
const output=process.argv[2];assert(output,'Usage: node --import tsx scripts/lp-reference-backfill.mjs OUTPUT_DIRECTORY');await mkdir(output,{recursive:true});
const base=process.argv[3]??'data/lp-reference-2026-09-07',eventsText=await readFile(`${base}/reference-events.json`,'utf8'),events=JSON.parse(eventsText),
 metadataText=await readFile(`${base}/registry-source.json`,'utf8'),metadata=JSON.parse(metadataText),
 timingText=await readFile(process.argv[4]??'data/lp-research-2026-09-07/size-sweep-timestamps.json','utf8'),timing=JSON.parse(timingText);
const digest=text=>createHash('sha256').update(text).digest('hex'),serialize=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
const nvda=metadata.assets.find(a=>a.registry.symbol==='NVDA'),feeds={rwa:nvda.oracle.feed,quote:metadata.quoteOracle.feed};
const headers=new Map([...timing.headers.map(h=>[h.number,h]),...events.blocks.map(b=>[Number(b.number),{number:Number(b.number),hash:b.hash,timestamp:Number(BigInt(b.timestamp))}])]);
for(const h of timing.headers) assert.equal(headers.get(h.number).hash.toLowerCase(),h.hash.toLowerCase(),'Reference/pool block hash mismatch');
assert(timing.fromBlock===events.fromBlock&&timing.toBlock===events.toBlock);
const plan={schemaVersion:1,executionEligible:false,fromBlock:timing.fromBlock,toBlock:timing.toBlock,decisionSeconds:60,
 maxAgeSeconds:Number(process.env.RISK_MAX_PRICE_AGE_SECONDS??300),referenceTolerancePpm:50000,
 eventsSha256:digest(eventsText),metadataSha256:digest(metadataText),timestampSha256:digest(timingText),
 methodology:'Archive-verified oracle rounds, made available from canonical publication block timestamp; never from an earlier updatedAt timestamp',
 sourceMapping:'September registry/feed mapping verified against August on-chain descriptions, decimals and proxy aggregator endpoints; historical issuer registry attestation unavailable',
 limitations:['No historical fallback reference reconstructed','Issuer status and sequencer continuity remain unverified','No market-hour freshness exception is silently introduced']};
await writeFile(`${output}/manifest.json`,serialize(plan),{flag:'wx'});
const config=loadHistoryConfig(process.env.ROBINHOOD_READ_HTTP_URL??process.env.RH_RPC_URL??'https://rpc.mainnet.chain.robinhood.com');
const client=createRobinhoodClient(HISTORY_TRANSPORT_URL,30000,{fetchFn:createHistoryFetch(config),retryCount:0}),reader=new ViemRiskChainReader(client);
const proxyAbi=parseAbi(['function aggregator() view returns (address)']);
const answerAbi=parseAbi(['event AnswerUpdated(int256 indexed current,uint256 indexed roundId,uint256 updatedAt)']);
const topic=toEventSelector(answerAbi[0]);
const roles={};
for(const [role,feed] of Object.entries(feeds)){
 const first=await reader.readOracle(feed.address,BigInt(timing.fromBlock));
 const aggregator=await client.readContract({address:feed.address,abi:proxyAbi,functionName:'aggregator',blockNumber:BigInt(timing.fromBlock)});
 const aggregatorEnd=await client.readContract({address:feed.address,abi:proxyAbi,functionName:'aggregator',blockNumber:BigInt(timing.toBlock)});
 assert.equal(aggregator.toLowerCase(),aggregatorEnd.toLowerCase(),'Aggregator changed across window');
 assert(!events.logs.some(l=>l.address.toLowerCase()===feed.address.toLowerCase()),'Proxy emitted events; upgrade/phase review required');
 const updates=events.logs.filter(l=>l.address.toLowerCase()===aggregator.toLowerCase()&&l.topic0===topic)
   .sort((a,b)=>Number(a.block_number)-Number(b.block_number)||Number(a.transaction_index)-Number(b.transaction_index)||Number(a.log_index)-Number(b.log_index));
 const rounds=[{blockNumber:timing.fromBlock,blockHash:headers.get(timing.fromBlock).hash,availableAt:headers.get(timing.fromBlock).timestamp,state:first}];
 let previous=BigInt(first.roundId);
 for(const log of updates){
  const b=Number(log.block_number),header=headers.get(b);assert(log.removed===false&&header.hash.toLowerCase()===log.block_hash.toLowerCase());
  const event=decodeEventLog({abi:answerAbi,data:log.data,topics:[log.topic0,log.topic1,log.topic2]});
  const value=await client.readContract({address:feed.address,abi:aggregatorV3Abi,functionName:'latestRoundData',blockNumber:BigInt(b)});
  assert.equal(value[0],previous+1n,'Missing round, phase change, or multiple publications in one block');
  assert.equal(value[0]&((1n<<64n)-1n),event.args.roundId);assert.equal(value[1],event.args.current);assert.equal(value[3],event.args.updatedAt);
  const state={...first,roundId:String(value[0]),answer:String(value[1]),startedAt:String(value[2]),updatedAt:String(value[3]),answeredInRound:String(value[4])};
  rounds.push({blockNumber:b,blockHash:header.hash,availableAt:header.timestamp,state});previous=value[0];
 }
 const last=await reader.readOracle(feed.address,BigInt(timing.toBlock));
 assert.deepEqual(last,rounds.at(-1).state,'Terminal oracle state does not reconcile with publications');
 roles[role]={feed,aggregator,rounds,terminal:last};console.log(JSON.stringify({phase:'rounds_verified',role,updates:updates.length}));
}
// Token snapshots are evidence at explicit boundaries/publications, not a claim
// that an event census proves every getter value between observations.
const riskBlocks=[...new Set([timing.fromBlock,timing.toBlock,...roles.rwa.rounds.map(r=>r.blockNumber),...roles.quote.rounds.map(r=>r.blockNumber)])].sort((a,b)=>a-b),tokenSnapshots=[];
for(const b of riskBlocks){const state=await reader.readToken(nvda.registry.address,BigInt(b));tokenSnapshots.push({blockNumber:b,blockHash:headers.get(b).hash,at:headers.get(b).timestamp,state});}
const points=[];for(let at=headers.get(timing.fromBlock).timestamp;at<=headers.get(timing.toBlock).timestamp;at+=60){points.push(historicalReferenceAt({at,maxAgeSeconds:plan.maxAgeSeconds,rwaFeed:feeds.rwa,quoteFeed:feeds.quote,rwaRounds:roles.rwa.rounds,quoteRounds:roles.quote.rounds}));}
const reasons={};for(const p of points)for(const reason of p.reasons)reasons[reason]=(reasons[reason]??0)+1;
const result={manifest:plan,roles,tokenSnapshots,points,summary:{observations:points.length,priceReferencePassing:points.filter(p=>p.available).length,
 rwaFresh:points.filter(p=>!p.reasons.includes('rwa_oracle_price_stale')).length,quoteFresh:points.filter(p=>!p.reasons.includes('quote_oracle_price_stale')).length,reasons,
 guardedExecutionPassing:0},executionEligible:false,guardedReplayStatus:'unavailable_without_complete_issuer_sequencer_and_cost_evidence',
 tokenEventCensus:events.census,tokenRiskCoverage:'Start/end and every oracle-publication block only; not every minute',
 conclusion:'Historical oracle publication reconstruction completed; reference-quality results are distinct from complete strategy eligibility'};
await writeFile(`${output}/references.json`,serialize(result),{flag:'wx'});console.log(JSON.stringify(result.summary));
