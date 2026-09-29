// Read-only release gate for the dashboard and command service asset split.
// Usage: node --import tsx test/integration/dashboard-release-coherence.mjs \
//   RELEASE DASHBOARD_URL COMMAND_URL [PUBLIC_URL]
// Local route fixture: node --import tsx test/integration/dashboard-release-coherence.mjs --self-test
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash, inventory, releaseId, verifyRelease} from '../../scripts/release-files.mjs';

const documentPath='/dashboard/index.html';
const dashboardDocumentRoutes=[{path:'/',file:documentPath}];
const commandDocumentRoutes=[{path:'/operator',file:documentPath},{path:'/operator/',file:documentPath}];
const publicDocumentRoutes=[...dashboardDocumentRoutes,...commandDocumentRoutes];
const FETCH_TIMEOUT_MS=10_000;

function baseUrl(value,label){
 let url;
 try{url=new URL(value);}catch{throw Error(`${label} must be an absolute HTTP(S) URL`);}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')
  throw Error(`${label} must be an HTTP(S) origin without credentials, path, query or fragment`);
 return url.origin;
}

function localAssetPath(specifier,fromPath){
 let url;
 try{url=new URL(specifier,`https://release.invalid${fromPath}`);}catch{return null;}
 if(url.origin!=='https://release.invalid'||url.search||url.hash)return null;
 return url.pathname;
}

function linkedPaths(html){
 const paths=[];
 for(const match of html.matchAll(/<(script|link)\b[^>]*>/gi)){
  const tag=match[0],name=match[1].toLowerCase();
  const attr=name==='script'?'src':'href';
  const ref=new RegExp(`\\b${attr}\\s*=\\s*(["'])(.*?)\\1`,'i').exec(tag)?.[2];
  if(!ref||!(/\.m?js(?:$|[?#])|\.css(?:$|[?#])|\.html(?:$|[?#])/i.test(ref)))continue;
  const path=localAssetPath(ref,'/');if(path)paths.push(path);
 }
 return paths;
}

function importedPaths(source,fromPath){
 const paths=[];
 const pattern=/\b(?:import|export)\s*(?:\(\s*(["'])([^"']+)\1\s*\)|(?:[^'";]*?\s+from\s*)?(["'])([^"']+)\3)/g;
 for(const match of source.matchAll(pattern)){
  const specifier=match[2]??match[4];
  if(!specifier)continue;
  const path=localAssetPath(specifier,fromPath);if(path)paths.push(path);
 }
 return paths;
}

function collectSharedAssets(release){
 const root=resolve(release),htmlFile=join(root,documentPath.slice(1));
 const html=readFileSync(htmlFile,'utf8'),pending=linkedPaths(html),assets=new Map([[documentPath,{file:documentPath,bytes:readFileSync(htmlFile)}]]);
 while(pending.length){
  const route=pending.pop();
  if(assets.has(route))continue;
  if(!/^\/(?:[A-Za-z0-9._/-]+)$/.test(route)||route.split('/').includes('..'))
   throw Error(`Unsafe linked dashboard asset path: ${route}`);
  const file=`/dashboard${route}`;
  const absolute=resolve(root,`.${file}`);
  if(!absolute.startsWith(`${root}${sep}`))throw Error(`Dashboard asset escapes release: ${route}`);
  let bytes;
  try{bytes=readFileSync(absolute);}catch{throw Error(`Release is missing linked dashboard asset ${file}`);}
  assets.set(route,{file,bytes});
  if(route.endsWith('.js')||route.endsWith('.mjs'))pending.push(...importedPaths(bytes.toString('utf8'),route));
  if(route.endsWith('.css')){
   for(const match of bytes.toString('utf8').matchAll(/@import\s+(?:url\()?\s*(["'])([^"']+)\1\s*\)?/gi)){
    const imported=localAssetPath(match[2],route);if(imported)pending.push(imported);
   }
  }
 }
 return assets;
}

async function fetchBytes(fetchImpl,url){
 let response,bytes;
 try{
  response=await fetchImpl(url,{method:'GET',redirect:'manual',cache:'no-store',
   signal:AbortSignal.timeout(FETCH_TIMEOUT_MS),headers:{accept:'*/*'}});
  bytes=Buffer.from(await response.arrayBuffer());
 }catch(error){throw Error(`GET failed for ${new URL(url).pathname}: ${error instanceof Error?error.message:'network_error'}`);}
 return {status:response.status,bytes};
}

export async function checkDashboardCoherence({releasePath,dashboardURL,commandURL,publicURL,
 fetchImpl=globalThis.fetch}={}){
 if(!releasePath)throw Error('A verified sealed release path is required');
 const release=resolve(releasePath),manifest=verifyRelease(release),assets=collectSharedAssets(release);
 const targets=[{name:'dashboard',origin:baseUrl(dashboardURL,'DASHBOARD_URL'),documents:dashboardDocumentRoutes},
  {name:'command',origin:baseUrl(commandURL,'COMMAND_URL'),documents:commandDocumentRoutes}];
 if(publicURL)targets.push({name:'public',origin:baseUrl(publicURL,'PUBLIC_URL'),documents:publicDocumentRoutes});
 const checks=[];
 for(const target of targets){
  for(const document of target.documents){
   const expected=assets.get(document.file);
   await compare(target,document.path,expected);
  }
  for(const [route,expected] of assets){if(route===documentPath)continue;await compare(target,route,expected);}
 }
 return {status:'passed',buildId:manifest.buildId,assets:[...assets.keys()].sort(),targets:targets.map(x=>x.name),checks};

 async function compare(target,route,expected){
  const actual=await fetchBytes(fetchImpl,`${target.origin}${route}`),expectedHash=hash(expected.bytes),actualHash=hash(actual.bytes);
  const check={service:target.name,path:route,status:actual.status,expectedSha256:expectedHash,actualSha256:actualHash};
  checks.push(check);
  if(actual.status!==200||!actual.bytes.equals(expected.bytes))
   throw Error(`Dashboard release mismatch at ${target.name}${route}: HTTP ${actual.status}, expected HTTP 200 and sealed bytes ${expectedHash}, received ${actualHash}`);
 }
}

function startFixture(files,{mismatchPath=null,documents=[]}={}){
 const server=createServer((request,response)=>{
  const route=new URL(request.url??'/', 'http://fixture').pathname;
  const document=documents.find(item=>item.path===route),
   file=document?files.get(document.file):files.get(route);
  if(!file){response.writeHead(404);response.end('missing');return;}
  const bytes=route===mismatchPath?Buffer.from(`${file.toString()}\nfixture mismatch`):file;
  response.writeHead(200);response.end(bytes);
 });
 return new Promise((resolveServer,reject)=>{
  server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
   const address=server.address();if(!address||typeof address==='string')return reject(Error('fixture listen failed'));
   resolveServer({server,url:`http://127.0.0.1:${address.port}`});
  });
 });
}

async function selfTest(){
 const parent=mkdtempSync(join(tmpdir(),'dashboard-coherence-'));
 const release=join(parent,'release'),dashboard=join(release,'dashboard');mkdirSync(dashboard,{recursive:true});
 const files={
  'index.html':'<!doctype html><link rel="stylesheet" href="/styles.css"><script type="module" src="/app.js"></script><script type="module" src="/tabs.js"></script>',
  'styles.css':'body { color: white; }',
  'app.js':"import {x} from './deployment-actions.js'; void x; void import('./lazy.js');",
  'deployment-actions.js':'export const x = 1;',
  'lazy.js':'export const lazy = true;',
  'tabs.js':"import {x} from './operator-session.js'; void x;",
  'operator-session.js':'export const x = 1;',
 };
 for(const [file,content] of Object.entries(files))writeFileSync(join(dashboard,file),content);
 const manifest={format:1,sourceCommit:'fixture',nodeVersion:process.version,files:inventory(release)};
 manifest.buildId=releaseId(manifest);writeFileSync(join(release,'release.json'),JSON.stringify(manifest,null,2)+'\n');
 const expected=collectSharedAssets(release);
 const fixtureFiles=new Map([['/dashboard/index.html',readFileSync(join(dashboard,'index.html'))]]);
 for(const [route,asset] of expected)if(route!==documentPath)fixtureFiles.set(route,asset.bytes);
 assert(expected.has('/deployment-actions.js')&&expected.has('/operator-session.js')&&expected.has('/lazy.js'),
  'transitive dependencies from the linked modules must be included');
 const dashboardFixture=await startFixture(fixtureFiles,{documents:dashboardDocumentRoutes}),
  commandFixture=await startFixture(fixtureFiles,{documents:commandDocumentRoutes}),
  publicFixture=await startFixture(fixtureFiles,{documents:publicDocumentRoutes}),
  mismatchFixture=await startFixture(fixtureFiles,{mismatchPath:'/tabs.js',documents:commandDocumentRoutes});
 try{
  const baseline=await checkDashboardCoherence({releasePath:release,dashboardURL:dashboardFixture.url,
   commandURL:commandFixture.url,publicURL:publicFixture.url});
  assert.equal(baseline.status,'passed');assert(baseline.checks.length>=20);
  assert.equal((await fetch(`${dashboardFixture.url}/operator`)).status,404,
   'the dashboard service does not serve the operator document');
  assert.equal((await fetch(`${commandFixture.url}/`)).status,404,
   'the command service does not serve the read-only dashboard document');
  await assert.rejects(checkDashboardCoherence({releasePath:release,dashboardURL:dashboardFixture.url,
   commandURL:mismatchFixture.url}),/release mismatch at command\/tabs\.js/);
  console.log(JSON.stringify({status:'passed',cases:['verified release and all routes match','mismatched module asset is rejected']}));
 }finally{
  for(const fixture of [dashboardFixture,commandFixture,publicFixture,mismatchFixture])
   await new Promise(resolveServer=>fixture.server.close(resolveServer));
  rmSync(parent,{recursive:true,force:true});
 }
}

if(import.meta.url===pathToFileURL(resolve(process.argv[1]??'')).href){
 const args=process.argv.slice(2);
 if(args.length===1&&args[0]==='--self-test')await selfTest();
 else{
  const [releasePath,dashboardURL,commandURL,publicURL]=args;
  if(args.length<3||args.length>4)throw Error('Usage: node --import tsx test/integration/dashboard-release-coherence.mjs RELEASE DASHBOARD_URL COMMAND_URL [PUBLIC_URL]');
  console.log(JSON.stringify(await checkDashboardCoherence({releasePath,dashboardURL,commandURL,publicURL})));
 }
}
