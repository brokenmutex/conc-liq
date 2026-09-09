import {execFileSync} from 'node:child_process';
import {dirname} from 'node:path';
import {readFile,mkdir} from 'node:fs/promises';
import {loadRuntimeIdentity} from './runtime/identity.js';
import {ExperimentSource} from './experiment/source.js';
import {capture,loadDataset,screen,parse,startForward,tickForward} from './experiment/runner.js';
async function main(){
 const [command,...args]=process.argv.slice(2);
 if(command==='status'){console.log(await readFile(args[0]!+'.status.md','utf8'));return;}
 if(command==='screen'){const result=await screen(await loadDataset(args[0]!),args[1]!);console.log(JSON.stringify({windows:result.windows.length,selected:result.selected,scores:result.scores}));return;}
 if(['start','tick','watch'].includes(command!)&&process.env.LP_EXPERIMENT_LOCK!=='1'){
  const path=command==='start'?args[1]:args[0];if(!path)throw Error('Experiment state path required');
  await mkdir(dirname(path),{recursive:true});
  try{execFileSync('/usr/bin/flock',['-n',path+'.lock',process.execPath,...process.execArgv,...process.argv.slice(1)],{stdio:'inherit',env:{...process.env,LP_EXPERIMENT_LOCK:'1'}});}
  catch(error){if((error as {status?:number}).status===2){process.exitCode=2;return;}throw error;}return;
 }
 const source=new ExperimentSource(process.env.DATABASE_URL!);await source.connect();
 try{
  if(command==='capture')console.log(JSON.stringify(await capture(source,args[0]!,args[1]!,args[2]!)));
  else if(command==='start'){const selection=parse(await readFile(args[0]!,'utf8'));const state=await startForward(source,selection.selected,selection.costEvidence.costs,loadRuntimeIdentity(),args[1]!);console.log(JSON.stringify({createdAt:state.createdAt,candidates:state.candidates,status:state.status}));}
  else if(command==='tick'||command==='watch'){
   do{const state=await tickForward(source,args[0]!,loadRuntimeIdentity());console.log(JSON.stringify({at:new Date().toISOString(),status:state.status,reason:state.reason,source:state.lastFrame.sourceAt,candidates:state.candidates.map((c,i)=>({id:c.id,entries:state.states[i]!.entries,invalid:state.states[i]!.invalid}))}));if(state.status==='invalid'){process.exitCode=2;break;}if(command==='tick')break;await new Promise(resolve=>setTimeout(resolve,15000));}while(true);
  }else throw Error('Usage: lp-experiment capture FROM TO OUTPUT | screen INPUT OUTPUT | start SELECTION STATE | tick STATE | watch STATE');
 }finally{await source.close();}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Experiment failed');process.exitCode=1;});
