// GLORY ARENA simplified two-dice variants. Each participant sends two
// user-origin Telegram dice animations (1-6) per round.
export const SPECIAL_MODES=Object.freeze({baccarat:'바카라식 · 2회 끝자리',seotda:'간이 섯다식 · 2회 족보'});
export const isSpecialMode=mode=>Object.hasOwn(SPECIAL_MODES,mode);
export const pairKey=(a,b)=>[a,b].sort((x,y)=>x-y).join('-');
export function baccaratHand(a,b){
  checkDie(a);checkDie(b);
  return {score:(a+b)%10,label:a+' + '+b+' = '+((a+b)%10)+'점',rank:(a+b)%10};
}
function checkDie(x){if(!Number.isInteger(x)||x<1||x>6)throw Error('INVALID_SPECIAL_DIE');}
export function seotdaHand(a,b){
  checkDie(a);checkDie(b);
  const values=[a,b].sort((x,y)=>x-y);
  if(values[0]===values[1])return {rank:100+values[0],label:values[0]+'땡',score:values[0]};
  const pairs={'1-2':{rank:93,label:'알리'},'1-4':{rank:92,label:'독사'},'4-6':{rank:91,label:'세륙'}};
  const special=pairs[pairKey(a,b)];
  if(special)return {rank:special.rank,label:special.label,score:(a+b)%10};
  const k=(a+b)%10;
  return {rank:k,label:k?k+'끗':'망통 (0끗)',score:k};
}
export function compareHands(mode,owner,guest){
  if(!isSpecialMode(mode)||!Array.isArray(owner)||!Array.isArray(guest)||owner.length!==2||guest.length!==2)throw Error('INVALID_HAND');
  const evalFn=mode==='baccarat'?baccaratHand:seotdaHand;
  const a=evalFn(...owner),b=evalFn(...guest);
  return {a,b,winner:Math.sign(a.rank-b.rank)};
}
export function createSpecialDiceEngine(db){
  db.exec('CREATE TABLE IF NOT EXISTS special_second_rolls(match INTEGER NOT NULL,round INTEGER NOT NULL,player INTEGER NOT NULL,value INTEGER NOT NULL,message INTEGER NOT NULL,PRIMARY KEY(match,round,player),UNIQUE(message,match))');
  const one=(sql,...params)=>db.prepare(sql).get(...params);
  const run=(sql,...params)=>db.prepare(sql).run(...params);
  const hand=(match,round,player)=>{
    const first=one('SELECT value FROM rolls WHERE match=? AND round=? AND player=?',match,round,player);
    const second=one('SELECT value FROM special_second_rolls WHERE match=? AND round=? AND player=?',match,round,player);
    return [first?.value,second?.value];
  };
  function getStage(m){
    if(!isSpecialMode(m.mode))return null;
    const a=hand(m.id,m.round,m.owner),b=hand(m.id,m.round,m.guest);
    if(a[0]===undefined)return {player:m.owner,throwNumber:1};
    if(b[0]===undefined)return {player:m.guest,throwNumber:1};
    if(a[1]===undefined)return {player:m.owner,throwNumber:2};
    if(b[1]===undefined)return {player:m.guest,throwNumber:2};
    return null;
  }
  function accept(m,{chat,user,value,message}){
    if(!isSpecialMode(m.mode)||m.state!=='active'||m.game!=='🎲')return {accepted:false};
    checkDie(value);
    const stage=getStage(m);
    if(!stage||stage.player!==user||m.turn!==user)return {accepted:false};
    if(stage.throwNumber===1){
      run('INSERT INTO rolls(chat,message,match,round,player,value) VALUES(?,?,?,?,?,?)',chat,message,m.id,m.round,user,value);
    }else{
      run('INSERT INTO special_second_rolls(match,round,player,value,message) VALUES(?,?,?,?,?)',m.id,m.round,user,value,message);
    }
    const next=getStage(m);
    if(next){
      run('UPDATE matches SET turn=? WHERE id=? AND state=?',next.player,m.id,'active');
      return {accepted:true,done:false,stage:next};
    }
    const a=hand(m.id,m.round,m.owner),b=hand(m.id,m.round,m.guest);
    const result=compareHands(m.mode,a,b);
    const scoreA=m.a+(result.winner===1?1:0),scoreB=m.b+(result.winner===-1?1:0);
    // A tied round awards neither side a point; 3/5/etc rounds decide the match.
    const finished=m.round>=m.rounds;
    run('UPDATE matches SET a=?,b=?,state=?,round=?,turn=? WHERE id=? AND state=?',scoreA,scoreB,finished?'finished':'active',finished?m.round:m.round+1,finished?null:m.owner,m.id,'active');
    return {accepted:true,done:finished,result,scoreA,scoreB};
  }
  return {accept,getStage,hand};
}
