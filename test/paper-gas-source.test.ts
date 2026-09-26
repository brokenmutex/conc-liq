import assert from 'node:assert/strict';
import {test} from 'node:test';
import {safePaperGasVerifyFailure} from '../src/deployments/paper-gas-source.js';

test('paper gas verification diagnostics expose safe invariant codes only',()=>{
 const invariant=new assert.AssertionError({
  message:'Paper gas source chain id mismatch\n\n1 !== 2',
 });
 assert.equal(safePaperGasVerifyFailure(invariant),'paper_gas_chain_id_mismatch');

 const credentialError=new Error('https://rpc.example/key-secret request failed');
 assert.equal(safePaperGasVerifyFailure(credentialError),'Error');
 assert.equal(safePaperGasVerifyFailure(new Error('paper_safe_code\ncredential-secret')),'paper_safe_code');
 assert.equal(safePaperGasVerifyFailure('credential-secret'),'unknown');
});
