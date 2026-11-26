import {createHash} from 'node:crypto';
import {projectPrize,PLATFORM_FEE_BPS} from './fee-policy.mjs';
export const STAKES_USDT=[1,5,10,50,100];
const MAX=BigInt(Number.MAX_SAFE_INTEGER);
export function toMicro(stake){const n=BigInt(stake);if(n<=0n||n>MAX)throw RangeError('BAD_STAKE');return n;}
export function createMoneyEngine(db,options={}){
 db.exec("CREATE TABLE IF NOT EXISTS money_escrow(match_id INTEGER PRIMARY KEY,request_code TEXT NOT NULL,owner INTEGER NOT NULL,guest INTEGER NOT NULL,stake_a INTEGER NOT NULL CHECK(stake_a>0),stake_b INTEGER NOT NULL CHECK(stake_b>0),created INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'held' CHECK(status IN ('held','settled')));CREATE TABLE IF NOT EXISTS money_settlements(match_id INTEGER PRIMARY KEY,decision TEXT NOT NULL CHECK(decision IN ('winner','refund')),winner INTEGER,fee_micro INTEGER NOT NULL,payout_micro INTEGER NOT NULL,created INTEGER NOT NULL,reason TEXT NOT NULL);CREATE TABLE IF NOT EXISTS money_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT UNIQUE NOT NULL,match_id INTEGER NOT NULL,user_id INTEGER NOT NULL,delta_micro INTEGER NOT NULL,created INTEGER NOT NULL,kind TEXT NOT NULL);CREATE TABLE IF NOT EXISTS money_house(id INTEGER PRIMARY KEY CHECK(id=1),fee_micro INTEGER NOT NULL DEFAULT 0 CHECK(fee_micro>=0));INSERT OR IGNORE INTO money_house(id,fee_micro) VALUES(1,0)");
 db.exec("CREATE TRIGGER IF NOT EXISTS money_ledger_no_update BEFORE UPDATE ON money_ledger BEGIN SELECT RAISE(ABORT,'MONEY_LEDGER_IMMUTABLE');END;CREATE TRIGGER IF NOT EXISTS money_ledger_no_delete BEFORE DELETE ON money_ledger BEGIN SELECT RAISE(ABORT,'MONEY_LEDGER_IMMUTABLE');END");
 const get=(q,...a)=>db.prepare(q).get(...a),all=(q,...a)=>db.prepare(q).all(...a),run=(q,...a)=>db.prepare(q).run(...a),now=options.now||Date.now;
 function escrow(matchId){return get('SELECT * FROM money_escrow WHERE match_id=?',matchId);}
 function balance(user){return BigInt(get('SELECT balance_micro FROM tron_wallets WHERE user_id=?',user)?.balance_micro||0);}
 function deposit(matchId,code,owner,guest,stake){
  if(!Number.isSafeInteger(matchId)||matchId<=0||!Number.isSafeInteger(owner)||!Number.isSafeInteger(guest)||owner===guest)return {ok:false,reason:'INVALID_PLAYERS'};
  const amount=toMicro(stake);if(amount>MAX/2n)return {ok:false,reason:'STAKE_LIMIT'};
  const prior=escrow(matchId);
  if(prior)return {ok:prior.request_code===code&&prior.owner===owner&&prior.guest===guest&&BigInt(prior.stake_a)===amount&&prior.status==='held',reused:true,reason:'ALREADY_ESCROWED'};
  db.exec('SAVEPOINT money_deposit');
  try{
   // Deduct both balances before registering escrow; rollback both if either fails.
   for(const user of [owner,guest]){
    const debit=run('UPDATE tron_wallets SET balance_micro=balance_micro-?,updated=? WHERE user_id=? AND balance_micro>=?',Number(amount),now(),user,Number(amount));
    if(debit.changes!==1){db.exec('ROLLBACK TO money_deposit');db.exec('RELEASE money_deposit');return {ok:false,reason:'INSUFFICIENT_BALANCE',user};}
   }
   run('INSERT INTO money_escrow(match_id,request_code,owner,guest,stake_a,stake_b,created) VALUES(?,?,?,?,?,?,?)',matchId,code,owner,guest,Number(amount),Number(amount),now());
   for(const user of [owner,guest])run('INSERT INTO money_ledger(event_key,match_id,user_id,delta_micro,created,kind) VALUES(?,?,?,?,?,?)',matchId+':hold:'+user,matchId,user,-Number(amount),now(),'stake_hold');
   db.exec('RELEASE money_deposit');
   return {ok:true,amount:String(amount)};
  }catch(e){db.exec('ROLLBACK TO money_deposit');db.exec('RELEASE money_deposit');throw e;}
 }
 function settle(match){
  if(!match||!Number.isSafeInteger(match.id))return {ok:false,reason:'INVALID_MATCH'};
  const e=escrow(match.id);
  if(!e)return {ok:false,reason:'NOT_FUNDED'};
  const existing=get('SELECT * FROM money_settlements WHERE match_id=?',match.id);
  if(existing)return {ok:true,reused:true,decision:existing.decision,winner:existing.winner,fee:existing.fee_micro,payout:existing.payout_micro};
  if(!['finished','cancelled'].includes(match.state))return {ok:false,reason:'NOT_TERMINAL'};
  if(e.status!=='held')return {ok:false,reason:'ALREADY_SETTLED'};
  // All authoritative scores come from saved game engine; cancelled always refunds.
  const refund=match.state==='cancelled'||match.a===match.b;
  const winner=refund?null:(match.a>match.b?e.owner:e.guest);
  if(!refund&&![e.owner,e.guest].includes(winner))return {ok:false,reason:'WINNER_MISMATCH'};
  const projection=projectPrize(e.stake_a,e.stake_b);
  const payout=refund?BigInt(e.stake_a)+BigInt(e.stake_b):projection.winnerPayout;
  const fee=refund?0n:projection.fee;
  const reason=match.state==='cancelled'?'cancelled':refund?'draw':'win';
  db.exec('SAVEPOINT money_settle');
  try{
   const m=run("UPDATE money_escrow SET status='settled' WHERE match_id=? AND status='held'",match.id);
   if(m.changes!==1){db.exec('ROLLBACK TO money_settle');db.exec('RELEASE money_settle');return {ok:false,reason:'ALREADY_SETTLED'};}
   run('INSERT INTO money_settlements(match_id,decision,winner,fee_micro,payout_micro,created,reason) VALUES(?,?,?,?,?,?,?)',match.id,refund?'refund':'winner',winner,Number(fee),Number(payout),now(),reason);
   const changes=refund?[[e.owner,BigInt(e.stake_a),'refund'],[e.guest,BigInt(e.stake_b),'refund']]:[[winner,payout,'prize']];
   for(const [user,amount,kind] of changes){
    if(balance(user)+amount>MAX)throw Error('BALANCE_OVERFLOW');
    run('INSERT INTO tron_wallets(user_id,balance_micro,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance_micro=balance_micro+excluded.balance_micro,updated=excluded.updated',user,Number(amount),now());
    run('INSERT INTO money_ledger(event_key,match_id,user_id,delta_micro,created,kind) VALUES(?,?,?,?,?,?)',match.id+':'+kind+':'+user,match.id,user,Number(amount),now(),kind);
   }
   if(fee)run('UPDATE money_house SET fee_micro=fee_micro+? WHERE id=1',Number(fee));
   db.exec('RELEASE money_settle');
   return {ok:true,decision:refund?'refund':'winner',winner,fee:Number(fee),payout:Number(payout)};
  }catch(err){db.exec('ROLLBACK TO money_settle');db.exec('RELEASE money_settle');throw err;}
 }
 function reconcile(limit=100){
  const rows=all("SELECT m.* FROM money_escrow e JOIN matches m ON m.id=e.match_id LEFT JOIN money_settlements s ON s.match_id=m.id WHERE e.status='held' AND s.match_id IS NULL AND m.state IN ('finished','cancelled') ORDER BY m.id LIMIT ?",Math.min(limit,100));
  let done=0,errors=0;
  for(const m of rows)try{if(settle(m).ok)done++;}catch(e){errors++;console.error('Money settlement failed',m.id,String(e.message||e).slice(0,90));}
  return {done,errors};
 }
 function summary(){return {open:get("SELECT COUNT(*) n FROM money_escrow WHERE status='held'").n,settled:get('SELECT COUNT(*) n FROM money_settlements').n,fees:get('SELECT fee_micro FROM money_house WHERE id=1').fee_micro};}
 function ledger(limit=50){return all('SELECT * FROM money_ledger ORDER BY id DESC LIMIT ?',Math.max(1,Math.min(100,limit)));}
 return {deposit,settle,reconcile,escrow,summary,ledger,balance};
}
