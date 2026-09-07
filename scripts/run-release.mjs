import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { hash, verifyRelease } from './release-files.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const [envPath,command,...args]=process.argv.slice(2);
const manifest=verifyRelease(root);
if(envPath==='--verify' && !command) { console.log(JSON.stringify({buildId:manifest.buildId,verified:true}));process.exit(0); }
if(!envPath || !command || !/^[a-z][a-z-]*$/.test(command))throw Error('Usage: launch.mjs /absolute/runtime.env ENTRYPOINT [arguments]');
if(!envPath.startsWith('/'))throw Error('Runtime environment path must be absolute');
if(realpathSync(process.execPath)!==realpathSync(join(root,'bin/node')) || process.version!==manifest.nodeVersion)throw Error('Use the pinned Node binary');
const env=parseEnv(readFileSync(envPath,'utf8'));
if(Object.keys(env).some(k=>k.startsWith('CONC_LIQ_') || ['NODE_OPTIONS','NODE_PATH','ANVIL_BIN','PATH','HOME','LD_PRELOAD','LD_LIBRARY_PATH'].includes(k)))throw Error('Runtime environment contains a reserved launcher setting');
// The dedicated file owns application configuration. Services must not inherit
// another project's application variables. Strip inherited values before load.
for(const key of Object.keys(process.env))if(!['HOME','USER','LOGNAME','LANG','TZ','TMPDIR','INVOCATION_ID','JOURNAL_STREAM','NOTIFY_SOCKET'].includes(key))delete process.env[key];
Object.assign(process.env,env);
process.env.PATH=`${join(root,'bin')}:/usr/bin:/bin`;
process.env.ANVIL_BIN=join(root,'bin/anvil');
process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify({buildId:manifest.buildId,configHash:hash(JSON.stringify(Object.fromEntries(Object.entries(env).sort(([a],[b])=>a.localeCompare(b,'en'))))),nodeVersion:process.version});
process.chdir(root);
process.argv=[process.execPath,resolve(root,'dist/src',`${command}.js`),...args];
await import(pathToFileURL(process.argv[1]).href);
