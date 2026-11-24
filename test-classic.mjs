import assert from 'node:assert/strict';
import {GAME_LIMITS} from './game-emojis.mjs';
import {classicRound} from './classic-rules.mjs';
for(const [emoji,max] of Object.entries(GAME_LIMITS)){
  for(const mode of ['wins','total','round']){
    const a={game:emoji,mode,rounds:3,round:1,owner:1,a:0,b:0};
    const high=classicRound(a,max,1);
    assert.equal(high.nextTurn,1);
    assert.equal(high.done,false);
    assert(high.a>high.b);
    const tie=classicRound(a,max,max);
    assert.equal(tie.a,tie.b);
    assert.equal(tie.done,false);
    const final=classicRound({...a,round:3},max,1);
    assert.equal(final.done,true);
    assert.equal(final.nextTurn,null);
    assert.equal(final.nextRound,3);
    assert.throws(()=>classicRound(a,max+1,1),/INVALID_CLASSIC_ROUND/);
    assert.throws(()=>classicRound(a,1,0),/INVALID_CLASSIC_ROUND/);
  }
}
const win={game:'🎲',mode:'wins',round:2,rounds:5,owner:1,a:2,b:0};
assert.equal(classicRound(win,6,1).done,true,'first to three victories finishes early');
const sum={game:'🏀',mode:'total',round:2,rounds:3,owner:11,a:5,b:4};
const scores=classicRound(sum,3,4);
assert.equal(scores.a,8);assert.equal(scores.b,8);
assert.equal(scores.done,false);
assert.equal(scores.nextTurn,11);
console.log('GLORY ARENA six-game classic scoring regression PASS: all modes, ties, thresholds, invalid scores');
