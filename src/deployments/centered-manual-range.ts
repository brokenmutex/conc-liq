import {MIN_TICK,MAX_TICK} from '../backtest/principal.js';
import {alignManualRange} from '../strategy/static-manual/planner.js';
import {staticManualParameters} from './contracts.js';

/** Resolve the setup half-width around the nearest usable tick. Setup choices
 * are tick-spacing multiples, so the aligned range preserves the requested
 * width exactly. The fresh preview source supplies centerTick. */
export function resolveCenteredManualRange(centerTick:number,halfWidthTicks:number,spacing:number){
 if(!Number.isSafeInteger(centerTick)||centerTick<MIN_TICK||centerTick>MAX_TICK)
  throw Error('manual_center_tick_invalid');
 if(!Number.isSafeInteger(spacing)||spacing<=0)throw Error('manual_tick_spacing_invalid');
 if(!Number.isSafeInteger(halfWidthTicks)||halfWidthTicks<=0||halfWidthTicks%spacing!==0)
  throw Error('manual_half_width_not_spacing_aligned');
 const centerAnchorTick=Math.round(centerTick/spacing)*spacing;
 const requestedLower=centerAnchorTick-halfWidthTicks;
 const requestedUpper=centerAnchorTick+halfWidthTicks;
 if(requestedLower<MIN_TICK||requestedUpper>MAX_TICK)
  throw Error('manual_centered_range_tick_bounds');
 const aligned=alignManualRange(requestedLower,requestedUpper,spacing);
 if(aligned.tickLower!==requestedLower||aligned.tickUpper!==requestedUpper||
  centerTick<aligned.tickLower||centerTick>=aligned.tickUpper)
  throw Error('manual_centered_range_resolution_invalid');
 return {...aligned,centerTick,centerAnchorTick,halfWidthTicks};
}

/** Bind a persisted setup request to the preview's canonical pool tick. Legacy
 * explicit bounds remain readable for existing recovery records. */
export function resolveStaticManualRange(parameters:unknown,centerTick:number,spacing:number){
 const parsed=staticManualParameters.parse(parameters);
 if('halfWidthTicks'in parsed)
  return resolveCenteredManualRange(centerTick,parsed.halfWidthTicks,spacing);
 return alignManualRange(parsed.tickLower,parsed.tickUpper,spacing);
}
