import assert from 'node:assert/strict';
import {summarizeReadiness,OFFICIAL_GAMES} from './readiness.mjs';
assert.equal(OFFICIAL_GAMES.length,6);
const complete={serverOnline:true,webhookReady:true,enabledGames:6,matchesEnabled:true,roomAccountConnected:true,adminRecipients:1,tronKey:true,treasuryAddress:'TValid',sharedDepositsEnabled:true,internalSettlementEnabled:true};
const r=summarizeReadiness(complete);
assert.equal(r.freeReady,true);
assert.equal(r.allReady,false,'never claim full operation before signed withdrawals and money settlement');
assert.equal(r.checks.find(c=>c.id==='deposits').ok,true);
assert.equal(r.checks.find(c=>c.id==='withdrawals').ok,false);
assert.equal(r.checks.find(c=>c.id==='settlement').ok,true,'internal USDT escrow and payout now implemented');
for(const [field,checked] of [['webhookReady','telegram'],['matchesEnabled','matches'],['roomAccountConnected','rooms']]){
 const values={...complete,[field]:false};
 const state=summarizeReadiness(values);
 assert.equal(state.checks.find(c=>c.id===checked).ok,false);
 assert.equal(state.freeReady,false);
}
const inactive=summarizeReadiness({...complete,treasuryAddress:null,sharedDepositsEnabled:false,adminRecipients:0});
assert.equal(inactive.checks.find(c=>c.id==='deposits').ok,false);
assert.equal(inactive.checks.find(c=>c.id==='admin').ok,false);
console.log('GLORY ARENA operational readiness tests PASS: 6 games, room credentials, webhook, treasury readiness and hard financial execution gates');
