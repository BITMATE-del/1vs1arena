import http from 'node:http';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { createTelegramAuth } from './telegram-auth.mjs';
import { createRoomService } from './rooms.mjs';
import { createMatchFlow } from './match-flow.mjs';
import { createMatchBoard } from './match-board.mjs';
import { gameEmoji, validDiceMessage, gameInstructions } from './game-emojis.mjs';
import { createSpecialDiceEngine, isSpecialMode, SPECIAL_MODES } from './special-rules.mjs';
import { createMatchWatch } from './match-watch.mjs';
import {classicRound} from './classic-rules.mjs';
import {resultForMatch,managedRoomStatus} from './admin-results.mjs';
import {createTronDeposits,usdtDisplay} from './tron-deposits.mjs';
import {createSharedWallet} from './shared-wallet.mjs';
import {createBotAdmin} from './bot-admin.mjs';
import {projectPrize,PLATFORM_FEE_BPS,FEE_POLICY_VERSION} from './fee-policy.mjs';
import {createSettlementJournal} from './settlement-journal.mjs';
import {summarizeReadiness,OFFICIAL_GAMES} from './readiness.mjs';
import {createMoneyEngine} from './money-engine.mjs';
import {createWalletOps} from './wallet-ops.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const token=(process.env.BOT_TOKEN||'').trim();
let username=(process.env.BOT_USERNAME||'').trim().replace(/^@/,'');
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
const modes={wins:'선승제',total:'점수 합산',round:'매판 승패',...SPECIAL_MODES};
const rounds=[1,3,5,7,9];
const one=(sql,...args)=>db.prepare(sql).get(...args);
const all=(sql,...args)=>db.prepare(sql).all(...args);
const run=(sql,...args)=>db.prepare(sql).run(...args);
const button=(text,callback_data)=>({text,callback_data});
const specialDice=createSpecialDiceEngine(db);
const settlementJournal=createSettlementJournal(db);
const tronDeposits=createTronDeposits(db,(user,message)=>send(user,message));
const botAdmin=createBotAdmin(db,enqueue);
const sharedWallet=createSharedWallet(db,(user,message)=>send(user,message),{onEvent:event=>botAdmin.notify(event)});
const moneyEngine=createMoneyEngine(db);
const walletOps=createWalletOps(db);
const pendingWalletInput=new Map();

db.exec("CREATE TABLE IF NOT EXISTS arena_users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT ''); CREATE TABLE IF NOT EXISTS arena_rooms(id INTEGER PRIMARY KEY, title TEXT NOT NULL, last_seen INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS admin_audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL); CREATE TABLE IF NOT EXISTS arena_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
// Apply user's one-time request to activate all six game modes and funded matchmaking.
// A durable migration marker ensures later manual admin disable controls remain respected.
if(!one("SELECT value FROM arena_settings WHERE key='activation_20261126_funded_matches'")){
 db.exec('SAVEPOINT activate_games_once');
 try{
  for(const g of Object.keys(games))run("INSERT INTO arena_settings(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value='1'",'game:'+g);
  run("INSERT INTO arena_settings(key,value) VALUES('matches_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'");
  run("INSERT INTO arena_settings(key,value) VALUES('paid_matches_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'");
  run("INSERT INTO arena_settings(key,value) VALUES('activation_20261126_funded_matches','1')");
  run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),'activate_games_paid_once','6 official games + free match + funded match');
  db.exec('RELEASE activate_games_once');
 }catch(e){db.exec('ROLLBACK TO activate_games_once');db.exec('RELEASE activate_games_once');throw e;}
}
function setting(k,fallback=''){return one('SELECT value FROM arena_settings WHERE key=?',k)?.value??fallback;}
function track(u){const m=u.message||u.callback_query?.message, p=u.callback_query?.from||u.message?.from;
if(p&&!p.is_bot&&Number.isSafeInteger(p.id))run("INSERT INTO arena_users(id,name,username,first_seen,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username,last_seen=excluded.last_seen",p.id,[p.first_name,p.last_name].filter(Boolean).join(' ').slice(0,200),String(p.username||'').slice(0,100),Date.now(),Date.now());
if(m?.chat&&['group','supergroup'].includes(m.chat.type))run("INSERT INTO arena_rooms(id,title,last_seen) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,last_seen=excluded.last_seen",m.chat.id,String(m.chat.title||'그룹').slice(0,200),Date.now());
}
function blocked(id){return !!one('SELECT blocked FROM arena_users WHERE id=?',id)?.blocked;}
function roomDisabled(id){return one('SELECT enabled FROM arena_rooms WHERE id=?',id)?.enabled===0;}
function gameEnabled(g){return setting('game:'+g,'1')==='1';}

function playerDiceHelp(chat,user,id){
const m=one("SELECT * FROM matches WHERE id=? AND chat=? AND state='active'",id,chat);
if(!m)return;
const current=matchBoard.player(m.turn);
if(m.turn!==user){send(chat,'현재 차례는 '+current+' 님입니다. 본인 차례에만 게임을 전송할 수 있습니다.');return;}
send(chat,'👤 지금은 '+current+' 님 차례입니다.\n\n'+gameInstructions(m.game));
}
function enqueue(method,payload){run('INSERT INTO outbox(method,payload) VALUES(?,?)',method,JSON.stringify(payload));}
function send(chat,text,buttons){enqueue('sendMessage',{chat_id:chat,text,...(buttons?{reply_markup:{inline_keyboard:buttons}}:{})});}
db.exec('CREATE TABLE IF NOT EXISTS welcome_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS welcome_banner_tokens(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL)');
const welcomeSetupHash='f27a916bb327294d267c9cf51a30a058c19be78304a25309a0ae278c63ab20f5';
function menu(chat){
const photo=one("SELECT value FROM welcome_settings WHERE key='photo'")?.value||process.env.WELCOME_PHOTO_FILE_ID;
const buttons=[[button('🎯 상대 지정 대결','mf:begin'),button('⏳ 매치 대기 등록','mf:public')],[button('🏛 공개 매치 대기실','mf:lobby'),button('🎮 내 경기','mf:mine')],[button('💎 USDT 지갑','wallet'),button('📊 내 전적','stats')],[button('📖 이용 안내','mf:help')]];
const caption=setting('welcome_caption','⚜️ GLORY ARENA\n━━━━━━━━━━━━━━\n승부의 끝, 영광의 시작.\n\n당신의 다음 승부를 시작하세요.\n매치를 개설하거나 대기실에서 상대를 만나보세요.\n\n1vs1 무료·USDT 대전 · 텔레그램 공식 게임');
if(photo)enqueue('sendPhoto',{chat_id:chat,photo,caption,reply_markup:{inline_keyboard:buttons}});
else send(chat,'GLORY ARENA\n'+caption,buttons);
}
function walletMenu(chat,user){
 if(chat!==user){send(chat,'지갑 정보는 봇 개인 대화에서 확인해 주세요.');return;}
 const addr=sharedWallet.treasury(),balance=usdtDisplay(tronDeposits.balance(user)),status=sharedWallet.status();
 const out=['💎 GLORY ARENA · USDT/TRC20 지갑','','현재 잔액: '+balance+' USDT',''];
 if(addr)out.push('고정 충전 주소:',addr,'','모든 회원이 같은 주소로 입금합니다. 반드시 먼저 충전 신청을 하여 안내되는 정확한 금액을 보내세요.');
 else out.push('아직 공용 입금 지갑주소가 설정되지 않았습니다.');
 if(!status.enabled||!status.apiConfigured)out.push('','⚠️ 자동 충전 확인이 현재 비활성화되어 있습니다.');
 out.push('','출금은 운영 지갑에서 송금되며, 현재 자동 송금은 연동 전입니다. 출금 신청은 보류 상태로 접수됩니다.');
 send(chat,out.join('\n'),[[button('➕ USDT 충전 신청','wallet_invoice'),button('📤 출금 신청','wallet_withdraw')],[button('🔄 잔액 새로고침','wallet'),button('📋 입출금 내역','wallet_history')],[button('🏠 메인 메뉴','menu')]]);
}
function walletHistory(chat,user){
 if(chat!==user)return;
 const deposits=tronDeposits.history(user),withdrawals=sharedWallet.mine(user).withdrawals;
 const ds=deposits.length?deposits.map(r=>'✅ 입금 '+usdtDisplay(r.amount_micro)+' USDT\n'+r.txid.slice(0,20)+'…').join('\n\n'):'입금 기록 없음';
 const ws=withdrawals.length?withdrawals.map(r=>'📤 #'+r.id+' '+usdtDisplay(r.amount_micro)+' USDT / '+r.status).join('\n'):'출금 신청 없음';
 send(chat,'📋 USDT 입출금 내역\n\n입금\n'+ds+'\n\n출금\n'+ws,[[button('💎 내 지갑','wallet')]]);
}
function walletInvoice(chat,user){
 if(chat!==user)return;
 const state=sharedWallet.status();
 if(!state.address||!state.enabled||!state.apiConfigured){send(chat,'현재 USDT 자동 충전 접수가 준비되지 않았습니다.');return;}
 const active=sharedWallet.mine(user).invoice;
 if(active){send(chat,'✅ 입금 신청 확인\n\nTRC20 주소:\n'+active.address+'\n\n정확한 입금액: '+usdtDisplay(active.amount_micro)+' USDT\n\n30분 유효. 금액이 다르면 자동 반영되지 않습니다.',[[button('🔄 지갑 확인','wallet')]]);return;}
 pendingWalletInput.set(user,{kind:'invoice',at:Date.now()});
 send(chat,'💎 충전할 금액을 USDT 단위로 입력해 주세요.\n예: 10 또는 25.5\n\n공용 주소를 사용하므로 회원별 구분을 위해 신청 금액에 0.01 USDT 미만의 식별 금액이 더해집니다.\n입력 후 안내되는 최종 정확한 금액으로 전송해야 자동 충전됩니다.',[[button('🏠 메인 메뉴','menu')]]);
}
function walletWithdraw(chat,user){
 if(chat!==user)return;
 pendingWalletInput.set(user,{kind:'withdraw',at:Date.now()});
 send(chat,'📤 출금 신청\n\n출금받을 본인 TRON 주소와 금액을 한 줄로 입력하세요.\n예: T로시작하는34자리주소 10\n\n신청 즉시 잔액이 보류 처리됩니다. 현재 자동 온체인 송금은 미연결이며, 운영자가 송금 시스템을 연결하기 전에는 출금 완료되지 않습니다.',[[button('🏠 메인 메뉴','menu')]]);
}
function handleWalletInput(chat,user,text){
 if(chat!==user)return false;
 const pending=pendingWalletInput.get(user);
 if(!pending||Date.now()-pending.at>10*60000){pendingWalletInput.delete(user);return false;}
 if(text.startsWith('/'))return false;
 pendingWalletInput.delete(user);
 if(pending.kind==='invoice'){
   const result=sharedWallet.invoice(user,text.trim());
   if(!result.ok){send(chat,'충전 신청을 처리하지 못했습니다: '+result.reason);return true;}
   const v=result.invoice;
   send(chat,'✅ 충전 신청 접수\n\n공용 USDT/TRC20 주소:\n'+v.address+'\n\n정확한 입금 금액: '+usdtDisplay(v.amount_micro)+' USDT\n\n30분 안에 정확한 수량으로 보내세요. 확정 거래만 자동 반영됩니다. 다른 금액은 관리자 확인 대상입니다.',[[button('🔄 지갑 확인','wallet')]]);
   return true;
 }
 if(pending.kind==='withdraw'){
   const parts=text.trim().split(/\s+/);
   if(parts.length!==2){send(chat,'입력 형식 오류입니다. 주소와 금액을 공백으로 구분해 입력해 주세요.');return true;}
   const result=sharedWallet.requestWithdrawal(user,parts[0],parts[1]);
   send(chat,result.ok?'📤 출금 요청 #'+result.id+' 접수\n잔액을 보류 처리했습니다. 자동 전송 기능이 연결되기 전에는 송금되지 않습니다.':'출금 신청 실패: '+result.reason);
   return true;
 }
 return false;
}

function guide(chat){send(chat,'GLORY ARENA | 이용 안내\n\n1. 그룹에 봇을 추가하세요.\n2. 매치 개설에서 게임과 경기 조건을 선택하세요.\n3. 상대의 신청을 수락하세요.\n4. 안내된 순서에 따라 공식 이모지 게임을 진행하세요.\n\n모든 대전은 무료입니다.',[[button('메인 메뉴','menu')]]);}
function stats(chat,user){
const r=one("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN (owner=? AND a>b) OR (guest=? AND b>a) THEN 1 ELSE 0 END),0) AS wins, COALESCE(SUM(CASE WHEN a=b THEN 1 ELSE 0 END),0) AS draws FROM matches WHERE state='finished' AND (owner=? OR guest=?)",user,user,user,user);
send(chat,'내 전적\n\n총 경기 '+r.total+'회\n승리 '+r.wins+' · 패배 '+(r.total-r.wins-r.draws)+' · 무승부 '+r.draws,[[button('메인 메뉴','menu')]]);
}
function setWelcome(m){
if(m.chat.type!=='private'||!Array.isArray(m.photo)||!m.photo.length||!m.caption?.startsWith('/banner '))return false;
const code=m.caption.slice('/banner '.length).trim();
const hash=createHash('sha256').update(code).digest('hex');
const entry=one('SELECT expires FROM welcome_banner_tokens WHERE hash=?',hash);
if(!entry||entry.expires<Date.now()){send(m.chat.id,'시작 이미지 등록 코드가 만료되었거나 올바르지 않습니다. 관리자 화면에서 새 코드를 발급받으세요.');return true;}
const photo=m.photo.at(-1).file_id;
if(typeof photo!=='string'||photo.length<5)return false;
// handle() already runs inside the webhook transaction. Do not open a nested transaction.
const deleted=run('DELETE FROM welcome_banner_tokens WHERE hash=? AND expires>=?',hash,Date.now()).changes;
if(!deleted){send(m.chat.id,'등록 코드가 이미 사용되었습니다.');return true;}
run('DELETE FROM welcome_banner_tokens');
run("INSERT INTO welcome_settings(key,value) VALUES('photo',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",photo);
console.log('Welcome image replaced through one-time admin registration code');
send(m.chat.id,'✅ 새 봇의 시작 이미지가 등록되었습니다.\n아래 /start를 눌러 시작 화면을 확인하세요.');
menu(m.chat.id);return true;
}
function groupLink(chat){send(chat,'대전은 텔레그램 그룹에서 진행합니다.',[[{text:'그룹에 글로리 아레나 추가',url:'https://t.me/'+username+'?startgroup=true'}]]);}
function choose(chat){if(setting('matches_enabled','1')!=='1'){send(chat,'현재 신규 매치 개설이 중단되어 있습니다.');return;}send(chat,'게임을 선택하세요.',Object.entries(games).filter(([g])=>gameEnabled(g)).map(([g,v])=>[button(g+' '+v[0],'game:'+g)]).concat([[button('메인 메뉴','menu')]]));}
function lobby(chat){const rows=all("SELECT * FROM matches WHERE chat=? AND state='waiting' ORDER BY id DESC LIMIT 20",chat);
if(!rows.length){send(chat,'대기 중인 매치가 없습니다.',[[button('매치 개설','choose')]]);return;}
for(const m of rows)send(chat,'#'+m.id+' '+m.game+' '+games[m.game]?.[0]+' | '+m.rounds+'판 | '+modes[m.mode]+' | 무료 이벤트',[[button('매치 신청','join:'+m.id),button('취소','cancel:'+m.id)]]);
}
function action(chat,user,id,op){const m=one('SELECT * FROM matches WHERE id=? AND chat=?',id,chat);if(!m){send(chat,'존재하지 않는 경기입니다.');return;}
if(op==='join'&&m.state==='waiting'&&user!==m.owner){run("UPDATE matches SET guest=?,state='requested' WHERE id=?",user,id);send(chat,'신청 완료. 개설자 수락 대기 중입니다.',[[button('수락','accept:'+id),button('거절','reject:'+id)]]);return;}
if(op==='accept'&&m.state==='requested'&&user===m.owner){if(one("SELECT 1 FROM matches WHERE chat=? AND state='active' AND (owner IN (?,?) OR guest IN (?,?))",chat,user,m.guest,user,m.guest)){send(chat,'참가자가 다른 경기 진행 중입니다.');return;}run("UPDATE matches SET state='active',turn=owner WHERE id=?",id);matchWatch.arm(id);matchBoard.queueMatch(id);return;}
if(op==='reject'&&m.state==='requested'&&user===m.owner){run("UPDATE matches SET guest=NULL,state='waiting' WHERE id=?",id);send(chat,'신청 거절. 다시 대기 중입니다.');return;}
if(op==='cancel'&&['waiting','requested'].includes(m.state)&&user===m.owner){run("UPDATE matches SET state='cancelled' WHERE id=?",id);send(chat,'매치 취소 완료.');return;}send(chat,'현재 상태 또는 권한으로 실행할 수 없습니다.');}
function roll(m){const {chat,from,dice,message_id}=m;const user=from.id,cid=chat.id,g=gameEmoji(dice?.emoji),v=dice?.value;
if(!g||!validDiceMessage(dice,g)||one('SELECT 1 FROM rolls WHERE chat=? AND message=?',cid,message_id))return;
const row=one("SELECT * FROM matches WHERE chat=? AND state='active' AND turn=?",cid,user);
if(!row)return;
if(!validDiceMessage(dice,row.game)){send(cid,'⚠️ 현재 경기는 '+row.game+' '+(games[row.game]?.[0]||'공식 게임')+'입니다.\n다른 종목 결과는 점수로 기록되지 않습니다.\n\n'+gameInstructions(row.game));return;}
const id=row.id,r=row.round;
if(isSpecialMode(row.mode)){
  const result=specialDice.accept(row,{chat:cid,user,value:v,message:message_id});
  if(result.accepted){matchWatch.touch(id);matchBoard.queueMatch(id);if(result.done)matchFlow.finished(cid);}
  return;
}
run('INSERT INTO rolls VALUES(?,?,?,?,?,?)',cid,message_id,id,r,user,v);
if(user===row.owner){run('UPDATE matches SET turn=guest WHERE id=?',id);matchWatch.touch(id);matchBoard.queueMatch(id);return;}
const av=one('SELECT value FROM rolls WHERE match=? AND round=? AND player=?',id,r,row.owner).value;
const outcome=classicRound(row,av,v),{a,b,done}=outcome;
run('UPDATE matches SET a=?,b=?,state=?,round=?,turn=? WHERE id=?',a,b,done?'finished':'active',outcome.nextRound,outcome.nextTurn,id);
matchWatch.touch(id);matchBoard.queueMatch(id);if(done)matchFlow.finished(cid);}
function handle(u){track(u);const actor=u.callback_query?.from||u.message?.from;const chat=u.callback_query?.message?.chat||u.message?.chat;if(actor&&blocked(actor.id)){if(u.callback_query)enqueue('answerCallbackQuery',{callback_query_id:u.callback_query.id,text:'이용이 제한된 계정입니다.',show_alert:true});else if(chat?.type==='private')send(chat.id,'이용이 제한된 계정입니다.');return;}if(chat&&roomDisabled(chat.id)&&chat.type!=='private')return;const q=u.callback_query;
if(q){const chat=q.message?.chat;if(!chat||!q.from||typeof q.data!=='string')return;const cid=chat.id,user=q.from.id,p=q.data.split(':');
enqueue('answerCallbackQuery',{callback_query_id:q.id});
if(p[0]==='mf'&&matchFlow.onCallback(user,cid,p))return;
if(p[0]==='dice'&&/^\d+$/.test(p[1]||'')){playerDiceHelp(cid,user,Number(p[1]));return;}
if(p[0]==='menu'){menu(cid);return;}
if(p[0]==='stats'){stats(cid,user);return;}
if(p[0]==='wallet'){walletMenu(cid,user);return;}
if(p[0]==='wallet_history'){walletHistory(cid,user);return;}
if(p[0]==='wallet_invoice'){walletInvoice(cid,user);return;}
if(p[0]==='wallet_withdraw'){walletWithdraw(cid,user);return;}
if(p[0]==='wo'&&['approve','reject'].includes(p[1])&&/^\\d+$/.test(p[2]||'')){
 const valid=q.message?.chat?.type==='private'&&cid===user&&botAdmin.isAdmin(user);
 if(!valid){send(cid,'관리자 개인 채팅에서만 출금을 처리할 수 있습니다.');return;}
 const id=Number(p[2]),result=walletOps.withdrawal(id,p[1],'bot:'+user);
 if(result.ok){
  run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),'bot_withdraw_'+p[1],String(id)+' by '+user);
  send(user,p[1]==='approve'?'✅ 출금 #'+id+' 승인 완료. 실제 온체인 송금은 아직 실행되지 않았습니다. 웹 관리자에서 송금 후 TXID로 완료 처리하세요.':'❌ 출금 #'+id+' 거절 완료. 보류 금액이 회원에게 환급됐습니다.');
  send(result.user,p[1]==='approve'?'📤 출금 #'+id+' 신청이 승인되었습니다. 운영자가 송금을 진행합니다.':'↩️ 출금 #'+id+' 신청이 거절되어 보류 금액이 지갑 잔액으로 반환됐습니다.');
 }else send(user,'이미 처리됐거나 현재 처리할 수 없는 출금입니다. ('+result.reason+')');
 return;
}
if(p[0]==='botadmin'){if(botAdmin.isAdmin(user)&&cid===user)send(user,botAdmin.inbox(user),[[button('🔄 관리자 새로고침','botadmin')]]);else enqueue('answerCallbackQuery',{callback_query_id:q.id,text:'관리자 권한이 없습니다.',show_alert:true});return;}
if(p[0]==='guide'){guide(cid);return;}
if(chat.type==='private'){if(p[0]==='choose'){matchFlow.begin(user);return;}if(p[0]==='lobby'){matchFlow.lobby(user);return;}groupLink(cid);return;}
if(p[0]==='lobby'){lobby(cid);return;}
if(p[0]==='choose'){choose(cid);return;}
if(p[0]==='game'&&Object.hasOwn(games,p[1])){send(cid,'경기 방식 선택',Object.entries(modes).filter(([key])=>p[1]==='🎲'||!isSpecialMode(key)).map(([k,t])=>[button(t,'mode:'+p[1]+':'+k)]));return;}
if(p[0]==='mode'&&Object.hasOwn(games,p[1])&&Object.hasOwn(modes,p[2])&&(!isSpecialMode(p[2])||p[1]==='🎲')){send(cid,'경기 횟수 선택',[rounds.map(n=>button(n+'판','new:'+p[1]+':'+p[2]+':'+n))]);return;}
if(p[0]==='new'&&setting('matches_enabled','1')==='1'&&gameEnabled(p[1])&&Object.hasOwn(games,p[1])&&Object.hasOwn(modes,p[2])&&(!isSpecialMode(p[2])||p[1]==='🎲')&&rounds.includes(Number(p[3]))){const id=Number(run('INSERT INTO matches(chat,owner,game,mode,rounds) VALUES(?,?,?,?,?)',cid,user,p[1],p[2],Number(p[3])).lastInsertRowid);send(cid,'#'+id+' 매치 개설 완료',[[button('매치 신청','join:'+id),button('취소','cancel:'+id)]]);return;}
if(['join','accept','reject','cancel'].includes(p[0])&&/^\d+$/.test(p[1]||'')){action(cid,user,Number(p[1]),p[0]);return;}return;}
const m=u.message;if(!m?.from||!['private','group','supergroup'].includes(m.chat?.type))return;
if(setWelcome(m))return;
const cid=m.chat.id,t=(m.text||'').split(/\s+/)[0].split('@')[0],full=m.text||'';
if(m.chat.type==='private'&&['/admin','/adminpanel','/ops'].includes(t)){
 if(!botAdmin.isAdmin(m.from.id)){send(cid,'관리자 권한이 없습니다. 웹 관리자에서 텔레그램 사용자 ID를 등록해야 합니다.');return;}
 send(cid,botAdmin.inbox(m.from.id),[[button('🔄 관리자 새로고침','botadmin')]]);return;
}
if(['/start','/help'].includes(t)||full==='🏠 메인 메뉴'){if(m.chat.type==='private')pendingWalletInput.delete(m.from.id);if(m.chat.type!=='private'&&roomService.isGeneratedChat(cid)){send(cid,'⚜️ 이 그룹은 GLORY ARENA 전용 대전방입니다. 경기 진행 안내는 위 공지에서 확인해 주세요.');return;}menu(cid);return;}
if(full==='📖 이용 안내'){matchFlow.tutorial(cid);return;}
if(m.chat.type==='private'&&['/wallet','/deposit','/balance'].includes(t)){walletMenu(cid,m.from.id);return;}
if(m.chat.type==='private'&&t==='/deposits'){walletHistory(cid,m.from.id);return;}
if(m.chat.type==='private'&&one("SELECT 1 FROM match_inputs WHERE user_id=? AND kind LIKE 'stake:%'",m.from.id)&&matchFlow.onText(m.from.id,full))return;
if(m.chat.type==='private'&&handleWalletInput(cid,m.from.id,full))return;
if(m.chat.type==='private'&&matchFlow.onText(m.from.id,full))return;
if(m.chat.type!=='private'&&['/resume','/status'].includes(t)){const current=one("SELECT id FROM matches WHERE chat=? AND state='active' ORDER BY id DESC LIMIT 1",cid);if(current)matchBoard.queueMatch(current.id);else send(cid,'현재 진행 중인 경기가 없습니다.');void drain();return;}
if(m.chat.type!=='private'&&['/end','/stop','/close'].includes(t)){matchFlow.stopByChat(m.from.id,cid);return;}
if(m.chat.type!=='private'&&!m.dice&&gameEmoji(full)){const active=one("SELECT * FROM matches WHERE chat=? AND state='active' ORDER BY id DESC LIMIT 1",cid);if(active&&active.turn===m.from.id){send(cid,'⚠️ '+gameEmoji(full)+'가 일반 텍스트로 전송되어 점수가 기록되지 않았습니다.\n공식 게임 애니메이션으로 전송해야 합니다.\n\n'+gameInstructions(active.game));}return;}
if(m.chat.type!=='private'&&['/play','/game','/roll'].includes(t)){const active=one("SELECT * FROM matches WHERE chat=? AND state='active' ORDER BY id DESC LIMIT 1",cid);if(active)send(cid,'🔴 현재 차례: '+matchBoard.player(active.turn)+'\n\n'+gameInstructions(active.game));return;}
if(t==='/create'||t==='/lobby'||['⚔ 매치 개설','🏛 매치 대기실'].includes(full)){if(m.chat.type==='private'){if(t==='/create'||full==='⚔ 매치 개설')matchFlow.begin(m.from.id);else matchFlow.lobby(m.from.id);return;}if(t==='/create'||full==='⚔ 매치 개설')choose(cid);else lobby(cid);return;}
if(m.new_chat_members?.some(x=>x.id===botId)){if(!roomService.isGeneratedChat(cid))menu(cid);return;}
if(m.chat.type!=='private'&&m.new_chat_members?.some(x=>!x.is_bot)){const current=one("SELECT * FROM matches WHERE chat=? AND state='active' ORDER BY id DESC LIMIT 1",cid);if(current){send(cid,'👋 대전방 입장을 확인했습니다.\n현재 차례: '+matchBoard.player(current.turn)+'\n상단 고정 경기판에서 진행 상황을 확인해 주세요.');matchBoard.queueMatch(current.id);}return;}
if(m.chat.type!=='private'&&m.dice&&!m.forward_origin&&!m.forward_date&&!m.via_bot&&!m.sender_chat&&!m.from.is_bot)roll(m);
}
let webhookReady=false,blockedUntil=Date.now(),lastError=null,busy=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function tg(method,data){const wait=blockedUntil-Date.now();if(wait>0)await sleep(wait);
const response=await fetch('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(25000)});
let result;try{result=await response.json();}catch{result={};}
if(!response.ok||!result.ok){const code=Number(result.error_code||response.status);if(code===429){const retry=Math.max(Number(result.parameters?.retry_after)||0,Number(response.headers.get('retry-after'))||0,120);blockedUntil=Date.now()+(retry+5)*1000;console.warn('Telegram',method,'HTTP 429; retry_after=',retry);}throw Object.assign(new Error('Telegram API error'),{code,description:String(result.description||'')});}
return result.result;}
async function register(){for(;;){if(webhookReady)return;try{const me=await tg('getMe',{});if(!me?.id||!me?.username)throw Error('GETME_EMPTY');console.log('Telegram Bot API identity verified: @'+me.username+' (ID '+me.id+')');if(me.id!==botId)throw Error('BOT_TOKEN_ID_MISMATCH');username=me.username;await tg('setWebhook',{url:base+'/telegram/webhook',secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false,max_connections:1});webhookReady=true;lastError=null;console.log('Telegram webhook registered successfully for @'+username);void drain();return;}catch(e){lastError=e.code||e.cause?.code||e.name||'network';const description=String(e.description||e.cause?.message||e.message||'API_FAILURE').replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g,'[REDACTED_TOKEN]').slice(0,180);console.warn('Telegram API connection failed:',String(lastError).slice(0,60),description);await sleep(e.code===429?Math.max(0,blockedUntil-Date.now()):120000);}}}
async function drain(){if(busy||!webhookReady)return;busy=true;try{for(;;){const r=one('SELECT * FROM outbox ORDER BY id LIMIT 1');if(!r)break;try{const p=JSON.parse(r.payload);if(r.method==='arenaBoardSync'){await matchBoard.sync(p,tg);}else if(r.method==='sendDice'){/* Remove any leftover bot-generated game jobs from prior deployments; never throw on behalf of a player. */}else await tg(r.method,p);run('DELETE FROM outbox WHERE id=?',r.id);}catch(e){lastError=e.code||'network';console.warn('Delivery',r.method,'failed:',lastError);
if([400,403].includes(e.code)){if(r.method==='sendPhoto'){const p=JSON.parse(r.payload);enqueue('sendMessage',{chat_id:p.chat_id,text:'GLORY ARENA\n'+p.caption,reply_markup:p.reply_markup});}run('DELETE FROM outbox WHERE id=?',r.id);continue;}await sleep(e.code===429?Math.max(0,blockedUntil-Date.now()):60000);break;}}}finally{busy=false;}}
function validSecret(req){const a=Buffer.from(String(req.headers['x-telegram-bot-api-secret-token']||''));const b=Buffer.from(secret);return a.length===b.length&&timingSafeEqual(a,b);}

const adminPassword=process.env.ADMIN_PASSWORD||'';
const telegramAuth=createTelegramAuth(db,secret,adminPassword);
const roomService=createRoomService(db,telegramAuth,username,send);
const matchBoard=createMatchBoard(db,enqueue);
let matchFlow;
const matchWatch=createMatchWatch(db,send,{getConfig:(k)=>setting(k,''),onTimeout:(id)=>matchFlow?.timeoutMatch(id)});
matchFlow=createMatchFlow(db,send,roomService,games,modes,rounds,{gameEnabled,money:moneyEngine,paidMatchesEnabled:()=>setting('paid_matches_enabled','1')==='1',onMatchStart:id=>{matchWatch.arm(id);matchBoard.queueMatch(id);},onMatchEnd:id=>{const m=one('SELECT * FROM matches WHERE id=?',id);if(m){const r=moneyEngine.settle(m);if(r.ok&&!r.reused){for(const u of [m.owner,m.guest])if(u)send(u,r.decision==='refund'?'↩️ 경기 종료: 참가금 전액 환급 완료 · 수수료 0%':'🏆 경기 종료: 내부 USDT 잔액 정산 완료 · 수수료 3%');}}},onMatchStopped:id=>{matchWatch.touch(id);matchBoard.queueMatch(id);},onCloseFailed:(id,code)=>matchWatch.incident('room_close_failed',id||0,'그룹 종료 실패 '+code)});
matchWatch.sync();
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
const sections={overview:'대시보드',users:'회원 관리',rooms:'방 관리',matches:'경기 관리',records:'판정 기록',games:'게임 설정',telegram:'텔레그램 계정 관리',requests:'대전 신청 관리',operations:'운영 안정성',readiness:'기능 최종 점검',settlement:'정산 감사 기록',deposits:'입출금·잔액 관리',bot_admin:'봇 관리자',bot:'봇 설정',audit:'운영 로그'};
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
if(act==='bot_admin_add'||act==='bot_admin_remove'){
 const user=Number(q.get('admin_user_id'));
 const result=botAdmin.setAdmin(user,act==='bot_admin_add');
 if(result){
   run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),act,String(user));
   if(act==='bot_admin_add')send(user,'🛡 GLORY ARENA 봇 관리자 등록 완료\n\n이 채팅에서 /admin 명령어로 입출금 현황을 확인할 수 있습니다. 충전 및 출금 신청 알림이 이곳으로 전달됩니다.\n\n출금 신청은 봇으로 승인·거절할 수 있으며 실제 송금은 운영자가 진행합니다.');
 }
 res.writeHead(303,{location:'/admin?tab=bot_admin&saved='+Number(result)}).end();void drain();return true;
}
if(act==='bot_admin_test'){
 const user=Number(q.get('admin_user_id'));
 const result=botAdmin.isAdmin(user);
 if(result)send(user,'🔔 GLORY ARENA 봇 관리자 알림 테스트\n이 메시지가 보이면 관리자로 등록된 개인 채팅에 정상 발송 중입니다.');
 res.writeHead(303,{location:'/admin?tab=bot_admin&saved='+Number(result)}).end();void drain();return true;
}
if(act==='paid_matches_toggle'&&['0','1'].includes(value)){
 run("INSERT INTO arena_settings(key,value) VALUES('paid_matches_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",value);
 run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),'paid_matches_toggle',value);
 res.writeHead(303,{location:'/admin?tab=settlement&saved=1'}).end();return true;
}
if(act==='enable_free_games'){
 const count=OFFICIAL_GAMES.reduce((n,g)=>n+Number(gameEnabled(g)),0);
 db.exec('SAVEPOINT enable_free_games');
 try{
  run("INSERT INTO arena_settings(key,value) VALUES('matches_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'");
  for(const g of OFFICIAL_GAMES)run("INSERT INTO arena_settings(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value='1'",'game:'+g);
  run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),'enable_free_games','6 games + matches; previous enabled='+count);
  db.exec('RELEASE enable_free_games');
 }catch(e){db.exec('ROLLBACK TO enable_free_games');db.exec('RELEASE enable_free_games');throw e;}
 res.writeHead(303,{location:'/admin?tab=readiness&saved=1'}).end();return true;
}
if(['wallet_manual_credit','wallet_manual_debit','wallet_manual_deposit'].includes(act)){
 const kind=act==='wallet_manual_credit'?'credit':act==='wallet_manual_debit'?'debit':'manual_deposit';
 const user=Number(q.get('user_id')),amount=(q.get('amount')||'').trim(),reference=(q.get('reference')||'').trim(),requestKey=q.get('request_key')||'';
 const result=walletOps.operate({user,kind,amount,reference,requestKey,actor:'web_admin'});
 if(result.ok){
  run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),act,String(user)+':'+amount+':'+reference.slice(0,70));
  send(user,kind==='debit'?'📉 관리자 잔액 조정: -'+amount+' USDT':'✅ '+(kind==='manual_deposit'?'수동 입금 반영':'관리자 잔액 조정')+': +'+amount+' USDT');
 }
 res.writeHead(303,{location:'/admin?tab=deposits&saved='+Number(result.ok)+'&reason='+encodeURIComponent(result.reason||'')}).end();void drain();return true;
}
if(['withdraw_approve','withdraw_reject','withdraw_paid'].includes(act)){
 const wid=Number(q.get('withdrawal_id')),action=act==='withdraw_approve'?'approve':act==='withdraw_reject'?'reject':'paid';
 const result=walletOps.withdrawal(wid,action,'web_admin',(q.get('txid')||'').trim());
 if(result.ok){
  run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),act,String(wid));
  send(result.user,action==='approve'?'📤 출금 #'+wid+' 승인 완료 · 송금 대기':action==='reject'?'↩️ 출금 #'+wid+' 거절 · 보류금액 환급 완료':'✅ 출금 #'+wid+' 수동 송금 완료 처리 · TXID '+result.txid);
 }
 res.writeHead(303,{location:'/admin?tab=deposits&saved='+Number(result.ok)+'&reason='+encodeURIComponent(result.reason||'')}).end();void drain();return true;
}
if(act==='treasury_set'){
 const addr=(q.get('treasury_address')||'').trim();
 const result=sharedWallet.setAddress(addr);
 if(result)run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),'treasury_set',addr);
 res.writeHead(303,{location:'/admin?tab=deposits&saved='+Number(result)}).end();return true;
}
if(act==='treasury_check'){
 const result=await sharedWallet.poll();
 if(result.credited)void drain();
 res.writeHead(303,{location:'/admin?tab=deposits&saved='+Number(!result.error)}).end();return true;
}
if(act==='treasury_withdraw_cancel'){
 const id=Number(q.get('withdrawal_id'));
 const result=Number.isSafeInteger(id)&&sharedWallet.cancelWithdrawal(id);
 if(result)run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),'treasury_withdraw_cancel',String(id));
 res.writeHead(303,{location:'/admin?tab=deposits&saved='+Number(!!result)}).end();return true;
}
if(act==='tron_assign'){
 const user=Number(q.get('user_id')),addr=(q.get('deposit_address')||'').trim();
 const done=tronDeposits.assign(user,addr);
 if(done)run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),'tron_assign',String(user));
 res.writeHead(303,{location:'/admin?tab=deposits&saved='+Number(done)}).end();return true;
}
if(act==='tron_rescan'){
 const state=await tronDeposits.poll().catch(e=>({error:String(e.message||e).slice(0,75)}));
 if(state.credited)void drain();
 res.writeHead(303,{location:'/admin?tab=deposits&saved='+Number(!state.error)}).end();return true;
}
if(act==='banner_generate'){
const code=randomBytes(18).toString('base64url');
const hash=createHash('sha256').update(code).digest('hex');
run('DELETE FROM welcome_banner_tokens');
run('INSERT INTO welcome_banner_tokens(hash,expires) VALUES(?,?)',hash,Date.now()+15*60000);
const instruction='/banner '+code;
adminPage(res,'<header><h1>GLORY ARENA 시작 이미지 등록</h1></header><section><h2>새 봇 시작 이미지 등록 코드</h2><p>15분 이내 1회 사용 가능. 본인의 텔레그램에서 @'+escapeHtml(username)+' 봇에게 사진을 보내고, 사진의 설명(캡션)에 아래 문구를 붙여넣으세요.</p><textarea readonly rows="3">'+escapeHtml(instruction)+'</textarea><p>이미지가 사진으로 전송되어야 합니다. 파일로 전송하면 인식하지 않습니다. 코드는 다른 사람에게 공유하지 마세요.</p><p>등록 후 새 봇에서 /start를 눌러 확인하세요.</p><a href="/admin?tab=bot">봇 설정으로 돌아가기</a></section>');return true;
}
if(act==='mr_cancel'&&/^GA-[A-F0-9]{8}$/.test(String(q.get('code')||''))){const done=matchFlow.cancelForAdmin(q.get('code'));res.writeHead(303,{location:'/admin?tab=requests&saved='+Number(done)}).end();void drain();return true;}
if(act==='close_retry'&&/^GA-[A-F0-9]{8}$/.test(String(q.get('code')||''))){const code=q.get('code');const done=matchFlow.retryCloseForAdmin(code);if(done)run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),'close_retry',code);res.writeHead(303,{location:'/admin?tab=operations&saved='+Number(done)}).end();void drain();return true;}
if(act==='mr_finish_close'&&/^GA-[A-F0-9]{8}$/.test(String(q.get('code')||''))){
const code=q.get('code'),done=matchFlow.closeFinishedForAdmin(code);
if(done)run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),'close_finished_room',code);
res.writeHead(303,{location:'/admin?tab=rooms&saved='+Number(done)}).end();void drain();return true;
}
if(act==='mr_force'&&/^GA-[A-F0-9]{8}$/.test(String(q.get('code')||''))){const code=q.get('code');const done=matchFlow.forceCloseForAdmin(code);if(done)run('INSERT INTO admin_audit(at,action,target) VALUES(?,?,?)',Date.now(),'force_match_close',code);res.writeHead(303,{location:'/admin?tab=requests&saved='+Number(done)}).end();void drain();return true;}
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
if(['turn_warn_minutes','turn_timeout_minutes'].includes(act)&&Number.isInteger(Number(value))&&Number(value)>=1&&Number(value)<=1440){const other=act==='turn_warn_minutes'?Number(setting('turn_timeout_minutes','20')):Number(setting('turn_warn_minutes','3'));if((act==='turn_warn_minutes'&&Number(value)<other)||(act==='turn_timeout_minutes'&&Number(value)>other)){run('INSERT INTO arena_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',act,value);changed=true;}}
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
if(tab==='rooms'){
const rows=all("SELECT r.*, (SELECT COUNT(*) FROM matches m WHERE m.chat=r.id AND m.state IN ('waiting','requested','active')) AS open, (SELECT m.state FROM matches m WHERE m.chat=r.id ORDER BY id DESC LIMIT 1) AS latest_match_state, (SELECT g.status FROM generated_rooms g WHERE g.chat=r.id LIMIT 1) AS generated_status, (SELECT q.status FROM match_requests q JOIN generated_rooms g ON g.code=q.room_code WHERE g.chat=r.id ORDER BY q.updated DESC LIMIT 1) AS request_status, (SELECT v.state FROM match_continue_votes v JOIN match_requests q ON q.code=v.code JOIN generated_rooms g ON g.code=q.room_code WHERE g.chat=r.id ORDER BY v.updated DESC LIMIT 1) AS close_state, (SELECT q.code FROM match_requests q JOIN generated_rooms g ON g.code=q.room_code WHERE g.chat=r.id ORDER BY q.updated DESC LIMIT 1) AS match_code FROM arena_rooms r WHERE CAST(r.id AS TEXT) LIKE ? OR r.title LIKE ? ORDER BY r.last_seen DESC LIMIT 50 OFFSET ?",like,like,offset);
content='<section><h2>전용 대전방 목록</h2><p>경기 종료와 텔레그램 그룹 삭제를 구분해 표시합니다. 삭제 확인 상태는 실제 삭제 성공 기록에 따라 결정됩니다. 일반 그룹 사용 중단은 방 삭제가 아닙니다.</p>'+finder()+table(['그룹 번호','그룹명','최근 접속','진행·대기','경기·방 상태','관리'],rows.map(r=>{
const status=managedRoomStatus(r),canClose=r.match_code&&r.open===0&&['finished','cancelled','error'].includes(status.kind)&&status.kind!=='closed';
return tr([r.id,r.title,date(r.last_seen),r.open,status.label],'<td>'+(canClose?form(r.request_status==='finished'?'mr_finish_close':'mr_force','', '<input type="hidden" name="code" value="'+esc(r.match_code)+'">','종료 방 정리'):'')+form(r.enabled?'room_disable':'room_enable',r.id,'',r.enabled?'봇 중단':'봇 활성',r.enabled&&r.open?'disabled':'')+'</td>');
}))+paging()+'</section>';}
if(tab==='matches'){
const rows=all("SELECT m.*, a.name AS owner_name,a.username AS owner_username,b.name AS guest_name,b.username AS guest_username,q.code AS request_code, q.status AS request_status,g.status AS group_status FROM matches m LEFT JOIN arena_users a ON a.id=m.owner LEFT JOIN arena_users b ON b.id=m.guest LEFT JOIN match_requests q ON q.match_id=m.id LEFT JOIN generated_rooms g ON g.chat=m.chat WHERE CAST(m.id AS TEXT) LIKE ? OR CAST(m.chat AS TEXT) LIKE ? OR CAST(m.owner AS TEXT) LIKE ? OR m.state LIKE ? ORDER BY m.id DESC LIMIT 50 OFFSET ?",like,like,like,like,offset);
const display=(name,username,id)=>username?'@'+username:name?name+' ('+id+')':String(id||'-');
content='<section><h2>경기 결과·승자 현황</h2><p>종료 경기의 실제 승자·무승부·중도 중단을 구분합니다. 중단된 경기는 승패를 확정하지 않으며 기존 전적은 수정하지 않습니다.</p>'+finder()+table(['경기 번호','그룹','개설자','참가자','게임·방식','라운드','상태','최종 점수','판정','승자','그룹 정리','관리'],rows.map(m=>{
const owner=display(m.owner_name,m.owner_username,m.owner),guest=display(m.guest_name,m.guest_username,m.guest);
const result=resultForMatch(m,{owner,guest});const status=m.group_status==='closed'?'삭제 완료':m.group_status==='close_failed'?'삭제 실패':m.group_status==='closing'?'종료 중':m.group_status==='finished'?'경기 종료 · 방 유지':m.group_status==='ready'?'방 유지':m.group_status||'-';
return tr([m.id,m.chat,owner,guest,(games[m.game]?.[0]||m.game)+' · '+(modes[m.mode]||m.mode),m.round+'/'+m.rounds,result.state,m.a+' : '+m.b,result.result,result.winner,status],'<td>'+(['waiting','requested'].includes(m.state)?form('cancel',m.id,'','취소'):'—')+'</td>');
}))+paging()+'</section>';}
if(tab==='records'){const rows=all("SELECT * FROM rolls WHERE CAST(match AS TEXT) LIKE ? OR CAST(player AS TEXT) LIKE ? OR CAST(chat AS TEXT) LIKE ? ORDER BY rowid DESC LIMIT 50 OFFSET ?",like,like,like,offset);
content='<section><h2>텔레그램 원본 판정</h2><p>수신한 공식 이모지 결과와 메시지 번호를 조회합니다. 수정 및 삭제 기능은 제공하지 않습니다.</p>'+finder()+table(['경기','그룹','메시지 ID','라운드','참가자','공식 값'],rows.map(r=>tr([r.match,r.chat,r.message,r.round,r.player,r.value])))+paging()+'</section>';}
if(tab==='readiness'){
 const serviceStatus=summarizeReadiness({
  serverOnline:true,webhookReady,
  enabledGames:OFFICIAL_GAMES.filter(gameEnabled).length,
  matchesEnabled:setting('matches_enabled','1')==='1',
  roomAccountConnected:telegramAuth.info().connected,
  adminRecipients:one('SELECT COUNT(*) n FROM bot_admins WHERE enabled=1').n,
  tronKey:Boolean(process.env.TRONGRID_API_KEY),
  treasuryAddress:sharedWallet.treasury(),
  sharedDepositsEnabled:sharedWallet.status().enabled,internalSettlementEnabled:setting('paid_matches_enabled','1')==='1'
 });
 content='<section><h2>운영 기능 최종 점검</h2><p>서버의 현재 설정과 DB 상태를 확인한 결과입니다. 단위 테스트 통과와 실제 고객 입출금 거래 성공은 서로 다른 확인 항목입니다.</p>'+
 table(['기능','상태','상세'],serviceStatus.checks.map(x=>tr([x.label,x.ok?'설정 확인':'조치 필요',x.detail])))+'</section>'+
 '<section><h2>무료 게임 기능 활성화</h2><p>6종 게임 및 신규 무료 매치 접수만 한 번에 활성화합니다. 기존 경기는 유지하며, USDT 입금·출금·유료 정산 설정은 변경하지 않습니다.</p>'+
 form('enable_free_games','','무료 대전 6종 전체 활성화')+'</section>'+
 '<section><h2>필수 운영 확인</h2><p>자동 입금은 공용 지갑 주소 등록과 활성화 변수 설정, 실거래 소액 검증이 필요합니다. 자동 출금은 서명 서비스와 온체인 거래 검증이 구현되지 않았습니다. 승리금·환급금의 실제 이동은 금전 정산 엔진이 없으므로 활성화할 수 없습니다.</p></section>';
}
if(tab==='settlement'){
const financial=moneyEngine.summary();
const moneyRows=moneyEngine.ledger();
const stat=settlementJournal.summary(),entries=settlementJournal.entries();
content='<section><h2>경기별 판정 및 환급 정책</h2><p>승패 확정: 총 참가금의 3%를 수수료로 산정하며 나머지 97%를 승리자에게 배정하는 계산 정책입니다. 동액 참가인 경우 1.94배 지급 예정입니다.</p><p>무승부: 양쪽 참가금 전액 반환 · 수수료 0%. 경기 시작 전 취소·상호 동의 중단·시간초과 중단·관리자 강제 종료: 양측 참가금 전액 반환 · 수수료 0%. 완료된 승패 기록은 이후 방 종료와 관계없이 유지됩니다.</p><p><strong>유료 경기를 선택하고 양측 준비를 마치면 실제 내부 지갑 잔액에서 참가금이 예치·정산됩니다. 기존 무료 경기에는 금전 처리되지 않습니다.</strong> 역사적 무료 게임은 수수료 정책 적용에서 제외됩니다.</p></section>'+
'<div class="grid">'+[['기록된 종료 경기',stat.total],['무승부·중단 환급 대상',stat.refunds],['승자 정산 예정',stat.winners],['과거 기록 제외 경계',stat.cutoff]].map(([k,v])=>'<section><small>'+esc(k)+'</small><div class="metric">'+esc(v)+'</div></section>').join('')+'</div>'+
'<section><h2>실제 내부 USDT 경기 정산</h2><p>양쪽 회원의 실제 USDT 지갑 잔액에서 참가금 예치 → 경기 종료 후 승리 시 판돈의 97% 지급, 무승부/중도 종료 시 각자 참가금 100% 환급합니다. 수수료는 내부 운영 원장에 누적됩니다.</p><p>경기별 예치 및 정산은 DB 원자적 트랜잭션, 중복 이벤트 차단, 불변 원장으로 처리합니다. 출금은 별도 온체인 송금 연동이 필요합니다.</p><p>현재 유료 경기: '+(setting('paid_matches_enabled','1')==='1'?'신규 접수 허용':'신규 접수 중단')+'</p>'+form('paid_matches_toggle','',valueField(setting('paid_matches_enabled','1')==='1'?'0':'1'),setting('paid_matches_enabled','1')==='1'?'신규 유료 경기 중단':'신규 유료 경기 활성화')+'</section>'+
'<div class="grid">'+[['미정산 예치 경기',financial.open],['실제 정산 완료 경기',financial.settled],['누적 경기 수수료',usdtDisplay(financial.fees)+' USDT']].map(([k,v])=>'<section><small>'+esc(k)+'</small><div class="metric">'+esc(v)+'</div></section>').join('')+'</div>'+
'<section><h2>실제 내부 잔액 변동 원장</h2>'+table(['경기','회원 ID','종류','잔액 변동 (USDT)','시각'],moneyRows.map(m=>tr([m.match_id,m.user_id,m.kind,(m.delta_micro>0?'+':'-')+usdtDisplay(Math.abs(m.delta_micro)),date(m.created)])))+'</section>'+
'<section><h2>읽기 전용 정산 감사 기록</h2><p>경기번호별 최초 판정만 등록하고 같은 경기의 중복 기록을 차단합니다. 이벤트 변경 및 삭제는 DB에서 금지됩니다. 감사 해시로 기록 내용의 일치 여부를 확인합니다.</p>'+table(['경기 ID','기록 시각','경기 결과','정산 정책','승자 ID','수수료율','변경 검증','금전 처리'],entries.map(e=>tr([e.match_id,date(e.created),e.match_state,e.decision==='refund_both'?'전액 환급 예정 · '+e.reason:'승자 지급 예정',e.winner_id||'-',(e.fee_bps/100)+'%',settlementJournal.verify(e)?'정상':'검증 실패',one('SELECT decision FROM money_settlements WHERE match_id=?',e.match_id)?'내부 USDT 정산 완료':'금전 미집행'])))+'</section>';
}
if(tab==='games'){
 const sample=projectPrize(100000000n);
 content='<section><h2>경기 정산 수수료 정책</h2><p>정책 버전: '+esc(FEE_POLICY_VERSION)+'</p><p><strong>총 판돈의 '+(PLATFORM_FEE_BPS/100)+'% 수수료</strong> · 양쪽이 같은 금액을 참가하는 경우 승리자 지급 비율 1.94배입니다.</p><p>예시: 양측 100 USDT씩, 합계 200 USDT → 수수료 '+usdtDisplay(sample.fee)+' USDT → 승리자 지급 예정 '+usdtDisplay(sample.winnerPayout)+' USDT.</p><p>유료 대전 참가금 예치 및 경기 종료 후 승리금·환급금의 <strong>내부 USDT 잔액 정산이 연결되어 있습니다</strong>. 실제 블록체인 출금 송금은 별도입니다. 기존 무료 경기와 과거 데이터는 변경하지 않습니다. 무승부·중도 종료는 수수료 0%와 양측 전액 반환 정책으로 정의되었으나 실제 잔액 이동은 미구현입니다.</p></section>';
}
if(tab==='games'){content+='<section><h2>신규 매치 접수</h2><p>기존 경기를 유지하면서 신규 경기 개설을 제어합니다.</p>'+form('matches_enabled','',valueField(setting('matches_enabled','1')==='1'?'0':'1'),setting('matches_enabled','1')==='1'?'신규 접수 중단':'신규 접수 허용')+'</section><section><h2>게임별 설정</h2>'+table(['게임','공식 값 범위','신규 개설','관리'],Object.entries(games).map(([g,v])=>tr([g+' '+v[0],'1~'+v[1],gameEnabled(g)?'사용':'중단'],'<td>'+form('game',g,valueField(gameEnabled(g)?'0':'1'),gameEnabled(g)?'비활성화':'활성화')+'</td>')))+'<p>무료 대전만 지원합니다. 슬롯은 원시 값 비교이며 조합 판정은 미구현입니다.</p></section>';}
if(tab==='bot'){content='<section><h2>연결 정보</h2><p>공식 봇: @'+esc(username)+'<br>웹훅: '+(webhookReady?'정상':'미연결')+'<br>API ID / HASH: '+(process.env.TELEGRAM_API_ID&&process.env.TELEGRAM_API_HASH?'등록 완료':'미등록')+'<br>시작 이미지: '+(one("SELECT value FROM welcome_settings WHERE key='photo'")?.value?'새 봇용 이미지 등록됨':process.env.WELCOME_PHOTO_FILE_ID?'기존 이미지 ID 등록됨 · 새 봇에서 재등록 필요':'미등록')+'<br>마지막 오류: '+esc(lastError||'없음')+'</p><p>그룹 생성 계정의 연결 상태와 전용 방 생성 결과는 텔레그램 계정 관리 메뉴에서 확인하세요. 비밀값은 표시하지 않습니다.</p></section><section><h2>시작 화면 문구</h2>'+form('welcome_caption','', '<textarea name="value" maxlength="900" rows="7" required>'+esc(setting('welcome_caption','⚜️ GLORY ARENA\n승부의 끝, 영광의 시작.\n\n당신의 다음 승부를 시작하세요.\n매치를 개설하거나 대기실에서 상대를 만나보세요.\n\n1vs1 무료·USDT 대전 · 텔레그램 공식 게임'))+'</textarea>','문구 저장')+'</section><section><h2>시작 이미지 변경</h2><p>텔레그램 봇을 변경했다면 기존 사진 ID가 무효가 됩니다. 새 봇에서 등록해야 합니다.</p>'+form('banner_generate','','사진 등록 코드 발급')+'</section>';}

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
content='<section><h2>대전 신청 현황</h2><p>상대 확인, 신청 수락, 그룹 생성, 양측 준비 상태를 확인할 수 있습니다. 강제 방 종료는 진행 중인 경기를 중단하고 비공개 그룹 삭제를 요청합니다. 기존 종료 경기 전적은 보존됩니다.</p>'+table(['코드','생성자','상대방','종목','방식','상태','공지 A/B','준비 A/B','관리'],rows.map(r=>tr([r.code,r.owner,r.guest||'-',r.game+' · '+r.rounds+'판',modes[r.mode],r.status,r.notice_owner+'/'+r.notice_guest,r.ready_owner+'/'+r.ready_guest],'<td>'+(r.room_code&&['room_ready','playing','finished','cancelled'].includes(r.status)?form('mr_force','', '<input type="hidden" name="code" value="'+esc(r.code)+'">','강제 방 종료'):!['finished','cancelled','expired'].includes(r.status)?form('mr_cancel','', '<input type="hidden" name="code" value="'+esc(r.code)+'">','신청 취소'):'-')+'</td>')))+paging()+'</section>'+
'<section><h2>대전 자동 진행 설정</h2><p>신청 수락 대기 시간(5~120분)</p>'+form('flow_minutes','', '<input type="number" name="value" min="5" max="120" value="'+esc(matchFlow.config('request_minutes','60'))+'">','저장')+'</section>'+
'<section><h2>이용 안내 문구</h2>'+form('flow_guide','', '<textarea name="value" rows="9" maxlength="1800" required>'+esc(matchFlow.config('text_guide','📖 GLORY ARENA 이용 안내\n1. 상대를 지정하거나 대기실에서 신청\n2. 상대방 수락\n3. 전용 비공개 그룹 생성\n4. 양측 준비 완료\n5. 공식 이모지 게임으로 대전\n모든 대전은 무료입니다.'))+'</textarea>','문구 저장')+'</section>'+
'<section><h2>전용 그룹 공지 문구</h2>'+form('flow_room_notice','', '<textarea name="value" rows="9" maxlength="1800" required>'+esc(matchFlow.config('text_room_notice','📌 GLORY ARENA 경기 안내\n\n두 참가자 모두 공지를 확인하고 준비 완료를 눌러주세요.\n모든 대전은 무료입니다.'))+'</textarea>','문구 저장')+'</section>';
}
if(tab==='bot_admin'){
const admins=botAdmin.list(),rows=all("SELECT n.key,n.admin_id,n.created,u.username FROM bot_admin_notice n LEFT JOIN arena_users u ON u.id=n.admin_id ORDER BY n.created DESC LIMIT 50");
content='<section><h2>텔레그램 봇 관리자 등록</h2><p>등록된 관리자에게 입금 신청, 자동 충전 완료, 미확인 입금, 출금 신청 및 취소 알림을 개인 채팅으로 전달합니다. 운영자 계정은 먼저 @'+esc(username)+' 봇에서 /start를 누르고, 웹 회원 관리 목록에 표시된 숫자 ID로 등록하세요. 아이디(@username)만으로는 등록되지 않습니다.</p>'+
form('bot_admin_add','', '<input name="admin_user_id" type="number" min="1" placeholder="관리자 텔레그램 숫자 ID" required>','봇 관리자 등록')+'</section>'+
'<section><h2>관리자 계정 현황</h2>'+table(['텔레그램 ID','이름','아이디','등록 시각','상태','관리'],admins.map(a=>tr([a.user_id,a.name||'-',a.username?'@'+a.username:'-',date(a.added),a.enabled?'활성':'해제'],'<td>'+(a.enabled?form('bot_admin_test','', '<input type="hidden" name="admin_user_id" value="'+a.user_id+'">','알림 테스트')+form('bot_admin_remove','', '<input type="hidden" name="admin_user_id" value="'+a.user_id+'">','권한 해제'):form('bot_admin_add','', '<input type="hidden" name="admin_user_id" value="'+a.user_id+'">','재등록'))+'</td>')))+'</section>'+
'<section><h2>발송 대기열 등록 기록</h2><p>중복 발송을 방지하기 위해 이벤트와 관리자의 조합으로 1회만 대기열에 추가합니다. 실제 텔레그램 전달 성공 여부는 별도로 확인해야 합니다.</p>'+table(['이벤트','관리자','대기열 등록 시각'],rows.map(r=>tr([r.key,r.username?'@'+r.username:r.admin_id,date(r.created)])))+'</section>';
}
if(tab==='deposits'){
const fixed=sharedWallet.status(),invoices=all('SELECT i.*,u.username FROM treasury_invoices i LEFT JOIN arena_users u ON u.id=i.user_id ORDER BY i.id DESC LIMIT 75'),requests=all('SELECT * FROM treasury_withdrawals ORDER BY id DESC LIMIT 75'),unmatched=all('SELECT * FROM treasury_unmatched ORDER BY detected DESC LIMIT 50');
const st=tronDeposits.status();
const addr=all("SELECT u.id AS user_id,u.username,u.name,COALESCE(d.address,'-') AS address,COALESCE(d.active_from,0) AS active_from,COALESCE(w.balance_micro,0) AS balance_micro FROM arena_users u LEFT JOIN tron_deposit_addresses d ON d.user_id=u.id LEFT JOIN tron_wallets w ON w.user_id=u.id ORDER BY u.last_seen DESC LIMIT 100");
const tx=all("SELECT d.txid,d.user_id,d.amount_micro,d.block_time,d.credited FROM tron_deposits d ORDER BY d.credited DESC LIMIT 75");
const errors=all("SELECT * FROM tron_monitor_events WHERE kind!='address_set' ORDER BY id DESC LIMIT 20");
content='<div class="grid">'+[['감시 상태',fixed.enabled&&fixed.apiConfigured?'활성':'설정 대기'],['TronGrid API',st.apiConfigured?'설정됨':'미설정'],['등록된 주소',st.addressCount],['자동 충전 건수',st.credits]].map(([k,v])=>'<section><small>'+esc(k)+'</small><div class="metric">'+esc(v)+'</div></section>').join('')+'</div>'+
'<section><h2>공용 USDT/TRC20 입출금 지갑</h2><p>모든 회원은 같은 운영 지갑주소로 입금합니다. 회원별 고유 입금액으로 매칭하며, 미확정·금액 불일치·만료 입금은 자동 반영하지 않습니다. 출금은 동일 운영 지갑에서 보내도록 설계하지만 현재 송금·서명 서비스가 없어 신청과 잔액 보류만 가능합니다.</p><p>공용 주소: '+esc(fixed.address||'미등록')+' · 잔액 반영: '+(fixed.enabled&&fixed.apiConfigured?'설정 활성':'비활성')+' · 미매칭 입금: '+fixed.unmatched+'건 · 출금 신청: '+fixed.withdrawals+'건</p>'+form('treasury_set','', '<input name="treasury_address" maxlength="34" value="'+esc(fixed.address||'')+'" placeholder="T로 시작하는 운영 지갑 주소" required>','고정 지갑주소 등록')+form('treasury_check','','고정 지갑 입금 재확인')+'</section>'+
'<section><h2>입금 감시 설정</h2><p>Railway에 TRONGRID_API_KEY와 SHARED_USDT_ENABLED=1을 등록하면 공용 지갑의 확정 거래만 조회·충전 처리합니다. 정확히 일치하는 활성 입금 신청이 없으면 보류합니다. 개인키는 등록하지 마세요.</p>'+
'<p>마지막 확인: '+(st.lastChecked?date(st.lastChecked):'아직 없음')+' · 오류: '+esc(st.lastError||'없음')+'</p>'+
form('tron_rescan','','지금 입금 재확인')+'</section>'+
'<section><h2>회원별 입금주소 배정</h2><p>실제 본사가 통제하는 회원 전용 TRON 주소만 등록하세요. 개인키는 입력하지 않습니다. 동일 주소 중복 배정 및 주소 체크섬 오류를 차단합니다.</p>'+
form('tron_assign','', '<input name="user_id" type="number" min="1" placeholder="회원 텔레그램 숫자 ID" required><input name="deposit_address" maxlength="34" placeholder="T로 시작하는 TRON 입금주소" required>','기존 회원별 주소 배정')+'</section>'+
'<section><h2>공용 지갑 충전 신청</h2>'+table(['번호','회원','정확한 금액','상태','생성일','TXID'],invoices.map(r=>tr([r.id,r.username?'@'+r.username:r.user_id,usdtDisplay(r.amount_micro),r.status,date(r.created),r.txid||'-'])))+'</section>'+
'<section><h2>미매칭 거래 · 관리자 확인</h2><p>미매칭 입금은 자동으로 다른 회원에게 배정하지 않습니다.</p>'+table(['TXID','수량','사유','감지 시각'],unmatched.map(r=>tr([r.txid,usdtDisplay(r.amount_micro),r.reason,date(r.detected)])))+'</section>'+
'<section><h2>회원 잔액 조절</h2><p>회원 ID와 증감 금액을 입력하세요. 기존 금전 기록은 삭제되지 않으며 조정 전후 잔액이 별도 기록됩니다. 차감 시 잔액 부족을 차단합니다.</p>'+
form('wallet_manual_credit','', '<input name="request_key" type="hidden" value="'+randomBytes(16).toString('hex')+'"><input name="user_id" type="number" min="1" placeholder="회원 텔레그램 숫자 ID" required><input name="amount" placeholder="충전 금액 USDT" required><input name="reference" minlength="3" maxlength="160" placeholder="조정 사유 또는 관리번호" required>','잔액 추가')+
form('wallet_manual_debit','', '<input name="request_key" type="hidden" value="'+randomBytes(16).toString('hex')+'"><input name="user_id" type="number" min="1" placeholder="회원 텔레그램 숫자 ID" required><input name="amount" placeholder="차감 금액 USDT" required><input name="reference" minlength="3" maxlength="160" placeholder="조정 사유 또는 관리번호" required>','잔액 차감')+'</section>'+
'<section><h2>수동 입금 반영</h2><p>이미 자동 반영된 TXID는 중복 처리되지 않습니다. 수동 입금은 별도 기록으로 남으며 실제 블록체인 입금 확인을 의미하지 않습니다.</p>'+
form('wallet_manual_deposit','', '<input name="request_key" type="hidden" value="'+randomBytes(16).toString('hex')+'"><input name="user_id" type="number" min="1" placeholder="입금 회원 숫자 ID" required><input name="amount" placeholder="반영할 USDT" required><input name="reference" minlength="3" maxlength="160" placeholder="고유 입금 관리번호 또는 TXID" required>','수동 입금 반영')+'</section>'+
'<section><h2>출금 신청 · 수동 승인/거절</h2><p>승인은 송금 대기 상태로 변경하는 것이며 자동 온체인 송금이 아닙니다. 실제 송금 후 TXID를 등록해 완료 처리하세요. 거절 시 보류금이 회원 잔액으로 환급됩니다. 봇 관리자 개인 채팅에서도 승인·거절할 수 있습니다.</p>'+
table(['번호','회원','출금 주소','USDT','상태','시각','관리'],requests.map(r=>tr([r.id,r.user_id,r.to_address,usdtDisplay(r.amount_micro),r.status,date(r.created)],'<td>'+(
r.status==='requested'?form('withdraw_approve','', '<input type="hidden" name="withdrawal_id" value="'+r.id+'">','승인 · 송금 대기')+form('withdraw_reject','', '<input type="hidden" name="withdrawal_id" value="'+r.id+'">','거절 · 잔액 반환'):
r.status==='approved'?form('withdraw_paid','', '<input type="hidden" name="withdrawal_id" value="'+r.id+'"><input name="txid" pattern="[a-fA-F0-9]{64}" minlength="64" maxlength="64" placeholder="실제 송금 TXID 64자리" required>','송금 완료 기록')+form('withdraw_reject','', '<input type="hidden" name="withdrawal_id" value="'+r.id+'">','승인 취소 · 반환'):'—')+'</td>')))+'</section>'+
'<section><h2>수동 잔액·입금 처리 기록</h2>'+
table(['회원','유형','금액 USDT','이전 잔액','변경 잔액','관리번호','시각'],walletOps.adjustments().map(r=>tr([r.user_id,r.kind,usdtDisplay(r.amount_micro),usdtDisplay(r.balance_before),usdtDisplay(r.balance_after),r.reference,date(r.created)])))+'</section>'+
'<section><h2>출금 처리 기록</h2>'+
table(['출금번호','처리','관리자','TXID','시각'],walletOps.withdrawalActions().map(r=>tr([r.withdrawal_id,r.action,r.actor,r.txid||'-',date(r.created)])))+'</section>'+
'<section><h2>회원 지갑 현황</h2>'+table(['회원 ID','이름','입금주소','등록 시각','USDT 잔액'],addr.map(a=>tr([a.user_id,a.username?'@'+a.username:a.name,a.address,date(a.active_from),usdtDisplay(a.balance_micro)])))+'</section>'+
'<section><h2>확정 입금 내역</h2>'+table(['거래 해시','회원 ID','충전 USDT','체인 시간','반영 시간'],tx.map(r=>tr([r.txid,r.user_id,usdtDisplay(r.amount_micro),date(r.block_time),date(r.credited)])))+'</section>'+
'<section><h2>입금 감시 오류</h2>'+table(['시각','구분','내용'],errors.map(r=>tr([date(r.at),r.kind,r.detail])))+'</section>';
}
if(tab==='operations'){
const summary=matchWatch.issueSummary();
const alerts=all("SELECT i.* FROM arena_incidents i WHERE i.state='open' ORDER BY created DESC LIMIT 50");
const failures=all("SELECT v.code,v.updated,v.state,v.last_error,r.status AS match_status,g.error AS room_error FROM match_continue_votes v LEFT JOIN match_requests r ON r.code=v.code LEFT JOIN generated_rooms g ON g.code=r.room_code WHERE v.state='close_failed' ORDER BY v.updated DESC LIMIT 30");
const watches=all("SELECT m.id,m.chat,m.game,m.mode,m.round,w.turn_started,w.warned_at,w.alerted_at,u.username AS player FROM matches m JOIN match_turn_watch w ON w.match_id=m.id LEFT JOIN arena_users u ON u.id=m.turn WHERE m.state='active' ORDER BY w.turn_started ASC LIMIT 50");
const cards=[['진행 중 경기',summary.active],['미응답 경고',summary.warnings],['미해결 사고',summary.incidents],['종료 실패',summary.closeFailures]];
content='<div class="grid">'+cards.map(([k,v])=>'<section><small>'+esc(k)+'</small><div class="metric">'+esc(v)+'</div></section>').join('')+'</div>'+
'<section><h2>경기 시간 제한 설정</h2><p>미응답 경고 이후 제한시간이 지나면 진행 중인 경기만 중단합니다. 기존 전적은 그대로 유지합니다.</p>'+
form('turn_warn_minutes','', '<label>미응답 안내 (분)<input type="number" name="value" min="1" max="1440" value="'+esc(setting('turn_warn_minutes','3'))+'"></label>','경고 시간 저장')+
form('turn_timeout_minutes','', '<label>자동 종료 (분)<input type="number" name="value" min="1" max="1440" value="'+esc(setting('turn_timeout_minutes','20'))+'"></label>','제한시간 저장')+'</section>'+
'<section><h2>현재 경기 모니터링</h2>'+table(['경기','방','종목','라운드','현재 차례','턴 시작','경고'],watches.map(r=>tr([r.id,r.chat,r.game+' / '+(modes[r.mode]||r.mode),r.round,(r.player?'@'+r.player:'회원 ID '+(one('SELECT turn FROM matches WHERE id=?',r.id)?.turn||'-')),date(r.turn_started),r.warned_at?'경고 발송':'정상'])))+'</section>'+
'<section><h2>운영 오류 및 경고</h2>'+table(['시간','종류','경기','그룹 코드','상세'],alerts.map(r=>tr([date(r.created),r.kind,r.match_id||'-',r.room_code||'-',r.detail])))+'</section>'+
'<section><h2>삭제 실패 방 재처리</h2><p>자동 재시도를 반복하지 않습니다. 원인 확인 후 직접 재시도를 실행하세요.</p>'+
table(['코드','상태','오류','관리'],failures.map(r=>tr([r.code,r.match_status||'-',r.room_error||r.last_error||'-'],'<td>'+form('close_retry','', '<input type="hidden" name="code" value="'+esc(r.code)+'">','방 삭제 재시도')+'</td>')))+'</section>';
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
}catch(e){console.error('Webhook processing failed',e?.name||'Error',String(e?.message||'unknown').slice(0,180));res.writeHead(500).end();}
});
server.listen(port,'0.0.0.0',()=>{console.log('GLORY ARENA HTTP server listening on',port);void register();});
setInterval(()=>{moneyEngine.reconcile();void drain();void roomService.work();roomService.recover();matchFlow.tick();matchWatch.sync();matchWatch.tick();settlementJournal.reconcile();},5000).unref();
setInterval(()=>{void tronDeposits.poll().then(r=>{if(r.credited)void drain();}).catch(e=>console.warn('TRON watcher:',String(e.message||e).slice(0,90)));void sharedWallet.poll().then(r=>{if(r.credited)void drain();}).catch(e=>console.warn('Treasury watcher:',String(e.message||e).slice(0,90)));},60000).unref();
setTimeout(()=>{void tronDeposits.poll().then(r=>{if(r.credited)void drain();}).catch(e=>console.warn('TRON watcher startup:',String(e.message||e).slice(0,90)));void sharedWallet.poll().then(r=>{if(r.credited)void drain();}).catch(e=>console.warn('Treasury watcher startup:',String(e.message||e).slice(0,90)));},15000).unref();
