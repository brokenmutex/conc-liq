// Research-only equivalent shortcut: after liquidity reaches zero and there
// are no more initialized ticks, skip empty bitmap words to the price limit.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const target=new URL('../src/research/portfolio-math.ts',import.meta.url).href,raw=readFileSync(new URL(target),'utf8');
const expected=JSON.parse(readFileSync('notes/adaptive-lp-study-2026-09-13/manifest.json')).code['src/research/portfolio-math.ts'];
assert.equal(createHash('sha256').update(raw).digest('hex'),expected);
const before='initialized ? candidate! : wordBoundary * source.spacing';
assert.equal(raw.split(before).length,2);
const source=raw.replace(before,'initialized ? candidate! : (liquidity === 0n && candidate === undefined && source.fee === 500 && source.spacing === 10 && source.ticks.length < 10000 ? (down ? MIN_TICK : MAX_TICK) : wordBoundary * source.spacing)');
registerHooks({load(url,context,nextLoad){if(url!==target)return nextLoad(url,context);return {format:'module-typescript',source,shortCircuit:true};}});
