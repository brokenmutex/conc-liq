import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inventory, releaseId, verifyRelease } from './release-files.mjs';

const parent=process.argv[2];
if(!parent || !parent.startsWith('/') || process.argv.length!==3)throw Error('Usage: npm run release:build -- /absolute/release-directory');
const source=process.cwd();
if(execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim())throw Error('Commit the reviewed source first; release builds require a clean checkout');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const scratch=join(parent,`.building-${process.pid}`);
mkdirSync(parent,{recursive:true});mkdirSync(scratch);
try {
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json','--outDir',join(scratch,'dist')],{stdio:'inherit'});
 // Tests are validated before release, not shipped into a runtime.
 rmSync(join(scratch,'dist/test'),{recursive:true,force:true});
 for(const path of ['dashboard','config','package.json','package-lock.json'])cpSync(join(source,path),join(scratch,path),{recursive:true});
 cpSync(realpathSync(join(source,'node_modules')),join(scratch,'node_modules'),{recursive:true,verbatimSymlinks:true});
 for(const path of ['notes/canary-evidence-2026-09-06/local-lifecycle.json','notes/paper-execution-evidence-2026-09-07/round-trip.json']) {
  mkdirSync(dirname(join(scratch,path)),{recursive:true});cpSync(join(source,path),join(scratch,path));
 }
 mkdirSync(join(scratch,'bin'));cpSync(process.execPath,join(scratch,'bin/node'));
 const anvil=process.env.ANVIL_BIN ?? '/root/.foundry/bin/anvil';
 cpSync(realpathSync(anvil),join(scratch,'bin/anvil'));
 cpSync(join(source,'scripts/run-release.mjs'),join(scratch,'launch.mjs'));
 cpSync(join(source,'scripts/release-files.mjs'),join(scratch,'release-files.mjs'));
 const manifest={format:1,sourceCommit,nodeVersion:process.version,files:inventory(scratch)};
 manifest.buildId=releaseId(manifest);
 writeFileSync(join(scratch,'release.json'),JSON.stringify(manifest,null,2)+'\n');
 verifyRelease(scratch);
 const destination=join(parent,manifest.buildId);
 if(existsSync(destination))throw Error('Release already exists; refusing to overwrite');
 // Copied binaries and dependencies are independent of the working checkout.
 // File permissions guard accidental edits, not an administrator changing them.
 function seal(dir){for(const name of readdirSync(dir)){const p=join(dir,name);const s=lstatSync(p);if(s.isSymbolicLink())continue;if(s.isDirectory())seal(p);else chmodSync(p,s.mode & 0o111 ? 0o555 : 0o444);}chmodSync(dir,0o555);}
 seal(scratch);renameSync(scratch,destination);
 console.log(JSON.stringify({release:destination,buildId:manifest.buildId,sourceCommit}));
}catch(error){rmSync(scratch,{recursive:true,force:true});throw error;}
