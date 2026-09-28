import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentSetupDefaults} from '../src/deployments/setup-defaults.js';

test('deployment setup defaults only return a normalized valid public address',()=>{
 assert.deepEqual(deploymentSetupDefaults(undefined),{walletAddress:null});
 assert.deepEqual(deploymentSetupDefaults('not-an-address'),{walletAddress:null});
 assert.deepEqual(deploymentSetupDefaults('0x52908400098527886E0F7030069857D2E4169EE7'),
  {walletAddress:'0x52908400098527886E0F7030069857D2E4169EE7'});
});
