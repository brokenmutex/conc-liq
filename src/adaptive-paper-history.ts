import {appendFile,readFile} from 'node:fs/promises';
import {z} from 'zod';
import {marketValue,type PaperMarket} from './paper/market.js';

const markSchema=z.object({
 version:z.literal(1),symbol:z.string().regex(/^[A-Z0-9.]+$/),sourceAt:z.string().datetime({offset:true}),observedAt:z.string().datetime({offset:true}),block:z.string().regex(/^\d+$/),
 continuity:z.enum(['baseline','continuous']),action:z.string().min(1),status:z.string().min(1),navQuote:z.string().regex(/^-?\d+$/),holdQuote:z.string().regex(/^-?\d+$/),
 sqrtPriceX96:z.string().regex(/^\d+$/),priceQuoteX18:z.string().regex(/^\d+$/),usdg:z.string().regex(/^-?\d+$/),rwa:z.string().regex(/^-?\d+$/),exposurePpm:z.string().regex(/^-?\d+$/),
 inRange:z.boolean(),tickLower:z.number().int().nullable(),tickUpper:z.number().int().nullable(),fees0:z.string().regex(/^\d+$/),fees1:z.string().regex(/^\d+$/),
 gasThisMarkQuote:z.string().regex(/^\d+$/).nullable(),swapThisMarkQuote:z.string().regex(/^\d+$/).nullable(),swapsThisMark:z.number().int().nonnegative(),drawdownPpm:z.string().regex(/^\d+$/),
}).strict();
export type AdaptivePaperMark=z.infer<typeof markSchema>;

export function adaptiveHistoryPath(statePath:string,symbol:string){
 if(!/^[A-Z0-9.]+$/.test(symbol))throw new Error('Invalid adaptive paper history symbol');
 return `${statePath}.${symbol.toLowerCase()}.marks.jsonl`;
}
export async function appendAdaptivePaperMark(statePath:string,mark:AdaptivePaperMark){
 const parsed=markSchema.parse(mark);await appendFile(adaptiveHistoryPath(statePath,parsed.symbol),JSON.stringify(parsed)+'\n');
}
export async function readAdaptivePaperMarks(statePath:string,symbol:string){
 let raw:string;try{raw=await readFile(adaptiveHistoryPath(statePath,symbol),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
 const lines=raw.split('\n'),byBlock=new Map<string,AdaptivePaperMark>();
 for(const [index,line] of lines.entries()){if(!line)continue;let mark:AdaptivePaperMark;
  try{mark=markSchema.parse(JSON.parse(line));}catch(error){if(index===lines.length-1&&!raw.endsWith('\n'))break;throw error;}
  if(mark.symbol!==symbol)throw new Error('Adaptive paper history symbol mismatch');byBlock.set(mark.block,mark);}
 return [...byBlock.values()].sort((a,b)=>{const time=Date.parse(a.sourceAt)-Date.parse(b.sourceAt);if(time)return time;const left=BigInt(a.block),right=BigInt(b.block);return left<right?-1:left>right?1:0;});
}
export function adaptiveHistoryPoint(market:PaperMarket,mark:AdaptivePaperMark,previous?:AdaptivePaperMark){
 const baseline=mark.continuity==='baseline'||!previous;
 const fees=baseline?null:String(marketValue(market,BigInt(mark.sqrtPriceX96),BigInt(mark.fees0)-BigInt(previous.fees0),BigInt(mark.fees1)-BigInt(previous.fees1)));
 return {sourceAt:mark.sourceAt,observedAt:mark.observedAt,block:mark.block,action:mark.action,status:mark.status,economicNavQuote:mark.navQuote,holdQuote:mark.holdQuote,
  priceQuoteX18:mark.priceQuoteX18,usdg:mark.usdg,nvda:mark.rwa,exposurePpm:mark.exposurePpm,inRange:mark.inRange,tickLower:mark.tickLower,tickUpper:mark.tickUpper,
  feesThisIntervalQuote:fees,gasThisMarkQuote:baseline?null:mark.gasThisMarkQuote,swapThisMarkQuote:baseline?null:mark.swapThisMarkQuote,swapsThisMark:baseline?0:mark.swapsThisMark,drawdownPpm:mark.drawdownPpm};
}
