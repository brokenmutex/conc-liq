import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hash, inventory, releaseId, verifyRelease } from './release-files.mjs';

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
 for(const path of ['assets/evidence/canary-local-lifecycle.json','assets/evidence/paper-round-trip.json']) {
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
 // A release is a self-contained byte copy: the realpathSync calls above resolve
 // node, anvil and node_modules so nothing points back at the checkout, and
 // inventory refuses a symlink that leaves the release. Consecutive builds
 // therefore land ~314 MB that is identical whenever the Node version and the
 // lockfile have not moved. Share those with hardlinks instead: a hardlink is a
 // second directory entry for the same content, not a link out of the release,
 // so inventory still reads a plain file and the manifest still verifies. Source
 // bytes are rehashed before every link and the release is verified again after,
 // so a corrupt sibling cannot be adopted. Sharing is only an optimisation - a
 // release that shares nothing is still correct, just larger.
 // Prefer the sibling with the most identical entries, so a Node or dependency
 // upgrade re-anchors on the new generation rather than the superseded one.
 function chooseReference(){
  let best=null;
  for(const name of readdirSync(parent)) {
   if(name===manifest.buildId || !/^[a-f0-9]{64}$/.test(name))continue;
   let files;
   try{files=JSON.parse(readFileSync(join(parent,name,'release.json'),'utf8')).files;}catch{continue;}
   if(!files)continue;
   let shared=0;
   for(const [path,digest] of Object.entries(manifest.files))if(files[path]===digest)shared++;
   if(shared>0 && (!best || shared>best.shared))best={name,files,shared};
  }
  return best;
 }
 function share(){
  const reference=chooseReference();
  if(!reference)return null;
  let linked=0,bytes=0;
  for(const [path,digest] of Object.entries(manifest.files)) {
   if(digest.startsWith('symlink:') || reference.files[path]!==digest)continue;
   const ours=join(destination,path),theirs=join(parent,reference.name,path);
   try {
    const source=lstatSync(theirs);
    if(!source.isFile() || source.ino===lstatSync(ours).ino)continue;
    if(hash(readFileSync(theirs))!==digest)continue;
    const pending=`${ours}.linking-${process.pid}`;
    linkSync(theirs,pending);renameSync(pending,ours);
    linked++;bytes+=source.size;
   }catch{/* an unshared file is correct; leave this build's own copy in place */}
  }
  return {reference:reference.name,linked,bytes};
 }
 let shared=null;
 try{shared=share();verifyRelease(destination);}
 catch(error){rmSync(destination,{recursive:true,force:true});throw error;}
 console.log(JSON.stringify({release:destination,buildId:manifest.buildId,sourceCommit,shared}));
}catch(error){rmSync(scratch,{recursive:true,force:true});throw error;}
