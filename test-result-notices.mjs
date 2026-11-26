import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';

const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
const a=source.indexOf('function criticalNotice('),b=source.indexOf('function send(chat',a);
const c=source.indexOf('function announceMatchSettlement('),d=source.indexOf('matchFlow=createMatchFlow(',c);
assert(a>0&&b>a&&c>b&&d>c,'notification and settlement sections must exist');

const db=new DatabaseSync(':memory:');
db.exec("CREATE TABLE matches(id INTEGER PRIMARY KEY,chat INTEGER,owner INTEGER,guest INTEGER,game TEXT,rounds INTEGER,state TEXT,a INTEGER,b INTEGER);CREATE TABLE match_requests(code TEXT,match_id INTEGER,stake_micro INTEGER);CREATE TABLE money_settlements(match_id INTEGER PRIMARY KEY,decision TEXT,winner INTEGER,fee_micro INTEGER,payout_micro INTEGER,reason TEXT);CREATE TABLE match_notice_events(event_key TEXT PRIMARY KEY,match_id INTEGER,chat INTEGER,text TEXT,status TEXT DEFAULT 'queued',attempts INTEGER DEFAULT 0,last_error TEXT,created INTEGER,delivered INTEGER);CREATE TABLE outbox(id INTEGER PRIMARY KEY,method TEXT,payload TEXT,notification_key TEXT UNIQUE);");
const one=(sql,...args)=>db.prepare(sql).get(...args);
const all=(sql,...args)=>db.prepare(sql).all(...args);
const run=(sql,...args)=>db.prepare(sql).run(...args);
const incidents=[];
const moneyEngine={
 escrow:id=>id===3?{stake_a:10000000,stake_b:10000000}:null,
 settle:()=>({ok:true,reused:true}),
 balance:()=>29400000n
};
const context={one,all,run,Date,JSON,console,moneyEngine,
 matchBoard:{player:id=>'@player'+id},
 matchWatch:{incident:(...args)=>incidents.push(args)},
 usdtDisplay:v=>String(Number(v)/1000000)};
const {announceMatchSettlement,repairNoticeQueue}=vm.runInNewContext(source.slice(a,b)+source.slice(c,d)+'\n({announceMatchSettlement,repairNoticeQueue})',context);
for(const [id,state,stake] of [[1,'finished',0],[2,'finished',5000000],[3,'finished',10000000],[4,'cancelled',5000000]]){
 run('INSERT INTO matches(id,chat,owner,guest,game,rounds,state,a,b) VALUES(?,?,?,?,?,?,?,?,?)',id,-100444,101,102,'🎲',3,state,2,1);
 run('INSERT INTO match_requests(code,match_id,stake_micro) VALUES(?,?,?)','GA-'+id,id,stake);
}
run("INSERT INTO money_settlements(match_id,decision,winner,fee_micro,payout_micro,reason) VALUES(3,'winner',101,600000,19400000,'win')");
for(let i=1;i<=4;i++)announceMatchSettlement(i);
assert(one("SELECT 1 FROM match_notice_events WHERE event_key='match:1:free_result'"));
assert(one("SELECT 1 FROM match_notice_events WHERE event_key='match:2:missing_escrow'"));
assert(!one("SELECT 1 FROM match_notice_events WHERE event_key='match:2:free_result'"),'missing funded escrow never means free');
assert(one("SELECT 1 FROM match_notice_events WHERE event_key='match:3:result'"),'already settled match still gets notification');
assert(one("SELECT 1 FROM match_notice_events WHERE event_key='match:3:personal:101'"));
assert(one("SELECT 1 FROM match_notice_events WHERE event_key='match:4:cancel_no_escrow'"));
assert.equal(incidents.length,1);
const before=one('SELECT COUNT(*) n FROM match_notice_events').n;
for(let i=1;i<=4;i++)announceMatchSettlement(i);
assert.equal(one('SELECT COUNT(*) n FROM match_notice_events').n,before,'repeated reconciliation does not duplicate events');
run('DELETE FROM outbox');
repairNoticeQueue();
assert.equal(one('SELECT COUNT(*) n FROM outbox').n,before,'interrupted outbox can recover');
run("UPDATE match_notice_events SET status='delivered' WHERE event_key='match:3:result'");
run("DELETE FROM outbox WHERE notification_key='match:3:result'");
repairNoticeQueue();
assert(!one("SELECT 1 FROM outbox WHERE notification_key='match:3:result'"),'delivered event cannot requeue');
console.log('GLORY ARENA durable result notices PASS: free vs missing escrow, already settled, cancellations, dedupe, restart recovery');
