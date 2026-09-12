import assert from 'node:assert/strict';
import { reconstructSwap, lowerBound, type FeeSegment, type SwapSource } from '../research/swap.js';
import type {PaperReferenceEvidence} from '../paper/reference.js';
export interface MarketSeed {
  price:string; tick:number; liquidity:string; global0:string; global1:string; protocol0:number; protocol1:number;
  ticks:{tick:number;gross:string;net:string}[];
}
export interface ExperimentEvent {block:string;hash:string;tx:number;log:number;name:string;args:Record<string,string|number>}
export interface ExperimentFrame {
  id:string; block:string; hash:string; sourceAt:string; observedAt:string; targetSetHash:string;
  price:string;tick:number;liquidity:string;global0:string;global1:string;
  referencePrice:string|null;referenceEligible:boolean;referenceBasis:string;chainHealthy:boolean;
  reasons:string[];dataValid:boolean;events:ExperimentEvent[];
  capturedAt?:string; referenceEvidence?:PaperReferenceEvidence; healthSampleIds?:readonly string[];
  decisionMode?:'historical_checkpoint_only'|'prospective'|'accounting_only';
}
const MASK=(1n<<256n)-1n;
/** Shared canonical market path. Candidate inventory never mutates this book. */
export class ExperimentMarket {
  price:bigint;tick:number;liquidity:bigint;global0:bigint;global1:bigint;protocol0:number;protocol1:number;
  readonly ticks=new Map<number,{gross:bigint;net:bigint}>();readonly sorted:number[]=[];
  constructor(seed:MarketSeed){
    this.price=BigInt(seed.price);this.tick=seed.tick;this.liquidity=BigInt(seed.liquidity);
    this.global0=BigInt(seed.global0);this.global1=BigInt(seed.global1);this.protocol0=seed.protocol0;this.protocol1=seed.protocol1;
    for(const t of seed.ticks){assert(BigInt(t.gross)>0n);this.ticks.set(t.tick,{gross:BigInt(t.gross),net:BigInt(t.net)});this.sorted.push(t.tick);}
    this.sorted.sort((a,b)=>a-b);
    assert.equal([...this.ticks].filter(([t])=>t<=this.tick).reduce((n,[,t])=>n+t.net,0n),this.liquidity,'Seed tick liquidity mismatch');
  }
  source():SwapSource{return {price:this.price,tick:this.tick,liquidity:this.liquidity,fee:500,spacing:10,ticks:this.sorted,net:t=>this.ticks.get(t)?.net??0n};}
  seed():MarketSeed{return {price:String(this.price),tick:this.tick,liquidity:String(this.liquidity),global0:String(this.global0),global1:String(this.global1),protocol0:this.protocol0,protocol1:this.protocol1,ticks:[...this.ticks].map(([tick,t])=>({tick,gross:String(t.gross),net:String(t.net)}))};}
  apply(e:ExperimentEvent):{segment:FeeSegment;protocol:number}[]{
    const a=e.args,out:{segment:FeeSegment;protocol:number}[]=[];
    if(e.name==='Swap'){
      const segments=reconstructSwap(this.source(),{price:BigInt(a.sqrtPriceX96!),tick:Number(a.tick),liquidity:BigInt(a.liquidity!),amount0:BigInt(a.amount0!),amount1:BigInt(a.amount1!)});
      for(const segment of segments)out.push({segment,protocol:segment.token===0?this.protocol0:this.protocol1});
      this.price=BigInt(a.sqrtPriceX96!);this.tick=Number(a.tick);this.liquidity=BigInt(a.liquidity!);
    }else if(e.name==='Flash'){
      for(const token of [0,1] as const)out.push({segment:{from:this.price,to:this.price,tickBefore:this.tick,liquidity:this.liquidity,fee:BigInt(a[token===0?'paid0':'paid1']!),token,crossed:null},protocol:token===0?this.protocol0:this.protocol1});
    }else if(e.name==='Mint'||e.name==='Burn'){
      const change=BigInt(a.amount!)*(e.name==='Burn'?-1n:1n),lo=Number(a.tickLower),hi=Number(a.tickUpper);
      for(const [tick,sign] of [[lo,1n],[hi,-1n]] as const){
        const old=this.ticks.get(tick),t=old??{gross:0n,net:0n};t.gross+=change;t.net+=change*sign;assert(t.gross>=0n);
        if(t.gross===0n){assert.equal(t.net,0n);if(old){this.ticks.delete(tick);this.sorted.splice(lowerBound(this.sorted,tick),1);}}
        else if(!old){this.ticks.set(tick,t);this.sorted.splice(lowerBound(this.sorted,tick),0,tick);}
      }
      if(lo<=this.tick&&this.tick<hi)this.liquidity+=change;
      assert(this.liquidity>=0n);
    }else if(e.name==='SetFeeProtocol'){
      this.protocol0=Number(a.feeProtocol0New);this.protocol1=Number(a.feeProtocol1New);
    }
    for(const {segment:s,protocol:p} of out){assert(p===0||(p>=4&&p<=10));const fee=s.fee-(p?s.fee/BigInt(p):0n);assert(s.liquidity>0n||fee===0n);const growth=s.liquidity?fee*(1n<<128n)/s.liquidity:0n;if(s.token===0)this.global0=(this.global0+growth)&MASK;else this.global1=(this.global1+growth)&MASK;}
    return out;
  }
  verify(f:Pick<ExperimentFrame,'price'|'tick'|'liquidity'|'global0'|'global1'>){assert.equal(String(this.price),f.price,'Checkpoint price mismatch');assert.equal(this.tick,f.tick,'Checkpoint tick mismatch');assert.equal(String(this.liquidity),f.liquidity,'Checkpoint liquidity mismatch');assert.equal(String(this.global0),f.global0,'Checkpoint fee0 mismatch');assert.equal(String(this.global1),f.global1,'Checkpoint fee1 mismatch');}
}
