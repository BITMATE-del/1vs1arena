import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const token=(process.env.BOT_TOKEN||'').trim();
const username=(process.env.BOT_USERNAME||'GloryArena_bot').trim().replace(/^@/,'');
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
function menu(chat){enqueue('sendMessage',{chat_id:chat,text:'⚔ GLORY ARENA | 글로리 아레나\n최강자에게 허락된 전장\n아래 메뉴에서 원하는 기능을 선택하세요.\n무료 이벤트 대전',reply_markup:{keyboard:[['⚔ 매치 개설','🏛 매치 대기실'],['📖 이용 안내','🏠 메인 메뉴']],resize_keyboard:true,is_persistent:true}});}
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
if(chat.type==='private'){groupLink(cid);return;}
if(p[0]==='choose'){choose(cid);return;}
if(p[0]==='game'&&Object.hasOwn(games,p[1])){send(cid,'경기 방식 선택',Object.entries(modes).map(([k,t])=>[button(t,'mode:'+p[1]+':'+k)]));return;}
if(p[0]==='mode'&&Object.hasOwn(games,p[1])&&Object.hasOwn(modes,p[2])){send(cid,'경기 횟수 선택',[rounds.map(n=>button(n+'판','new:'+p[1]+':'+p[2]+':'+n))]);return;}
if(p[0]==='new'&&Object.hasOwn(games,p[1])&&Object.hasOwn(modes,p[2])&&rounds.includes(Number(p[3]))){const id=Number(run('INSERT INTO matches(chat,owner,game,mode,rounds) VALUES(?,?,?,?,?)',cid,user,p[1],p[2],Number(p[3])).lastInsertRowid);send(cid,'#'+id+' 매치 개설 완료',[[button('매치 신청','join:'+id),button('취소','cancel:'+id)]]);return;}
if(['join','accept','reject','cancel'].includes(p[0])&&/^\d+$/.test(p[1]||'')){action(cid,user,Number(p[1]),p[0]);return;}return;}
const m=u.message;if(!m?.from||!['private','group','supergroup'].includes(m.chat?.type))return;
const cid=m.chat.id,t=(m.text||'').split(/\s+/)[0].split('@')[0],full=m.text||'';
if(['/start','/help'].includes(t)||full==='🏠 메인 메뉴'){menu(cid);return;}
if(full==='📖 이용 안내'){send(cid,'1. 그룹에 글로리 아레나 봇을 추가하세요.\n2. 매치 개설 버튼에서 게임과 조건을 선택하세요.\n3. 상대가 신청하면 개설자가 수락하세요.\n4. 차례에 맞춰 해당 이모지를 단독 전송하세요.\n모든 대전은 무료입니다.');return;}
if(t==='/create'||t==='/lobby'||['⚔ 매치 개설','🏛 매치 대기실'].includes(full)){if(m.chat.type==='private'){groupLink(cid);return;}if(t==='/create'||full==='⚔ 매치 개설')choose(cid);else lobby(cid);return;}
if(m.new_chat_members?.some(x=>x.id===botId)){menu(cid);return;}
if(m.chat.type!=='private'&&m.dice&&!m.forward_origin&&!m.forward_date&&!m.via_bot&&!m.sender_chat&&!m.from.is_bot)roll(m);
}
let webhookReady=false,blockedUntil=Date.now()+120000,lastError=null,busy=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function tg(method,data){const wait=blockedUntil-Date.now();if(wait>0)await sleep(wait);
const response=await fetch('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(25000)});
let result;try{result=await response.json();}catch{result={};}
if(!response.ok||!result.ok){const code=Number(result.error_code||response.status);if(code===429){const retry=Math.max(Number(result.parameters?.retry_after)||0,Number(response.headers.get('retry-after'))||0,120);blockedUntil=Date.now()+(retry+5)*1000;console.warn('Telegram',method,'HTTP 429; retry_after=',retry);}throw Object.assign(new Error('Telegram API error'),{code});}
return result.result;}
async function register(){for(;;){try{await tg('setWebhook',{url:base+'/telegram/webhook',secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false,max_connections:1});webhookReady=true;lastError=null;console.log('Telegram webhook registered successfully');void drain();return;}catch(e){lastError=e.code||'network';console.warn('Webhook registration failed:',lastError);await sleep(e.code===429?Math.max(0,blockedUntil-Date.now()):120000);}}}
async function drain(){if(busy||!webhookReady)return;busy=true;try{for(;;){const r=one('SELECT * FROM outbox ORDER BY id LIMIT 1');if(!r)break;try{await tg(r.method,JSON.parse(r.payload));run('DELETE FROM outbox WHERE id=?',r.id);}catch(e){lastError=e.code||'network';console.warn('Delivery',r.method,'failed:',lastError);if([400,403].includes(e.code)){run('DELETE FROM outbox WHERE id=?',r.id);continue;}await sleep(e.code===429?Math.max(0,blockedUntil-Date.now()):60000);break;}}}finally{busy=false;}}
function validSecret(req){const a=Buffer.from(String(req.headers['x-telegram-bot-api-secret-token']||''));const b=Buffer.from(secret);return a.length===b.length&&timingSafeEqual(a,b);}
const server=http.createServer(async(req,res)=>{
if(req.method==='GET'&&req.url.split('?')[0]==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',transport:'webhook',webhook_registered:webhookReady,last_error:lastError}));return;}
if(req.method!=='POST'||req.url!=='/telegram/webhook'){res.writeHead(404).end();return;}
if(!validSecret(req)){res.writeHead(403).end();return;}
try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1048576){res.writeHead(413).end();return;}chunks.push(chunk);}
const u=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Number.isSafeInteger(u.update_id)){res.writeHead(400).end();return;}
db.exec('BEGIN IMMEDIATE');try{const inserted=run('INSERT OR IGNORE INTO updates(id) VALUES(?)',u.update_id).changes;if(inserted)handle(u);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
console.log('Webhook update accepted',u.update_id);res.writeHead(200).end('OK');void drain();
}catch(e){console.error('Webhook processing failed',e.name);res.writeHead(500).end();}
});
server.listen(port,'0.0.0.0',()=>{console.log('GLORY ARENA HTTP server listening on',port);void register();});
setInterval(()=>void drain(),5000).unref();
