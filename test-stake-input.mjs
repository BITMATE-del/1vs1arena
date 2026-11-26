import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createMatchFlow} from './match-flow.mjs';
const db=new DatabaseSync(':memory:');
db.exec("CREATE TABLE arena_users(id INTEGER PRIMARY KEY,name TEXT,username TEXT,blocked INTEGER DEFAULT 0);CREATE TABLE matches(id INTEGER PRIMARY KEY,chat INTEGER,owner INTEGER,guest INTEGER,game TEXT,mode TEXT,rounds INTEGER,state TEXT,turn INTEGER,round INTEGER DEFAULT 1,a INTEGER DEFAULT 0,b INTEGER DEFAULT 0)");
db.prepare("INSERT INTO arena_users VALUES(?, ?, ?, 0)").run(101,'테스터','tester001');
const messages=[];
const fakeRoom={connected:()=>true,getByCode:()=>null};
const money={deposit:()=>({ok:true}),balance:()=>10000000000000n,reconcile:()=>({done:0})};
const flow=createMatchFlow(db,(user,message,keyboard)=>messages.push({user,message,keyboard}),fakeRoom,{'🎲':['다이스',6]},{wins:'선승제'},[1],{money,paidMatchesEnabled:()=>true,gameEnabled:()=>true});
const latest=()=>db.prepare('SELECT * FROM match_requests ORDER BY rowid DESC LIMIT 1').get();
const fire=(...parts)=>assert.equal(flow.onCallback(101,101,['mf',...parts]),true);
const cases=[
 ['0',0],['0.0',0],['0.000000',0],['0.000001',1],['0.5',500000],['2.5',2500000],
 ['15.123456',15123456],['999.999999',999999999],['1000000',1000000000000]
];
const invalid=['-1','abc','NaN','Infinity','0.0000001','1.0000001','1,000','01','1e3','1000000.000001','1000001','0x10',' ','1.'];
for(const [input,micro] of cases){
 fire('public');const code=latest().code;fire('game',code,'🎲');fire('mode',code,'wins');fire('round',code,'1');
 assert(messages.at(-1).message.includes('직접 입력'), 'text amount prompt required');
 assert(!messages.at(-1).keyboard.flat().some(b=>/양측 각각/.test(b.text)), 'preset paid amount buttons removed');
 assert.equal(flow.onText(101,input),true);
 assert.equal(latest().stake_micro,micro,'exact micro units for '+input);
 assert(messages.at(-1).message.includes(micro===0?'무료 대전':'참가금 '+input.replace(/\.0+$/,'')+' USDT'),'amount confirmation '+input);
 fire('submit',code);
 assert.equal(latest().status,'public');
 fire('cancel',code);
 assert.equal(latest().status,'cancelled');
}
fire('public');const code=latest().code;fire('game',code,'🎲');fire('mode',code,'wins');fire('round',code,'1');
fire('submit',code);
assert.equal(latest().status,'selecting','cannot bypass entered amount with old submit callback');
for(const bad of invalid){assert.equal(flow.onText(101,bad),true);assert.equal(latest().status,'selecting');assert(db.prepare("SELECT 1 FROM match_inputs WHERE user_id=101 AND kind LIKE 'stake:%'").get(),'retry after invalid '+bad);}
assert.equal(flow.onText(101,'3.125'),true);
assert.equal(latest().stake_micro,3125000);
fire('cancel',code);
assert.equal(latest().status,'cancelled');
console.log('GLORY ARENA custom stake input PASS: 0 free, arbitrary 6-decimal USDT, exact micro units, invalid retry, max cap, stale-button bypass protection');
