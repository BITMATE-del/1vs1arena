// Internal balance operations; no blockchain signing or transfer takes place here.
import {parseUsdt} from './shared-wallet.mjs';
export function createWalletOps(db,options={}){
 db.exec("CREATE TABLE IF NOT EXISTS wallet_manual_ops(id INTEGER PRIMARY KEY AUTOINCREMENT,request_key TEXT NOT NULL UNIQUE,user_id INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('credit','debit','manual_deposit')),amount_micro INTEGER NOT NULL CHECK(amount_micro>0),balance_before INTEGER NOT NULL,balance_after INTEGER NOT NULL,reference TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS wallet_withdrawal_actions(id INTEGER PRIMARY KEY AUTOINCREMENT,withdrawal_id INTEGER NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,txid TEXT,UNIQUE(withdrawal_id,action))");
 db.exec("CREATE TRIGGER IF NOT EXISTS wallet_manual_ops_no_update BEFORE UPDATE ON wallet_manual_ops BEGIN SELECT RAISE(ABORT,'WALLET_AUDIT_IMMUTABLE');END;CREATE TRIGGER IF NOT EXISTS wallet_manual_ops_no_delete BEFORE DELETE ON wallet_manual_ops BEGIN SELECT RAISE(ABORT,'WALLET_AUDIT_IMMUTABLE');END;CREATE TRIGGER IF NOT EXISTS wallet_withdrawal_actions_no_update BEFORE UPDATE ON wallet_withdrawal_actions BEGIN SELECT RAISE(ABORT,'WITHDRAWAL_AUDIT_IMMUTABLE');END;CREATE TRIGGER IF NOT EXISTS wallet_withdrawal_actions_no_delete BEFORE DELETE ON wallet_withdrawal_actions BEGIN SELECT RAISE(ABORT,'WITHDRAWAL_AUDIT_IMMUTABLE');END");
 const get=(q,...a)=>db.prepare(q).get(...a),all=(q,...a)=>db.prepare(q).all(...a),run=(q,...a)=>db.prepare(q).run(...a),now=options.now||Date.now;
 function operate({user,kind,amount,reference,actor,requestKey}){
  const micro=parseUsdt(String(amount||''));const ref=String(reference||'').trim(),who=String(actor||'').slice(0,100);
  if(!Number.isSafeInteger(user)||user<=0||!get('SELECT 1 FROM arena_users WHERE id=?',user)||!['credit','debit','manual_deposit'].includes(kind)||!micro||ref.length<3||ref.length>160||!who||!/^[-\w]{12,100}$/.test(String(requestKey)))return {ok:false,reason:'INVALID_INPUT'};
  const key=kind==='manual_deposit'?'deposit:'+ref.toLowerCase():String(requestKey);
  const duplicate=get('SELECT * FROM wallet_manual_ops WHERE request_key=?',key);
  if(duplicate)return {ok:false,reason:'DUPLICATE',record:duplicate};
  // No manually minted credit against a transaction already automatically credited.
  if(kind==='manual_deposit'&&/^[a-f0-9]{64}$/i.test(ref)&&get('SELECT 1 FROM tron_deposits WHERE txid=?',ref.toLowerCase()))return {ok:false,reason:'ALREADY_AUTOCREDITED'};
  db.exec('SAVEPOINT manual_wallet_op');
  try{
   const prior=BigInt(get('SELECT balance_micro FROM tron_wallets WHERE user_id=?',user)?.balance_micro||0);
   const next=kind==='debit'?prior-micro:prior+micro;
   if(next<0n||next>BigInt(Number.MAX_SAFE_INTEGER)){db.exec('ROLLBACK TO manual_wallet_op');db.exec('RELEASE manual_wallet_op');return {ok:false,reason:'BALANCE_LIMIT'};}
   run('INSERT INTO wallet_manual_ops(request_key,user_id,kind,amount_micro,balance_before,balance_after,reference,actor,created) VALUES(?,?,?,?,?,?,?,?,?)',key,user,kind,Number(micro),Number(prior),Number(next),ref,who,now());
   run('INSERT INTO tron_wallets(user_id,balance_micro,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance_micro=excluded.balance_micro,updated=excluded.updated',user,Number(next),now());
   db.exec('RELEASE manual_wallet_op');return {ok:true,before:Number(prior),after:Number(next)};
  }catch(e){db.exec('ROLLBACK TO manual_wallet_op');db.exec('RELEASE manual_wallet_op');throw e;}
 }
 function invoiceAction(id,action,actor,reference=''){
  const who=String(actor||'').slice(0,100),ref=String(reference||'').trim();
  if(!Number.isSafeInteger(id)||id<=0||!['credit','reject'].includes(action)||!who)return {ok:false,reason:'INVALID_INPUT'};
  db.exec('SAVEPOINT process_invoice');
  try{
   const inv=get('SELECT * FROM treasury_invoices WHERE id=?',id);
   if(!inv||!['pending','expired'].includes(inv.status)){db.exec('ROLLBACK TO process_invoice');db.exec('RELEASE process_invoice');return {ok:false,reason:'ALREADY_PROCESSED'};}
   if(action==='credit'&&(ref.length<3||ref.length>160)){db.exec('ROLLBACK TO process_invoice');db.exec('RELEASE process_invoice');return {ok:false,reason:'REFERENCE_REQUIRED'};}
   if(action==='credit'){
    const amount=BigInt(inv.amount_micro);
    const display=String(amount/1000000n)+'.'+String(amount%1000000n).padStart(6,'0');
    const result=operate({user:inv.user_id,kind:'manual_deposit',amount:display,reference:ref,actor:who,requestKey:'invoice-'+id+'-manual-credit'});
    if(!result.ok){db.exec('ROLLBACK TO process_invoice');db.exec('RELEASE process_invoice');return result;}
   }
   const status=action==='credit'?'manual_credited':'rejected';
   const updated=run('UPDATE treasury_invoices SET status=?,paid=CASE WHEN ?=? THEN ? ELSE paid END WHERE id=? AND status=?',status,action,'credit',now(),id,inv.status);
   if(!updated.changes)throw Error('INVOICE_CONFLICT');
   db.exec('RELEASE process_invoice');
   return {ok:true,user:inv.user_id,amount:inv.amount_micro,status};
  }catch(e){db.exec('ROLLBACK TO process_invoice');db.exec('RELEASE process_invoice');throw e;}
 }
 function withdrawal(id,action,actor,txid=''){
  const who=String(actor||'').slice(0,100);
  if(!Number.isSafeInteger(id)||id<=0||!['approve','reject','paid'].includes(action)||!who)return {ok:false,reason:'INVALID_INPUT'};
  const hash=String(txid||'').trim().toLowerCase();
  if(action==='paid'&&!/^[a-f0-9]{64}$/.test(hash))return {ok:false,reason:'TXID_REQUIRED'};
  db.exec('SAVEPOINT manual_withdrawal');
  try{
   const row=get('SELECT * FROM treasury_withdrawals WHERE id=?',id);
   if(!row){db.exec('ROLLBACK TO manual_withdrawal');db.exec('RELEASE manual_withdrawal');return {ok:false,reason:'NOT_FOUND'};}
   if((action==='approve'&&row.status!=='requested')||(action==='reject'&&!['requested','approved'].includes(row.status))||(action==='paid'&&row.status!=='approved')){
    db.exec('ROLLBACK TO manual_withdrawal');db.exec('RELEASE manual_withdrawal');return {ok:false,reason:'ALREADY_PROCESSED'};
   }
   if(action==='paid'&&get('SELECT 1 FROM treasury_withdrawals WHERE txid=? AND id<>?',hash,id)){db.exec('ROLLBACK TO manual_withdrawal');db.exec('RELEASE manual_withdrawal');return {ok:false,reason:'DUPLICATE_TXID'};}
   const status=action==='approve'?'approved':action==='reject'?'rejected':'paid';
   const update=run('UPDATE treasury_withdrawals SET status=?,updated=?,txid=CASE WHEN ?=? THEN ? ELSE txid END WHERE id=? AND status=?',status,now(),action,'paid',hash,id,row.status);
   if(update.changes!==1)throw Error('WITHDRAWAL_CONFLICT');
   if(action==='reject'){
    const old=BigInt(get('SELECT balance_micro FROM tron_wallets WHERE user_id=?',row.user_id)?.balance_micro||0);
    const next=old+BigInt(row.amount_micro);
    if(next>BigInt(Number.MAX_SAFE_INTEGER))throw Error('BALANCE_OVERFLOW');
    run('INSERT INTO tron_wallets(user_id,balance_micro,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance_micro=excluded.balance_micro,updated=excluded.updated',row.user_id,Number(next),now());
   }
   run('INSERT INTO wallet_withdrawal_actions(withdrawal_id,action,actor,created,txid) VALUES(?,?,?,?,?)',id,action,who,now(),hash||null);
   db.exec('RELEASE manual_withdrawal');return {ok:true,user:row.user_id,amount:row.amount_micro,address:row.to_address,status,txid:hash};
  }catch(e){db.exec('ROLLBACK TO manual_withdrawal');db.exec('RELEASE manual_withdrawal');throw e;}
 }
 return {operate,withdrawal,invoiceAction,adjustments:(limit=60)=>all('SELECT * FROM wallet_manual_ops ORDER BY id DESC LIMIT ?',Math.min(100,Math.max(1,limit))),withdrawalActions:(limit=60)=>all('SELECT * FROM wallet_withdrawal_actions ORDER BY id DESC LIMIT ?',Math.min(100,Math.max(1,limit)))};
}
