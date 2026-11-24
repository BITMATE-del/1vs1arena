import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
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
const dbPath=process.env.DB_PATH||'arena.db';
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
function enqueue(method,payload){run('INSERT INTO outbox(method,payload) VALUES(?,?)',method,JSON.stringify(payload));}
function send(chat,text,buttons){enqueue('sendMessage',{chat_id:chat,text,...(buttons?{reply_markup:{inline_keyboard:buttons}}:{})});}
db.exec('CREATE TABLE IF NOT EXISTS welcome_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
const welcomeSetupHash='f27a916bb327294d267c9cf51a30a058c19be78304a25309a0ae278c63ab20f5';
function menu(chat){
const photo=process.env.WELCOME_PHOTO_FILE_ID||one("SELECT value FROM welcome_settings WHERE key='photo'")?.value;
const buttons=[[button('⚔ 매치 개설','choose'),button('🏛 대기실 입장','lobby')],[button('📊 내 전적','stats'),button('📖 이용 안내','guide')]];
const caption='⚜️ GLORY ARENA\n━━━━━━━━━━━━━━\n승부의 끝, 영광의 시작.\n\n당신의 다음 승부를 시작하세요.\n매치를 개설하거나 대기실에서 상대를 만나보세요.\n\n1vs1 무료 대전 · 텔레그램 공식 게임';
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
function choose(chat){send(chat,'게임을 선택하세요.',Object.entries(games).map(([g,v])=>[button(g+' '+v[0],'game:'+g)]).concat([[button('메인 메뉴','menu')]]));}
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
send(cid,r+'라운드: '+av+' : '+v+'\n누적 '+a+' : '+b+'\n'+(done?'경기 종료 — '+(a===b?'무승부':a>b?'개설자 승리':'신청자 승리'):'다음 라운드: 개설자 차례'));}
function handle(u){const q=u.callback_query;
if(q){const chat=q.message?.chat;if(!chat||!q.from||typeof q.data!=='string')return;const cid=chat.id,user=q.from.id,p=q.data.split(':');
enqueue('answerCallbackQuery',{callback_query_id:q.id});
if(p[0]==='menu'){menu(cid);return;}
if(p[0]==='stats'){stats(cid,user);return;}
if(p[0]==='guide'){guide(cid);return;}
if(chat.type==='private'){groupLink(cid);return;}
if(p[0]==='lobby'){lobby(cid);return;}
if(p[0]==='choose'){choose(cid);return;}
if(p[0]==='game'&&Object.hasOwn(games,p[1])){send(cid,'경기 방식 선택',Object.entries(modes).map(([k,t])=>[button(t,'mode:'+p[1]+':'+k)]));return;}
if(p[0]==='mode'&&Object.hasOwn(games,p[1])&&Object.hasOwn(modes,p[2])){send(cid,'경기 횟수 선택',[rounds.map(n=>button(n+'판','new:'+p[1]+':'+p[2]+':'+n))]);return;}
if(p[0]==='new'&&Object.hasOwn(games,p[1])&&Object.hasOwn(modes,p[2])&&rounds.includes(Number(p[3]))){const id=Number(run('INSERT INTO matches(chat,owner,game,mode,rounds) VALUES(?,?,?,?,?)',cid,user,p[1],p[2],Number(p[3])).lastInsertRowid);send(cid,'#'+id+' 매치 개설 완료',[[button('매치 신청','join:'+id),button('취소','cancel:'+id)]]);return;}
if(['join','accept','reject','cancel'].includes(p[0])&&/^\d+$/.test(p[1]||'')){action(cid,user,Number(p[1]),p[0]);return;}return;}
const m=u.message;if(!m?.from||!['private','group','supergroup'].includes(m.chat?.type))return;
if(setWelcome(m))return;
const cid=m.chat.id,t=(m.text||'').split(/\s+/)[0].split('@')[0],full=m.text||'';
if(['/start','/help'].includes(t)||full==='🏠 메인 메뉴'){menu(cid);return;}
if(full==='📖 이용 안내'){guide(cid);return;}
if(t==='/create'||t==='/lobby'||['⚔ 매치 개설','🏛 매치 대기실'].includes(full)){if(m.chat.type==='private'){groupLink(cid);return;}if(t==='/create'||full==='⚔ 매치 개설')choose(cid);else lobby(cid);return;}
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
const adminAttempts=new Map();
const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const adminCss='*{box-sizing:border-box}body{margin:0;background:#101114;color:#eee;font:15px system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:30px 20px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:30px}h1{font-size:23px;margin:0;color:#d4af37;letter-spacing:1px}h2{font-size:17px}p{line-height:1.7;color:#a9a9ac}section{background:#191b20;border:1px solid #303137;border-radius:12px;padding:20px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.metric{font-size:30px;font-weight:700;color:#d4af37}small{color:#a9a9ac}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{text-align:left;padding:12px;border-bottom:1px solid #303137}th{color:#b0b0b5}button,a.btn{display:inline-block;border:0;background:#d4af37;color:#15120a;font:inherit;font-weight:700;padding:10px 16px;border-radius:8px;text-decoration:none;cursor:pointer}input{width:100%;padding:12px;color:#eee;background:#121318;border:1px solid #45464d;border-radius:8px;margin:8px 0 16px}a{color:#d4af37}.scroll{overflow:auto}.login{max-width:420px;margin:12vh auto}.tag{color:#d4af37}.error{color:#ffb4a8}@media(max-width:500px){main{padding:16px}header{align-items:flex-start}h1{font-size:19px}}';
function adminPage(res,body,status=200){res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GLORY ARENA 관리자</title><style>'+adminCss+'</style><main>'+body+'</main></html>');}
function adminSig(exp){return createHash('sha256').update(secret+':admin:'+adminPassword+':'+exp).digest('hex');}
function adminAuth(req){if(!adminPassword||adminPassword.length<16)return false;const value=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ga_admin='))?.slice(9)||'';const [exp,sig]=value.split('.');if(!/^\d+$/.test(exp||'')||!/^[a-f0-9]{64}$/.test(sig||'')||Number(exp)<Date.now())return false;return timingSafeEqual(Buffer.from(sig),Buffer.from(adminSig(exp)));}
async function adminRoute(req,res){const path=req.url.split('?')[0];if(path!='/admin'&&!path.startsWith('/admin/'))return false;
if(!adminPassword||adminPassword.length<16){adminPage(res,'<section class="login"><h1>GLORY ARENA</h1><p>관리자 접근이 비활성화되어 있습니다. Railway에 16자 이상의 ADMIN_PASSWORD를 설정하세요.</p></section>',503);return true;}
if(path==='/admin/login'&&req.method==='POST'){const ip=String(req.headers['x-real-ip']||req.socket.remoteAddress||'unknown');const now=Date.now();for(const [k,v] of adminAttempts)if(v.until<now)adminAttempts.delete(k);const hit=adminAttempts.get(ip)||{count:0,until:now+900000};if(hit.count>=5){adminPage(res,'<section class="login"><p class="error">로그인 시도 횟수를 초과했습니다.</p><a href="/admin">돌아가기</a></section>',429);return true;}let body='';for await(const chunk of req){body+=chunk.toString();if(body.length>4096){res.writeHead(413).end();return true;}}const pass=new URLSearchParams(body).get('password')||'';const h=x=>createHash('sha256').update(x).digest();if(!timingSafeEqual(h(pass),h(adminPassword))){hit.count++;adminAttempts.set(ip,hit);adminPage(res,'<section class="login"><p class="error">비밀번호가 일치하지 않습니다.</p><a href="/admin">다시 로그인</a></section>',401);return true;}adminAttempts.delete(ip);const exp=String(now+28800000);res.writeHead(303,{'location':'/admin','set-cookie':'ga_admin='+exp+'.'+adminSig(exp)+'; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800'}).end();return true;}
if(path==='/admin/logout'&&req.method==='POST'){res.writeHead(303,{'location':'/admin','set-cookie':'ga_admin=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0'}).end();return true;}
if(req.method!=='GET'||path!='/admin'){res.writeHead(404).end();return true;}
if(!adminAuth(req)){adminPage(res,'<section class="login"><h1>GLORY ARENA</h1><p>관리자 전용 로그인</p><form method="post" action="/admin/login"><label>관리자 비밀번호<input type="password" name="password" required autocomplete="current-password"></label><button>로그인</button></form></section>');return true;}
const counts=one("SELECT COUNT(*) AS total,COALESCE(SUM(state='waiting'),0) AS waiting,COALESCE(SUM(state='active'),0) AS active,COALESCE(SUM(state='finished'),0) AS finished FROM matches");
const rows=all('SELECT id,chat,owner,guest,game,mode,rounds,state,a,b FROM matches ORDER BY id DESC LIMIT 100');
const labels={waiting:'대기',requested:'신청 접수',active:'진행 중',finished:'종료',cancelled:'취소'};
const metrics=[['전체 경기',counts.total],['대기 경기',counts.waiting],['진행 경기',counts.active],['종료 경기',counts.finished]].map(([k,v])=>'<section><small>'+k+'</small><div class="metric">'+v+'</div></section>').join('');
const table=rows.map(m=>'<tr>'+[m.id,m.chat,m.owner,m.guest||'-',games[m.game]?.[0]||m.game,modes[m.mode]||m.mode,m.rounds,labels[m.state]||m.state,m.a+' : '+m.b].map(v=>'<td>'+escapeHtml(v)+'</td>').join('')+'</tr>').join('');
adminPage(res,'<header><div><h1>GLORY ARENA</h1><small>운영 관리 센터</small></div><form method="post" action="/admin/logout"><button>로그아웃</button></form></header><div class="grid">'+metrics+'</div><section><h2>텔레그램 연결 상태</h2><p>공식 봇: <span class="tag">@'+escapeHtml(username)+'</span><br>웹훅: '+(webhookReady?'연결 정상':'연결 확인 중')+'<br>API ID / HASH: '+(process.env.TELEGRAM_API_ID&&process.env.TELEGRAM_API_HASH?'등록 완료':'미등록')+'<br>자동 그룹 생성: 미구현</p><small>사용자 계정 인증번호 및 세션은 이 페이지에서 수집하지 않습니다.</small></section><section><h2>경기 관리</h2><p>무료 대전 기록 · 최근 100건 · 승패 수정 불가</p><div class="scroll"><table><thead><tr><th>번호</th><th>그룹</th><th>생성자</th><th>참가자</th><th>게임</th><th>방식</th><th>횟수</th><th>상태</th><th>점수</th></tr></thead><tbody>'+(table||'<tr><td colspan="9">등록된 경기가 없습니다.</td></tr>')+'</tbody></table></div></section><section><h2>대전방 관리</h2><p>전용 그룹 자동 배정 기능은 아직 연결되지 않았습니다. 현재 경기 목록에서 기존 그룹을 확인할 수 있습니다.</p></section><a class="btn" href="/admin">새로고침</a>');return true;
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
setInterval(()=>void drain(),5000).unref();
