import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chmodSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {recoverMessageAddress} from 'viem';
import {livePilotConfig} from '../src/live-pilot/config.js';
import {loadPilotEnvSigner} from '../src/live-pilot/signer.js';
import {pilotIntentSchema,verifyPilotSignature} from '../src/live-pilot/journal.js';
import {USDG} from '../src/constants.js';

// These fixtures never load the operator's .env or use the real wallet key.
const key=`0x${'01'.repeat(32)}` as const,account=privateKeyToAccount(key);
const original=JSON.parse(readFileSync('config/live-pilot-nvda-250.json','utf8'));
const config=livePilotConfig({...original,operator:account.address,signer:{kind:'env_file',reference:'.env',variable:'TEST_WALLET_PRIVATE_KEY'}});
function fixture() {
 const directory=mkdtempSync(join(tmpdir(),'conc-liq-signer-test-')),file=join(directory,'.env');
 writeFileSync(file,`TEST_WALLET_PRIVATE_KEY=${key}\n`,{mode:0o600});
 return {directory,file,close:()=>rmSync(directory,{recursive:true,force:true})};
}
test('env signer proves ownership without exporting secret or modifying process.env',async()=>{
 const f=fixture(),before=process.env.TEST_WALLET_PRIVATE_KEY;
 try {
  const signer=loadPilotEnvSigner(config,f.directory),proof=await signer.proveOwnership();
  assert.equal(await recoverMessageAddress({message:proof.message,signature:proof.signature}),account.address);
  assert.match(proof.message,/does not authorize transfers/);assert.equal(proof.verified,true);
  assert.notEqual((await signer.proveOwnership()).message,proof.message);
  assert.equal(process.env.TEST_WALLET_PRIVATE_KEY,before);assert(!JSON.stringify(signer).includes(key));
  assert(!JSON.stringify(proof).includes(key));assert.deepEqual(Object.keys(signer).sort(),['address','proveOwnership','signIntent']);
 }finally{f.close();}
});
test('env signer rejects wrong operator and unprotected key file',()=>{
 const f=fixture();try {
  assert.throws(()=>loadPilotEnvSigner({...config,operator:USDG},f.directory),/does not match/);
  chmodSync(f.file,0o644);assert.throws(()=>loadPilotEnvSigner(config,f.directory),/private file permissions/);
 }finally{f.close();}
});
test('invalid and missing key errors contain no secret input',()=>{
 const f=fixture();try {
  for(const value of ['bad-sensitive-fixture-value','0'.repeat(64),'']) {
   writeFileSync(f.file,`TEST_WALLET_PRIVATE_KEY=${value}\n`);
   assert.throws(()=>loadPilotEnvSigner(config,f.directory),error=>{
    assert(error instanceof Error);assert.equal(error.message,'Cannot load pilot key: check the configured env variable and private file permissions');return true;
   });
  }
 }finally{f.close();}
});
test('key without 0x prefix is accepted',()=>{
 const f=fixture();try{writeFileSync(f.file,`TEST_WALLET_PRIVATE_KEY=${key.slice(2)}\n`);assert.equal(loadPilotEnvSigner(config,f.directory).address,account.address);}finally{f.close();}
});
test('signs the reserved envelope and refuses another operator or chain',async()=>{
 const f=fixture();try {
  const signer=loadPilotEnvSigner(config,f.directory);
  const intent=pilotIntentSchema.parse({id:'37df20c4-12ab-4fd4-a5a5-020f0dcd06f5',chainId:4663,operator:account.address,
   action:'test_fixture',nonce:0,to:USDG,data:'0x1234',value:'0',gas:'50000',maxFeePerGas:'100000000',maxPriorityFeePerGas:'0',sourceBlock:'1234',sourceHash:`0x${'ab'.repeat(32)}`});
  const signed=await signer.signIntent(intent);assert.equal(await verifyPilotSignature(intent,signed.raw),signed.hash);
  await assert.rejects(()=>signer.signIntent({...intent,operator:USDG}));
  await assert.rejects(()=>signer.signIntent({...intent,chainId:1} as unknown as typeof intent));
 }finally{f.close();}
});
