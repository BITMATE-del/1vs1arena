import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createTelegramAuth } from './telegram-auth.mjs';
import { createRoomService } from './rooms.mjs';
import { createMatchFlow } from './match-flow.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const token=(process.env.BOT_TOKEN||'').trim();
const username=(process.env.BOT_USERNAME||'angelsda_bot').trim().replace(/^@/,'');
const base=(process.env.PUBLIC_URL||('https://'+(process.env.RAILWAY_PUBLIC_DOMAIN||''))).replace(/\/+$/,'');
const port=Number(process.env.PORT||3000);
if(!/^\d+:[\w-]+$/.test(token)) throw Error('BOT_TOKEN format invalid');
if(!/^https:\/\/[^/]+$/.test(base)) throw Error('PUBLIC_URL missing or invalid');
const botId=Number(token.split(':')[0]);
const secret=createHash('sha256').update(token+':valhalla-webhook-v1').digest('hex');
const dbPath=process.env.DB_PATH||'/data/arena.db';
mkdirSync(dirname(dbPath),{recursive:true});
const db=new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
db.exec('CREATE TABLE IF NOT EXISTS matches(id INTEGER PRIMARY KEY, chat INTEGER NOT NULL, owner INTEGER NOT NULL, guest INTEGER, game TEXT NOT NULL, mode TEXT NOT NULL, rounds INTEGER NOT NULL, state TEXT NOT NULL DEFAULT "waiting", turn INTEGER, round INTEGER NOT NULL DEFAULT 1, a INTEGER NOT NULL DEFAULT 0, b INTEGER NOT NULL DEFAULT 0)'.replace('DEFAULT "waiting"', "DEFAULT 'waiting'"));
db.exec('CREATE TABLE IF NOT EXISTS rolls(chat INTEGER, message INTEGER, match INTEGER, round INTEGER, player INTEGER, value INTEGER, PRIMARY KEY(chat,message), UNIQUE(match,round,player)); CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, method TEXT NOT NULL, payload TEXT NOT NULL)');
const games={'🎲':['다이스',6],'🏀':['농구',5],'⚽':['축구',5],'🎯':['다트',6],'🎳':['볼링',6],'🎰':['슬롯',64]};
const modes={wins:'선승제',total:'점수 합산',round:'매판 승패'};
const rounds=[1,3,5,7,9];
const one=(sql,...args)=>db.prepare(sql).get(...args);
const all=(sql,...args)=>db.prepare(sql).all(...args);
const run=(sql,...args)=>db.prepare(sql).run(...args);
const button=(text,callback_data)=>({text,callback_data});

db.exec("CREATE TABLE IF NOT EXISTS arena_users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT ''); CREATE TABLE IF NOT EXISTS arena_rooms(id INTEGER PRIMARY KEY, title TEXT NOT NULL, last_seen INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS admin_audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL); CREATE TABLE IF NOT EXISTS arena_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
function setting(k,fallback=''){return one('SELECT value FROM arena_settings WHERE key=?',k)?.value??fallback;}
function track(u){const m=u.message||u.callback_query?.message, p=u.callback_query?.from||u.message?.from;
if(p&&!p.is_bot&&Number.isSafeInteger(p.id))run("INSERT INTO arena_users(id,name,username,first_seen,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username,last_seen=excluded.last_seen",p.id,[p.first_name,p.last_name].filter(Boolean).join(' ').slice(0,200),String(p.username||'').slice(0,100),Date.now(),Date.now());
if(m?.chat&&['group','supergroup'].includes(m.chat.type))run("INSERT INTO arena_rooms(id,title,last_seen) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,last_seen=excluded.last_seen",m.chat.id,String(m.chat.title||'그룹').slice(0,200),Date.now());
}
function blocked(id){return !!one('SELECT blocked FROM arena_users WHERE id=?',id)?.blocked;}
function roomDisabled(id){return one('SELECT enabled FROM arena_rooms WHERE id=?',id)?.enabled===0;}
function gameEnabled(g){return setting('game:'+g,'1')==='1';}

function enqueue(method,payload){run('INSERT INTO outbox(method,payload) VALUES(?,?)',method,JSON.stringify(payload));}
function send(chat,text,buttons){enqueue('sendMessage',{chat_id:chat,text,...(buttons?{reply_markup:{inline_keyboard:buttons}}:{})});}
db.exec('CREATE TABLE IF NOT EXISTS welcome_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
const welcomeSetupHash='f27a916bb327294d267c9cf51a30a058c19be78304a25309a0ae278c63ab20f5';
function menu(chat){
const photo=process.env.WELCOME_PHOTO_FILE_ID||one("SELECT value FROM welcome_settings WHERE key='photo'")?.value;
const buttons=[[button('⚔ 매치 개설','mf:begin'),button('🏛 대기실','mf:lobby')],[button('🎮 내 경기','mf:mine'),button('📊 내 전적','stats')],[button('📖 이용 안내','mf:help')]];
const caption=setting('welcome_caption','⚜️ GLORY ARENA\n━━━━━━━━━━━━━━\n승부의 끝, 영광의 시작.\n\n당신의 다음 승부를 시작하세요.\n매치를 개설하거나 대기실에서 상대를 만나보세요.\n\n1vs1 무료 대전 · 텔레그램 공식 게임');
if(photo)enqueue('sendPhoto',{chat_id:chat,photo,caption,reply_markup:{inline_keyboard:buttons}});
else send(chat,'GLORY ARENA\n'+caption,buttons);
}
function guide(chat){send(chat,'GLORY ARENA | 이용 안내\n\n1. 그룹에 봇을 추가하세요.\n2. 매치 개설에서 게임과 경기 조건을 선택하세요.\n3. 상대의 신청을 수락하세요.\n4. 안내된 순서에 따라 공식 이모지 게임을 진행하세요.\n\n모든 대전은 무료입니다.',[[button('메인 메뉴','menu')]]);}
function stats(chat,user){
const r=one("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN (owner=? AND a>b) OR (guest=? AND b>a) THEN 1 ELSE 0 END),0) AS wins, COALESCE(SUM(CASE WHEN a=b THEN 1 ELSE 0 END),0) AS draws FROM matches WHERE state='finished' AND (owner=? OR guest=?)",user,user,user,user);
send(chat,'내 전적\n\n총 경기 '+r.total+'회\n승리 '+r.wins+' · 패배 '+(r.total-r.wins-r.draws)+' · 무승부 '+r.draws,[[button('메인 메뉴','menu')]]);
}
function setWelcome(m){
if(m.chat.type!=='private'||!Array.isArray(m.photo)||!m.photo.length||!m.caption?.startsWith('/banner '))return false;
const supplied=createHash('sha256').update(m.caption.slice(8).trim()).digest('hex');
if(!timingSafeEqual(Buffer.from(supplied),Buffer.from(welcomeSetupHash)))return false;
if(process.env.WELCOME_PHOTO_FILE_ID||one("SELECT value FROM welcome_settings WHERE key='photo'")){send(m.chat.id,'시작 이미지가 이미 등록되어 있습니다.');return true;}
const photo=m.photo.at(-1).file_id;
if(typeof photo!=='string'||photo.length<5)return false;
run("INSERT INTO welcome_settings(key,value) VALUES('photo',?)",photo);
console.log('Welcome photo registered; file_id='+photo);
send(m.chat.id,'시작 이미지 등록 완료.');menu(m.chat.id);return true;
}
function groupLink(chat){send(chat,'대전은 텔레그램 그룹에서 진행합니다.',[[{text:'그룹에 글로리 아레나 추가',url:'https://t.me/'+username+'?startgroup=true'}]]);}
function choose(chat){if(setting('matches_enabled','1')!=='1'){send(chat,'현재 신규 매치 개설이 중단되어 있습니다.');return;}send(chat,'게임을 선택하세요.',Object.entries(games).filter(([g])=>gameEnabled(g)).map(([g,v])=>[button(g+' '+v[0],'game:'+g)]).concat([[button('메인 메뉴','menu')]]));}
function lobby(chat){const rows=all("SELECT * FROM matches WHERE chat=? AND state='waiting' ORDER BY id DESC LIMIT 20",chat);
if(!rows.length){send(chat,'대기 중인 매치가 없습니다.',[[button('매치 개설','choose')]]);return;}
for(const m of rows)send(chat,'#'+m.id+' '+m.game+' '+games[m.game]?.[0]+' | '+m.rounds+'판 | '+modes[m.mode]+' | 무료 이벤트',[[button('매치 신청','join:'+m.id),button('취소','cancel:'+m.id)]]);
}
function action(chat,user,id,op){const m=one('SELECT * FROM matches WHERE id=? AND chat=?',id,chat);if(!m){send(chat,'존재하지 않는 경기입니다.');return;}
if(op==='join'&&m.state==='waiting'&&user!==m.owner){run("UPDATE matches SET guest=?,state='requested' WHERE id=?",user,id);send(chat,'신청 완료. 개설자 수락 대기 중입니다.',[[button('수락','accept:'+id),button('거절','reject:'+id)]]);return;}
if(op==='accept'&&m.state==='requested'&&user===m.owner){if(one("SELECT 1 FROM matches WHERE chat=? AND state='active' AND (owner IN (?,?) OR guest IN (?,?))",chat,user,m.guest,user,m.guest)){send(chat,'참가자가 다른 경기 진행 중입니다.');return;}run("UPDATE matches SET state='active',turn=owner WHERE id=?",id);send(chat,'경기 시작! 개설자부터 '+m.game+' 이모지를 단독 전송하세요. (ID '+user+')');return;}
if(op==='reject'&&m.state==='requested'&&user===m.owner){run("UPDATE matches SET guest=NULL,state='waiting' WHERE id=?",id);send(chat,'신청 거절. 다시 대기 중입니다.');return;}
if(op==='cancel'&&['waiting','requested'].includes(m.state)&&user===m.owner){run("UPDATE matches SET state='cancelled' WHERE id=?",id);send(chat,'매치 취소 완료.');return;}send(chat,'현재 상태 또는 권한으로 실행할 수 없습니다.');}
function roll(m){const {chat,from,dice,message_id}=m;const user=from.id,cid=chat.id,g=dice.emoji,v=dice.value;
if(!games[g]||!Number.isInteger(v)||v<1||v>games[g][1]||one('SELECT 1 FROM rolls WHERE chat=? AND message=?',cid,message_id))return;
const row=one("SELECT * FROM matches WHERE chat=? AND state='active' AND turn=? AND game=?",cid,user,g);if(!row)return;
const id=row.id,r=row.round;run('INSERT INTO rolls VALUES(?,?,?,?,?,?)',cid,message_id,id,r,user,v);
if(user===row.owner){run('UPDATE matches SET turn=guest WHERE id=?',id);send(cid,r+'라운드 개설자: '+v+'점. 상대방 차례입니다. (ID '+row.guest+')');return;}
const av=one('SELECT value FROM rolls WHERE match=? AND round=? AND player=?',id,r,row.owner).value;
let a=row.a,b=row.b;if(row.mode==='total'){a+=av;b+=v;}else{a+=Number(av>v);b+=Number(v>av);}
const done=r>=row.rounds||(row.mode==='wins'&&Math.max(a,b)>=Math.floor(row.rounds/2)+1);
run('UPDATE matches SET a=?,b=?,state=?,round=?,turn=? WHERE id=?',a,b,done?'finished':'active',done?r:r+1,done?null:row.owner,id);
send(cid,r+'라운드: '+av+' : '+v+'\n누적 '+a+' : '+b+'\n'+(done?'경기 종료 — '+(a===b?'무승부':a>b?'개설자 승리':'신청자 승리'):'다음 라운드: 개설자 차례'));if(done)matchFlow.finished(cid);}
function handle(u){track(u);const actor=u.callback_query?.from||u.message?.from;const chat=u.callback_query?.message?.chat||u.message?.chat;if(actor&&blocked(actor.id)){if(u.callback_query)enqueue('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:'이용이 제한된 계정입니다.',show_alert:true});else if(chat?.type==='private')send(chat.id,'이용이 제한된 계정입니다.');return;}if(chat&&roomDisabled(chat.id)&&chat.type!=='private')return;const q=u.callback_query;
if(q){const chat=q.message?.chat;if(!chat||!q.from||typeof q.data!=='string')return;const cid=chat.id,user=q.from.id,p=q.data.split(':');
enqueue('answerCallbackQuery',{callback_query_id:q.id});
if(p[0]==='mf'&&matchFlow.onCallback(user,cid,p))return;
if(p[0]==='menu'){menu(cid);return;}
if(p[0]==='stats'){stats(cid,user);return;}
if(p[0]==='guide'){guide(cid);return;}
if(chat.type==='private'){if(p[0]==='choose'){matchFlow.begin(user);return;}if(p[0]==='lobby'){matchFlow.lobby(user);return;}groupLink(cid);return;}
if(p[0]==='lobby'){lobby(cid);return;}
if(p[0]==='choose'){choose(cid);return;}
if(p[0]==='game'&&Object.hasOwn(games,p[1])){send(cid,'경기 방식 선택',Object.entries(modes).map(([k,t])=>[button(t,'mode:'+p[1]+':'+k)]));return;}
if(p[0]==='mode'&&Object.hasOwn(games,p[1])&&Object.hasOwn(modes,p[2])){send(cid,'경기 횟수 선택',[rounds.map(n=>button(n+'판','new:'+p[1]+':'+p[2]+':'+n))]);return;}
if(p[0]==='new'&&setting('matches_enabled','1')==='1'&&gameEnabled(p[1])&&Object.hasOwn(games,p[1])&&Object.hasOwn(modes,p[2])&&rounds.includes(Number(p[3]))){const id=Number(run('INSERT INTO matches(chat,owner,game,mode,rounds) VALUES(?,?,?,?,?)',cid,user,p[1],p[2],Number(p[3])).lastInsertRowid);send(cid,'#'+id+' 매치 개설 완료',[[button('매치 신청','join:'+id),button('취소','cancel:'+id)]]);return;}
if(['join','accept','reject','cancel'].includes(p[0])&&/^\d+$/.test(p[1]||'')){action(cid,user,Number(p[1]),p[0]);return;}return;}
const m=u.message;if(!m?.from||!['private','group','supergroup'].includes(m.chat?.type))return;
if(setWelcome(m))return;
const cid=m.chat.id,t=(m.text||'').split(/\s+/)[0].split('@')[0],full=m.text||'';
if(['/start','/help'].includes(t)||full==='🏠 메인 메뉴'){menu(cid);return;}
if(full==='📖 이용 안내'){matchFlow.tutorial(cid);return;}
if(m.chat.type==='private'&&matchFlow.onText(m.from.id,full))return;
if(t==='/create'||t==='/lobby'||['⚔ 매치 개설','🏛 매치 대기실'].includes(full)){if(m.chat.type==='private'){if(t==='/create'||full==='⚔ 매치 개설')matchFlow.begin(m.from.id);else matchFlow.lobby(m.from.id);return;}if(t==='/create'||full==='⚔ 매치 개설')choose(cid);else lobby(cid);return;}
if(m.new_chat_members?.some(x=>x.id===botId)){menu(cid);return;}
if(m.chat.type!=='private'&&m.dice&&!m.forward_origin&&!m.forward_date&&!m.via_bot&&!m.sender_chat&&!m.from.is_bot)roll(m);
}
let webhookReady=false,blockedUntil=Date.now(),lastError=null,busy=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function tg(method,data){const wait=blockedUntil-Date.now();if(wait>0)await sleep(wait);
const response=await fetch('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(25000)});
let result;try{result=await response.json();}catch{result={};}
if(!response.ok||!result.ok){const code=Number(result.error_code||response.status);if(code===429){const retry=Math.max(Number(result.parameters?.retry_after)||0,Number(response.headers.get('retry-after'))||0,120);blockedUntil=Date.now()+(retry+5)*1000;console.warn('Telegram',method,'HTTP 429; retry_after=',retry);}throw Object.assign(new Error('Telegram API error'),{code});}
return result.result;}
async function register(){for(;;){if(webhookReady)return;try{await tg('setWebhook',{url:base+'/telegram/webhook',secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false,max_connections:1});webhookReady=true;lastError=null;console.log('Telegram webhook registered successfully');void drain();return;}catch(e){lastError=e.code||'network';console.warn('Webhook registration failed:',lastError);await sleep(e.code===429?Math.max(0,blockedUntil-Date.now()):120000);}}}
async function drain(){if(busy||!webhookReady)return;busy=true;try{for(;;){const r=one('SELECT * FROM outbox ORDER BY id LIMIT 1');if(!r)break;try{await tg(r.method,JSON.parse(r.payload));run('DELETE FROM outbox WHERE id=?',r.id);}catch(e){lastError=e.code||'network';console.warn('Delivery',r.method,'failed:',lastError);if([400,403].includes(e.code)){if(r.method==='sendPhoto'){const p=JSON.parse(r.payload);enqueue('sendMessage',{chat_id:p.chat_id,text:'GLORY ARENA\n'+p.caption,reply_markup:p.reply_markup});}run('DELETE FROM outbox WHERE id=?',r.id);continue;}await sleep(e.code===429?Math.max(0,blockedUntil-Date.now()):60000);break;}}}finally{busy=false;}}
function validSecret(req){const a=Buffer.from(String(req.headers['x-telegram-bot-api-secret-token']||''));const b=Buffer.from(secret);return a.length===b.length&&timingSafeEqual(a,b);}

const adminPassword=process.env.ADMIN_PASSWORD||'';
const telegramAuth=createTelegramAuth(db,secret,adminPassword);
const roomService=createRoomService(db,telegramAuth,username,send);
const matchFlow=createMatchFlow(db,send,roomService,games,modes,rounds,{gameEnabled});
const adminAttempts=new Map();
const adminGlobalAttempts={count:0,until:0};
const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const adminCss='*{box-sizing:border-box}body{margin:0;background:#101114;color:#eee;font:15px system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:30px 20px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:30px}h1{font-size:23px;margin:0;color:#d4af37;letter-spacing:1px}h2{font-size:17px}p{line-height:1.7;color:#a9a9ac}section{background:#191b20;border:1px solid #303137;border-radius:12px;padding:20px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.metric{font-size:30px;font-weight:700;color:#d4af37}small{color:#a9a9ac}.layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:22px}nav{display:flex;flex-direction:column;gap:6px;align-self:start;background:#191b20;padding:10px;border-radius:12px}nav a{padding:12px 14px;text-decoration:none;color:#c2c2c5;border-radius:7px}nav a.selected{background:#332d1c;color:#f1d16d}article{min-width:0}.page-title{font-size:24px;margin:4px 0 18px}.inline{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.inline input:not([type=hidden]){width:180px;margin:0}.finder{display:flex;gap:10px;align-items:center;margin:12px 0}.finder input{margin:0;max-width:330px}textarea{display:block;width:min(100%,650px);padding:12px;background:#121318;color:#eee;border:1px solid #45464d;border-radius:8px;font:inherit}.pager{display:flex;gap:20px;margin:20px 0}button:disabled{opacity:.4;cursor:not-allowed}@media(max-width:800px){.layout{grid-template-columns:1fr}nav{flex-direction:row;overflow:auto}nav a{white-space:nowrap}}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{text-align:left;padding:12px;border-bottom:1px solid #303137}th{color:#b0b0b5}button,a.btn{display:inline-block;border:0;background:#d4af37;color:#15120a;font:inherit;font-weight:700;padding:10px 16px;border-radius:8px;text-decoration:none;cursor:pointer}input{width:100%;padding:12px;color:#eee;background:#121318;border:1px solid #45464d;border-radius:8px;margin:8px 0 16px}a{color:#d4af37}.scroll{overflow:auto}.login{max-width:420px;margin:12vh auto}.tag{color:#d4af37}.error{color:#ffb4a8}@media(max-width:500px){main{padding:16px}header{align-items:flex-start}h1{font-size:19px}}';
function adminPage(res,body,status=200){res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','content-security-policy':"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GLORY ARENA 관리자</title><style>'+adminCss+'</style><main>'+body+'</main><script src="/admin/ui.js" defer></script></html>');}
function adminSig(exp){return createHash('sha256').update(secret+':admin:'+adminPassword+':'+exp).digest('hex');}
function adminAuth(req){if(!adminPassword||adminPassword.length<16)return false;const value=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ga_admin='))?.slice(9)||'';const [exp,sig]=value.split('.');if(!/^\d+$/.test(exp||'')||!/^[a-f0-9]{64}$/.test(sig||'')||Number(exp)<Date.now())return false;return timingSafeEqual(Buffer.from(sig),Buffer.from(adminSig(exp)));}
async function adminRoute(req,res){const path=req.url.split('?')[0];if(path!='/admin'&&!path.startsWith('/admin/'))return false;
if(path==='/admin/ui.js'&&req.method==='GET'){
res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'"});res.end("(() => {\nconst messages={\nok:'텔레그램 요청이 처리되었습니다.',\nRETRY_EXHAUSTED:'텔레그램 서버가 재시도 후에도 요청을 처리하지 못했습니다.',\nREQUEST_COOLDOWN:'요청 간격이 너무 짧습니다. 잠시 후 다시 시도하세요.',\nAPI_MISSING:'API ID / HASH를 확인해주세요.',\nPHONE_INVALID:'전화번호는 01012345678 또는 +821012345678 형식으로 입력하세요.',\nPHONE_NUMBER_INVALID:'텔레그램에 등록된 전화번호가 아닙니다.',\nPHONE_NUMBER_FLOOD:'전화번호 인증 요청이 제한되었습니다.',\nPHONE_CODE_INVALID:'인증번호가 올바르지 않습니다.',\nPHONE_CODE_EXPIRED:'인증번호가 만료되었습니다.',\nPASSWORD_HASH_INVALID:'2단계 비밀번호를 확인하세요.',\nFLOOD_WAIT:'텔레그램 요청 제한입니다. 잠시 후 다시 시도하세요.',\nTELEGRAM_ERROR:'텔레그램 인증 요청에 실패했습니다. 관리자 화면의 최근 오류를 확인하세요.',\nNETWORK_ERROR:'텔레그램 서버와 연결할 수 없습니다.',\nAPI_ID_INVALID:'API ID 또는 HASH를 확인하세요.'\n};\ndocument.addEventListener('submit',async ev=>{\n const form=ev.target;\n if(!(form instanceof HTMLFormElement)||!form.classList.contains('inline')||!form.action.includes('/admin/action'))return;\n ev.preventDefault();if(form.dataset.busy==='1')return;form.dataset.busy='1';\n const button=form.querySelector('button'),original=button?.textContent;\n if(button){button.disabled=true;button.textContent='요청 처리 중...';}\n let status=form.querySelector('.form-status');\n if(!status){status=document.createElement('p');status.className='form-status';status.setAttribute('role','status');status.setAttribute('aria-live','assertive');form.append(status);}\n status.textContent='텔레그램 응답을 확인하고 있습니다.';\n try{\n const telegram=new FormData(form).get('action')?.toString().startsWith('tg_');\n const response=await fetch(form.action,{method:'POST',credentials:'same-origin',headers:telegram?{'Accept':'application/json'}:{},body:new URLSearchParams(new FormData(form))});\n if(telegram){\n   if(!response.ok)throw new Error('요청이 거부되었습니다. 관리자 로그인을 확인하세요.');\n   const result=await response.json();\n   if(!result.ok){status.textContent=messages[result.code]||('요청 실패: '+result.code);return;}\n   const page=await fetch('/admin?tab=telegram',{credentials:'same-origin',cache:'no-store'});\n   if(!page.ok)throw new Error('화면 정보를 불러오지 못했습니다.');\n   const doc=new DOMParser().parseFromString(await page.text(),'text/html');\n   const article=doc.querySelector('article'),current=document.querySelector('article');\n   if(!article||!current)throw new Error('관리자 화면을 찾지 못했습니다.');\n   current.innerHTML=article.innerHTML;\n   const banner=document.createElement('p');banner.setAttribute('role','status');banner.className='form-status';banner.textContent=result.stage==='code'?'인증번호 요청 성공. 텔레그램 앱의 인증번호를 입력하세요.':result.stage==='password'?'2단계 비밀번호를 입력하세요.':messages.ok;\n   current.prepend(banner);\n }else{\n   const doc=new DOMParser().parseFromString(await response.text(),'text/html');\n   const next=doc.querySelector('article'),current=document.querySelector('article');\n   if(!response.ok||!next||!current)throw new Error('요청 실패. 관리자 로그인을 확인하세요.');\n   current.innerHTML=next.innerHTML;\n }\n }catch(e){status.textContent=e.message||'요청 실패';}\n finally{form.dataset.busy='0';if(button){button.disabled=false;button.textContent=original;}}\n});\n})();");return true;}
if(!adminPassword||adminPassword.length<16){adminPage(res,'<section class="login"><h1>GLORY ARENA</h1><p>관리자 접근이 비활성화되어 있습니다. Railway에 16자 이상의 ADMIN_PASSWORD를 설정하세요.</p></section>',503);return true;}
if(path==='/admin/login'&&req.method==='POST'){const ip=String(req.headers['x-real-ip']||req.socket.remoteAddress||'unknown');const now=Date.now();if(adminGlobalAttempts.until<now){adminGlobalAttempts.count=0;adminGlobalAttempts.until=now+900000;}if(adminGlobalAttempts.count>=30){adminPage(res,'<section>로그인 시도 제한</section>',429);return true;}for(const [k,v] of adminAttempts)if(v.until<now)adminAttempts.delete(k);const hit=adminAttempts.get(ip)||{count:0,until:now+900000};if(hit.count>=5){adminPage(res,'<section class="login"><p class="error">로그인 시도 횟수를 초과했습니다.</p><a href="/admin">돌아가기</a></section>',429);return true;}let body='';for await(const chunk of req){body+=chunk.toString();if(body.length>4096){res.writeHead(413).end();return true;}}const pass=new URLSearchParams(body).get('password')||'';const h=x=>createHash('sha256').update(x).digest();if(!timingSafeEqual(h(pass),h(adminPassword))){hit.count++;adminGlobalAttempts.count++;adminAttempts.set(ip,hit);adminPage(res,'<section class="login"><p class="error">비밀번호가 일치하지 않습니다.</p><a href="/admin">다시 로그인</a></section>',401);return true;}adminAttempts.delete(ip);const exp=String(now+28800000);res.writeHead(303,{'location':'/admin','set-cookie':'ga_admin='+exp+'.'+adminSig(exp)+'; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800'}).end();return true;}
if(path==='/admin/logout'&&req.method==='POST'){res.writeHead(303,{'location':'/admin','set-cookie':'ga_admin=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0'}).end();return true;}

if(!adminAuth(req)){if(req.method!=='GET'){res.writeHead(403).end();return true;}adminPage(res,'<section class="login"><h1>GLORY ARENA</h1><p>관리자 전용 로그인</p><form method="post" action="/admin/login"><label>관리자 비밀번호<input type="password" name="password" required autocomplete="current-password"></label><button>로그인</button></form></section>');return true;}
const sections={overview:'대시보드',users:'회원 관리',rooms:'방 관리',matches:'경기 관리',records:'판정 기록',games:'게임 설정',telegram:'텔레그램 계정 관리',requests:'대전 신청 관리',bot:'봇 설정',audit:'운영 로그'};
const url=new URL(req.url,base);
const tab=Object.hasOwn(sections,url.searchParams.get('tab'))?url.searchParams.get('tab'):'overview';
const csrf=createHash('sha256').update(secret+':csrf:'+String(req.headers.cookie||'')).digest('hex');
const esc=escapeHtml;
const form=(act,id,inner,label,extra='')=>'<form class="inline" method="post" action="/admin/action?tab='+tab+'"><input type="hidden" name="csrf" value="'+csrf+'"><input type="hidden" name="action" value="'+act+'"><input type="hidden" name="id" value="'+esc(id)+'">'+inner+'<button '+extra+'>'+label+'</button></form>';
if(path==='/admin/action'&&req.method==='POST'){
let raw='';for await(const chunk of req){raw+=chunk.toString();if(raw.length>12000){res.writeHead(413).end();return true;}}
const q=new URLSearchParams(raw),provided=q.get('csrf')||'';
if(!/^[a-f0-9]{64}$/.test(provided)||!timingSafeEqual(Buffer.from(provided),Buffer.from(csrf))){res.writeHead(403).end();return true;}
const act=q.get('action'),id=Number(q.get('id')),value=q.get('value')||'';let changed=false;
if(act==='mr_cancel'&&/^GA-[A-F0-9]{8}$/.test(String(q.get('code')||''))){const done=matchFlow.cancelForAdmin(q.get('code'));res.writeHead(303,{location:'/admin?tab=requests&saved='+Number(done)}).end();void drain();return true;}
if(['tg_send','tg_code','tg_password','tg_session','tg_verify','tg_logout','tg_cancel'].includes(act)){
let result='ok';try{
if(act==='tg_send')await telegramAuth.start((q.get('phone')||'').trim());
if(act==='tg_code')await telegramAuth.code((q.get('code')||'').trim());
if(act==='tg_password')await telegramAuth.password(q.get('password')||'');
if(act==='tg_session')await telegramAuth.registerSession((q.get('session')||'').trim());
if(act==='tg_verify')await telegramAuth.verify();
if(act==='tg_logout')await telegramAuth.disconnect();
if(act==='tg_cancel')await telegramAuth.cancel();
run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),act,'telegram_account');
}catch(e){result=telegramAuth.error(e);}
if(req.headers.accept?.includes('application/json')){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify({ok:result==='ok',code:result,stage:telegramAuth.info().stage}));return true;}
res.writeHead(303,{location:'/admin?tab=telegram&result='+encodeURIComponent(result)}).end();return true;
}
db.exec('BEGIN IMMEDIATE');try{
if(['block','unblock','note'].includes(act)&&Number.isSafeInteger(id)&&one('SELECT id FROM arena_users WHERE id=?',id)){
if(act==='note')run('UPDATE arena_users SET note=? WHERE id=?',value.slice(0,500),id);
else run('UPDATE arena_users SET blocked=? WHERE id=?',Number(act==='block'),id);
changed=true;
}
if(['room_enable','room_disable'].includes(act)&&Number.isSafeInteger(id)){
if(!one("SELECT 1 FROM matches WHERE chat=? AND state IN ('active','requested','waiting')",id)||act==='room_enable'){changed=!!run('UPDATE arena_rooms SET enabled=? WHERE id=?',Number(act==='room_enable'),id).changes;}
}
if(act==='cancel'&&Number.isSafeInteger(id)){const m=one("SELECT * FROM matches WHERE id=? AND state IN ('waiting','requested')",id);if(m){run("UPDATE matches SET state='cancelled' WHERE id=?",id);send(m.chat,'운영 정책에 따라 대기 매치가 취소되었습니다.');changed=true;}}
if(act==='game'&&Object.hasOwn(games,q.get('id'))&&['0','1'].includes(value)){run('INSERT INTO arena_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value','game:'+q.get('id'),value);changed=true;}
if(act==='matches_enabled'&&['0','1'].includes(value)){run('INSERT INTO arena_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',act,value);changed=true;}
if(act==='flow_minutes'&&Number.isInteger(Number(value))&&Number(value)>=5&&Number(value)<=120){run("INSERT INTO match_flow_settings(key,value) VALUES('request_minutes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",value);changed=true;}
if(act==='flow_guide'&&value.trim().length>0&&value.length<=1800){run("INSERT INTO match_flow_settings(key,value) VALUES('text_guide',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",value);changed=true;}
if(act==='flow_room_notice'&&value.trim().length>0&&value.length<=1800){run("INSERT INTO match_flow_settings(key,value) VALUES('text_room_notice',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",value);changed=true;}
if(act==='welcome_caption'&&value.trim()&&value.length<=900){run('INSERT INTO arena_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',act,value);changed=true;}
if(changed)run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),act,String(q.get('id')||'설정').slice(0,100));
db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');adminPage(res,'<section>저장 실패. <a href="/admin">돌아가기</a></section>',500);return true;}
res.writeHead(303,{location:'/admin?tab='+tab+'&saved='+Number(changed)}).end();void drain();return true;
}
if(req.method!=='GET'||path!='/admin'){res.writeHead(404).end();return true;}
const search=(url.searchParams.get('q')||'').slice(0,100),like='%'+search+'%';
const page=Math.max(1,Math.min(100000,Number.parseInt(url.searchParams.get('page')||'1',10)||1)),offset=(page-1)*50;
const date=v=>v?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'-';
const labels={waiting:'대기',requested:'신청 접수',active:'진행 중',finished:'종료',cancelled:'취소'};
const table=(heads,rows)=>'<div class="scroll"><table><thead><tr>'+heads.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+(rows.length?rows.join(''):'<tr><td colspan="'+heads.length+'">표시할 기록이 없습니다.</td></tr>')+'</tbody></table></div>';
const tr=(values,extra='')=>'<tr>'+values.map(v=>'<td>'+esc(v)+'</td>').join('')+extra+'</tr>';
const paging=()=>'<div class="pager">'+(page>1?'<a href="?tab='+tab+'&q='+encodeURIComponent(search)+'&page='+(page-1)+'">이전</a>':'')+' <span>'+page+' 페이지</span> <a href="?tab='+tab+'&q='+encodeURIComponent(search)+'&page='+(page+1)+'">다음</a></div>';
const finder=()=>'<form class="finder" method="get" action="/admin"><input type="hidden" name="tab" value="'+tab+'"><input name="q" placeholder="이름 / 번호 / 상태 검색" value="'+esc(search)+'"><button>검색</button><a href="?tab='+tab+'">초기화</a></form>';
const valueField=v=>'<input type="hidden" name="value" value="'+esc(v)+'">';
let content='';
if(tab==='overview'){
const c=one("SELECT COUNT(*) AS total,COALESCE(SUM(state='waiting'),0) AS waiting,COALESCE(SUM(state='requested'),0) AS requested,COALESCE(SUM(state='active'),0) AS active,COALESCE(SUM(state='finished'),0) AS finished FROM matches");
const metrics=[['등록 회원',one('SELECT COUNT(*) n FROM arena_users').n],['등록 방',one('SELECT COUNT(*) n FROM arena_rooms').n],['전체 경기',c.total],['대기 경기',c.waiting],['신청 접수',c.requested],['진행 경기',c.active],['종료 경기',c.finished],['발송 대기',one('SELECT COUNT(*) n FROM outbox').n]];
content='<div class="grid">'+metrics.map(([k,v])=>'<section><small>'+k+'</small><div class="metric">'+v+'</div></section>').join('')+'</div><section><h2>시스템 상태</h2><p>웹훅: '+(webhookReady?'연결 정상':'확인 중')+' · 신규 매치: '+(setting('matches_enabled','1')==='1'?'허용':'중단')+'</p><p>현재 무료 대전 운영 · 자동 전용 그룹 생성 미연동</p></section>';
}
if(tab==='users'){const rows=all("SELECT u.*, (SELECT COUNT(*) FROM matches m WHERE m.owner=u.id OR m.guest=u.id) AS matches FROM arena_users u WHERE CAST(id AS TEXT) LIKE ? OR name LIKE ? OR username LIKE ? ORDER BY last_seen DESC LIMIT 50 OFFSET ?",like,like,like,offset);
content='<section><h2>회원 목록</h2><p>봇이 수신한 사용자만 등록됩니다. 이용 제한은 신규 봇 상호작용을 차단하며 기존 경기 결과는 변경하지 않습니다.</p>'+finder()+table(['ID','이름','아이디','최초 접속','최근 접속','경기 수','상태','관리','메모'],rows.map(r=>tr([r.id,r.name,r.username?'@'+r.username:'-',date(r.first_seen),date(r.last_seen),r.matches,r.blocked?'제한':'정상'],'<td>'+form(r.blocked?'unblock':'block',r.id,'',r.blocked?'해제':'제한')+'</td><td>'+form('note',r.id,'<input name="value" maxlength="500" value="'+esc(r.note)+'" placeholder="운영 메모">','저장')+'</td>')))+paging()+'</section>';}
if(tab==='rooms'){const rows=all("SELECT r.*, (SELECT COUNT(*) FROM matches m WHERE m.chat=r.id AND m.state IN ('waiting','requested','active')) AS open FROM arena_rooms r WHERE CAST(id AS TEXT) LIKE ? OR title LIKE ? ORDER BY last_seen DESC LIMIT 50 OFFSET ?",like,like,offset);
content='<section><h2>그룹 목록</h2><p>봇이 확인한 그룹입니다. 사용 중인 방은 중단할 수 없으며, 방 중단은 봇 기능에만 적용됩니다.</p>'+finder()+table(['그룹 번호','그룹명','최근 접속','진행·대기','상태','관리'],rows.map(r=>tr([r.id,r.title,date(r.last_seen),r.open,r.enabled?'사용':'중단'],'<td>'+form(r.enabled?'room_disable':'room_enable',r.id,'',r.enabled?'중단':'활성화',r.enabled&&r.open?'disabled':'')+'</td>')))+paging()+'</section><section><h2>전용 그룹 생성</h2><p>아직 연결되지 않았습니다. 그룹 자동 생성이나 실제 텔레그램 방 삭제를 수행하지 않습니다.</p></section>';}
if(tab==='matches'){const rows=all("SELECT * FROM matches WHERE CAST(id AS TEXT) LIKE ? OR CAST(chat AS TEXT) LIKE ? OR CAST(owner AS TEXT) LIKE ? OR state LIKE ? ORDER BY id DESC LIMIT 50 OFFSET ?",like,like,like,like,offset);
content='<section><h2>경기 현황</h2><p>대기 및 신청 접수 경기만 취소할 수 있습니다. 진행 중 또는 종료된 경기의 결과와 점수는 수정할 수 없습니다.</p>'+finder()+table(['번호','방','생성자','참가자','게임','방식','횟수','상태','점수','관리'],rows.map(m=>tr([m.id,m.chat,m.owner,m.guest||'-',games[m.game]?.[0]||m.game,modes[m.mode]||m.mode,m.rounds,labels[m.state]||m.state,m.a+' : '+m.b],'<td>'+(['waiting','requested'].includes(m.state)?form('cancel',m.id,'','취소'):'—')+'</td>')))+paging()+'</section>';}
if(tab==='records'){const rows=all("SELECT * FROM rolls WHERE CAST(match AS TEXT) LIKE ? OR CAST(player AS TEXT) LIKE ? OR CAST(chat AS TEXT) LIKE ? ORDER BY rowid DESC LIMIT 50 OFFSET ?",like,like,like,offset);
content='<section><h2>텔레그램 원본 판정</h2><p>수신한 공식 이모지 결과와 메시지 번호를 조회합니다. 수정 및 삭제 기능은 제공하지 않습니다.</p>'+finder()+table(['경기','그룹','메시지 ID','라운드','참가자','공식 값'],rows.map(r=>tr([r.match,r.chat,r.message,r.round,r.player,r.value])))+paging()+'</section>';}
if(tab==='games'){content='<section><h2>신규 매치 접수</h2><p>기존 경기를 유지하면서 신규 경기 개설을 제어합니다.</p>'+form('matches_enabled','',valueField(setting('matches_enabled','1')==='1'?'0':'1'),setting('matches_enabled','1')==='1'?'신규 접수 중단':'신규 접수 허용')+'</section><section><h2>게임별 설정</h2>'+table(['게임','공식 값 범위','신규 개설','관리'],Object.entries(games).map(([g,v])=>tr([g+' '+v[0],'1~'+v[1],gameEnabled(g)?'사용':'중단'],'<td>'+form('game',g,valueField(gameEnabled(g)?'0':'1'),gameEnabled(g)?'비활성화':'활성화')+'</td>')))+'<p>무료 대전만 지원합니다. 슬롯은 원시 값 비교이며 조합 판정은 미구현입니다.</p></section>';}
if(tab==='bot'){content='<section><h2>연결 정보</h2><p>공식 봇: @'+esc(username)+'<br>웹훅: '+(webhookReady?'정상':'미연결')+'<br>API ID / HASH: '+(process.env.TELEGRAM_API_ID&&process.env.TELEGRAM_API_HASH?'등록 완료':'미등록')+'<br>시작 이미지: '+(process.env.WELCOME_PHOTO_FILE_ID?'등록 완료':'확인 필요')+'<br>마지막 오류: '+esc(lastError||'없음')+'</p><p>계정 로그인 및 자동 그룹 생성은 미연동입니다. 비밀값은 표시하지 않습니다.</p></section><section><h2>시작 화면 문구</h2>'+form('welcome_caption','', '<textarea name="value" maxlength="900" rows="7" required>'+esc(setting('welcome_caption','⚜️ GLORY ARENA\n승부의 끝, 영광의 시작.\n\n당신의 다음 승부를 시작하세요.\n매치를 개설하거나 대기실에서 상대를 만나보세요.\n\n1vs1 무료 대전 · 텔레그램 공식 게임'))+'</textarea>','문구 저장')+'</section>';}

if(tab==='telegram'){
const a=telegramAuth.info();
const msg={RETRY_EXHAUSTED:'텔레그램 서버가 인증 요청을 처리하지 못했습니다. 연결 대상 재시도 후에도 실패했습니다.',REQUEST_COOLDOWN:'인증번호 발송은 잠시 간격을 두고 다시 시도해 주세요.',PHONE_NUMBER_BANNED:'해당 전화번호는 텔레그램에서 제한되었습니다.',PHONE_NUMBER_FLOOD:'전화번호 인증 요청이 너무 많습니다. 텔레그램 제한이 해제된 후 시도하세요.',PHONE_PASSWORD_FLOOD:'비밀번호 인증 요청이 너무 많습니다. 나중에 다시 시도하세요.',API_ID_PUBLISHED_FLOOD:'API ID가 텔레그램에서 제한되었습니다. 개발자 페이지에서 상태를 확인하세요.',AUTH_RESTART:'텔레그램에서 인증 절차를 다시 시작하도록 요청했습니다.',SEND_CODE_UNAVAILABLE:'텔레그램에서 현재 인증번호를 발송할 수 없습니다.',PHONE_CODE_HASH_INVALID:'인증 요청이 유효하지 않습니다. 처음부터 다시 시도하세요.',ok:'인증 요청 처리에 성공했습니다. 텔레그램 앱에서 인증번호를 확인하세요.',PHONE_INVALID:'전화번호를 +821012345678 형식으로 입력하세요.',PHONE_NUMBER_INVALID:'텔레그램에 등록된 번호를 확인하세요.',PHONE_CODE_INVALID:'인증번호가 올바르지 않습니다.',PHONE_CODE_EXPIRED:'인증번호가 만료되었습니다. 다시 발송하세요.',PASSWORD_HASH_INVALID:'2단계 비밀번호가 올바르지 않습니다.',LOGIN_EXPIRED:'인증 시간이 만료되었습니다. 처음부터 다시 진행하세요.',FLOOD_WAIT:'텔레그램 요청 제한입니다. 일정 시간 이후 다시 시도하세요.',TELEGRAM_ERROR:'인증번호 발송에 실패했습니다. 전화번호, API 정보 또는 텔레그램 요청 제한을 확인하세요.',NETWORK_ERROR:'텔레그램 서버 연결이 지연되거나 실패했습니다. 다시 시도하세요.',API_ID_INVALID:'API ID 또는 HASH가 올바르지 않습니다.',UNAUTHORIZED:'유효하지 않은 세션입니다.',SESSION_INVALID:'세션 형식이 올바르지 않습니다.',USER_REQUIRED:'봇이 아닌 사용자 계정만 등록할 수 있습니다.',API_MISSING:'API ID와 32자리 HEX 형식의 HASH를 Railway 환경변수에서 확인하세요.',NOT_CONNECTED:'연결된 계정이 없습니다.',TOO_MANY_ATTEMPTS:'인증 시도 횟수를 초과했습니다.',PASSWORD_INVALID:'비밀번호가 올바르지 않습니다.',CODE_INVALID:'인증번호 형식이 올바르지 않습니다.'};
const notices=url.searchParams.get('result');const notice=notices?'<section role="status" aria-live="polite"><p>'+esc(msg[notices]||'요청 결과를 확인하세요.')+'</p></section>':'';
const field=(name,label,type='text',placeholder='')=>'<label>'+label+'<input name="'+name+'" type="'+type+'" placeholder="'+esc(placeholder)+'" required autocomplete="off"></label>';
const sendForm=(name,fields,label)=>form(name,'',fields,label);
const state=a.connected?'<p><b>연결된 계정</b> · '+esc(a.name||'-')+' '+(a.username?'@'+esc(a.username):'')+' · ID '+esc(a.id)+'</p>':'<p>현재 연결된 사용자 계정이 없습니다.</p>';
content=notice+'<section><h2>그룹 생성 전용 계정</h2>'+state+table(['항목','상태'],[tr(['API ID',a.configured?'등록 완료':'확인 필요']),tr(['사용자 세션',a.connected?'암호화 저장 완료':'미등록']),tr(['최근 인증 오류',a.lastError||'없음']),tr(['인증 진행',a.stage==='code'?'인증번호 입력 대기':a.stage==='password'?'2단계 비밀번호 입력 대기':'대기'])])+(a.connected?sendForm('tg_verify','','연결 확인')+sendForm('tg_logout','','연결 해제'):'')+'</section>';
if(!a.connected)content+='<section><h2>전화번호로 로그인</h2><p>본인이 소유한 텔레그램 계정으로만 로그인하세요. 수신된 인증번호와 2단계 비밀번호는 서버에 저장되지 않습니다.</p>'+
(a.stage==='code'?sendForm('tg_code',field('code','텔레그램 인증번호','text','12345'),'인증 완료'):
a.stage==='password'?sendForm('tg_password',field('password','2단계 비밀번호','password'),'계정 연결'):
sendForm('tg_send',field('phone','국가번호 포함 전화번호','tel','+821012345678'),'인증번호 받기'))+
(a.stage?sendForm('tg_cancel','','인증 취소'):'')+'</section><section><h2>기존 세션 등록</h2><p>운영자 본인이 생성한 GramJS StringSession만 등록하세요. 등록되면 암호화하여 서버 DB에 저장합니다.</p>'+sendForm('tg_session','<label>StringSession<textarea name="session" maxlength="20000" rows="3" required autocomplete="off" placeholder="1..."></textarea></label>','세션 연결')+'</section>';
content+='<section><h2>자동 생성 대전방</h2><p>등록된 사용자 계정으로 신규 비공개 그룹 생성 및 기존 봇 관리자 등록을 요청합니다.</p>'+table(['코드','생성자','그룹 ID','상태','오류'],all('SELECT * FROM generated_rooms ORDER BY created DESC LIMIT 30').map(r=>tr([r.code,r.owner,r.chat||'-',r.status,r.error||'-'])))+'</section>';
}
if(tab==='requests'){
const rows=all('SELECT * FROM match_requests ORDER BY created DESC LIMIT 50 OFFSET ?',offset);
content='<section><h2>대전 신청 현황</h2><p>상대 확인, 신청 수락, 그룹 생성, 양측 준비 상태를 확인할 수 있습니다. 기존 경기 데이터는 보존됩니다.</p>'+table(['코드','생성자','상대방','종목','방식','상태','공지 A/B','준비 A/B','관리'],rows.map(r=>tr([r.code,r.owner,r.guest||'-',r.game+' · '+r.rounds+'판',modes[r.mode],r.status,r.notice_owner+'/'+r.notice_guest,r.ready_owner+'/'+r.ready_guest],'<td>'+(!['finished','cancelled','expired'].includes(r.status)?form('mr_cancel','', '<input type="hidden" name="code" value="'+esc(r.code)+'">','중단'):'-')+'</td>')))+paging()+'</section>'+
'<section><h2>대전 자동 진행 설정</h2><p>신청 수락 대기 시간(5~120분)</p>'+form('flow_minutes','', '<input type="number" name="value" min="5" max="120" value="'+esc(matchFlow.config('request_minutes','60'))+'">','저장')+'</section>'+
'<section><h2>이용 안내 문구</h2>'+form('flow_guide','', '<textarea name="value" rows="9" maxlength="1800" required>'+esc(matchFlow.config('text_guide','📖 GLORY ARENA 이용 안내\n1. 상대를 지정하거나 대기실에서 신청\n2. 상대방 수락\n3. 전용 비공개 그룹 생성\n4. 양측 준비 완료\n5. 공식 이모지 게임으로 대전\n모든 대전은 무료입니다.'))+'</textarea>','문구 저장')+'</section>'+
'<section><h2>전용 그룹 공지 문구</h2>'+form('flow_room_notice','', '<textarea name="value" rows="9" maxlength="1800" required>'+esc(matchFlow.config('text_room_notice','📌 GLORY ARENA 경기 안내\n\n두 참가자 모두 공지를 확인하고 준비 완료를 눌러주세요.\n모든 대전은 무료입니다.'))+'</textarea>','문구 저장')+'</section>';
}
if(tab==='audit'){const rows=all('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 50 OFFSET ?',offset);const names={block:'회원 제한',unblock:'회원 제한 해제',note:'회원 메모',room_enable:'방 활성화',room_disable:'방 중단',cancel:'대기 경기 취소',game:'게임 설정',matches_enabled:'신규 매치 설정',welcome_caption:'시작 문구 수정'};content='<section><h2>관리자 변경 기록</h2>'+table(['시간','작업','대상'],rows.map(r=>tr([date(r.at),names[r.action]||r.action,r.target])))+paging()+'</section>';}
const nav=Object.entries(sections).map(([k,v])=>'<a class="'+(k===tab?'selected':'')+'" href="/admin?tab='+k+'">'+v+'</a>').join('');
adminPage(res,'<header><div><h1>GLORY ARENA</h1><small>운영 관리 센터</small></div><form method="post" action="/admin/logout"><button>로그아웃</button></form></header><div class="layout"><nav>'+nav+'</nav><article><h2 class="page-title">'+sections[tab]+'</h2>'+(url.searchParams.has('saved')?'<section>'+ (url.searchParams.get('saved')==='1'?'저장되었습니다.':'변경되지 않았습니다. 상태 또는 입력값을 확인하세요.')+'</section>':'')+content+'</article></div>');return true;
}

const server=http.createServer(async(req,res)=>{
if(await adminRoute(req,res))return;
if(req.method==='GET'&&req.url.split('?')[0]==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',transport:'webhook',webhook_registered:webhookReady,last_error:lastError}));return;}
if(req.method!=='POST'||req.url!=='/telegram/webhook'){res.writeHead(404).end();return;}
if(!validSecret(req)){res.writeHead(403).end();return;}
try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1048576){res.writeHead(413).end();return;}chunks.push(chunk);}
const u=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Number.isSafeInteger(u.update_id)){res.writeHead(400).end();return;}
db.exec('BEGIN IMMEDIATE');try{const inserted=run('INSERT OR IGNORE INTO updates(id) VALUES(?)',u.update_id).changes;if(inserted)handle(u);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
webhookReady=true;console.log('Webhook update accepted',u.update_id);res.writeHead(200).end('OK');void drain();
}catch(e){console.error('Webhook processing failed',e.name);res.writeHead(500).end();}
});
server.listen(port,'0.0.0.0',()=>{console.log('GLORY ARENA HTTP server listening on',port);void register();});
setInterval(()=>{void drain();void roomService.work();roomService.recover();matchFlow.tick();},5000).unref();
