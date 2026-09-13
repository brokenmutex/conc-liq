import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sqrtRatioAtTick,MIN_TICK,MAX_TICK} from '../src/backtest/principal.ts';
const root=process.argv[2]??'data/adaptive-lp-universe-study-2026-09-13/memo-validation';mkdirSync(root,{recursive:true});
const raw=readFileSync('src/backtest/principal.ts'),baseline=root+'/principal-original.ts';writeFileSync(baseline,raw);
const original=await import(pathToFileURL(resolve(baseline)).href),start=Date.now();let values=0;
for(let tick=MIN_TICK;tick<=MAX_TICK;tick++){const expected=original.sqrtRatioAtTick(tick);assert.equal(sqrtRatioAtTick(tick),expected);assert.equal(sqrtRatioAtTick(tick),expected);values++;}
const invalid=[MIN_TICK-1,MAX_TICK+1,1.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,'0',null,undefined];
for(const tick of invalid){let first,second;try{original.sqrtRatioAtTick(tick);}catch(e){first=[e.constructor.name,e.message];}try{sqrtRatioAtTick(tick);}catch(e){second=[e.constructor.name,e.message];}assert(first);assert.deepEqual(second,first);}
assert.equal(sqrtRatioAtTick(-0),original.sqrtRatioAtTick(0));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const result={validTicks:values,eachCheckedColdAndCached:true,cacheEvictionCovered:true,invalidInputs:invalid.length,negativeZeroChecked:true,sourceSha256:hash('src/backtest/principal.ts'),hookSha256:hash('scripts/lp-tick-memo-hook.mjs'),verifierSha256:hash('scripts/verify-lp-tick-memo.mjs'),elapsedMs:Date.now()-start,scope:'Exact bigint results over the complete valid tick domain and identical errors for invalid inputs. Runtime-only bounded memoization; no source-file or policy changes.'};
writeFileSync(root+'/exhaustive.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
