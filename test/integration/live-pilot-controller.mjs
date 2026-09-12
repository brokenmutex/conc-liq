// Real contract execution and signed test transactions on an owned fork only.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {encodeAbiParameters,keccak256,toHex,parseTransaction} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {livePilotConfig} from '../../src/live-pilot/config.ts';
import {loadPilotEnvSigner} from '../../src/live-pilot/signer.ts';
import {PilotStore} from '../../src/live-pilot/store.ts';
import {PilotChain,encodePilotPlan} from '../../src/live-pilot/chain.ts';
import {PilotController} from '../../src/live-pilot/controller.ts';
import {createRobinhoodClient} from '../../src/client.ts';
import {loadIndexerConfig} from '../../src/indexer/config.ts';
import {PostgresRpcHealthGate} from '../../src/rpc-health/store.ts';
import {openPaperFork} from '../../src/paper/fork.ts';
import {createPaperExecutionContext,fundPaperFixture,fixtureSend} from '../../src/paper/execution.ts';
import {quoteValue} from '../../src/simulator/math.ts';
import {USDG} from '../../src/constants.ts';
import {PAPER_NVDA,PAPER_POOL} from '../../src/paper/engine.ts';
import {sqrtRatioAtTick} from '../../src/backtest/principal.ts';
import {PAPER_ROUTER,paperTokenAbi} from '../../src/paper/execution-abi.ts';
import {json} from '../../src/live-pilot/domain.ts';
const [envPath,output,mode]=process.argv.slice(2);assert(envPath&&output);const revertMode=mode==='revert',approvalRetryMode=mode==='retry-approval';
Object.assign(process.env,parseEnv(readFileSync(envPath,'utf8')));process.env.ANVIL_BIN??='/root/.foundry/bin/anvil';
const schema=`pilot_controller_test_${process.pid}_${Date.now()}`,store=new PilotStore(process.env.DATABASE_URL,schema);
const key=generatePrivateKey(),account=privateKeyToAccount(key),directory=mkdtempSync(join(tmpdir(),'pilot-controller-'));
writeFileSync(join(directory,'.env'),`TEST_PILOT_KEY=${key}\n`,{mode:0o600});
const base=JSON.parse(readFileSync('config/live-pilot-nvda-250.json'));
const config=livePilotConfig({...base,broadcastEnabled:true,operator:account.address,signer:{kind:'env_file',reference:'.env',variable:'TEST_PILOT_KEY'}},{allowBroadcast:true});
const health=new PostgresRpcHealthGate({connectionString:process.env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30}),beforeRead=()=>health.assertBulkAllowed().then(()=>{});
const indexer=loadIndexerConfig(),upstream=createRobinhoodClient(indexer.rpcUrl,indexer.rpcTimeoutMs,{beforeRequest:beforeRead,retryCount:0});
let fork;
try {
 const head=await upstream.getBlockNumber(),block=await upstream.getBlock({blockNumber:head-512n});
 fork=await openPaperFork({source:{number:block.number,hash:block.hash,timestamp:block.timestamp},rpcUrl:indexer.rpcUrl,beforeRead,maxRequests:2000,timeoutMs:600000});
 const local=createRobinhoodClient(fork.localUrl,60000,{retryCount:0}),ctx=await createPaperExecutionContext(fork,config.strategy,undefined,account.address);
 await fundPaperFixture(ctx,{quote:300000000n,rwa:0n});await store.initialize();
 let lostAcknowledgement=false,wrongReceiptBlock=false,holdConfirmation=false,revertInjected=false,approvalRejected=false,approvalRetried=false;
 const sendHashes=[];
 const wrapped={...local,sendRawTransaction:async args=>{
  if(approvalRetryMode&&!approvalRejected){approvalRejected=true;throw new Error('publishing transactions not supported by this endpoint');}
  let hash;const tx=parseTransaction(args.serializedTransaction);
  if(revertMode&&!revertInjected&&tx.to?.toLowerCase()===PAPER_ROUTER.toLowerCase()){
   const code=await local.getBytecode({address:PAPER_ROUTER});assert(code);revertInjected=true;
   // Contract fault occurs after successful preflight, only on the owned fork.
   await fork.rpc('anvil_setCode',[PAPER_ROUTER,'0x60006000fd']);
   try{hash=await local.sendRawTransaction(args);}finally{await fork.rpc('anvil_setCode',[PAPER_ROUTER,code]);}
  }else hash=await local.sendRawTransaction(args);sendHashes.push(hash);
  if(!lostAcknowledgement&&!approvalRetryMode){lostAcknowledgement=true;throw new Error('Injected lost acknowledgement after acceptance');}return hash;},
  getBlock:async args=>{const b=await local.getBlock(args);if(wrongReceiptBlock&&args?.blockNumber!==undefined){wrongReceiptBlock=false;return {...b,hash:`0x${'cd'.repeat(32)}`};}return b;}};
 const chain=new PilotChain(wrapped,config),guardChain=new PilotChain(local,config),signer=loadPilotEnvSigner(config,directory);
 const guard=async()=>{
  const b=await local.getBlock({blockTag:'latest'}),source={block:String(b.number),hash:b.hash,timestamp:String(b.timestamp)};
  const s=await guardChain.snapshot(source,null),price=quoteValue({amount0:0n,amount1:10n**18n,token0:USDG,token1:PAPER_NVDA,quoteToken:USDG,sqrtPriceX96:BigInt(s.sqrtPriceX96)})*10n**12n;
  return {source:holdConfirmation?{...source,block:String(b.number-1n)}:source,entryAllowed:true,referencePriceX18:String(price),reasons:[]};
 };
 let controller=new PilotController(store,chain,config,signer,guard);
 const initial=await controller.start();assert.equal(initial.reserveUsdg,'50000000');
 // Inject a process stop at each durable boundary, then reconstruct the controller.
 const injected=new Set(),events=[];
 const hook=async(at,action)=>{if(!injected.has(at)){injected.add(at);if(at==='broadcast')holdConfirmation=true;throw new Error(`injected_stop:${at}`);}};
 controller=new PilotController(store,chain,config,signer,guard,revertMode||approvalRetryMode?undefined:hook);
 let requestedExit=false,observedHolding=false;
 let recenters=0;const mintedIds=[];
 async function cross(position,token) {
  const b=await local.getBlock({blockTag:'latest'}),s=await guardChain.snapshot({block:String(b.number),hash:b.hash,timestamp:String(b.timestamp)},position.tokenId);
  const target=sqrtRatioAtTick(token===0?position.tickLower-5:position.tickUpper+5);
  const crossed=q=>token===0?q.price<target:q.price>target;
  let high=token===0?1000000n:10n**16n;
  while(!crossed(await guardChain.quote(s,high,token))){high*=2n;assert(high<(token===0?100000000000000n:1000000n*10n**18n));}
  let low=0n;for(let n=0;n<24;n++){const mid=(low+high)/2n;if(crossed(await guardChain.quote(s,mid,token)))high=mid;else low=mid;}
  const counterparty=privateKeyToAccount(generatePrivateKey()).address;
  const other=await createPaperExecutionContext(fork,config.strategy,undefined,counterparty);
  // Synthetic counterparty balance on the owned fork. Identify the balance map
  // against the real pool's nonzero token balance before changing a test address.
  const asset=token===0?USDG:PAPER_NVDA;
  const balance=await local.readContract({address:asset,abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_POOL]});assert(balance>0n);
  const slotFor=(owner,slot)=>keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[owner,slot]));
  const oz=BigInt(keccak256(encodeAbiParameters([{type:'uint256'}],[BigInt(keccak256(toHex('openzeppelin.storage.ERC20')))-1n])))&~255n;
  let found=null;
  for(const slot of [oz,...Array.from({length:201},(_,i)=>BigInt(i))]){
   const value=await local.getStorageAt({address:asset,slot:slotFor(PAPER_POOL,slot)});
   if(BigInt(value??'0x0')===balance){found=slot;break;}
  }
  assert(found!==null,'Test balance storage slot not identified');
  await fork.rpc('anvil_setStorageAt',[asset,slotFor(counterparty,found),toHex(high,{size:32})]);
  assert.equal(await local.readContract({address:asset,abi:paperTokenAbi,functionName:'balanceOf',args:[counterparty]}),high);
  await fork.rpc('anvil_impersonateAccount',[counterparty]);await fork.rpc('anvil_setBalance',[counterparty,toHex(10n**18n)]);
  const approved=encodePilotPlan({kind:'approve',token:token===0?USDG:PAPER_NVDA,spender:PAPER_ROUTER,amount:String(high)},counterparty);
  await fixtureSend(other,counterparty,approved.to,approved.data);
  const q=await guardChain.quote(s,high,token),call=encodePilotPlan({kind:'swap',token,amountIn:String(high),minOut:String(q.amountOut*9950n/10000n),quotedOut:String(q.amountOut),deadline:String(BigInt(s.timestamp)+300n)},counterparty);
  await fixtureSend(other,counterparty,call.to,call.data);
  console.log(json({counterpartyCross:token,amountIn:String(high)}));
 }
 for(let i=0;i<160;i++) {
  try {const result=await controller.tick();events.push(result);console.log(json({iteration:i,...result}));
   if(approvalRetryMode&&approvalRejected&&!approvalRetried){const retried=await controller.retryApproval();assert.equal(retried.hash,result.hash);assert.equal(retried.phase,'approval_retried_same_hash');approvalRetried=true;events.push(retried);}
   if(result.phase==='confirming'&&holdConfirmation){holdConfirmation=false;wrongReceiptBlock=true;}}
  catch(e){assert(e instanceof Error&&e.message.startsWith('injected_stop:'),e);events.push({fault:e.message});console.log(e.message);controller=new PilotController(store,chain,config,signer,guard,revertMode||approvalRetryMode?undefined:hook);}
  const row=await store.locked(account.address,db=>store.current(db,account.address));assert(row);
  if(revertMode&&row.state.phase==='halted'){
   assert(row.state.haltReason.startsWith('transaction_reverted:'));await assert.rejects(()=>controller.request('running'),/halted/);
   await controller.recoverExit();requestedExit=true;
  }
  if(row.state.phase==='holding'&&!requestedExit){observedHolding=true;
   if(!mintedIds.includes(row.state.tokenId)){mintedIds.push(row.state.tokenId);
    if(recenters<2&&!approvalRetryMode){await cross(row.state.last.position,recenters===0?0:1);recenters++;}
    else {await controller.tick();await controller.request('exit');requestedExit=true;}}
  }
  if(row.state.phase==='closed')break;
 }
 const final=await store.locked(account.address,db=>store.current(db,account.address));assert.equal(final.state.phase,'closed');if(!revertMode)assert(observedHolding);else assert(revertInjected&&requestedExit);
 if(!revertMode&&!approvalRetryMode){assert.deepEqual([...injected].sort(),['broadcast','prepared','receipt','signed']);
 assert(lostAcknowledgement&&events.some(e=>e.phase==='confirming')&&events.some(e=>e.phase==='reorg_wait'));}
 await store.locked(account.address,async()=>{await assert.rejects(()=>store.locked(account.address,async()=>{}),/Another live controller/);});
 const actions=(await store.pool.query(`SELECT id,intent,plan,before_state AS before,status,hash,receipt FROM ${schema}.actions ORDER BY created_at`)).rows;
 const confirmed=actions.filter(a=>a.status==='confirmed'||a.status==='reverted');assert(confirmed.length>=(revertMode?3:8));
 assert.equal(new Set(confirmed.map(a=>a.intent.nonce)).size,confirmed.length);assert.equal(final.state.last.nonce,confirmed.length);
 assert.equal(final.state.last.nvda,'0');assert.equal(final.state.tokenId,null);assert(final.state.last.allowances.every(a=>a.amount==='0'));
 if(!revertMode&&!approvalRetryMode){assert.equal(mintedIds.length,3);assert.equal(final.state.retiredTokenIds.length,3);
 assert(BigInt(final.state.collectedFee0)>0n&&BigInt(final.state.collectedFee1)>0n);}
 assert.equal(final.state.reserveUsdg,'50000000');assert(BigInt(final.state.last.usdg)>=50000000n);
 assert.equal(BigInt(initial.last.native)-BigInt(final.state.last.native),BigInt(final.state.gasSpentWei));
 await fork.rpc('anvil_setBalance',[account.address,toHex(BigInt(final.state.last.native)+1n)]);
 assert.equal((await controller.tick()).phase,'halted');await assert.rejects(()=>controller.recoverExit(),/reconciled reverted/);
 writeFileSync(output,json({mode:mode??'recenter_restarts',computedAt:new Date().toISOString(),scope:'signed_owned_fork_controller_recovery',mainnetTransactions:0,source:{block:String(block.number),hash:block.hash},
  injected:[...injected],mintedIds,events,initial,final:final.state,actions,checks:{nonceUniqueness:true,gasReconciled:true,reservePreserved:true,entryAndExit:!revertMode,recenterBothDirections:!revertMode&&!approvalRetryMode,collectedFeesBothTokens:!revertMode&&!approvalRetryMode,lostAcknowledgement:lostAcknowledgement,unconfirmedReceiptBlocked:!revertMode&&!approvalRetryMode,reorgReceiptBlocked:!revertMode&&!approvalRetryMode,rejectedApprovalSameHashRetry:approvalRetried,concurrentWorkerExcluded:true,revertedReceiptRecovery:revertMode,externalWalletChangeHalted:true}})+'\n',{flag:'wx'});
 console.log(`Signed controller fork ${mode??'recenter_restarts'} passed`);
}finally{await fork?.close();await store.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await store.close();await health.close();rmSync(directory,{recursive:true,force:true});}
