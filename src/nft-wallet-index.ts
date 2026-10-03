import {z} from 'zod';
import {getAddress,isAddress} from 'viem';
import {createRobinhoodClient} from './client.js';
import {DeploymentStore} from './deployments/store.js';
import {PostgresPositionManagerWalletTransferStore} from './nft/position-manager-wallet-transfer-store.js';
import {maintainRegisteredWalletPositionManagerHistory} from './nft/wallet-transfer-index-runtime.js';
import {rangeKeeperConfirmedSource} from './strategy/rangekeeper/source.js';

const HELP=`Usage: node --import tsx src/nft-wallet-index.ts [--chunk-blocks N] [--max-blocks N]

Explicitly backfill/resume the server wallet's Position Manager Transfer history.
Requires v14 schema, DATABASE_URL, ROBINHOOD_READ_HTTP_URL, and
DEPLOYMENT_OPERATOR_WALLET_ADDRESS. Starts at genesis and performs read-only
RPC queries plus writes only to the isolated wallet-scoped history tables.
Defaults: 10000000 blocks/chunk, 100000000 blocks/run. No schema migration.
`;

export function parsePositionManagerWalletIndexArgs(args:readonly string[]){
 const values=new Map<string,string>();
 for(let i=0;i<args.length;i++){
  const key=args[i]!;
  if(key!=='--chunk-blocks'&&key!=='--max-blocks')throw Error(`unknown_argument:${key}`);
  if(values.has(key))throw Error(`duplicate_argument:${key}`);
  const value=args[++i];if(!value||! /^(0|[1-9][0-9]*)$/.test(value))throw Error(`invalid_argument:${key}`);
  values.set(key,value);
 }
 const parsed=z.object({chunkBlocks:z.coerce.bigint().min(1n).max(10_000_000n).default(10_000_000n),
  maxBlocksPerRun:z.coerce.bigint().min(1n).max(100_000_000n).default(100_000_000n)}).strict().parse({
  chunkBlocks:values.get('--chunk-blocks'),maxBlocksPerRun:values.get('--max-blocks')});
 if(parsed.chunkBlocks>parsed.maxBlocksPerRun)throw Error('chunk_blocks_exceeds_run_bound');
 return parsed;
}

async function main(){
 if(process.argv.slice(2).includes('--help')||process.argv.slice(2).includes('-h')){
  process.stdout.write(HELP);return;
 }
 const args=parsePositionManagerWalletIndexArgs(process.argv.slice(2));
 const env=z.object({DATABASE_URL:z.string().min(1),ROBINHOOD_READ_HTTP_URL:z.url(),
  DEPLOYMENT_OPERATOR_WALLET_ADDRESS:z.string().refine(isAddress),
  DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000)}).parse(process.env);
 const wallet=getAddress(env.DEPLOYMENT_OPERATOR_WALLET_ADDRESS);
 const deploymentStore=new DeploymentStore(env.DATABASE_URL);
 const walletStore=new PostgresPositionManagerWalletTransferStore(env.DATABASE_URL,wallet);
 try{
  await deploymentStore.assertReady();
  await walletStore.assertReady();
  const catalog=await deploymentStore.listMarketProfiles();
  const active=catalog.filter(row=>row.reason!=='retired');
  if(active.length===0)throw Error('registered_market_profiles_unavailable');
  const registered=await Promise.all(active.map(async row=>{
   const value=await deploymentStore.paperSetupProfile(row.id);
   if(!value)throw Error('registered_market_profile_unavailable');
   return value.profile;
  }));
  const client=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,env.DEPLOYMENT_RPC_TIMEOUT_MS,{retryCount:0});
  const source=await rangeKeeperConfirmedSource(client);
  const result=await maintainRegisteredWalletPositionManagerHistory({client,store:walletStore,wallet,profiles:registered,
   source:{block:source.block,hash:source.hash,timestamp:source.timestamp},...args});
  process.stdout.write(`${JSON.stringify({kind:'position_manager_wallet_transfer_maintenance',wallet,
   manager:registered[0]!.pool.positionManager,source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
   ...result},(_,value)=>typeof value==='bigint'?String(value):value)}\n`);
  if(result.status!=='scanned'||!result.completeThroughSource)process.exitCode=2;
 }finally{
  await Promise.allSettled([walletStore.close(),deploymentStore.close()]);
 }
}

if(process.argv[1]?.endsWith('/nft-wallet-index.ts')||process.argv[1]?.endsWith('/nft-wallet-index.js'))main().catch(error=>{
 const message=(error instanceof Error?error.message:'unknown')
  .replace(/\b(?:https?|postgres(?:ql)?):\/\/\S+/gi,'[redacted-url]');
 process.stderr.write(`wallet transfer maintenance failed: ${message}\n`);
 process.exitCode=1;
});
