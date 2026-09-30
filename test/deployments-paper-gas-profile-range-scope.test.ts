import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES,costIndicativePaperOpenPreview,
 type PaperGasProfileRow} from '../src/deployments/paper-cost.js';
import {DeploymentStore} from '../src/deployments/store.js';

const poolAddress='0x'+'a'.repeat(40);
const now=Date.now();

/** A complete, currently-valid six-stage band at one exact tick range. Every
 * setup review samples a brand-new band at the candidate's exact range, so a
 * pool accumulates one of these per review at whatever range it reviewed. */
function band(sizeBand:string,tickLower:number,tickUpper:number):PaperGasProfileRow[]{
 return PAPER_STATIC_GAS_STAGES.map(stage=>{
  const source={block:'100',hash:'0x'+'1'.repeat(64),estimatedAt:new Date(now-5000).toISOString(),
   callHash:'0x'+'2'.repeat(64),method:'owned_fork_nitro_exact_call_v1' as const};
  const model={schemaVersion:1 as const,source,gasUnitsExpected:'100000',gasUnitsBound:'150000',
   sizeMinValue:'1',sizeMaxValue:String(10n**24n),shareMinPpm:'0',shareMaxPpm:'1000000',
   tickLower,tickUpper};
  return {id:randomUUID(),version:1,poolAddress,pathVersion:PAPER_STATIC_GAS_PATH,stage,
   allowanceState:'zero',sizeBand,component:'gas_units',status:'provisional',
   evidenceClass:'fork_estimated',model,sourceHash:contentHash(source),
   observedUntil:new Date(now-5000)} satisfies PaperGasProfileRow;
 });
}

/** Wires a DeploymentStore to a fake read pool that behaves like Postgres
 * would for the paperGasProfiles query: it always applies the pool/path/
 * component/allowance filters, and additionally applies the exact tick-range
 * filter only when the query text carries it. Rows outside chain_id, pool or
 * path never leak in even from the pre-fix code path, matching what the real
 * WHERE clause always enforced; the tick predicate is what this change adds. */
function storeOverAllRows(rows:PaperGasProfileRow[]){
 const store=new DeploymentStore('postgresql://localhost/unused');
 (store as unknown as {readPool:{query:(sql:string,params:unknown[])=>
  Promise<{rows:PaperGasProfileRow[]}>;end:()=>Promise<void>}}).readPool={
  query:async(sql,params)=>{
   let matched=rows.filter(row=>row.poolAddress.toLowerCase()===String(params[0]).toLowerCase()&&
    row.pathVersion===params[1]);
   if(sql.includes("(model->>'tickLower')::int=$")){
    const tickLower=params[2] as number,tickUpper=params[3] as number;
    matched=matched.filter(row=>(row.model as {tickLower:number}).tickLower===tickLower&&
     (row.model as {tickUpper:number}).tickUpper===tickUpper);
   }
   return {rows:matched};
  },end:async()=>{}};
 return store;
}

test('paperGasProfiles excludes rows outside the candidate\'s exact tick range',async()=>{
 // A pool with a review at the candidate range and, separately, eleven other
 // reviews' worth of bands at ranges the pool has since moved through. None
 // of those can ever validate against this candidate (valid() requires exact
 // equality on both ticks), so a correct query must not spend the 201-row
 // budget on them.
 const candidateBand=band('candidate_band',100,200);
 const otherRanges=Array.from({length:11},(_,i)=>band(`other_band_${i}`,300+i,400+i)).flat();
 const store=storeOverAllRows([...candidateBand,...otherRanges]);
 try{
  const rows=await store.paperGasProfiles(poolAddress,100,200);
  assert.equal(rows.length,6,'only the exact-range band should come back');
  assert(rows.every(row=>(row.model as {tickLower:number}).tickLower===100&&
   (row.model as {tickUpper:number}).tickUpper===200),
   'no row from an unrelated tick range may be returned');
 }finally{await store.close();}
});

test('a complete band at the exact candidate range still resolves to provisional costs',async()=>{
 const store=storeOverAllRows(band('candidate_band',100,200));
 try{
  const rows=await store.paperGasProfiles(poolAddress,100,200);
  const preview={status:'indicative' as const,
   candidate:{range:{tickLower:100,tickUpper:200},deployedValue:'1000000000000000000',
    dilutedSharePpm:'500000'}};
  const costed=costIndicativePaperOpenPreview(preview,rows,poolAddress,10n**18n,1_000_000_000n,now);
  assert.equal(costed.costs.status,'provisional');
 }finally{await store.close();}
});

test('single-range pools cost the same as before scoping was added',async()=>{
 // When every row in the pool already shares one range, scoping by that exact
 // range cannot change which evidence validates: it is the same row set the
 // unscoped query would have returned.
 const rows=band('only_band',100,200);
 const preview={status:'indicative' as const,
  candidate:{range:{tickLower:100,tickUpper:200},deployedValue:'1000000000000000000',
   dilutedSharePpm:'500000'}};
 const scoped=storeOverAllRows(rows);
 try{
  const scopedRows=await scoped.paperGasProfiles(poolAddress,100,200);
  const before=costIndicativePaperOpenPreview(preview,rows,poolAddress,10n**18n,1_000_000_000n,now);
  const after=costIndicativePaperOpenPreview(preview,scopedRows,poolAddress,10n**18n,1_000_000_000n,now);
  assert.deepEqual(after,before);
 }finally{await scoped.close();}
});
