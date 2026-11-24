import { randomBytes } from 'node:crypto';

export function createMatchFlow(db, send, roomService, games, modes, rounds, options={}) {
  const one=(q,...a)=>db.prepare(q).get(...a);
  const all=(q,...a)=>db.prepare(q).all(...a);
  const run=(q,...a)=>db.prepare(q).run(...a);
  db.exec("CREATE TABLE IF NOT EXISTS match_requests(code TEXT PRIMARY KEY,owner INTEGER NOT NULL,guest INTEGER,game TEXT NOT NULL DEFAULT '🎲',mode TEXT NOT NULL DEFAULT 'wins',rounds INTEGER NOT NULL DEFAULT 3,status TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,match_id INTEGER,room_code TEXT,ready_owner INTEGER NOT NULL DEFAULT 0,ready_guest INTEGER NOT NULL DEFAULT 0,notice_owner INTEGER NOT NULL DEFAULT 0,notice_guest INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS match_inputs(user_id INTEGER PRIMARY KEY,kind TEXT NOT NULL,created INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS match_flow_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const config=(key,defaultValue)=>one('SELECT value FROM match_flow_settings WHERE key=?',key)?.value??defaultValue;
  const mins=()=>Math.max(5,Math.min(120,Number(config('request_minutes','60'))||60));
  const name=id=>{const u=one('SELECT name,username FROM arena_users WHERE id=?',id);return u?.username?'@'+u.username:u?.name||String(id);};
  const btn=(label,code)=>({text:label,callback_data:code});
  const sendMain=user=>send(user,'⚜️ GLORY ARENA\n1:1 무료 대전\n\n대전 신청부터 결과 기록까지 자동으로 진행됩니다.',[[btn('⚔ 상대방 지정 신청','mf:begin')],[btn('🏛 공개 대기실','mf:lobby'),btn('🎮 내 경기','mf:mine')],[btn('📖 이용 안내','mf:help')]]);
  const text=(key,fallback)=>config('text_'+key,fallback);
  function tutorial(user){send(user,text('guide','📖 GLORY ARENA 이용 안내\n\n① 상대방 아이디를 입력하거나 공개 대기실에서 신청합니다.\n② 신청서를 확인하고 상대방이 수락합니다.\n③ 전용 비공개 그룹이 생성됩니다.\n④ 양쪽 모두 공지 확인과 준비 완료를 누릅니다.\n⑤ 텔레그램 공식 이모지 게임으로 승부를 겨룹니다.\n\n모든 대전은 무료이며 입금과 보증금이 없습니다.'),[[btn('⚔ 첫 매치 개설','mf:begin')],[btn('🏠 메인 메뉴','mf:home')]]);}
  const get=code=>one('SELECT * FROM match_requests WHERE code=?',code);
  const byChat=chat=>one("SELECT q.* FROM match_requests q JOIN generated_rooms r ON r.code=q.room_code WHERE r.chat=? AND q.status IN ('room_pending','room_ready','playing') ORDER BY q.created DESC LIMIT 1",chat);
  function begin(user){if(!roomService.connected()){send(user,'운영자 그룹 생성 계정이 아직 연결되지 않았습니다.');return;}if(one("SELECT 1 FROM match_requests WHERE owner=? AND status IN ('selecting','pending','room_pending','room_ready','playing')",user)){send(user,'기존 진행 중인 매치가 있습니다. 내 경기에서 확인하세요.',[[btn('🎮 내 경기','mf:mine')]]);return;}run('INSERT INTO match_inputs(user_id,kind,created) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind,created=excluded.created',user,'opponent',Date.now());send(user,'👤 상대방의 텔레그램 아이디를 입력해 주세요.\n예: @playername\n\n상대방도 GLORY ARENA 봇에서 /start를 한 번 눌러야 신청을 받을 수 있습니다.',[[btn('❌ 취소','mf:input_cancel')]]);}
  function onText(user,body){const input=one('SELECT * FROM match_inputs WHERE user_id=?',user);if(!input)return false;if(input.kind!=='opponent')return false;run('DELETE FROM match_inputs WHERE user_id=?',user);
    const username=String(body||'').trim().replace(/^@/,'');
    if(!/^[A-Za-z0-9_]{5,32}$/.test(username)){send(user,'올바른 텔레그램 아이디를 입력해 주세요. 예: @playername',[[btn('🔄 다시 입력','mf:begin')]]);return true;}
    const match=one('SELECT id,username,name,blocked FROM arena_users WHERE username=? COLLATE NOCASE',username);
    if(!match||match.blocked||match.id===user){send(user,'상대방을 확인할 수 없습니다. 상대방이 먼저 봇에서 /start를 눌렀는지 확인해 주세요.',[[btn('🔄 다시 입력','mf:begin')]]);return true;}
    const code='GA-'+randomBytes(4).toString('hex').toUpperCase();const now=Date.now();
    run("INSERT INTO match_requests(code,owner,guest,status,created,expires,updated) VALUES(?,?,?,'selecting',?,?,?)",code,user,match.id,now,now+mins()*60000,now);
    send(user,'👤 상대방 확인\n━━━━━━━━━━━━━━\n이름: '+(match.name||'-')+'\n아이디: @'+match.username+'\n\n이 상대방에게 무료 대전을 신청하시겠습니까?',[[btn('✅ 확인','mf:confirm:'+code),btn('❌ 취소','mf:cancel:'+code)]]);
    return true;
  }
  function chooseGame(user,code){const r=get(code);if(!r||r.owner!==user||r.status!=='selecting')return;send(user,'🎮 '+code+'\n대전 게임을 선택해 주세요.',Object.keys(games).filter(g=>options.gameEnabled?.(g)!==false).map(g=>[btn(g+' '+games[g][0],'mf:game:'+code+':'+g)]));}
  function request(user,code){const r=get(code);if(!r||r.owner!==user||r.status!=='selecting'||!r.guest)return;const now=Date.now();run("UPDATE match_requests SET status='pending',expires=?,updated=? WHERE code=?",now+mins()*60000,now,code);
    send(r.owner,'📨 매치 신청서를 보냈습니다.\n━━━━━━━━━━━━━━\n매치: '+code+'\n상대방: '+name(r.guest)+'\n'+r.game+' '+r.rounds+'판 · '+modes[r.mode]+'\n\n상대방 수락을 기다리고 있습니다.',[[btn('❌ 신청 취소','mf:cancel:'+code)]]);
    send(r.guest,'⚔️ 1:1 무료 대전 신청\n━━━━━━━━━━━━━━\n매치 코드: '+code+'\n신청자: '+name(r.owner)+'\n게임: '+r.game+' · '+modes[r.mode]+' · '+r.rounds+'판\n\n'+mins()+'분 안에 수락해 주세요.',[[btn('✅ 수락','mf:accept:'+code),btn('❌ 거절','mf:reject:'+code)]]);
  }
  function createPublic(user){const active=one("SELECT 1 FROM match_requests WHERE owner=? AND status IN ('selecting','pending','room_pending','room_ready','playing')",user);if(active){send(user,'진행 중인 매치가 있습니다.',[[btn('내 경기','mf:mine')]]);return;}
    const code='GA-'+randomBytes(4).toString('hex').toUpperCase(),now=Date.now();
    run("INSERT INTO match_requests(code,owner,status,created,expires,updated) VALUES(? ,?,'selecting',?,?,?)",code,user,now,now+mins()*60000,now);
    chooseGame(user,code);
  }
  function lobby(user){const rows=all("SELECT * FROM match_requests WHERE status='public' AND expires>? ORDER BY created DESC LIMIT 15",Date.now());if(!rows.length){send(user,'🏛 현재 공개 대기 중인 매치가 없습니다.',[[btn('➕ 공개 매치 만들기','mf:public'),btn('🏠 메인','mf:home')]]);return;}for(const r of rows)send(user,'🏛 '+r.code+'\n개설자: '+name(r.owner)+'\n'+r.game+' · '+modes[r.mode]+' · '+r.rounds+'판',[[btn('⚔ 참가 신청','mf:join:'+r.code)]]);}
  function mine(user){const rows=all("SELECT * FROM match_requests WHERE (owner=? OR guest=?) ORDER BY created DESC LIMIT 10",user,user);if(!rows.length){send(user,'아직 신청한 대전이 없습니다.',[[btn('⚔ 매치 개설','mf:begin')]]);return;}for(const r of rows){const labels={selecting:'조건 설정',public:'공개 대기',pending:'수락 대기',room_pending:'그룹 생성',room_ready:'입장 및 준비',playing:'경기 진행',finished:'경기 종료',cancelled:'취소',expired:'만료',failed:'오류'};send(user,r.code+' · '+(labels[r.status]||r.status)+'\n'+r.game+' '+r.rounds+'판\n상대방: '+(r.guest?name(r.guest):'미정'),r.status==='room_ready'?[[btn('✅ 공지 확인','mf:notice:'+r.code)],[btn('🎮 준비 완료','mf:ready:'+r.code)]]:undefined);}}
  function groupReady(code,room){const r=get(code);if(!r||r.status!=='room_pending')return;
    const id=Number(run("INSERT INTO matches(chat,owner,guest,game,mode,rounds,state) VALUES(?,?,?,?,?,?,'waiting')",room.chat,r.owner,r.guest,r.game,r.mode,r.rounds).lastInsertRowid);
    run("UPDATE match_requests SET status='room_ready',match_id=?,updated=? WHERE code=?",id,Date.now(),code);
    send(room.chat,text('room_notice','📌 GLORY ARENA 경기 안내\n\n양측 모두 공지 확인 후 준비 완료를 눌러주세요.\n입금, 보증금, 수수료 없이 진행되는 무료 대전입니다.\n승패는 공식 텔레그램 이모지 결과로 기록됩니다.')+'\n\n매치: '+code+'\n'+r.game+' '+r.rounds+'판',[[btn('✅ 공지 확인','mf:notice:'+code)],[btn('🎮 준비 완료','mf:ready:'+code)]]);
    send(r.owner,'✅ 대전방 생성 완료: '+code+'\n비공개 그룹 입장 후 공지를 확인해 주세요.',[[{text:'🚪 그룹 입장',url:room.linkOwner}]]);
    send(r.guest,'✅ 대전이 성사되었습니다: '+code+'\n비공개 그룹에 입장하고 공지를 확인해 주세요.',[[{text:'🚪 그룹 입장',url:room.linkGuest}]]);
  }
  function groupFailed(code){const r=get(code);if(!r)return;run("UPDATE match_requests SET status='failed',updated=? WHERE code=?",Date.now(),code);send(r.owner,'전용 대전방 생성에 실패했습니다. 운영자에게 알려주세요. ('+code+')');if(r.guest)send(r.guest,'전용 대전방 생성에 실패했습니다. ('+code+')');}
  function notice(user,code){const r=get(code);if(!r||r.status!=='room_ready'||(user!==r.owner&&user!==r.guest))return;
    const column=user===r.owner?'notice_owner':'notice_guest';run('UPDATE match_requests SET '+column+'=1,updated=? WHERE code=?',Date.now(),code);send(user,'✅ 공지 확인 완료: '+code+'\n이제 준비 완료를 눌러주세요.',[[btn('🎮 준비 완료','mf:ready:'+code)]]);
  }
  function ready(user,code){const r=get(code);if(!r||r.status!=='room_ready'||(user!==r.owner&&user!==r.guest))return;
    if(user===r.owner&&!r.notice_owner||user===r.guest&&!r.notice_guest){send(user,'먼저 공지를 확인해 주세요.',[[btn('📌 공지 확인','mf:notice:'+code)]]);return;}
    const column=user===r.owner?'ready_owner':'ready_guest';
    run('UPDATE match_requests SET '+column+'=1,updated=? WHERE code=?',Date.now(),code);
    const current=get(code);
    if(current.ready_owner&&current.ready_guest){run("UPDATE match_requests SET status='playing',updated=? WHERE code=?",Date.now(),code);run("UPDATE matches SET state='active',turn=owner WHERE id=? AND state='waiting'",current.match_id);const room=roomService.getByCode(current.room_code);if(room?.chat)send(room.chat,'⚔️ 양측 준비 완료!\n\n'+code+' · '+r.game+' '+modes[r.mode]+' '+r.rounds+'판\n\n'+name(r.owner)+' 님부터 공식 '+r.game+' 이모지를 전송해 주세요.');send(r.owner,'⚔️ 경기가 시작됐습니다. 전용 그룹으로 이동하세요.');send(r.guest,'⚔️ 경기가 시작됐습니다. 전용 그룹으로 이동하세요.');}
    else send(user,'✅ 준비 완료. 상대방을 기다리고 있습니다.');
  }
  function onCallback(user,chat,p){if(p[0]!=='mf')return false;const op=p[1],code=p[2],r=code?get(code):null;
    if(op==='home'){sendMain(user);return true;}if(op==='help'){tutorial(user);return true;}if(op==='begin'){begin(user);return true;}if(op==='input_cancel'){run('DELETE FROM match_inputs WHERE user_id=?',user);sendMain(user);return true;}
    if(op==='lobby'){lobby(user);return true;}if(op==='mine'){mine(user);return true;}if(op==='public'){createPublic(user);return true;}
    if(!r){send(user,'대전 요청을 찾을 수 없습니다.');return true;}
    if(op==='confirm'&&r.owner===user&&r.status==='selecting'){chooseGame(user,code);return true;}
    if(op==='game'&&r.owner===user&&r.status==='selecting'&&games[p[3]]&&options.gameEnabled?.(p[3])!==false){run('UPDATE match_requests SET game=?,updated=? WHERE code=?',p[3],Date.now(),code);send(user,'경기 방식을 선택해 주세요.',Object.entries(modes).map(([k,v])=>[btn(v,'mf:mode:'+code+':'+k)]));return true;}
    if(op==='mode'&&r.owner===user&&r.status==='selecting'&&modes[p[3]]){run('UPDATE match_requests SET mode=?,updated=? WHERE code=?',p[3],Date.now(),code);send(user,'경기 횟수를 선택하세요.',[rounds.map(n=>btn(n+'판','mf:round:'+code+':'+n))]);return true;}
    if(op==='round'&&r.owner===user&&r.status==='selecting'&&rounds.includes(Number(p[3]))){run('UPDATE match_requests SET rounds=?,updated=? WHERE code=?',Number(p[3]),Date.now(),code);send(user,'✅ 최종 확인\n'+code+'\n'+r.game+' · '+modes[r.mode]+' · '+Number(p[3])+'판\n'+(r.guest?'상대: '+name(r.guest):'공개 대기실에 등록'),[[btn(r.guest?'📩 상대에게 신청':'🏛 대기실에 공개','mf:submit:'+code),btn('❌ 취소','mf:cancel:'+code)]]);return true;}
    if(op==='submit'&&r.owner===user&&r.status==='selecting'){if(r.guest)request(user,code);else{run("UPDATE match_requests SET status='public',expires=?,updated=? WHERE code=?",Date.now()+mins()*60000,Date.now(),code);send(user,'✅ 공개 대기실에 등록됐습니다. '+code);}return true;}
    if(op==='join'&&r.status==='public'&&r.owner!==user){const applied=run("UPDATE match_requests SET guest=?,status='pending',updated=? WHERE code=? AND status='public'",user,Date.now(),code);if(applied.changes){send(r.owner,'⚔️ 대전 참가 신청\n'+r.code+'\n신청자: '+name(user),[[btn('✅ 수락','mf:accept:'+code),btn('❌ 거절','mf:reject:'+code)]]);send(user,'신청 완료. 개설자 수락을 기다립니다.');}return true;}
    if(op==='accept'&&r.status==='pending'&&(r.guest===user&&!r.guest===r.owner||r.owner===user&&r.guest)){if(Date.now()>r.expires){expireOne(r);return true;}
      const byPublic=r.owner===user;
      if(!byPublic&&r.guest!==user)return true;
      const x=run("UPDATE match_requests SET status='room_pending',updated=? WHERE code=? AND status='pending'",Date.now(),code);
      if(x.changes){roomService.requestPair({code:r.code,owner:r.owner,guest:r.guest},groupReady,groupFailed);send(r.owner,'✅ 대전 수락 완료. 전용 그룹을 생성합니다.');send(r.guest,'✅ 대전 수락 완료. 전용 그룹을 생성합니다.');}return true;}
    if(op==='reject'&&r.status==='pending'&&(r.owner===user||r.guest===user)){if(r.guest)send(r.owner,'❌ 대전 신청이 거절되었습니다: '+code);if(r.guest)send(r.guest,'❌ 대전 신청이 거절되었습니다: '+code);run("UPDATE match_requests SET status='cancelled',updated=? WHERE code=?",Date.now(),code);return true;}
    if(op==='cancel'&&r.owner===user&&['selecting','public','pending'].includes(r.status)){run("UPDATE match_requests SET status='cancelled',updated=? WHERE code=?",Date.now(),code);if(r.guest)send(r.guest,'대전 신청이 취소되었습니다: '+code);send(user,'취소되었습니다.');return true;}
    if(op==='notice'){notice(user,code);return true;}if(op==='ready'){ready(user,code);return true;}
    send(user,'이미 처리된 요청이거나 권한이 없습니다.');return true;
  }
  function expireOne(r){run("UPDATE match_requests SET status='expired',updated=? WHERE code=? AND status IN ('selecting','public','pending')",Date.now(),r.code);send(r.owner,'⌛ 매치 '+r.code+' 신청 시간이 만료됐습니다.');if(r.guest)send(r.guest,'⌛ 매치 '+r.code+' 신청 시간이 만료됐습니다.');}
  function tick(){const jobs=all("SELECT * FROM match_requests WHERE status IN ('selecting','public','pending') AND expires<? LIMIT 25",Date.now());for(const r of jobs)expireOne(r);}
  function finished(chat){const r=byChat(chat);if(r&&r.status==='playing'){run("UPDATE match_requests SET status='finished',updated=? WHERE code=?",Date.now(),r.code);roomService.finish(r.room_code);send(r.owner,'🏆 '+r.code+' 경기가 종료되었습니다. 내 전적에서 결과를 확인하세요.');send(r.guest,'🏆 '+r.code+' 경기가 종료되었습니다. 내 전적에서 결과를 확인하세요.');}}
  function cancelForAdmin(code){const r=get(code);if(!r||['finished','cancelled','expired'].includes(r.status))return false;run("UPDATE match_requests SET status='cancelled',updated=? WHERE code=?",Date.now(),code);if(r.match_id)run("UPDATE matches SET state='cancelled' WHERE id=? AND state!='finished'",r.match_id);send(r.owner,'운영자에 의해 대전이 중단됐습니다: '+code);if(r.guest)send(r.guest,'운영자에 의해 대전이 중단됐습니다: '+code);return true;}
  return {sendMain,tutorial,begin,lobby,mine,onText,onCallback,tick,finished,cancelForAdmin,get,config};
}
