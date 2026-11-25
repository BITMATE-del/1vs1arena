import {isSpecialMode} from './special-rules.mjs';
import { randomBytes } from 'node:crypto';

export function createMatchFlow(db, send, roomService, games, modes, rounds, options={}) {
  const one=(q,...a)=>db.prepare(q).get(...a);
  const all=(q,...a)=>db.prepare(q).all(...a);
  const run=(q,...a)=>db.prepare(q).run(...a);
  db.exec("CREATE TABLE IF NOT EXISTS match_requests(code TEXT PRIMARY KEY,owner INTEGER NOT NULL,guest INTEGER,game TEXT NOT NULL DEFAULT '🎲',mode TEXT NOT NULL DEFAULT 'wins',rounds INTEGER NOT NULL DEFAULT 3,status TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,match_id INTEGER,room_code TEXT,ready_owner INTEGER NOT NULL DEFAULT 0,ready_guest INTEGER NOT NULL DEFAULT 0,notice_owner INTEGER NOT NULL DEFAULT 0,notice_guest INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS match_inputs(user_id INTEGER PRIMARY KEY,kind TEXT NOT NULL,created INTEGER NOT NULL)");
  try{db.exec("ALTER TABLE match_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'direct'");}catch(e){if(!String(e.message).includes('duplicate column name'))throw e;}
  db.exec("CREATE TABLE IF NOT EXISTS match_flow_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const config=(key,defaultValue)=>one('SELECT value FROM match_flow_settings WHERE key=?',key)?.value??defaultValue;
  const mins=()=>Math.max(5,Math.min(120,Number(config('request_minutes','60'))||60));
  db.exec("CREATE TABLE IF NOT EXISTS match_continue_votes(code TEXT PRIMARY KEY, owner_vote TEXT, guest_vote TEXT, deadline INTEGER NOT NULL, close_after INTEGER, state TEXT NOT NULL DEFAULT 'voting', last_error TEXT, updated INTEGER NOT NULL)");
  const votesFor=code=>one("SELECT * FROM match_continue_votes WHERE code=?",code);
  db.exec("CREATE TABLE IF NOT EXISTS match_stop_requests(code TEXT PRIMARY KEY, requested_by INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', updated INTEGER NOT NULL)");
  const stopFor=code=>one('SELECT * FROM match_stop_requests WHERE code=?',code);
  const finishMsg=(code,room)=>'🏆 경기가 종료되었습니다.\n\n매치 코드: '+code+'\n\n추가 경기를 계속 진행하시겠습니까?\n양쪽 참가자 모두 선택해 주세요. 두 명 모두 예를 선택하면 같은 그룹에서 새 경기를 시작합니다.\n아니오를 선택한 회원이 있으면 양쪽 응답 확인 후 그룹이 종료됩니다.';

  const name=id=>{const u=one('SELECT name,username FROM arena_users WHERE id=?',id);return u?.username?'@'+u.username:u?.name||String(id);};
  const btn=(label,code)=>({text:label,callback_data:code});
  const sendMain=user=>send(user,'⚜️ GLORY ARENA\n1:1 무료 대전\n\n진행 방식을 선택하세요. 상대를 정하거나 공개 대기실에서 신청을 받을 수 있습니다.',[[btn('🎯 상대 지정 대결','mf:begin')],[btn('⏳ 매치 대기 등록','mf:public')],[btn('🏛 대기 중인 매치','mf:lobby'),btn('🎮 내 경기','mf:mine')],[btn('📖 이용 안내','mf:help')]]);
  const text=(key,fallback)=>config('text_'+key,fallback);
  function tutorial(user){send(user,text('guide','📖 GLORY ARENA 이용 안내\n\n① 상대방 아이디를 입력하거나 공개 대기실에서 신청합니다.\n② 신청서를 확인하고 상대방이 수락합니다.\n③ 전용 비공개 그룹이 생성됩니다.\n④ 양쪽 모두 공지 확인과 준비 완료를 누릅니다.\n⑤ 텔레그램 공식 이모지 게임으로 승부를 겨룹니다.\n\n모든 대전은 무료이며 입금과 보증금이 없습니다.'),[[btn('⚔ 첫 매치 개설','mf:begin')],[btn('🏠 메인 메뉴','mf:home')]]);}
  const get=code=>one('SELECT * FROM match_requests WHERE code=?',code);
  const byChat=chat=>one("SELECT q.* FROM match_requests q JOIN generated_rooms r ON r.code=q.room_code WHERE r.chat=? AND q.status IN ('room_pending','room_ready','playing') ORDER BY q.created DESC LIMIT 1",chat);
  function begin(user){if(!roomService.connected()){send(user,'운영자 그룹 생성 계정이 아직 연결되지 않았습니다.');return;}if(one("SELECT 1 FROM match_requests WHERE owner=? AND status IN ('selecting','public','pending','room_pending','room_ready','playing')",user)){send(user,'기존 진행 중인 매치가 있습니다. 내 경기에서 확인하세요.',[[btn('🎮 내 경기','mf:mine')]]);return;}run('INSERT INTO match_inputs(user_id,kind,created) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind,created=excluded.created',user,'opponent',Date.now());send(user,'👤 상대방의 텔레그램 아이디를 입력해 주세요.\n예: @playername\n\n상대방도 GLORY ARENA 봇에서 /start를 한 번 눌러야 신청을 받을 수 있습니다.',[[btn('❌ 취소','mf:input_cancel')]]);}
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
  function createPublic(user){const active=one("SELECT 1 FROM match_requests WHERE owner=? AND status IN ('selecting','public','pending','room_pending','room_ready','playing')",user);if(active){send(user,'진행 중인 매치가 있습니다.',[[btn('내 경기','mf:mine')]]);return;}
    const code='GA-'+randomBytes(4).toString('hex').toUpperCase(),now=Date.now();
    run("INSERT INTO match_requests(code,owner,status,created,expires,updated) VALUES(? ,?,'selecting',?,?,?)",code,user,now,now+mins()*60000,now);
    chooseGame(user,code);
  }
  function lobby(user){const rows=all("SELECT * FROM match_requests WHERE status='public' AND expires>? ORDER BY created DESC LIMIT 15",Date.now());send(user,'🏛 GLORY ARENA 공개 매치 대기실\n\n원하는 경기의 참가 신청 버튼을 누르세요. 개설자의 수락 후 비공개 대전방을 생성합니다.\n현재 대기 중: '+rows.length+'건',[[btn('➕ 내 매치 대기 등록','mf:public')],[btn('🔄 대기 목록 새로고침','mf:lobby'),btn('🏠 메인 메뉴','mf:home')]]);if(!rows.length){send(user,'현재 참가 가능한 매치가 없습니다. 매치 대기를 등록해 다른 회원의 신청을 받아보세요.');return;}for(const r of rows){const remaining=Math.max(1,Math.ceil((r.expires-Date.now())/60000));send(user,'⏳ '+r.code+'\n개설자: '+name(r.owner)+'\n종목: '+r.game+' · '+modes[r.mode]+' · '+r.rounds+'판\n남은 대기 시간: 약 '+remaining+'분',r.owner===user?[[btn('❌ 내 대기 취소','mf:cancel:'+r.code)]]:[[btn('⚔ 이 매치에 참가 신청','mf:join:'+r.code)]]);}}
  function mine(user){const rows=all("SELECT * FROM match_requests WHERE (owner=? OR guest=?) ORDER BY created DESC LIMIT 10",user,user);if(!rows.length){send(user,'아직 신청한 대전이 없습니다.',[[btn('⚔ 매치 개설','mf:begin')]]);return;}for(const r of rows){const labels={selecting:'조건 설정',public:'공개 대기',pending:'수락 대기',room_pending:'그룹 생성',room_ready:'입장 및 준비',playing:'경기 진행',finished:'경기 종료',cancelled:'취소',expired:'만료',failed:'오류'};send(user,r.code+' · '+(labels[r.status]||r.status)+'\n'+r.game+' '+r.rounds+'판\n상대방: '+(r.guest?name(r.guest):'미정'),['room_ready','playing'].includes(r.status)?[[btn('🔄 대전방 재입장·상태 복구','mf:resume:'+r.code)]]:undefined);}}
  function groupReady(code,room){const r=get(code);if(!r||r.status!=='room_pending'||!room?.chat||!room?.linkOwner||!room?.linkGuest)return;
    const id=Number(run("INSERT INTO matches(chat,owner,guest,game,mode,rounds,state) VALUES(?,?,?,?,?,?,'waiting')",room.chat,r.owner,r.guest,r.game,r.mode,r.rounds).lastInsertRowid);
    run("UPDATE match_requests SET status='room_ready',room_code=COALESCE(room_code,?),match_id=?,updated=? WHERE code=?",room.code,id,Date.now(),code);
    send(room.chat,text('room_notice','📌 GLORY ARENA 경기 안내\n\n양측 모두 공지 확인 후 준비 완료를 눌러주세요.\n입금, 보증금, 수수료 없이 진행되는 무료 대전입니다.\n승패는 공식 텔레그램 이모지 결과로 기록됩니다.')+'\n\n매치: '+code+'\n'+r.game+' '+r.rounds+'판',[[btn('✅ 공지 확인','mf:notice:'+code)],[btn('🎮 준비 완료','mf:ready:'+code)],[btn('🛑 중도 종료 요청','mf:stop:'+code)]]);
    send(r.owner,'🚪 '+code+' 전용 그룹 입장 링크입니다.\n진행 안내와 공지 확인은 그룹 안에서 이루어집니다.',[[{text:'🚪 그룹 입장',url:room.linkOwner}]]);
    send(r.guest,'🚪 '+code+' 전용 그룹 입장 링크입니다.\n진행 안내와 공지 확인은 그룹 안에서 이루어집니다.',[[{text:'🚪 그룹 입장',url:room.linkGuest}]]);
  }
  function groupFailed(code){const r=get(code);if(!r)return;run("UPDATE match_requests SET status='failed',updated=? WHERE code=?",Date.now(),code);send(r.owner,'전용 대전방 생성에 실패했습니다. 운영자에게 알려주세요. ('+code+')');if(r.guest)send(r.guest,'전용 대전방 생성에 실패했습니다. ('+code+')');}
  function notice(user,code,chat){const r=get(code);if(!r||r.status!=='room_ready'||(user!==r.owner&&user!==r.guest)||roomService.getByCode(r.room_code)?.chat!==chat){send(chat===user?user:chat,'전용 그룹에서 공지를 확인해 주세요.');return;}
    const column=user===r.owner?'notice_owner':'notice_guest';run('UPDATE match_requests SET '+column+'=1,updated=? WHERE code=?',Date.now(),code);send(chat,'✅ '+name(user)+' 님이 공지를 확인했습니다.\n준비 완료 버튼을 눌러주세요.',[[btn('🎮 준비 완료','mf:ready:'+code)]]);
  }
  function ready(user,code,chat){const r=get(code);if(!r||r.status!=='room_ready'||(user!==r.owner&&user!==r.guest)||roomService.getByCode(r.room_code)?.chat!==chat){send(chat===user?user:chat,'전용 그룹에서 준비를 완료해 주세요.');return;}
    if(user===r.owner&&!r.notice_owner||user===r.guest&&!r.notice_guest){send(chat,'먼저 공지를 확인해 주세요.',[[btn('📌 공지 확인','mf:notice:'+code)]]);return;}
    const column=user===r.owner?'ready_owner':'ready_guest';
    run('UPDATE match_requests SET '+column+'=1,updated=? WHERE code=?',Date.now(),code);
    const current=get(code);
    if(current.ready_owner&&current.ready_guest){run("UPDATE match_requests SET status='playing',updated=? WHERE code=?",Date.now(),code);run("UPDATE matches SET state='active',turn=owner WHERE id=? AND state='waiting'",current.match_id);const room=roomService.getByCode(current.room_code);if(room?.chat)options.onMatchStart?.(current.match_id);}
    else send(chat,'✅ '+name(user)+' 님 준비 완료. 상대방 준비를 기다리고 있습니다.');
  }
  function requestStop(user,chat,code){
    const r=get(code),room=r?.room_code?roomService.getByCode(r.room_code):null;
    if(!r||room?.chat!==chat||![r.owner,r.guest].includes(user)||!['room_ready','playing'].includes(r.status)){send(chat,'진행 중인 대전방에서만 종료를 요청할 수 있습니다.');return;}
    const previous=stopFor(code),now=Date.now();
    if(previous?.state==='pending'&&previous.expires>now){
      if(previous.requested_by===user){send(chat,'이미 상대방의 종료 동의를 기다리고 있습니다.');return;}
      approveStop(user,chat,code,'yes');return;
    }
    run("INSERT INTO match_stop_requests(code,requested_by,expires,state,updated) VALUES(?,?,?,'pending',?) ON CONFLICT(code) DO UPDATE SET requested_by=excluded.requested_by,expires=excluded.expires,state='pending',updated=excluded.updated",code,user,now+5*60000,now);
    const other=user===r.owner?r.guest:r.owner;
    send(chat,'🛑 대전 중도 종료 요청\n\n요청자: '+name(user)+'\n상대방: '+name(other)+'\n매치 코드: '+code+'\n\n상대방이 동의하면 경기를 중단하고 방을 종료합니다.\n진행 중 경기 결과는 승패로 확정하지 않습니다.\n5분 동안 응답이 없으면 요청이 취소됩니다.',[[btn('✅ 종료 동의','mf:stopanswer:'+code+':yes'),btn('❌ 종료 거절','mf:stopanswer:'+code+':no')]]);
  }
  function approveStop(user,chat,code,answer){
    const r=get(code),room=r?.room_code?roomService.getByCode(r.room_code):null,v=stopFor(code);
    if(!r||!v||v.state!=='pending'||room?.chat!==chat||!['room_ready','playing'].includes(r.status)||!v.requested_by||user===v.requested_by||![r.owner,r.guest].includes(user))return;
    if(Date.now()>v.expires){run("UPDATE match_stop_requests SET state='expired',updated=? WHERE code=?",Date.now(),code);send(chat,'⌛ 종료 요청이 만료되었습니다. 경기를 계속 진행할 수 있습니다.');return;}
    if(answer==='no'){
      run("UPDATE match_stop_requests SET state='rejected',updated=? WHERE code=?",Date.now(),code);
      send(chat,'❌ '+name(user)+' 님이 종료 요청을 거절했습니다.\n경기는 그대로 진행됩니다.');
      return;
    }
    run("UPDATE match_stop_requests SET state='accepted',updated=? WHERE code=?",Date.now(),code);
    scheduleStop(r,'mutual');
  }
  function scheduleStop(r,source){
    const now=Date.now(),room=r.room_code?roomService.getByCode(r.room_code):null;
    run("UPDATE match_requests SET status='cancelled',updated=? WHERE code=? AND status IN ('room_ready','playing','finished')",now,r.code);
    if(r.match_id)run("UPDATE matches SET state='cancelled',turn=NULL WHERE id=? AND state IN ('active','waiting','requested')",r.match_id);
    if(r.match_id&&r.status==='playing')options.onMatchStopped?.(r.match_id);
    run("INSERT INTO match_continue_votes(code,deadline,close_after,state,updated) VALUES(?,?,?,'closing',?) ON CONFLICT(code) DO UPDATE SET close_after=excluded.close_after,state='closing',updated=excluded.updated,last_error=NULL",r.code,now,now+12000,now);
    const who=source==='admin'?'관리자 강제 종료':source==='timeout'?'응답 시간 초과 종료':'양측 합의 종료';
    if(room?.chat)send(room.chat,'🛑 '+who+'\n\n매치 '+r.code+'의 진행이 중단되었습니다.\n약 12초 후 전용 그룹이 종료됩니다.\n완료된 이전 경기 기록은 보존됩니다.');
    else{send(r.owner,'매치 '+r.code+'가 종료되었습니다.');if(r.guest)send(r.guest,'매치 '+r.code+'가 종료되었습니다.');}
  }
  function timeoutMatch(matchId){
    const m=one("SELECT * FROM matches WHERE id=? AND state='active'",matchId);
    if(!m)return false;
    const r=get(one('SELECT code FROM match_requests WHERE match_id=?',matchId)?.code);
    if(!r||r.status!=='playing')return false;
    scheduleStop(r,'timeout');return true;
  }
  function retryCloseForAdmin(code){
    const r=get(code),v=votesFor(code);
    if(!r||!r.room_code||!v||v.state!=='close_failed')return false;
    const room=roomService.getByCode(r.room_code);
    if(!room||room.status==='closed')return false;
    run("UPDATE match_continue_votes SET state='closing',close_after=?,last_error=NULL,updated=? WHERE code=? AND state='close_failed'",Date.now(),Date.now(),code);
    void processClose(code);
    return true;
  }
  async function resume(user,code){
    const r=get(code);
    if(!r||![r.owner,r.guest].includes(user)||!['room_ready','playing'].includes(r.status)){
      send(user,'현재 재입장할 수 있는 대전방이 없습니다.');return;
    }
    const room=roomService.getByCode(r.room_code);
    if(!room?.chat){send(user,'대전방이 아직 준비되지 않았습니다.');return;}
    try{
      const link=await roomService.freshInvite(r.room_code,user===r.owner?'owner':'guest');
      send(user,'🔄 대전방 복귀 안내\n'+r.code+' · '+r.game+' '+r.rounds+'판\n현재 진행 상황은 그룹의 고정 경기판에서 확인할 수 있습니다.',[[{text:'🚪 대전방 재입장',url:link}]]);
      if(r.status==='playing')options.onMatchStart?.(r.match_id);
    }catch(e){
      send(user,'대전방 재입장 링크 발급에 실패했습니다. 관리자에게 문의해 주세요.');
      console.warn('Resume invite failed',{code,reason:String(e?.errorMessage||e?.message||'error').slice(0,65)});
    }
  }
  function closeFinishedForAdmin(code){
    const r=get(code);
    if(!r||!r.room_code||r.status!=='finished')return false;
    const room=roomService.getByCode(r.room_code),v=votesFor(code);
    if(!room?.chat||room.status==='closed'||v?.state==='closed')return false;
    if(v?.state==='closing')return true;
    const now=Date.now();
    run("INSERT INTO match_continue_votes(code,deadline,close_after,state,updated) VALUES(?,?,?,'closing',?) ON CONFLICT(code) DO UPDATE SET close_after=excluded.close_after,state='closing',last_error=NULL,updated=excluded.updated",code,now,now+12000,now);
    send(room.chat,'✅ 종료된 경기를 정리합니다.\n기존 승패와 점수는 그대로 보존되며 전용 그룹은 잠시 후 종료됩니다.');
    return true;
  }
  function forceCloseForAdmin(code){
    const r=get(code);if(!r)return false;
    const room=r.room_code?roomService.getByCode(r.room_code):null;
    if(room?.status==='closed'||votesFor(code)?.state==='closed')return false;
    if(!room?.chat){return cancelForAdmin(code);}
    if(votesFor(code)?.state==='closing')return true;
    scheduleStop(r,'admin');return true;
  }
  function stopByChat(user,chat){const r=byChat(chat);if(!r){send(chat,'진행 중인 대전방이 아닙니다.');return;}requestStop(user,chat,r.code);}
  function onCallback(user,chat,p){if(p[0]!=='mf')return false;const op=p[1],code=p[2],r=code?get(code):null;
    if(op==='home'){sendMain(user);return true;}if(op==='help'){tutorial(user);return true;}if(op==='begin'){begin(user);return true;}if(op==='input_cancel'){run('DELETE FROM match_inputs WHERE user_id=?',user);sendMain(user);return true;}
    if(op==='lobby'){lobby(user);return true;}if(op==='mine'){mine(user);return true;}if(op==='public'){createPublic(user);return true;}
    if(op==='resume'&&code){void resume(user,code);return true;}
    if(!r){send(user,'대전 요청을 찾을 수 없습니다.');return true;}
    if(op==='confirm'&&r.owner===user&&r.status==='selecting'){chooseGame(user,code);return true;}
    if(op==='game'&&r.owner===user&&r.status==='selecting'&&games[p[3]]&&options.gameEnabled?.(p[3])!==false){run('UPDATE match_requests SET game=?,mode=?,updated=? WHERE code=?',p[3],'wins',Date.now(),code);send(user,'경기 방식을 선택해 주세요.',Object.entries(modes).filter(([k])=>r.game==='🎲'||!isSpecialMode(k)).map(([k,v])=>[btn(v,'mf:mode:'+code+':'+k)]));return true;}
    if(op==='mode'&&r.owner===user&&r.status==='selecting'&&modes[p[3]]&&(!isSpecialMode(p[3])||r.game==='🎲')){run('UPDATE match_requests SET mode=?,updated=? WHERE code=?',p[3],Date.now(),code);send(user,'경기 횟수를 선택하세요.',[rounds.map(n=>btn(n+'판','mf:round:'+code+':'+n))]);return true;}
    if(op==='round'&&r.owner===user&&r.status==='selecting'&&rounds.includes(Number(p[3]))){run('UPDATE match_requests SET rounds=?,updated=? WHERE code=?',Number(p[3]),Date.now(),code);send(user,'✅ 최종 확인\n'+code+'\n'+r.game+' · '+modes[r.mode]+' · '+Number(p[3])+'판\n'+(r.guest?'상대: '+name(r.guest):'공개 대기실에 등록'),[[btn(r.guest?'📩 상대에게 신청':'🏛 대기실에 공개','mf:submit:'+code),btn('❌ 취소','mf:cancel:'+code)]]);return true;}
    if(op==='submit'&&r.owner===user&&r.status==='selecting'){if(r.guest)request(user,code);else{run("UPDATE match_requests SET status='public',source='public',expires=?,updated=? WHERE code=?",Date.now()+mins()*60000,Date.now(),code);send(user,'✅ 공개 매치 대기 등록 완료!\n\n매치 코드: '+code+'\n조건: '+r.game+' · '+modes[r.mode]+' · '+r.rounds+'판\n\n다른 회원이 대기실에서 신청하면 수락·거절 버튼을 보내드립니다.',[[btn('🏛 대기실 확인','mf:lobby')],[btn('❌ 매치 취소','mf:cancel:'+code)]]);}return true;}
    if(op==='join'&&r.status==='public'&&r.owner!==user&&Date.now()<=r.expires){const applied=run("UPDATE match_requests SET guest=?,status='pending',updated=? WHERE code=? AND status='public'",user,Date.now(),code);if(applied.changes){send(r.owner,'⚔️ 공개 매치 참가 신청\n━━━━━━━━━━━━━━\n매치 코드: '+r.code+'\n신청자: '+name(user)+'\n조건: '+r.game+' · '+modes[r.mode]+' · '+r.rounds+'판\n\n수락하면 전용 그룹 생성이 시작됩니다.',[[btn('✅ 신청 수락','mf:accept:'+code),btn('❌ 신청 거절','mf:reject:'+code)]]);send(user,'✅ 참가 신청 완료!\n매치: '+code+'\n개설자 '+name(r.owner)+'님의 승인을 기다리고 있습니다.',[[btn('❌ 내 신청 철회','mf:withdraw:'+code)]]);}else send(user,'이미 다른 회원이 신청 중입니다. 대기실에서 다른 매치를 확인해 주세요.',[[btn('🏛 대기실','mf:lobby')]]);return true;}
    if(op==='accept'&&r.status==='pending'&&r.guest&&((r.source==='public'&&r.owner===user)||(r.source==='direct'&&r.guest===user))){if(Date.now()>r.expires){expireOne(r);return true;}
      if(!roomService.connected()){send(user,'운영자 대전방 생성 계정이 연결되지 않았습니다.');return true;}
      const x=run("UPDATE match_requests SET status='room_pending',updated=? WHERE code=? AND status='pending'",Date.now(),code);
      if(x.changes){try{const roomCode=roomService.requestPair({code:r.code,owner:r.owner,guest:r.guest},groupReady,groupFailed);run("UPDATE match_requests SET room_code=? WHERE code=?",roomCode,code);}catch(e){run("UPDATE match_requests SET status='failed',updated=? WHERE code=?",Date.now(),code);send(r.owner,'그룹 생성 요청 실패. 운영자에게 문의하세요.');send(r.guest,'그룹 생성 요청 실패. 운영자에게 문의하세요.');return true;}send(r.owner,'✅ 대전 수락 완료. 전용 그룹을 생성합니다.');send(r.guest,'✅ 대전 수락 완료. 전용 그룹을 생성합니다.');}return true;}
    if(op==='reject'&&r.status==='pending'&&((r.source==='public'&&r.owner===user)||(r.source==='direct'&&r.guest===user))){if(r.guest)send(r.guest,'❌ 매치 신청이 거절되었습니다: '+code);if(r.source==='public'){run("UPDATE match_requests SET status='public',guest=NULL,updated=? WHERE code=?",Date.now(),code);send(r.owner,'다른 회원의 신청을 계속 받을 수 있도록 대기 상태로 돌아갔습니다.',[[btn('🏛 대기실','mf:lobby')]]);}else{run("UPDATE match_requests SET status='cancelled',updated=? WHERE code=?",Date.now(),code);send(r.owner,'상대방이 대전 신청을 거절했습니다: '+code);}return true;}
    if(op==='withdraw'&&r.source==='public'&&r.status==='pending'&&r.guest===user){run("UPDATE match_requests SET status='public',guest=NULL,updated=? WHERE code=? AND guest=?",Date.now(),code,user);send(user,'참가 신청을 철회했습니다.');send(r.owner,'참가자가 신청을 철회했습니다. '+code+' 대기는 계속됩니다.');return true;}
    if(op==='cancel'&&r.owner===user&&['selecting','public','pending'].includes(r.status)){run("UPDATE match_requests SET status='cancelled',updated=? WHERE code=?",Date.now(),code);if(r.guest)send(r.guest,'대전 신청이 취소되었습니다: '+code);send(user,'취소되었습니다.');return true;}
    if(op==='stop'){requestStop(user,chat,code);return true;}
    if(op==='stopanswer'&&['yes','no'].includes(p[3])){approveStop(user,chat,code,p[3]);return true;}
    if(op==='again'&&['yes','no'].includes(p[3])){voteContinue(user,chat,code,p[3]);return true;}
    if(op==='notice'){notice(user,code,chat);return true;}if(op==='ready'){ready(user,code,chat);return true;}
    send(user,'이미 처리된 요청이거나 권한이 없습니다.');return true;
  }
  function expireOne(r){const changed=run("UPDATE match_requests SET status='expired',updated=? WHERE code=? AND status IN ('selecting','public','pending')",Date.now(),r.code);if(!changed.changes)return;send(r.owner,'⌛ 매치 '+r.code+' 신청 시간이 만료됐습니다.');if(r.guest)send(r.guest,'⌛ 매치 '+r.code+' 신청 시간이 만료됐습니다.');}
  function tick(){const jobs=all("SELECT * FROM match_requests WHERE status IN ('selecting','public','pending') AND expires<? LIMIT 25",Date.now());for(const r of jobs)expireOne(r);
    const pending=all("SELECT * FROM match_requests WHERE status='room_pending' LIMIT 20");for(const r of pending){const room=roomService.getByCode(r.room_code||('R-'+r.code));if(room?.status==='ready'&&room.link&&room.link_guest)groupReady(r.code,{chat:room.chat,linkOwner:room.link,linkGuest:room.link_guest,code:room.code});else if(room?.status==='failed')groupFailed(r.code);}
    for(const row of all("SELECT * FROM match_stop_requests WHERE state='pending' AND expires<? LIMIT 20",Date.now())){run("UPDATE match_stop_requests SET state='expired',updated=? WHERE code=? AND state='pending'",Date.now(),row.code);const room=get(row.code)?.room_code?roomService.getByCode(get(row.code).room_code):null;if(room?.chat)send(room.chat,'⌛ 중도 종료 요청이 만료됐습니다. 경기는 계속 진행됩니다.');}
    for(const row of all("SELECT * FROM match_continue_votes WHERE state='voting' AND deadline<? LIMIT 20",Date.now())){const r=get(row.code);if(r)closeDecision(r,'timeout');}
    // Recover legacy completed matches which lost the rematch-vote row. Only
    // automatically clean up after the finished request has aged beyond the vote window.
    const oldFinished=all("SELECT q.code FROM match_requests q JOIN generated_rooms g ON g.code=q.room_code LEFT JOIN match_continue_votes v ON v.code=q.code WHERE q.status='finished' AND q.updated<? AND v.code IS NULL AND g.status='finished' LIMIT 5",Date.now()-15*60000);
    for(const r of oldFinished)closeFinishedForAdmin(r.code);
    for(const row of all("SELECT code FROM match_continue_votes WHERE state='closing' AND close_after<=? LIMIT 10",Date.now()))void processClose(row.code);
  }
  function finished(chat){
    const r=byChat(chat);if(!r||r.status!=='playing')return;
    const now=Date.now();
    run("UPDATE match_requests SET status='finished',updated=? WHERE code=?",now,r.code);
    roomService.finish(r.room_code);
    run("INSERT INTO match_continue_votes(code,deadline,state,updated) VALUES(?,?,'voting',?) ON CONFLICT(code) DO UPDATE SET owner_vote=NULL,guest_vote=NULL,deadline=excluded.deadline,close_after=NULL,state='voting',last_error=NULL,updated=excluded.updated",r.code,now+10*60000,now);
    send(chat,finishMsg(r.code),[[btn('✅ 예, 계속하기','mf:again:'+r.code+':yes'),btn('❌ 아니오, 종료','mf:again:'+r.code+':no')]]);
  }
  function voteContinue(user,chat,code,vote){
    const r=get(code),decision=votesFor(code),room=r?.room_code?roomService.getByCode(r.room_code):null;
    if(!r||!decision||r.status!=='finished'||decision.state!=='voting'||room?.chat!==chat||![r.owner,r.guest].includes(user))return;
    if(Date.now()>decision.deadline){closeDecision(r,'timeout');return;}
    const col=user===r.owner?'owner_vote':'guest_vote';
    if(decision[col]===vote){send(chat,name(user)+' 님은 이미 응답했습니다.');return;}
    run("UPDATE match_continue_votes SET "+col+"=?,updated=? WHERE code=? AND state='voting'",vote,Date.now(),code);
    const now=votesFor(code);
    if(!now.owner_vote||!now.guest_vote){
      send(chat,'✅ '+name(user)+' 님 응답 완료 ('+(vote==='yes'?'계속':'종료')+').\n상대방 응답을 기다리고 있습니다.');
      return;
    }
    if(now.owner_vote==='yes'&&now.guest_vote==='yes'){
      const last=one("SELECT * FROM matches WHERE id=? AND state='finished'",r.match_id);
      if(!last){send(chat,'이전 경기 결과를 확인할 수 없습니다. 운영자에게 문의해 주세요.');return;}
      const next=Number(run("INSERT INTO matches(chat,owner,guest,game,mode,rounds,state,turn,round,a,b) VALUES(?,?,?,?,?,?,'active',?,1,0,0)",room.chat,r.owner,r.guest,r.game,r.mode,r.rounds,r.owner).lastInsertRowid);
      run("UPDATE match_requests SET status='playing',match_id=?,updated=? WHERE code=?",next,Date.now(),code);
      run("UPDATE match_continue_votes SET state='rematched',updated=? WHERE code=?",Date.now(),code);
      roomService.reopen(r.room_code);
      options.onMatchStart?.(next);
      send(chat,'✅ 양쪽 모두 추가 경기에 동의했습니다. 새 경기를 시작합니다.\n현재 차례와 굴리기 버튼은 상단 고정 경기판에서 확인해 주세요.');
      return;
    }
    closeDecision(r,'declined');
  }
  function closeDecision(r,reason){
    const v=votesFor(r.code);if(!v||v.state!=='voting')return;
    const now=Date.now();
    run("UPDATE match_continue_votes SET state='closing',close_after=?,updated=? WHERE code=? AND state='voting'",now+15000,now,r.code);
    send(roomService.getByCode(r.room_code)?.chat||r.owner,reason==='timeout'?'⌛ 추가 경기 응답 시간이 만료되었습니다. 대전방을 종료합니다.':'✅ 추가 경기를 진행하지 않기로 했습니다.\n대전방을 종료합니다.\n기존 경기 결과는 내 전적에 저장되어 있습니다.');
  }
  const closingInProgress=new Set();
  async function processClose(code){
    if(closingInProgress.has(code))return;
    closingInProgress.add(code);
    try{
      const r=get(code),v=votesFor(code);
      if(!r||!v||v.state!=='closing')return;
      const closed=await roomService.close(r.room_code);
      if(!closed)throw Error('ROOM_NOT_CLOSED');
      run("UPDATE match_continue_votes SET state='closed',updated=?,last_error=NULL WHERE code=?",Date.now(),code);
      send(r.owner,'✅ '+code+' 대전방이 종료되었습니다. 다시 대전하려면 봇에서 새로운 매치를 개설하세요.');
      if(r.guest)send(r.guest,'✅ '+code+' 대전방이 종료되었습니다.');
    }catch(e){
      run("UPDATE match_continue_votes SET state='close_failed',last_error='GROUP_CLOSE_FAILED',updated=? WHERE code=?",Date.now(),code);
      options.onCloseFailed?.(get(code)?.match_id,code);
      console.warn('Match cleanup failed',{code,reason:String(e?.errorMessage||e?.message||'error').replace(/\\+?\\d{8,}/g,'[redacted]').slice(0,80)});
    }finally{closingInProgress.delete(code);}
  }

  function cancelForAdmin(code){const r=get(code);if(!r||['finished','cancelled','expired'].includes(r.status))return false;run("UPDATE match_requests SET status='cancelled',updated=? WHERE code=?",Date.now(),code);if(r.match_id)run("UPDATE matches SET state='cancelled' WHERE id=? AND state!='finished'",r.match_id);send(r.owner,'운영자에 의해 대전이 중단됐습니다: '+code);if(r.guest)send(r.guest,'운영자에 의해 대전이 중단됐습니다: '+code);return true;}
  return {sendMain,tutorial,begin,lobby,mine,onText,onCallback,tick,finished,cancelForAdmin,forceCloseForAdmin,stopByChat,timeoutMatch,retryCloseForAdmin,closeFinishedForAdmin,resume,get,config,votesFor,stopFor,processClose};
}
