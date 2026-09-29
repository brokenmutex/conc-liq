// Private Chromium/CDP lifecycle for dashboard acceptance fixtures.
import {spawn} from 'node:child_process';
import {access,mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function startDashboardBrowser(){
 const temp=await mkdtemp(join(tmpdir(),'dashboard-acceptance-'));
 const candidates=process.env.CHROMIUM_PATH?[process.env.CHROMIUM_PATH]:
  (await readdir('/root/.cache/ms-playwright').catch(()=>[])).filter(n=>/^chromium-\d+$/.test(n))
   .sort((a,b)=>Number(b.slice(9))-Number(a.slice(9)))
   .map(n=>`/root/.cache/ms-playwright/${n}/chrome-linux64/chrome`);
 let executable;for(const file of candidates){try{await access(file);executable=file;break;}catch{}}
 if(!executable){await rm(temp,{recursive:true,force:true});throw Error('Chromium unavailable');}
 const child=spawn(executable,['--headless=new','--no-sandbox','--disable-dev-shm-usage',
  '--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',
  `--user-data-dir=${temp}`,'about:blank'],{stdio:'ignore'});
 const sockets=[];
 const close=async()=>{
  for(const ws of sockets)ws.close();child.kill('SIGTERM');
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(1500)]);
  if(child.exitCode===null)child.kill('SIGKILL');
  await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
 };
 try{
  let port;for(let i=0;i<100;i++){try{port=Number((await readFile(join(temp,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break;}catch{}await wait(100);}
  if(!port)throw Error('Chromium did not expose CDP');
  async function connect(url){
   const ws=new WebSocket(url);sockets.push(ws);
   await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
   let sequence=0;const pending=new Map(),listeners=new Map();
   ws.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.id){const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);
     message.error?entry.reject(Error(message.error.message)):entry.resolve(message.result);}
    else for(const listener of listeners.get(message.method)??[])listener(message.params);
   });
   ws.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('CDP closed'));}pending.clear();});
   const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method}`));},30000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
   });
   const evaluate=async expression=>{
    const response=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(response.exceptionDetails)throw Error(response.exceptionDetails.text??'browser evaluation failed');
    return response.result?.value;
   };
   const waitFor=async(expression,timeout=30000)=>{const deadline=Date.now()+timeout;
    do{if(await evaluate(expression))return;await wait(100);}while(Date.now()<deadline);throw Error(`Browser condition timed out: ${expression}`);};
   return {send,evaluate,waitFor,on(method,handler){const list=listeners.get(method)??[];list.push(handler);listeners.set(method,list);}};
  }
  const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser=await connect(version.webSocketDebuggerUrl);
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page=await connect(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  return {child,temp,port,page,browser,connect,close};
 }catch(error){await close();throw error;}
}
