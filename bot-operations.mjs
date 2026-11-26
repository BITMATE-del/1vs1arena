// Telegram-only operational panel. Access is checked for every callback and text operation.
import {randomBytes} from 'node:crypto';
import {usdtDisplay} from './tron-deposits.mjs';
export function createBotOperations(db,send,botAdmin,walletOps,getMatchFlow,options={}){
 const one=(sql,...args)=>db.prepare(sql).get(...args);
 const all=(sql,...args)=>db.prepare(sql).all(...args);
 const run=(sql,...args)=>db.prepare(sql).run(...args);
 const now=options.now||Date.now;
 db.exec("CREATE TABLE IF NOT EXISTS bot_admin_inputs(admin_id INTEGER PRIMARY KEY,kind TEXT NOT NULL,target INTEGER NOT NULL,expires INTEGER NOT NULL,request_key TEXT NOT NULL);CREATE TABLE IF NOT EXISTS bot_room_calls(id INTEGER PRIMARY KEY AUTOINCREMENT,room_id INTEGER NOT NULL,member_id INTEGER NOT NULL,room_title TEXT NOT NULL,created INTEGER NOT NULL)");
 const b=(label,data)=>({text:label,callback_data:data});
 const isAdmin=id=>botAdmin.isAdmin(id);
 const nav=[[b('📥 충전 신청','ba:deposits'),b('📤 출금 신청','ba:withdrawals')],[b('👥 회원 관리','ba:users'),b('🏠 방 관리','ba:rooms')],[b('🔄 새로고침','ba:home')]];
 function home(admin){if(!isAdmin(admin))return false;send(admin,'🛡 GLORY ARENA · 봇 관리자\n\n충전·출금 신청과 회원·대전방을 이곳에서 관리할 수 있습니다.\n출금 승인은 실제 블록체인 송금과 구별됩니다.',nav);return true;}
 function requirePrivate(admin,chat,chatType){return chatType==='private'&&Number(admin)===Number(chat)&&isAdmin(admin);}
 function deposits(admin){
  const rows=all("SELECT i.id,i.user_id,i.amount_micro,i.status,u.username FROM treasury_invoices i LEFT JOIN arena_users u ON u.id=i.user_id ORDER BY i.id DESC LIMIT 10");
  send(admin,'📥 충전 신청 관리\n\n최근 10건을 확인하세요. 자동확정 이외 수동 반영은 실제 입금 확인 후 진행하세요.',[[b('🏠 관리자 메인','ba:home')]]);
  if(!rows.length){send(admin,'최근 충전 신청이 없습니다.');return;}
  for(const r of rows)send(admin,'#'+r.id+' · '+(r.username?'@'+r.username:'회원 '+r.user_id)+'\n'+usdtDisplay(r.amount_micro)+' USDT · '+r.status,
   ['pending','expired'].includes(r.status)?[[b('✅ 수동 입금 반영','ba:ic:'+r.id),b('❌ 신청 거절','ba:ir:'+r.id)]]:undefined);
 }
 function withdrawals(admin){
  const rows=all("SELECT w.id,w.user_id,w.amount_micro,w.to_address,w.status,u.username FROM treasury_withdrawals w LEFT JOIN arena_users u ON u.id=w.user_id ORDER BY w.id DESC LIMIT 12");
  send(admin,'📤 출금 신청 관리\n\n승인은 송금 대기 상태로 전환하며 실제 온체인 출금을 실행하지 않습니다.',[[b('🏠 관리자 메인','ba:home')]]);
  if(!rows.length){send(admin,'출금 신청 내역이 없습니다.');return;}
  for(const r of rows)send(admin,'#'+r.id+' · '+(r.username?'@'+r.username:'회원 '+r.user_id)+'\n'+usdtDisplay(r.amount_micro)+' USDT\n'+r.to_address+'\n상태: '+r.status,
   ['requested','approved'].includes(r.status)?[[...(r.status==='requested'?[b('✅ 승인','ba:wa:'+r.id)]:[]),b('❌ 거절·환급','ba:wr:'+r.id)]]:undefined);
 }
 function users(admin){
  const rows=all("SELECT u.id,u.username,u.name,u.blocked,COALESCE(w.balance_micro,0) balance_micro FROM arena_users u LEFT JOIN tron_wallets w ON w.user_id=u.id ORDER BY u.last_seen DESC LIMIT 12");
  send(admin,'👥 회원 관리 · 최근 12명\n\n회원 이름을 눌러 잔액·이용제한 상태를 관리하세요.',[[b('🔎 회원 ID 검색','ba:search')],[b('🏠 관리자 메인','ba:home')]]);
  for(const u of rows)send(admin,(u.username?'@'+u.username:u.name||String(u.id))+' (ID '+u.id+')\nUSDT 잔액 '+usdtDisplay(u.balance_micro)+' · '+(u.blocked?'이용 제한':'정상'),[[b('⚙️ 회원 관리','ba:user:'+u.id)]]);
 }
 function member(admin,id){
  const u=one("SELECT u.id,u.username,u.name,u.blocked,COALESCE(w.balance_micro,0) balance_micro FROM arena_users u LEFT JOIN tron_wallets w ON w.user_id=u.id WHERE u.id=?",id);
  if(!u){send(admin,'회원 정보를 찾을 수 없습니다.');return;}
  send(admin,'👤 회원 관리\n'+(u.username?'@'+u.username:u.name)+' · ID '+u.id+'\n잔액 '+usdtDisplay(u.balance_micro)+' USDT\n상태 '+(u.blocked?'이용 제한':'정상'),[[b('➕ 잔액 추가','ba:uc:'+id),b('➖ 잔액 차감','ba:ud:'+id)],[b(u.blocked?'🔓 이용 제한 해제':'🔒 이용 제한','ba:ub:'+id)],[b('◀ 회원 목록','ba:users')]]);
 }
 function rooms(admin){
  const rows=all("SELECT r.id,r.title,r.enabled,g.status AS generated_status FROM arena_rooms r LEFT JOIN generated_rooms g ON g.chat=r.id ORDER BY r.last_seen DESC LIMIT 12");
  send(admin,'🏠 대전방 관리 · 최근 12개\n\n방을 선택해 운영 상태를 확인하고 이용을 제한하거나 종료할 수 있습니다.',[[b('🏠 관리자 메인','ba:home')]]);
  for(const r of rows)send(admin,(r.title||'대전방')+'\n방 ID '+r.id+' · '+(r.enabled?'운영 중':'봇 중단')+' · '+(r.generated_status||'일반 그룹'),[[b('⚙️ 방 관리','ba:room:'+r.id)]]);
 }
 function room(admin,id){
  const r=one("SELECT r.id,r.title,r.enabled,g.status AS room_status,g.link,q.code,q.status AS match_status FROM arena_rooms r LEFT JOIN generated_rooms g ON g.chat=r.id LEFT JOIN match_requests q ON q.room_code=g.code WHERE r.id=? ORDER BY q.updated DESC LIMIT 1",id);
  if(!r){send(admin,'대전방 정보가 없습니다.');return;}
  const buttons=[[b(r.enabled?'⏸ 봇 사용 중단':'▶ 봇 사용 재개','ba:rt:'+id)]];
  if(r.code&&!['closed','closing'].includes(r.room_status))buttons.push([b('🛑 대전방 강제 종료','ba:rf:'+id)]);
  buttons.push([b('◀ 방 목록','ba:rooms')]);
  send(admin,'🏠 '+r.title+'\nID '+r.id+'\n봇 '+(r.enabled?'운영 중':'중단')+'\n그룹 '+(r.room_status||'-')+'\n매치 '+(r.code||'-')+' '+(r.match_status||''),buttons);
 }
 function audit(action,target){try{run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',now(),action,String(target).slice(0,100));}catch(e){console.warn('Bot admin audit failed',e.message);}}
 function prompt(admin,kind,target){
  const key=randomBytes(16).toString('hex');
  run('INSERT INTO bot_admin_inputs(admin_id,kind,target,expires,request_key) VALUES(?,?,?,?,?) ON CONFLICT(admin_id) DO UPDATE SET kind=excluded.kind,target=excluded.target,expires=excluded.expires,request_key=excluded.request_key',admin,kind,target,now()+600000,key);
  const msg=kind==='credit'||kind==='debit'?'조절 금액과 사유를 한 줄로 입력해 주세요.\n예: 20 정산 오류 보정\n소수점 6자리까지 가능 · 10분 유효':kind==='invoice'?'실제 입금 확인 후 고유 입금 관리번호 또는 TXID를 입력하세요.\n예: TXID 또는 CASH-ORDER-123\n10분 유효':'회원 텔레그램 숫자 ID를 입력해 주세요.\n예: 123456789\n10분 유효';
  send(admin,'✍️ 관리자 입력\n'+msg,[[b('❌ 입력 취소','ba:cancel')]]);
 }
 function callback(admin,chat,chatType,data){
  if(!data.startsWith('ba:'))return false;
  if(!requirePrivate(admin,chat,chatType)){send(admin,'관리자 등록된 계정의 봇 개인 채팅에서만 이용할 수 있습니다.');return true;}
  const [,action,param]=data.split(':');
  if(action==='home'){home(admin);return true;}
  if(action==='deposits'){deposits(admin);return true;}
  if(action==='withdrawals'){withdrawals(admin);return true;}
  if(action==='users'){users(admin);return true;}
  if(action==='rooms'){rooms(admin);return true;}
  if(action==='cancel'){run('DELETE FROM bot_admin_inputs WHERE admin_id=?',admin);home(admin);return true;}
  if(action==='search'){prompt(admin,'search',0);return true;}
  const id=Number(param);
  if(!Number.isSafeInteger(id))return true;
  if(action==='user'){member(admin,id);return true;}
  if(action==='room'){room(admin,id);return true;}
  if(['uc','ud'].includes(action)){
   if(!one('SELECT 1 FROM arena_users WHERE id=?',id))send(admin,'존재하지 않는 회원입니다.');
   else prompt(admin,action==='uc'?'credit':'debit',id);
   return true;
  }
  if(action==='ic'){const row=one("SELECT 1 FROM treasury_invoices WHERE id=? AND status IN ('pending','expired')",id);if(row)prompt(admin,'invoice',id);else send(admin,'이미 처리된 신청입니다.');return true;}
  if(action==='ir'){
   const result=walletOps.invoiceAction(id,'reject','bot:'+admin);
   send(admin,result.ok?'✅ 충전 신청 #'+id+' 거절 처리 완료':'⚠️ 처리 불가: '+result.reason);
   if(result.ok){audit('bot_invoice_reject',id+' by '+admin);const row=one('SELECT user_id FROM treasury_invoices WHERE id=?',id);if(row)send(row.user_id,'❌ 충전 신청 #'+id+'이 거절됐습니다.');}
   return true;
  }
  if(['wa','wr'].includes(action)){
   const type=action==='wa'?'approve':'reject',result=walletOps.withdrawal(id,type,'bot:'+admin);
   send(admin,result.ok?(type==='approve'?'✅ 출금 승인 · 송금 대기 #':'❌ 출금 거절 · 잔액 환급 #')+id:'⚠️ 처리 불가: '+result.reason);
   if(result.ok){audit('bot_withdraw_'+type,id+' by '+admin);send(result.user,type==='approve'?'📤 출금 #'+id+' 승인 · 수동 송금 대기':'↩️ 출금 #'+id+' 거절 · 보류 잔액 환급');}
   return true;
  }
  if(action==='ub'){
   const u=one('SELECT blocked FROM arena_users WHERE id=?',id);
   if(!u){send(admin,'회원 정보를 찾을 수 없습니다.');return true;}
   run('UPDATE arena_users SET blocked=? WHERE id=?',u.blocked?0:1,id);
   audit('bot_member_block',id+' by '+admin);member(admin,id);return true;
  }
  if(action==='rt'){
   const r=one('SELECT enabled FROM arena_rooms WHERE id=?',id);if(!r){send(admin,'존재하지 않는 방입니다.');return true;}
   const next=r.enabled?0:1;
   if(!next&&one("SELECT 1 FROM matches WHERE chat=? AND state IN ('active','requested','waiting')",id)){send(admin,'⚠️ 진행 중인 매치가 있어 봇 사용을 중단할 수 없습니다. 대전을 먼저 종료하세요.');return true;}
   run('UPDATE arena_rooms SET enabled=? WHERE id=?',next,id);audit('bot_room_toggle',id+' to '+next+' by '+admin);room(admin,id);return true;
  }
  if(action==='rf'){
   const request=one("SELECT q.code FROM match_requests q JOIN generated_rooms g ON g.code=q.room_code WHERE g.chat=? AND g.status NOT IN ('closed','closing') ORDER BY q.updated DESC LIMIT 1",id);
   const done=request&&getMatchFlow()?.forceCloseForAdmin(request.code);
   send(admin,done?'✅ 대전방 강제 종료 요청 완료 · '+request.code:'종료 가능한 대전방이 없습니다.');
   if(done)audit('bot_room_force_close',request.code+' by '+admin);
   return true;
  }
  return true;
 }
 function onText(admin,chat,chatType,content){
  if(!requirePrivate(admin,chat,chatType))return false;
  const v=one('SELECT * FROM bot_admin_inputs WHERE admin_id=?',admin);
  if(!v)return false;
  if(v.expires<now()){run('DELETE FROM bot_admin_inputs WHERE admin_id=?',admin);send(admin,'관리자 입력 시간이 만료됐습니다. 다시 선택해 주세요.');return true;}
  const input=String(content||'').trim();
  if(v.kind==='search'){
   if(!/^\d{1,16}$/.test(input)){send(admin,'숫자 회원 ID만 입력해 주세요.');return true;}
   run('DELETE FROM bot_admin_inputs WHERE admin_id=?',admin);member(admin,Number(input));return true;
  }
  if(v.kind==='invoice'){
   if(input.length<3||input.length>160){send(admin,'3~160자리의 관리번호 또는 TXID를 입력해 주세요.');return true;}
   const result=walletOps.invoiceAction(v.target,'credit','bot:'+admin,input);
   if(result.ok){run('DELETE FROM bot_admin_inputs WHERE admin_id=?',admin);audit('bot_invoice_credit',v.target+' by '+admin);send(admin,'✅ 충전 신청 #'+v.target+' 수동 입금 반영 완료\n금액: '+usdtDisplay(result.amount)+' USDT');send(result.user,'✅ 충전 신청 #'+v.target+' 수동 반영 완료 · '+usdtDisplay(result.amount)+' USDT');}
   else send(admin,'⚠️ 처리 불가: '+result.reason);
   return true;
  }
  if(['credit','debit'].includes(v.kind)){
   const match=/^((?:0|[1-9]\d{0,8})(?:\.\d{1,6})?)\s+(.{3,160})$/u.exec(input);
   if(!match){send(admin,'금액과 사유를 입력해 주세요.\n예: 20 운영 조정');return true;}
   const result=walletOps.operate({user:v.target,kind:v.kind,amount:match[1],reference:match[2],actor:'bot:'+admin,requestKey:v.request_key});
   if(result.ok){run('DELETE FROM bot_admin_inputs WHERE admin_id=?',admin);audit('bot_wallet_'+v.kind,v.target+' by '+admin);send(admin,'✅ 잔액 조절 완료\n회원: '+v.target+'\n이전: '+usdtDisplay(result.before)+' USDT\n현재: '+usdtDisplay(result.after)+' USDT');send(v.target,v.kind==='credit'?'✅ 관리자 잔액 추가: '+match[1]+' USDT':'📉 관리자 잔액 차감: '+match[1]+' USDT');}
   else send(admin,'⚠️ 처리 불가: '+result.reason);
   return true;
  }
  return false;
 }
 function callFromRoom(chat,title,member,messageId){
  if(!Number.isSafeInteger(chat)||chat>=0||!Number.isSafeInteger(member)||member<=0)return {ok:false,reason:'INVALID_CALL'};
  const r=one('SELECT enabled,title FROM arena_rooms WHERE id=?',chat);
  if(!r||r.enabled===0)return {ok:false,reason:'UNKNOWN_ROOM'};
  if(!botAdmin.list().some(a=>a.enabled))return {ok:false,reason:'NO_ADMIN'};
  const recent=one('SELECT created FROM bot_room_calls WHERE room_id=? ORDER BY created DESC LIMIT 1',chat);
  if(recent&&now()-recent.created<60000)return {ok:false,reason:'COOLDOWN'};
  const id=Number(run('INSERT INTO bot_room_calls(room_id,member_id,room_title,created) VALUES(?,?,?,?)',chat,member,String(title||r.title||'대전방').slice(0,200),now()).lastInsertRowid);
  const link=String(chat).startsWith('-100')&&Number.isSafeInteger(messageId)&&messageId>0?'https://t.me/c/'+String(chat).slice(4)+'/'+messageId:null;
  let sent=0;
  for(const a of botAdmin.list().filter(x=>x.enabled)){
   const text='🚨 GLORY ARENA 관리자 호출\n\n'+String(title||r.title||'대전방').slice(0,200)+'에서 관리자를 호출하였습니다.\n방 ID: '+chat+'\n호출 회원 ID: '+member+'\n호출번호: #'+id;
   send(a.user_id,text,link?[[{text:'📍 호출된 대전방 열기',url:link}],[b('⚙️ 방 관리','ba:room:'+chat)]]:[[b('⚙️ 방 관리','ba:room:'+chat)]]);
   sent++;
  }
  return {ok:sent>0,count:sent,id};
 }
 return {home,deposits,withdrawals,users,rooms,member,room,callback,onText,callFromRoom};
}
