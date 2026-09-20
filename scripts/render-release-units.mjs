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
// Units this renderer does not own, with the reason it does not. A release
// identity is not the right thing to stamp on either of them: the adaptive
// paper unit is a placeholder template that also needs a per-session state
// path, and telemetry retention deliberately runs from the source checkout.
// Rewriting them here would silently repoint a service the operator manages
// by another route.
const excluded={
 'conc-liq-adaptive-paper.service':'placeholder template; substitute @RELEASE@, @ENV@ and @STATE@ per session, as ops/experiments does',
 'conc-liq-telemetry-retention.service':'source-checkout maintenance that carries no release identity',
 'conc-liq-telemetry-retention.timer':'schedules a unit this renderer does not own',
};
const units=readdirSync('ops').filter(f=>f.endsWith('.service') || f.endsWith('.timer'));
// Both lists name real files, so a renamed or deleted unit cannot leave a stale
// entry behind that quietly stops being rendered against the new release.
for(const name of [...Object.keys(commands),...Object.keys(excluded)])if(!units.includes(name))throw Error(`Declared unit is missing from ops/: ${name}`);
mkdirSync(output,{recursive:true});
const rendered=[],skipped={};
for(const file of units){
 // An unlisted unit still fails: a new service must be classified before a
 // deployment can render it.
 if(excluded[file]){skipped[file]=excluded[file];continue;}
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
 rendered.push(file);
}
console.log(JSON.stringify({output:resolve(output),installed:false,rendered:rendered.sort(),skipped}));
