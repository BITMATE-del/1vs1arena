import assert from 'node:assert/strict';
import {GAME_LIMITS,GAME_TITLES,gameEmoji,validDiceMessage,gameInstructions} from './game-emojis.mjs';
const expected={'🎲':6,'🏀':5,'⚽':5,'🎯':6,'🎳':6,'🎰':64};
for(const [emoji,max] of Object.entries(expected)){
  assert.equal(gameEmoji(emoji),emoji,emoji+' recognized');
  assert.equal(GAME_LIMITS[emoji],max,emoji+' maximum');
  assert.equal(typeof GAME_TITLES[emoji],'string');
  for(let n=1;n<=max;n++)assert(validDiceMessage({emoji,value:n},emoji),emoji+' result '+n+' accepted');
  for(const n of [-1,0,max+1,undefined,1.5,'5'])assert(!validDiceMessage({emoji,value:n},emoji),emoji+' invalid value blocked');
  for(const other of Object.keys(expected).filter(x=>x!==emoji))assert(!validDiceMessage({emoji:other,value:1},emoji),'other game cannot affect score');
  assert(gameInstructions(emoji).includes(emoji),'game instructions must identify correct emoji');
  assert(gameInstructions(emoji).includes('직접'),'requires user-origin game');
}
assert.equal(gameEmoji('⚽️'),'⚽','football emoji variation selector accepted');
assert.equal(gameEmoji('🎳️'),'🎳','bowling emoji variation selector accepted');
assert.equal(gameEmoji(' 🏀 '),'🏀','stray whitespace trimmed');
assert.equal(gameEmoji('🎰️'),'🎰','slot variation selector accepted');
assert.equal(gameEmoji('🎲🎲'),null,'multiple emoji messages rejected');
assert.equal(gameEmoji(null),null);
assert.equal(validDiceMessage({emoji:'⚽️',value:5},'⚽'),true);
assert.equal(validDiceMessage({emoji:'🎳',value:6},'🎲'),false);
console.log('GLORY ARENA official game validations PASS: six games, ranges, emoji variations, player-origin instructions');
