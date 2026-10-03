import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {parsePositionManagerWalletIndexArgs} from '../src/nft-wallet-index.js';

test('wallet transfer maintenance CLI help exits without environment or network configuration',()=>{
 const result=spawnSync(process.execPath,['--import','tsx',resolve('src/nft-wallet-index.ts'),'--help'],
  {cwd:process.cwd(),env:{},encoding:'utf8',timeout:10_000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/v14 schema/);
 assert.match(result.stdout,/10000000 blocks\/chunk/);
});

test('wallet transfer maintenance bounds are explicit and reject malformed or oversized values',()=>{
 assert.deepEqual(parsePositionManagerWalletIndexArgs([]),{chunkBlocks:10_000_000n,maxBlocksPerRun:100_000_000n});
 assert.deepEqual(parsePositionManagerWalletIndexArgs(['--chunk-blocks','100','--max-blocks','500']),
  {chunkBlocks:100n,maxBlocksPerRun:500n});
 for(const args of [
  ['--chunk-blocks','10000001'],['--max-blocks','100000001'],['--chunk-blocks','501','--max-blocks','500'],
  ['--chunk-blocks','1.5'],['--manager','0x1111111111111111111111111111111111111111'],
 ])assert.throws(()=>parsePositionManagerWalletIndexArgs(args));
});
