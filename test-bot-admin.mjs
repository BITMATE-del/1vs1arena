import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createBotAdmin} from './bot-admin.mjs';
const db=new DatabaseSync(':memory:');
db.exec("CREATE TABLE arena_users(id INTEGER PRIMARY KEY,name TEXT,username TEXT);INSERT INTO arena_users VALUES (101,'관리자','gloryadmin'),(102,'부관리자','glorymanager'),(103,'회원','participant');CREATE TABLE treasury_invoices(id INTEGER PRIMARY KEY,user_id INTEGER,amount_micro INTEGER,status TEXT,created INTEGER,txid TEXT);CREATE TABLE treasury_withdrawals(id INTEGER PRIMARY KEY,user_id INTEGER,amount_micro INTEGER,status TEXT,created INTEGER,to_address TEXT);CREATE TABLE treasury_unmatched(txid TEXT,address TEXT,amount_micro INTEGER,block_time INTEGER,reason TEXT,detected INTEGER);CREATE TABLE outbox(id INTEGER PRIMARY KEY,method TEXT,payload TEXT)");
const sent=(method,payload)=>db.prepare('INSERT INTO outbox(method,payload) VALUES(?,?)').run(method,JSON.stringify(payload));
const admins=createBotAdmin(db,sent,{now:()=>1900000000000});
assert.equal(admins.setAdmin(999,true),false,'unknown member cannot register');
assert(admins.setAdmin(101,true));
assert(admins.setAdmin(102,true));
assert.equal(admins.isAdmin(101),true);
assert.equal(admins.isAdmin(103),false);
assert.equal(admins.inbox(103),null,'member cannot open admin panel');
db.prepare('INSERT INTO treasury_invoices VALUES(?,?,?,?,?,?)').run(7,103,10000123,'pending',1900000000000,null);
db.prepare('INSERT INTO treasury_withdrawals VALUES(?,?,?,?,?,?)').run(9,103,5000000,'requested',1900000000000,'Ttest');
assert(admins.inbox(101).includes('충전 신청'));
const events=[
 {type:'invoice',key:'invoice:7',user:103,amount:10000123,address:'T123',invoiceId:7},
 {type:'credit',key:'credit:'+'a'.repeat(64)+':T123',user:103,amount:10000123,txid:'a'.repeat(64),address:'T123',invoiceId:7},
 {type:'unmatched',key:'unmatched:'+'b'.repeat(64)+':T123',amount:5000000,txid:'b'.repeat(64),reason:'NO_ACTIVE_MATCH'},
 {type:'withdrawal',key:'withdraw:9',user:103,withdrawalId:9,amount:5000000,address:'T444'},
 {type:'withdraw_cancel',key:'withdraw-cancel:9',user:103,withdrawalId:9,amount:5000000,address:'T444'}
];
for(const event of events)assert.equal(admins.notify(event),2,'each admin receives event');
assert.equal(db.prepare('SELECT COUNT(*) n FROM outbox').get().n,10);
assert.equal(admins.notify(events[0]),0,'same event cannot notify twice');
assert.equal(db.prepare('SELECT COUNT(*) n FROM outbox').get().n,10);
const messages=db.prepare('SELECT payload FROM outbox ORDER BY id').all().map(r=>JSON.parse(r.payload));
assert(messages.every(x=>x.chat_id===101||x.chat_id===102));
assert(messages.some(x=>x.text.includes('TXID: '+('a'.repeat(64)))));
assert(messages.some(x=>x.text.includes('송금 미실행')));
assert(admins.setAdmin(102,false),'admin access can be revoked');
assert.equal(admins.isAdmin(102),false);
assert.equal(admins.notify({type:'invoice',key:'invoice:8',user:103,amount:2000000}),1,'disabled administrator receives no new events');
assert.equal(db.prepare('SELECT COUNT(*) n FROM outbox WHERE json_extract(payload,\'$.chat_id\')=102').get().n,5);
console.log('GLORY ARENA bot admin tests PASS: enrollment, revocation, private inbox, 5 finance event types, multi-admin fanout, event deduplication');
