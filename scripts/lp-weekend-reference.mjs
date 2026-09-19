// Bounded historical reads only; the resulting reference verification is also read-only.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {NativeHyperSync} from '../src/history/hypersync.ts';
import {loadHistoryConfig} from '../src/history/client.ts';

process.loadEnvFile('.env');
const base='data/lp-weekend-2026-09-07',timingPath='data/lp-research-2026-09-07/weekend-timestamps.json';
const timing=JSON.parse(await readFile(timingPath,'utf8'));assert(timing.fromBlock===36467320&&timing.toBlock===38377320);
await mkdir(base,{recursive:true});
const addresses=['0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15','0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2',
 '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2','0x8bEeE3503F6860D5dac4cE26b5eEe92982951c2e'];
const native=new NativeHyperSync(loadHistoryConfig(process.env.ROBINHOOD_READ_HTTP_URL??process.env.RH_RPC_URL??'https://rpc.mainnet.chain.robinhood.com'));
const events={fromBlock:timing.fromBlock,toBlock:timing.toBlock,blocks:[],logs:[],census:{},
 tokenEventScope:'Oracle proxies and aggregators only; token risk uses pinned archive snapshots, not a complete token-log census'};
for(let from=timing.fromBlock;from<=timing.toBlock;from+=100000){
 const r=await native.query(from,Math.min(from+100000,timing.toBlock+1),{logs:[{address:addresses}],field_selection:{
  block:['number','hash','parent_hash','timestamp'],log:['block_number','block_hash','transaction_hash','transaction_index','log_index','address','data','topic0','topic1','topic2','topic3','removed']}});
 events.blocks.push(...r.blocks);events.logs.push(...r.logs);
 for(const l of r.logs){assert(l.removed===false);const key=l.address+':'+l.topic0;events.census[key]=(events.census[key]??0)+1;}
 console.log(JSON.stringify({phase:'weekend_reference_logs',through:Math.min(from+99999,timing.toBlock),logs:events.logs.length}));
}
await writeFile(`${base}/reference-events.json`,JSON.stringify(events,null,2)+'\n',{flag:'wx'});
await writeFile(`${base}/registry-source.json`,await readFile('data/lp-reference-2026-09-07/registry-source.json'),{flag:'wx'});
process.argv.splice(2,process.argv.length,`${base}/backfill`,base,timingPath);
await import('./lp-reference-backfill.mjs');
