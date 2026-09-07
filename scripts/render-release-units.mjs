import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { verifyRelease } from './release-files.mjs';
const [release,envFile,output]=process.argv.slice(2);
if(!release || !envFile || !output || process.argv.length!==5 || ![release,envFile,output].every(p=>/^\/[A-Za-z0-9_./-]+$/.test(p)))throw Error('Usage: render-release-units.mjs /release /private/runtime.env /output (paths without spaces or systemd specifiers)');
verifyRelease(release);
const commands={
 'conc-liq-paper.service':['paper tick'],
 'conc-liq-dashboard.service':['dashboard'],
 'conc-liq-tail.service':['tail'],
 'conc-liq-rpc-health.service':['rpc-health'],
 'conc-liq-strategy-checkpoint.service':['strategy-checkpoint --rwa NVDA --fee 500'],
 'conc-liq-perp-reference.service':['perp-reference snapshot','perp-basis --rwa NVDA --fee 500'],
 'conc-liq-accounting.service':['accounting --if-new-source','principal --if-available','nft --if-configured','backtest --if-available','action-cost --lookback-blocks 50000 --max-per-class 25'],
};
mkdirSync(output,{recursive:true});
for(const file of readdirSync('ops').filter(f=>f.endsWith('.service') || f.endsWith('.timer'))){
 let text=readFileSync(join('ops',file),'utf8');
 if(file.endsWith('.service')){
  if(!commands[file])throw Error(`Unknown service: ${file}`);
  text=text.split('\n').filter(line=>!line.startsWith('EnvironmentFile=') && !line.startsWith('Environment=')).join('\n');
  text=text.replace(/^WorkingDirectory=.*$/m,`WorkingDirectory=${resolve(release)}`);
  let index=0;
  text=text.replace(/^ExecStart=.*$/gm,()=>{const command=commands[file][index++];if(!command)throw Error(`Unexpected command count: ${file}`);return `ExecStart=${resolve(release)}/bin/node ${resolve(release)}/launch.mjs ${resolve(envFile)} ${command}`;});
  if(index!==commands[file].length)throw Error(`Missing commands: ${file}`);
 }
 writeFileSync(join(output,file),text);
}
console.log(JSON.stringify({output:resolve(output),installed:false}));
