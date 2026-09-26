import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
export const hash = value => createHash('sha256').update(value).digest('hex');
export function inventory(root) {
 const result={};
 const walk=dir=>{
  for(const name of readdirSync(dir).sort()) {
   const path=join(dir,name),key=relative(root,path).split(sep).join('/');
   if(key==='release.json')continue;
   const stat=lstatSync(path);
   if(stat.isSymbolicLink()) {
    const target=realpathSync(path);
    if(!target.startsWith(resolve(root)+sep))throw Error(`Release symlink escapes its directory: ${key}`);
    result[key]=`symlink:${readlinkSync(path)}`;
   } else if(stat.isDirectory())walk(path);
   else if(stat.isFile())result[key]=hash(readFileSync(path));
   else throw Error(`Unsupported release file: ${key}`);
  }
 };
 walk(root);return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b,'en')));
}
export function releaseId(manifest) {
 return hash(JSON.stringify({format:manifest.format,sourceCommit:manifest.sourceCommit,nodeVersion:manifest.nodeVersion,files:manifest.files}));
}
export function verifyRelease(root) {
 const manifest=JSON.parse(readFileSync(join(root,'release.json'),'utf8'));
 if(manifest.format!==1 || manifest.buildId!==releaseId(manifest) || JSON.stringify(inventory(root))!==JSON.stringify(manifest.files))throw Error('Release contents differ from manifest');
 return manifest;
}

// Launch-time verification keeps the same complete manifest and symlink checks
// as verifyRelease, while allowing a small fixed number of file reads at once.
// This overlaps storage waits without caching trust or skipping any file.
const VERIFY_READ_CONCURRENCY=8;
export async function inventoryConcurrent(root) {
 const result={};
 const files=[];
 const walk=async dir=>{
  for(const name of (await readdir(dir)).sort()) {
   const path=join(dir,name),key=relative(root,path).split(sep).join('/');
   if(key==='release.json')continue;
   const stat=await lstat(path);
   if(stat.isSymbolicLink()) {
    const target=await realpath(path);
    if(!target.startsWith(resolve(root)+sep))throw Error(`Release symlink escapes its directory: ${key}`);
    result[key]=`symlink:${await readlink(path)}`;
   } else if(stat.isDirectory())await walk(path);
   else if(stat.isFile())files.push([key,path]);
   else throw Error(`Unsupported release file: ${key}`);
  }
 };
 await walk(root);
 let next=0;
 const worker=async()=>{
  while(next<files.length) {
   const [key,path]=files[next++];
   result[key]=hash(await readFile(path));
  }
 };
 await Promise.all(Array.from({length:Math.min(VERIFY_READ_CONCURRENCY,files.length)},worker));
 return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b,'en')));
}
export async function verifyReleaseConcurrent(root) {
 const manifest=JSON.parse(await readFile(join(root,'release.json'),'utf8'));
 if(manifest.format!==1 || manifest.buildId!==releaseId(manifest) || JSON.stringify(await inventoryConcurrent(root))!==JSON.stringify(manifest.files))throw Error('Release contents differ from manifest');
 return manifest;
}
