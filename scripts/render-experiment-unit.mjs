import {readFileSync,writeFileSync} from 'node:fs';
import {verifyRelease} from './release-files.mjs';
const [release,env,state,output]=process.argv.slice(2);
if(![release,env,state,output].every(p=>typeof p==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(p)))throw Error('Usage: render-experiment-unit.mjs RELEASE PRIVATE_ENV STATE OUTPUT (absolute paths)');
verifyRelease(release);
const text=readFileSync('ops/experiments/conc-liq-experiment.service','utf8').replaceAll('@RELEASE@',release).replaceAll('@ENV@',env).replaceAll('@STATE@',state);
writeFileSync(output,text,{flag:'wx'});
console.log(JSON.stringify({output,installed:false}));
