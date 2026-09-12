import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {encodeAbiParameters,encodeEventTopics,parseAbi,zeroAddress,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {livePilotConfig} from '../src/live-pilot/config.js';
import {pilotReceiptFacts,type PilotReceipt} from '../src/live-pilot/receipt.js';
import {pilotIntentSchema,verifyPilotSignature} from '../src/live-pilot/journal.js';
import {USDG,NONFUNGIBLE_POSITION_MANAGER} from '../src/constants.js';

const rawConfig=JSON.parse(readFileSync('config/live-pilot-nvda-250.json','utf8'));
// Public deterministic test identity; never a runtime signer.
const account=privateKeyToAccount(`0x${'01'.repeat(32)}`);
const other=privateKeyToAccount(`0x${'02'.repeat(32)}`);
const hash=`0x${'ab'.repeat(32)}` as Hex;
const intent=pilotIntentSchema.parse({id:'37df20c4-12ab-4fd4-a5a5-020f0dcd06f5',chainId:4663,operator:account.address,
 action:'approval_fixture',nonce:7,to:USDG,data:'0x1234',value:'0',gas:'50000',maxFeePerGas:'100000000',maxPriorityFeePerGas:'0',sourceBlock:'1234',sourceHash:hash});
const tx={type:'eip1559' as const,chainId:4663,nonce:7,to:USDG,data:'0x1234' as Hex,value:0n,gas:50000n,maxFeePerGas:100000000n,maxPriorityFeePerGas:0n};
const receipt:PilotReceipt={transactionHash:hash,blockHash:hash,blockNumber:1234n,status:'success',gasUsed:50000n,effectiveGasPrice:100000000n,logs:[]};
const transfer=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const transferLog=(from=account.address,to=other.address,value=17n)=>({address:USDG,
 topics:encodeEventTopics({abi:transfer,eventName:'Transfer',args:{from,to}}) as Hex[],data:encodeAbiParameters([{type:'uint256'}],[value])});

test('pilot preserves the running strategy except initial capital',()=>{
 const p=livePilotConfig(rawConfig),paper=JSON.parse(readFileSync('config/paper-nvda-5000-recenter-diluted.json','utf8'));
 assert.deepEqual(p.strategy,{...paper,budgetQuote:'250000000'});
 assert.equal(p.broadcastEnabled,false);assert.equal(p.gasFundingQuote,null);
 assert.throws(()=>livePilotConfig({...rawConfig,broadcastEnabled:true}));
 assert.throws(()=>livePilotConfig({...rawConfig,initialCapitalQuote:'1000000000'}));
 assert.throws(()=>livePilotConfig({...rawConfig,strategy:{...rawConfig.strategy,halfWidthSpacings:3}}));
});
test('known token receipts produce signed wallet deltas and charge gas once',()=>{
 const result=pilotReceiptFacts({...receipt,logs:[transferLog(),transferLog(other.address,account.address,5n),transferLog(account.address,account.address,100n)]},account.address);
 assert.equal(result.walletDeltas.usdg,'-12');assert.equal(result.gasWei,'5000000000000');
 assert.equal(result.lpFeeIncome,null);assert.equal(result.reconciled,false);
});
test('unrelated contract transfers cannot create wallet income',()=>{
 const result=pilotReceiptFacts({...receipt,logs:[{...transferLog(other.address,account.address),address:other.address}]},account.address);
 assert.equal(result.walletDeltas.usdg,'0');
});
test('malformed trusted transfers fail closed',()=>{
 assert.throws(()=>pilotReceiptFacts({...receipt,logs:[{...transferLog(),data:'0x'}]},account.address));
});
test('reverted transaction charges gas without inventing transfers',()=>{
 const result=pilotReceiptFacts({...receipt,status:'reverted'},account.address);assert.equal(result.gasWei,'5000000000000');
 assert.throws(()=>pilotReceiptFacts({...receipt,status:'reverted',logs:[transferLog()]},account.address));
 assert.throws(()=>pilotReceiptFacts({...receipt,status:'reverted',logs:[transferLog(account.address,account.address)]},account.address));
});
test('NFT ownership and liquidity events are distinct from fee income',()=>{
 const abi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
  'event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)']);
 const nft={address:NONFUNGIBLE_POSITION_MANAGER,topics:encodeEventTopics({abi,eventName:'Transfer',args:{from:zeroAddress,to:account.address,tokenId:9n}}) as Hex[],data:'0x' as Hex};
 const collect={address:NONFUNGIBLE_POSITION_MANAGER,topics:encodeEventTopics({abi,eventName:'Collect',args:{tokenId:9n}}) as Hex[],
  data:encodeAbiParameters([{type:'address'},{type:'uint256'},{type:'uint256'}],[account.address,250000000n,4n])};
 const result=pilotReceiptFacts({...receipt,logs:[nft,collect]},account.address);
 assert.equal(result.nfts[0]?.tokenId,'9');assert.equal(result.liquidityEvents[0]?.amount0,'250000000');assert.equal(result.lpFeeIncome,null);
});
test('correct signed envelope matches exactly',async()=>{
 assert.match(await verifyPilotSignature(intent,await account.signTransaction(tx)),/^0x[0-9a-f]{64}$/);
});
for(const [name,change] of Object.entries({chain:{chainId:1},nonce:{nonce:8},recipient:{to:other.address},calldata:{data:'0x1235' as Hex},value:{value:1n},gas:{gas:50001n},fee:{maxFeePerGas:100000001n},tip:{maxPriorityFeePerGas:1n},accessList:{accessList:[{address:USDG,storageKeys:[]}]}})){
 test(`signed ${name} mismatch is rejected`,async()=>{
  await assert.rejects(()=>account.signTransaction({...tx,...change}).then(raw=>verifyPilotSignature(intent,raw)));
 });
}
test('signature from another operator is rejected',async()=>{
 await assert.rejects(()=>other.signTransaction(tx).then(raw=>verifyPilotSignature(intent,raw)));
});
