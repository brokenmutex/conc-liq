import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,rename,writeFile} from 'node:fs/promises';
import {assertRuntimeMatches,type RuntimeIdentity} from './runtime/identity.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function migrateAdaptivePaperRuntime(path:string,expectedBuild:string,current:RuntimeIdentity){
 assertRuntimeMatches(current,current);assert(/^[a-f0-9]{64}$/.test(expectedBuild),'Expected prior adaptive build is invalid');
 const raw=await readFile(path,'utf8'),state=JSON.parse(raw);
 assert.equal(state.version,1,'Adaptive state version changed');assert(state.runtime,'Adaptive state runtime is missing');
 assert.equal(state.runtime.buildId,expectedBuild,'Prior adaptive runtime changed');assert.notEqual(current.buildId,expectedBuild,'Adaptive runtime migration requires a different build');
 assert.equal(current.configHash,state.runtime.configHash,'Adaptive runtime migration requires identical environment configuration');
 assert.equal(current.nodeVersion,state.runtime.nodeVersion,'Adaptive runtime migration requires identical Node');
 assert.equal(state.configHash,hash(JSON.stringify(state.config,null,2)+'\n'),'Adaptive strategy configuration changed');
 const entry={at:new Date().toISOString(),from:state.runtime,to:current,stateSha256:hash(raw)};
 state.runtime=current;state.runtimeHistory=[...(state.runtimeHistory??[]),entry];
 const target=JSON.stringify(state,null,2)+'\n';await writeFile(path+'.tmp',target);await rename(path+'.tmp',path);
 return {fromBuild:expectedBuild,toBuild:current.buildId,stateSha256:entry.stateSha256,historyEntries:state.runtimeHistory.length};
}
