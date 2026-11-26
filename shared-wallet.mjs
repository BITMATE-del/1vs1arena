// One shared TRON USDT treasury address, uniquely priced short-lived invoices.
// Incoming confirmation only. No private key, signing or automated payout logic.
import {randomInt} from 'node:crypto';
import {USDT_TRON,validTronAddress,normalizeTransfer,usdtDisplay} from './tron-deposits.mjs';

export function parseUsdt(s){
  if(typeof s!=='string'||!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(s))return null;
  const [integer,fraction='']=s.split('.');
  const amount=BigInt(integer)*1000000n+BigInt((fraction+'000000').slice(0,6));
  return amount>0n&&amount<=BigInt(Number.MAX_SAFE_INTEGER)?amount:null;
}
export function createSharedWallet(db,send,opts={}){
  db.exec("CREATE TABLE IF NOT EXISTS treasury_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS treasury_invoices(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,address TEXT NOT NULL,amount_micro INTEGER NOT NULL UNIQUE,base_micro INTEGER NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',txid TEXT,paid INTEGER,UNIQUE(txid,address));CREATE TABLE IF NOT EXISTS treasury_unmatched(txid TEXT NOT NULL,address TEXT NOT NULL,amount_micro INTEGER NOT NULL,block_time INTEGER NOT NULL,reason TEXT NOT NULL,detected INTEGER NOT NULL,PRIMARY KEY(txid,address));CREATE TABLE IF NOT EXISTS treasury_withdrawals(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,to_address TEXT NOT NULL,amount_micro INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'requested',created INTEGER NOT NULL,updated INTEGER NOT NULL,txid TEXT,reason TEXT)");
  const one=(q,...p)=>db.prepare(q).get(...p),all=(q,...p)=>db.prepare(q).all(...p),run=(q,...p)=>db.prepare(q).run(...p);
  const onEvent=opts.onEvent||(()=>{});
  const emit=event=>{try{onEvent(event);}catch(e){console.warn('Treasury admin notification failed:',String(e?.message||e).slice(0,100));}};
  const now=opts.now||Date.now,apiKey=opts.apiKey??process.env.TRONGRID_API_KEY??'',fetcher=opts.fetcher||fetch;
  const base=opts.baseUrl||'https://api.trongrid.io';
  const enabled=()=>opts.enabled?.()??(process.env.SHARED_USDT_ENABLED==='1');
  const cfg=k=>one('SELECT value FROM treasury_settings WHERE key=?',k)?.value;
  const treasury=()=>cfg('address')||null;
  let busy=false,lastChecked=0,lastError='';
  function setAddress(addr){
    if(!validTronAddress(addr))return false;
    const old=treasury();
    if(old===addr)return true;
    if(one('SELECT 1 FROM treasury_invoices WHERE status=? LIMIT 1','pending')||one('SELECT 1 FROM treasury_withdrawals WHERE status IN (?,?,?) LIMIT 1','requested','review','broadcast'))return false;
    if(one('SELECT 1 FROM tron_deposit_addresses WHERE address=?',addr))return false;
    // No silent re-attribution of historic deposits after changing treasury.
    run("INSERT INTO treasury_settings(key,value) VALUES('address',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",addr);
    run("INSERT INTO treasury_settings(key,value) VALUES('active_from',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(now()));
    return true;
  }
  function invoice(user,input){
    const addr=treasury(),baseAmount=parseUsdt(input),t=now();
    if(!enabled()||!apiKey||!addr)return {ok:false,reason:'DEPOSIT_NOT_READY'};
    if(!one('SELECT id FROM arena_users WHERE id=?',user))return {ok:false,reason:'UNKNOWN_USER'};
    if(!baseAmount||baseAmount<1000000n)return {ok:false,reason:'MIN_1_USDT'};
    const prior=one("SELECT * FROM treasury_invoices WHERE user_id=? AND status='pending' AND expires>? ORDER BY id DESC LIMIT 1",user,t);
    if(prior)return {ok:true,invoice:prior,reused:true};
    run("UPDATE treasury_invoices SET status='expired' WHERE status='pending' AND expires<=?",t);
    // Unique suffix up to 0.000999 USDT. User receives actual confirmed amount.
    for(let i=0;i<32;i++){
      const amount=baseAmount+BigInt(randomInt(1,1000));
      if(amount>BigInt(Number.MAX_SAFE_INTEGER))return {ok:false,reason:'AMOUNT_TOO_LARGE'};
      // Keep amounts reserved even after expiry: never credit old transfers to new customers.
      if(one('SELECT id FROM treasury_invoices WHERE amount_micro=?',Number(amount)))continue;
      const result=run("INSERT INTO treasury_invoices(user_id,address,amount_micro,base_micro,created,expires,status) VALUES(?,?,?,?,?,?,'pending')",user,addr,Number(amount),Number(baseAmount),t,t+30*60000);
      const inv=one('SELECT * FROM treasury_invoices WHERE id=?',Number(result.lastInsertRowid));
      emit({type:'invoice',key:'invoice:'+inv.id,user,amount:inv.amount_micro,address:addr,invoiceId:inv.id});
      return {ok:true,invoice:inv};
    }
    return {ok:false,reason:'NO_UNIQUE_AMOUNT'};
  }
  function walletBalance(user){return BigInt(one('SELECT balance_micro FROM tron_wallets WHERE user_id=?',user)?.balance_micro||0);}
  async function queryJson(path,options={}){
    const r=await fetcher(base+path,{...options,headers:{'TRON-PRO-API-KEY':apiKey,...(options.headers||{})},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error('TRONGRID_HTTP_'+r.status);
    return r.json();
  }
  async function confirmed(txid){
    const r=await queryJson('/walletsolidity/gettransactioninfobyid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:txid})});
    return String(r?.id||'').toLowerCase()===txid&&r.receipt?.result==='SUCCESS'&&!r.resMessage;
  }
  function recordUnmatched(tx,reason){
    const r=run('INSERT OR IGNORE INTO treasury_unmatched(txid,address,amount_micro,block_time,reason,detected) VALUES(?,?,?,?,?,?)',tx.txid,treasury(),Number(tx.amount),tx.timestamp,reason,now());
    if(r.changes)emit({type:'unmatched',key:'unmatched:'+tx.txid+':'+treasury(),amount:Number(tx.amount),address:treasury(),txid:tx.txid,reason});
  }
  function apply(tx,amountCount=1){
    if(amountCount!==1||!enabled())return false;
    const addr=treasury(),t=now(),amount=BigInt(tx.amount);
    if(!addr||amount>BigInt(Number.MAX_SAFE_INTEGER))return false;
    if(one('SELECT 1 FROM tron_deposits WHERE txid=? AND address=?',tx.txid,addr))return false;
    const intent=one("SELECT * FROM treasury_invoices WHERE address=? AND amount_micro=? AND status='pending' AND created<=? AND expires>=? LIMIT 1",addr,Number(amount),tx.timestamp,tx.timestamp);
    if(!intent){recordUnmatched(tx,'NO_ACTIVE_MATCH');return false;}
    if(tx.timestamp<Number(cfg('active_from')||0))return false;
    const current=walletBalance(intent.user_id);
    if(current+amount>BigInt(Number.MAX_SAFE_INTEGER))return false;
    db.exec('SAVEPOINT shared_credit');
    try{
      const changed=run("UPDATE treasury_invoices SET status='credited',txid=?,paid=? WHERE id=? AND status='pending'",tx.txid,t,intent.id);
      if(!changed.changes){db.exec('ROLLBACK TO shared_credit');db.exec('RELEASE shared_credit');return false;}
      run('INSERT INTO tron_deposits(txid,user_id,address,amount_micro,source,block_time,credited) VALUES(?,?,?,?,?,?,?)',tx.txid,intent.user_id,addr,Number(amount),tx.from,tx.timestamp,t);
      run('INSERT INTO tron_wallets(user_id,balance_micro,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance_micro=balance_micro+excluded.balance_micro,updated=excluded.updated',intent.user_id,Number(amount),t);
      run('DELETE FROM treasury_unmatched WHERE txid=? AND address=?',tx.txid,addr);
      db.exec('RELEASE shared_credit');
    }catch(e){db.exec('ROLLBACK TO shared_credit');db.exec('RELEASE shared_credit');throw e;}
    emit({type:'credit',key:'credit:'+tx.txid+':'+addr,user:intent.user_id,amount:Number(amount),address:addr,txid:tx.txid,invoiceId:intent.id});
    send(intent.user_id,'✅ USDT 입금 확인 완료\n충전: '+usdtDisplay(amount)+' USDT\n현재 잔액: '+usdtDisplay(current+amount)+' USDT\n거래: '+tx.txid.slice(0,16)+'…');
    return true;
  }
  async function poll(){
    const addr=treasury();
    if(!enabled()||!apiKey||!addr||busy)return {active:false,credited:0};
    busy=true;
    try{
      const start=Number(cfg('active_from')||0);
      const observed=[];let cursor='',done=false;
      for(let page=0;page<12;page++){
        const params=new URLSearchParams({only_to:'true',only_confirmed:'true',limit:'200',order_by:'block_timestamp,desc',min_timestamp:String(start),contract_address:USDT_TRON});
        if(cursor)params.set('fingerprint',cursor);
        const r=await queryJson('/v1/accounts/'+encodeURIComponent(addr)+'/transactions/trc20?'+params);
        if(!Array.isArray(r.data)||r.success===false)throw Error('TRONGRID_INVALID_RESPONSE');
        for(const event of r.data){
          const transfer=normalizeTransfer(event,addr,start);
          if(transfer)observed.push(transfer);
        }
        const next=r.meta?.fingerprint;
        if(!next||r.data.length<200){done=true;break;}
        if(next===cursor)throw Error('TRONGRID_PAGINATION_LOOP');
        cursor=next;
      }
      if(!done)throw Error('TRONGRID_PAGINATION_LIMIT');
      const counts=new Map();
      for(const v of observed)counts.set(v.txid,(counts.get(v.txid)||0)+1);
      let credited=0;
      for(const tx of observed.reverse()){
        if(one('SELECT 1 FROM tron_deposits WHERE txid=? AND address=?',tx.txid,addr))continue;
        if(counts.get(tx.txid)!==1){recordUnmatched(tx,'AMBIGUOUS_SAME_TX');continue;}
        if(!await confirmed(tx.txid))continue;
        if(apply(tx,counts.get(tx.txid)))credited++;
      }
      lastChecked=now();lastError='';
      return {active:true,credited};
    }catch(e){lastError=String(e?.message||e).slice(0,110);return {active:true,credited:0,error:lastError};}
    finally{busy=false;}
  }
  function requestWithdrawal(user,toAddress,amountText){
    const amount=parseUsdt(amountText),t=now();
    if(!validTronAddress(toAddress)||!amount||amount<1000000n)return {ok:false,reason:'INVALID_WITHDRAWAL'};
    if(!one('SELECT id FROM arena_users WHERE id=?',user))return {ok:false,reason:'UNKNOWN_USER'};
    const available=walletBalance(user);
    if(amount>available)return {ok:false,reason:'INSUFFICIENT_BALANCE'};
    db.exec('SAVEPOINT reserve_withdraw');
    try{
      const result=run("UPDATE tron_wallets SET balance_micro=balance_micro-?,updated=? WHERE user_id=? AND balance_micro>=?",Number(amount),t,user,Number(amount));
      if(!result.changes){db.exec('ROLLBACK TO reserve_withdraw');db.exec('RELEASE reserve_withdraw');return {ok:false,reason:'INSUFFICIENT_BALANCE'};}
      const id=Number(run('INSERT INTO treasury_withdrawals(user_id,to_address,amount_micro,created,updated) VALUES(?,?,?,?,?)',user,toAddress,Number(amount),t,t).lastInsertRowid);
      db.exec('RELEASE reserve_withdraw');
      emit({type:'withdrawal',key:'withdraw:'+id,user,withdrawalId:id,amount:Number(amount),address:toAddress});
      return {ok:true,id};
    }catch(e){db.exec('ROLLBACK TO reserve_withdraw');db.exec('RELEASE reserve_withdraw');throw e;}
  }
  function cancelWithdrawal(id){
    const row=one('SELECT * FROM treasury_withdrawals WHERE id=?',id);
    if(!row||row.status!=='requested')return false;
    db.exec('SAVEPOINT cancel_withdraw');
    try{
      run("UPDATE treasury_withdrawals SET status='cancelled',updated=? WHERE id=? AND status='requested'",now(),id);
      run('UPDATE tron_wallets SET balance_micro=balance_micro+?,updated=? WHERE user_id=?',row.amount_micro,now(),row.user_id);
      db.exec('RELEASE cancel_withdraw');
      emit({type:'withdraw_cancel',key:'withdraw-cancel:'+id,user:row.user_id,withdrawalId:id,amount:row.amount_micro,address:row.to_address});
      return true;
    }catch(e){db.exec('ROLLBACK TO cancel_withdraw');db.exec('RELEASE cancel_withdraw');throw e;}
  }
  function status(){return {enabled:enabled(),apiConfigured:!!apiKey,address:treasury(),lastChecked,lastError,pending:one("SELECT COUNT(*) n FROM treasury_invoices WHERE status='pending' AND expires>?",now()).n,unmatched:one('SELECT COUNT(*) n FROM treasury_unmatched').n,withdrawals:one("SELECT COUNT(*) n FROM treasury_withdrawals WHERE status='requested'").n};}
  function mine(user){return {invoice:one("SELECT * FROM treasury_invoices WHERE user_id=? AND status='pending' AND expires>? ORDER BY id DESC LIMIT 1",user,now()),withdrawals:all('SELECT * FROM treasury_withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 10',user)};}
  return {setAddress,invoice,poll,apply,confirmed,requestWithdrawal,cancelWithdrawal,status,mine,treasury};
}
