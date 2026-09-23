import assert from 'node:assert/strict';
import type {PaperOpenModel} from './paper-open-model.js';
import type {MarketProfile} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';

export interface PaperCloseConvertPersistedTerminal {
 ending:'close_convert'|'close_retain'|'valuation';fromMarkId:string;toMarkId:string;
 profile:MarketProfile;range:{tickLower:number;tickUpper:number};liquidity:bigint;
 after:{source:{block:string;hash:string;timestamp:number}};
}

/** Ensures the supplied replay context is anchored to the store's actual
 * converted-close endpoint before an owned fork is started. */
export function assertPaperCloseConvertSampleContext(input:{campaignId:string;
 terminalMarkId:string;previousMarkId:string;profile:MarketProfile;openModel:PaperOpenModel;
 frame:PaperOpenFrame},terminal:PaperCloseConvertPersistedTerminal|null){
 assert(terminal&&terminal.ending==='close_convert','Persisted converted-close endpoint is unavailable');
 assert.equal(input.campaignId,input.openModel.campaignId);
 assert.equal(input.profile.pool.pool.toLowerCase(),terminal.profile.pool.pool.toLowerCase());
 assert.equal(terminal.toMarkId,input.terminalMarkId);
 assert.equal(terminal.fromMarkId,input.previousMarkId);
 assert.deepEqual(terminal.after.source,input.frame.source,'Input source differs from persisted terminal source');
 assert.equal(terminal.range.tickLower,input.openModel.candidate.range.tickLower);
 assert.equal(terminal.range.tickUpper,input.openModel.candidate.range.tickUpper);
 assert.equal(terminal.liquidity,BigInt(input.openModel.candidate.liquidity));
}
