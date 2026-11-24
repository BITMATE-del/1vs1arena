export function createMatchBoard(db, enqueue) {
  db.exec("CREATE TABLE IF NOT EXISTS match_boards(chat INTEGER PRIMARY KEY,match INTEGER NOT NULL,message INTEGER,updated INTEGER NOT NULL DEFAULT 0)");
  const one=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  const modes={wins:'선승제',total:'점수 합산',round:'매판 승패'};
  const gameNames={'🎲':'다이스','🏀':'농구','⚽':'축구','🎯':'다트','🎳':'볼링','🎰':'슬롯'};
  function player(id){
    const row=one('SELECT name,username FROM arena_users WHERE id=?',id);
    return row?.username?'@'+row.username:row?.name?row.name.slice(0,28):'참가자 '+String(id).slice(-4);
  }
  function matchCode(m){return one("SELECT q.code FROM match_requests q WHERE q.match_id=?",m.id)?.code||'경기 #'+m.id;}
  function render(m){
    const a=player(m.owner),b=player(m.guest);
    const code=matchCode(m);
    const rolls=all("SELECT round,player,value FROM rolls WHERE match=? ORDER BY round,player",m.id);
    const scoreRows=[];
    for(let n=1;n<=m.rounds;n++){
      const ar=rolls.find(x=>x.round===n&&x.player===m.owner);
      const br=rolls.find(x=>x.round===n&&x.player===m.guest);
      if(!ar&&!br)continue;
      scoreRows.push(n+'라운드  '+(ar?.value??'–')+' : '+(br?.value??'–'));
    }
    const active=m.state==='active';
    const label=active?(m.turn===m.owner?a:b):'';
    let text='⚔️ GLORY ARENA | 실시간 경기 상태\n';
    text+='━━━━━━━━━━━━━━━━\n';
    text+='🎫 '+code+'\n';
    text+='🎮 '+m.game+' '+(gameNames[m.game]||'공식 게임')+' · '+(modes[m.mode]||m.mode)+' · '+m.rounds+'판\n\n';
    text+='👤 A  '+a+'\n';
    text+='👤 B  '+b+'\n';
    text+='━━━━━━━━━━━━━━━━\n';
    text+='📊 현재 점수\n';
    text+='A '+m.a+'  :  '+m.b+' B\n';
    if(scoreRows.length)text+='\n'+scoreRows.slice(-8).join('\n')+'\n';
    text+='\n';
    if(active){
      text+='🔴 현재 차례: '+label+'\n';
      text+='👉 '+label+' 님만 아래 버튼을 눌러주세요.\n';
      text+='📍 진행 라운드 '+m.round+' / '+m.rounds;
    }else if(m.state==='finished'){
      text+='🏆 경기 종료\n';
      text+=m.a===m.b?'🤝 무승부':'🥇 승리: '+(m.a>m.b?a:b);
      text+='\n추가 경기 여부를 아래 안내에서 선택하세요.';
    }else{text+='경기 상태: '+m.state;}
    const button=active?[[{text:m.game+' '+label.slice(0,22)+' 굴리기',callback_data:'dice:'+m.id}]]:undefined;
    return {text,reply_markup:button?{inline_keyboard:button}:{inline_keyboard:[]}};
  }
  function queue(chat){const m=one("SELECT * FROM matches WHERE chat=? AND state IN ('active','finished') ORDER BY id DESC LIMIT 1",chat);if(m)enqueue('arenaBoardSync',{chat_id:chat,match_id:m.id});}
  function queueMatch(id){const m=one('SELECT chat FROM matches WHERE id=?',id);if(m)enqueue('arenaBoardSync',{chat_id:m.chat,match_id:id});}
  async function sync(payload,tg){
    const chat=payload.chat_id;
    // Match ID is an explicit version; stale queued boards cannot override a rematch.
    const latest=one("SELECT * FROM matches WHERE chat=? AND state IN ('active','finished') ORDER BY id DESC LIMIT 1",chat);
    if(!latest||latest.id!==payload.match_id)return;
    const view=render(latest);
    const board=one('SELECT * FROM match_boards WHERE chat=?',chat);
    if(board?.message){
      try{
        await tg('editMessageText',{chat_id:chat,message_id:board.message,text:view.text,reply_markup:view.reply_markup});
        run('UPDATE match_boards SET match=?,updated=? WHERE chat=?',latest.id,Date.now(),chat);
        return;
      }catch(e){
        if(e?.code===400&&/message is not modified/i.test(e?.description||''))return;
        if(e?.code!==400)throw e;
        // Deleted or inaccessible board: create a replacement.
      }
    }
    const result=await tg('sendMessage',{chat_id:chat,text:view.text,reply_markup:view.reply_markup});
    if(!result?.message_id)throw Error('BOARD_MESSAGE_MISSING');
    run('INSERT INTO match_boards(chat,match,message,updated) VALUES(?,?,?,?) ON CONFLICT(chat) DO UPDATE SET match=excluded.match,message=excluded.message,updated=excluded.updated',chat,latest.id,result.message_id,Date.now());
    try{await tg('pinChatMessage',{chat_id:chat,message_id:result.message_id,disable_notification:true});}catch(e){console.warn('Match board pin unavailable',{code:e?.code||'network'});}
  }
  return {queue,queueMatch,render,sync,player};
}
