// Research-process-only memoization of an immutable integer function.
// Source files and strategy code remain unchanged; an exhaustive certificate
// and a byte-identical retained replay are required before study use.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const target=new URL('../src/backtest/principal.ts',import.meta.url).href;
const expected=JSON.parse(readFileSync('notes/adaptive-lp-study-2026-09-13/manifest.json')).code['src/backtest/principal.ts'];
assert.equal(createHash('sha256').update(readFileSync(new URL(target))).digest('hex'),expected);
registerHooks({load(url,context,nextLoad){const result=nextLoad(url,context);if(url!==target)return result;
 let source=typeof result.source==='string'?result.source:Buffer.from(result.source).toString('utf8');
 const direct=source.includes('export function sqrtRatioAtTick('),needle=direct?'export function sqrtRatioAtTick(':'function sqrtRatioAtTick(';
 assert.equal(source.split(needle).length,2,'Unexpected tick-function transform');
 source=source.replace(needle,'function __researchUncachedSqrtRatioAtTick(');
 source+='\nconst __researchTickMemo=new Map();\n'+(direct?'export ':'')+'function sqrtRatioAtTick(tick){const previous=__researchTickMemo.get(tick);if(previous!==undefined)return previous;const value=__researchUncachedSqrtRatioAtTick(tick);if(__researchTickMemo.size>=32768)__researchTickMemo.clear();__researchTickMemo.set(tick,value);return value;}\n';
 return {...result,source};
}});
