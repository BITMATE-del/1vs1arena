import {GAME_LIMITS} from './game-emojis.mjs';
export function classicRound(m,ownerValue,guestValue){
  const limit=GAME_LIMITS[m.game];
  if(!limit||![ownerValue,guestValue].every(x=>Number.isInteger(x)&&x>=1&&x<=limit))throw Error('INVALID_CLASSIC_ROUND');
  if(!['total','wins','round'].includes(m.mode))throw Error('INVALID_CLASSIC_MODE');
  const a=m.a+(m.mode==='total'?ownerValue:Number(ownerValue>guestValue));
  const b=m.b+(m.mode==='total'?guestValue:Number(guestValue>ownerValue));
  const done=m.round>=m.rounds||(m.mode==='wins'&&Math.max(a,b)>=Math.floor(m.rounds/2)+1);
  return {a,b,done,nextRound:done?m.round:m.round+1,nextTurn:done?null:m.owner};
}
