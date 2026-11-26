// GLORY ARENA Telegram operations inbox.
// Admin enrollment is exclusively through the password-protected web dashboard.
import {usdtDisplay} from './tron-deposits.mjs';

export function createBotAdmin(db,enqueue,options={}){
 db.exec("CREATE TABLE IF NOT EXISTS bot_admins(user_id INTEGER PRIMARY KEY,added INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);CREATE TABLE IF NOT EXISTS bot_admin_notice(key TEXT NOT NULL,admin_id INTEGER NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(key,admin_id))");
 const now=options.now||Date.now;
 const one=(q,...a)=>db.prepare(q).get(...a),all=(q,...a)=>db.prepare(q).all(...a),run=(q,...a)=>db.prepare(q).run(...a);
 const isAdmin=id=>Number.isSafeInteger(id)&&!!one('SELECT user_id FROM bot_admins WHERE user_id=? AND enabled=1',id);
 function setAdmin(id,active){
   if(!Number.isSafeInteger(id)||id<=0||!one('SELECT id FROM arena_users WHERE id=?',id))return false;
   if(active){
     run('INSERT INTO bot_admins(user_id,added,enabled) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET enabled=1,added=excluded.added',id,now());
     return true;
   }
   return !!run('UPDATE bot_admins SET enabled=0 WHERE user_id=?',id).changes;
 }
 function list(){return all('SELECT a.user_id,a.added,a.enabled,u.name,u.username FROM bot_admins a LEFT JOIN arena_users u ON u.id=a.user_id ORDER BY a.enabled DESC,a.added DESC');}
 function displayUser(user){const u=one('SELECT id,name,username FROM arena_users WHERE id=?',user);return (u?.username?'@'+u.username:u?.name||'회원')+' (ID '+user+')';}
 const types={
  invoice:'📥 충전 신청 접수',
  credit:'✅ 입금 확인 · 자동 충전 완료',
  unmatched:'⚠️ 미확인 입금 · 수동 확인 필요',
  withdrawal:'📤 출금 신청 접수',
  withdraw_cancel:'↩️ 출금 신청 취소 · 잔액 복구'
 };
 function format(event){
   if(!types[event.type])throw Error('UNKNOWN_ADMIN_EVENT');
   const lines=['⚜️ GLORY ARENA · 입출금 알림','',types[event.type]];
   if(Number.isSafeInteger(event.user)&&event.user>0)lines.push('회원: '+displayUser(event.user));
   if(event.invoiceId)lines.push('충전번호: #'+event.invoiceId);
   if(event.withdrawalId)lines.push('출금번호: #'+event.withdrawalId);
   if(event.amount!=null)lines.push('금액: '+usdtDisplay(event.amount)+' USDT');
   if(event.address)lines.push('주소: '+event.address);
   if(event.txid)lines.push('TXID: '+event.txid);
   if(event.reason)lines.push('확인 사유: '+event.reason);
   if(event.type==='withdrawal')lines.push('상태: 신청 접수 · 송금 미실행 / 운영 확인 필요');
   if(event.type==='credit')lines.push('상태: 블록체인 확정 · 회원 잔액 반영 완료');
   return lines.join('\n');
 }
 function notify(event){
   const key=String(event.key||'').toLowerCase();
   if(!/^[a-z][a-z0-9:_-]{1,145}$/.test(key))throw Error('BAD_NOTICE_KEY');
   const text=format(event);
   let count=0;
   for(const a of all('SELECT user_id FROM bot_admins WHERE enabled=1 ORDER BY user_id')){
     // Keep durable one-message-per-admin/event state across restarts.
     db.exec('SAVEPOINT admin_notify');
     try{
       const change=run('INSERT OR IGNORE INTO bot_admin_notice(key,admin_id,created) VALUES(?,?,?)',key,a.user_id,now());
       if(change.changes){enqueue('sendMessage',{chat_id:a.user_id,text});count++;}
       db.exec('RELEASE admin_notify');
     }catch(e){db.exec('ROLLBACK TO admin_notify');db.exec('RELEASE admin_notify');throw e;}
   }
   return count;
 }
 function inbox(user){
   if(!isAdmin(user))return null;
   const deposits=all("SELECT i.id,i.user_id,i.amount_micro,i.status,i.created,i.txid FROM treasury_invoices i ORDER BY i.id DESC LIMIT 5");
   const withdrawals=all("SELECT id,user_id,amount_micro,status,created,to_address FROM treasury_withdrawals ORDER BY id DESC LIMIT 5");
   const unmatches=one('SELECT COUNT(*) n FROM treasury_unmatched')?.n||0;
   const lines=['🛡 GLORY ARENA · 봇 관리자','', '📥 최근 충전 신청'];
   if(!deposits.length)lines.push('내역 없음');
   else for(const v of deposits)lines.push('#'+v.id+' · '+displayUser(v.user_id)+' · '+usdtDisplay(v.amount_micro)+' USDT · '+v.status);
   lines.push('','📤 최근 출금 신청');
   if(!withdrawals.length)lines.push('내역 없음');
   else for(const v of withdrawals)lines.push('#'+v.id+' · '+displayUser(v.user_id)+' · '+usdtDisplay(v.amount_micro)+' USDT · '+v.status);
   lines.push('','⚠️ 미확인 입금: '+unmatches+'건','입출금 승인 및 지갑 설정 변경은 웹 관리자에서만 가능합니다.');
   return lines.join('\n');
 }
 return {setAdmin,isAdmin,list,notify,inbox,format};
}
