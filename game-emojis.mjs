export const GAME_LIMITS=Object.freeze({'🎲':6,'🏀':5,'⚽':5,'🎯':6,'🎳':6,'🎰':64});
export const GAME_TITLES=Object.freeze({'🎲':'다이스','🏀':'농구','⚽':'축구','🎯':'다트','🎳':'볼링','🎰':'슬롯'});
export function gameEmoji(raw){
  if(typeof raw!=='string')return null;
  const normalized=raw.replace(/[\uFE0E\uFE0F]/g,'').trim();
  return Object.hasOwn(GAME_LIMITS,normalized)?normalized:null;
}
export function validDiceMessage(dice,expected){
  const kind=gameEmoji(dice?.emoji);
  const target=gameEmoji(expected);
  return !!kind&&kind===target&&Number.isInteger(dice?.value)&&dice.value>=1&&dice.value<=GAME_LIMITS[kind];
}
export function gameInstructions(kind){
  const emoji=gameEmoji(kind)||'🎲',title=GAME_TITLES[emoji];
  return '🎮 '+title+' ('+emoji+') 진행 방법\n'
    +'① 채팅창의 이모지 선택기를 엽니다.\n'
    +'② '+emoji+' 이모지 하나만 선택해 전송합니다.\n'
    +'③ '+title+' 애니메이션이 실행되면 공식 결과로 자동 기록됩니다.\n\n'
    +'※ 아래 간편 키보드가 일반 텍스트로만 전송될 경우, 이모지 선택기에서 직접 보내주세요.\n'
    +'※ 반드시 본인 계정으로 보내야 하며, 봇이 대신 굴린 결과는 인정되지 않습니다.';
}
