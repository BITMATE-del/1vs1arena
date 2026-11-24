import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMatchFlow } from './match-flow.mjs';

const db=new DatabaseSync(':memory:');
db.exec("CREATE TABLE arena_users(id INTEGER PRIMARY KEY,name TEXT,username TEXT,blocked INTEGER DEFAULT 0);CREATE TABLE matches(id INTEGER PRIMARY KEY,chat INTEGER,owner INTEGER,guest INTEGER,game TEXT,mode TEXT,rounds INTEGER,state TEXT,turn INTEGER,round INTEGER DEFAULT 1,a INTEGER DEFAULT 0,b INTEGER DEFAULT 0)");
db.exec("CREATE TABLE generated_rooms(code TEXT PRIMARY KEY,chat INTEGER,status TEXT,link TEXT,link_guest TEXT)");
db.prepare("INSERT INTO arena_users(id,name,username) VALUES(?,?,?)").run(1001,'첫 번째 회원','firstuser');
db.prepare("INSERT INTO arena_users(id,name,username) VALUES(?,?,?)").run(1002,'두 번째 회원','seconduser');
const messages=[],rooms=new Map(),events=new Map();
const send=(user,message,keyboard)=>messages.push({user,message,keyboard});
const fakeRoom={
  connected:()=>true,
  requestPair:(data,onReady,onFailed)=>{const code='R-'+data.code;rooms.set(code,{code,chat:-10012001200,status:'ready',link:'https://t.me/+owner',link_guest:'https://t.me/+guest'});db.prepare("INSERT INTO generated_rooms(code,chat,status,link,link_guest) VALUES(?,?,?,?,?)").run(code,-10012001200,'ready','https://t.me/+owner','https://t.me/+guest');events.set(code,{data,onReady,onFailed});return code;},
  getByCode:code=>rooms.get(code),
  finish:code=>{const r=rooms.get(code);if(r)r.status='finished';},
  reopen:code=>{const r=rooms.get(code);if(r)r.status='ready';},
  close:async code=>{const r=rooms.get(code);if(r)r.status='closed';return true;}
};
const flow=createMatchFlow(db,send,fakeRoom,{'🎲':['다이스',6],'🎯':['다트',6]},{wins:'선승제',round:'매판 승패'},[1,3,5],{gameEnabled:()=>true});
const get=()=>db.prepare("SELECT * FROM match_requests ORDER BY rowid DESC LIMIT 1").get();
function act(user,chat,parts){assert.equal(flow.onCallback(user,chat,parts),true);}
flow.begin(1001);
assert.equal(flow.onText(1001,'@seconduser'),true);
let row=get();assert.equal(row.status,'selecting');assert.equal(row.guest,1002);
act(1001,1001,['mf','confirm',row.code]);
act(1001,1001,['mf','game',row.code,'🎯']);
act(1001,1001,['mf','mode',row.code,'wins']);
act(1001,1001,['mf','round',row.code,'3']);
act(1001,1001,['mf','submit',row.code]);assert.equal(get().status,'pending');
act(1001,1001,['mf','accept',row.code]);assert.equal(get().status,'pending','requester cannot accept own direct request');
act(1002,1002,['mf','accept',row.code]);assert.equal(get().status,'room_pending');
const rcode='R-'+row.code;
events.get(rcode).onReady(row.code,{chat:-10012001200,code:rcode,linkOwner:'https://t.me/+owner',linkGuest:'https://t.me/+guest'});
assert.equal(get().status,'room_ready');
act(1001,1001,['mf','notice',row.code]);assert.equal(get().notice_owner,0,'private room notice should not count');
const inviteDMs=messages.filter(m=>[1001,1002].includes(m.user)&&m.message.includes('전용 그룹 입장 링크'));
assert.equal(inviteDMs.length,2,'each participant receives only their group-entry link in DM');
const statusStart=messages.length;
act(1001,-10012001200,['mf','notice',row.code]);
act(1002,-10012001200,['mf','notice',row.code]);
act(1001,-10012001200,['mf','ready',row.code]);
assert.equal(get().status,'room_ready');
act(1002,-10012001200,['mf','ready',row.code]);
assert.equal(get().status,'playing');
const progress=messages.slice(statusStart);
assert.equal(progress.filter(m=>m.user===1001||m.user===1002).length,0,'no duplicated private progress notifications');
assert(progress.some(m=>m.user===-10012001200&&m.message.includes('양측 준비 완료')),'group receives match start notice');
const startPrompt=progress.find(m=>m.user===-10012001200&&m.message.includes('양측 준비 완료'));
assert(startPrompt.keyboard?.flat().some(b=>b.callback_data?.startsWith('dice:')),'group match start includes immediate one-tap dice action');
const match=db.prepare('SELECT * FROM matches WHERE id=?').get(get().match_id);
assert.equal(match.state,'active');assert.equal(match.game,'🎯');assert.equal(match.turn,1001);
flow.finished(-10012001200);assert.equal(get().status,'finished');
assert.equal(rooms.get(rcode).status,'finished');
const finishMessage=messages.findLast(m=>m.user===-10012001200&&m.message.includes('추가 경기를 계속'));
assert(finishMessage?.keyboard?.flat().some(b=>b.callback_data?.includes(':yes')),'ask both players to rematch');
act(1001,-10012001200,['mf','again',row.code,'yes']);assert.equal(flow.votesFor(row.code).owner_vote,'yes');
act(1001,-10012001200,['mf','again',row.code,'yes']);assert.equal(flow.votesFor(row.code).guest_vote,null,'repeat owner vote cannot count for guest');
act(1002,-10012001200,['mf','again',row.code,'yes']);assert.equal(get().status,'playing');
const rematch=db.prepare('SELECT * FROM matches WHERE id=?').get(get().match_id);
assert.notEqual(rematch.id,match.id,'rematch is a separate historic match');
assert.equal(rematch.state,'active');assert.equal(rematch.a,0);assert.equal(rematch.b,0);assert.equal(rooms.get(rcode).status,'ready');
flow.finished(-10012001200);assert.equal(get().status,'finished');
act(1001,-10012001200,['mf','again',row.code,'no']);assert.equal(flow.votesFor(row.code).state,'voting');
act(1002,-10012001200,['mf','again',row.code,'no']);assert.equal(flow.votesFor(row.code).state,'closing');
await flow.processClose(row.code);
assert.equal(flow.votesFor(row.code).state,'closed');
assert.equal(rooms.get(rcode).status,'closed');
flow.begin(1001);assert.equal(flow.onText(1001,'@unknownuser'),true);
flow.onCallback(1001,1001,['mf','public']);const pub=get();assert.equal(pub.source,'direct');
act(1001,1001,['mf','game',pub.code,'🎲']);
act(1001,1001,['mf','mode',pub.code,'wins']);
act(1001,1001,['mf','round',pub.code,'1']);
act(1001,1001,['mf','submit',pub.code]);assert.equal(get().source,'public');
act(1002,1002,['mf','join',pub.code]);assert.equal(get().guest,1002);
act(1002,1002,['mf','accept',pub.code]);assert.equal(get().status,'pending','guest cannot self-approve public application');
act(1001,1001,['mf','reject',pub.code]);assert.equal(get().status,'public','rejected applicant returns public match to lobby');
assert.equal(get().guest,null,'rejection releases applicant slot');
act(1002,1002,['mf','join',pub.code]);assert.equal(get().status,'pending');
act(1002,1002,['mf','withdraw',pub.code]);assert.equal(get().status,'public','withdrawn application restores lobby match');
act(1002,1002,['mf','join',pub.code]);assert.equal(get().status,'pending');
act(1001,1001,['mf','accept',pub.code]);assert.equal(get().status,'room_pending');
console.log('GLORY ARENA match-flow smoke tests PASS',messages.length,'messages queued');
