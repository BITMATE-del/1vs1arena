import {createHash} from 'node:crypto';
// TRON USDT/TRC20 incoming transfer monitor. Read-only against the chain.
// No private key is stored, and this module cannot send withdrawals.
export const USDT_TRON='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export function usdtDisplay(micro){const v=BigInt(micro),whole=v/1000000n,frac=String(v%1000000n).padStart(6,'0');return whole+'.'+frac;}
export function validTronAddress(address){
 if(typeof address!=='string'||!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)||address===USDT_TRON)return false;
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 let n=0n;
 for(const c of address){const i=alphabet.indexOf(c);if(i<0)return false;n=n*58n+BigInt(i);}
 const bytes=Buffer.alloc(25);
 for(let i=24;i>=0;i--){bytes[i]=Number(n&255n);n>>=8n;}
 if(n!==0n||bytes[0]!==0x41)return false;
 const sha=x=>createHash('sha256').update(x).digest();
 return sha(sha(bytes.subarray(0,21))).subarray(0,4).equals(bytes.subarray(21));
}
export function normalizeTransfer(t,address,since){
  if(!t||typeof t!=='object'||!t.token_info)return null;
  const tx=String(t.transaction_id||'');
  if(!/^[0-9a-fA-F]{64}$/.test(tx))return null;
  const contract=String(t.token_info.address||'');
  if(contract!==USDT_TRON||String(t.token_info.decimals)!=='6')return null;
  if(String(t.to)!==address||String(t.from)===address)return null;
  const timestamp=Number(t.block_timestamp);
  if(!Number.isSafeInteger(timestamp)||timestamp<since)return null;
  const value=String(t.value);
  if(!/^[0-9]{1,18}$/.test(value)||BigInt(value)<=0n)return null;
  return {txid:tx.toLowerCase(),amount:value,from:String(t.from),timestamp};
}
export function createTronDeposits(db,send,options={}){
  db.exec("CREATE TABLE IF NOT EXISTS tron_deposit_addresses(user_id INTEGER PRIMARY KEY,address TEXT UNIQUE NOT NULL,active_from INTEGER NOT NULL,created INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS tron_deposits(txid TEXT NOT NULL,user_id INTEGER NOT NULL,address TEXT NOT NULL,amount_micro INTEGER NOT NULL,source TEXT NOT NULL,block_time INTEGER NOT NULL,credited INTEGER NOT NULL,PRIMARY KEY(txid,address));CREATE TABLE IF NOT EXISTS tron_wallets(user_id INTEGER PRIMARY KEY,balance_micro INTEGER NOT NULL DEFAULT 0 CHECK(balance_micro>=0),updated INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS tron_monitor_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL)");
  db.exec('CREATE TABLE IF NOT EXISTS treasury_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const legacyPk=db.prepare("PRAGMA table_info(tron_deposits)").all().filter(x=>x.pk>0);
  if(legacyPk.length===1&&legacyPk[0].name==='txid'){
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec("ALTER TABLE tron_deposits RENAME TO tron_deposits_legacy_v1");
      db.exec("CREATE TABLE tron_deposits(txid TEXT NOT NULL,user_id INTEGER NOT NULL,address TEXT NOT NULL,amount_micro INTEGER NOT NULL,source TEXT NOT NULL,block_time INTEGER NOT NULL,credited INTEGER NOT NULL,PRIMARY KEY(txid,address))");
      db.exec("INSERT INTO tron_deposits SELECT txid,user_id,address,amount_micro,source,block_time,credited FROM tron_deposits_legacy_v1");
      db.exec("DROP TABLE tron_deposits_legacy_v1");
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  const one=(sql,...p)=>db.prepare(sql).get(...p),all=(sql,...p)=>db.prepare(sql).all(...p),run=(sql,...p)=>db.prepare(sql).run(...p);
  const now=options.now||Date.now;
  const apiKey=options.apiKey??process.env.TRONGRID_API_KEY??'';
  const enabled=()=>options.enabled?.()??(process.env.TRON_DEPOSITS_ENABLED==='1');
  const base=options.baseUrl||'https://api.trongrid.io';
  const fetcher=options.fetcher||fetch;
  let running=false,lastChecked=0,lastError='';
  const log=(kind,detail)=>run('INSERT INTO tron_monitor_events(at,kind,detail) VALUES(?,?,?)',now(),kind,String(detail).slice(0,180));
  function assign(user,address){
    if(!Number.isSafeInteger(user)||user<=0||!one('SELECT id FROM arena_users WHERE id=?',user))return false;
    if(!validTronAddress(address))return false;
    if(db.prepare("SELECT value FROM treasury_settings WHERE key='address'").get()?.value===address)return false;
    // Reassignment is forbidden once funds have arrived; operators must use a separate reconciliation path.
    if(one('SELECT 1 FROM tron_deposits WHERE user_id=? LIMIT 1',user))return false;
    if(one('SELECT user_id FROM tron_deposit_addresses WHERE address=? AND user_id!=?',address,user))return false;
    const previous=one('SELECT address FROM tron_deposit_addresses WHERE user_id=?',user);
    if(previous?.address===address)return true;
    const t=now();
    run('INSERT INTO tron_deposit_addresses(user_id,address,active_from,created) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET address=excluded.address,active_from=excluded.active_from',user,address,t,t);
    log('address_set','user='+user+' address='+address);
    return true;
  }
  function balance(user){return String(one('SELECT balance_micro FROM tron_wallets WHERE user_id=?',user)?.balance_micro||0);}
  function credit(user,address,transfer){
    if(!enabled())return false;
    const assigned=one('SELECT address,active_from FROM tron_deposit_addresses WHERE user_id=?',user);
    if(!assigned||assigned.address!==address||transfer.timestamp<assigned.active_from)return false;
    if(one('SELECT txid FROM tron_deposits WHERE txid=? AND address=?',transfer.txid,address))return false;
    const amount=BigInt(transfer.amount),max=9223372036854775807n;
    const current=BigInt(balance(user));
    if(amount<=0n||amount>BigInt(Number.MAX_SAFE_INTEGER)||current+amount>BigInt(Number.MAX_SAFE_INTEGER))throw Error('BALANCE_LIMIT');
    db.exec('SAVEPOINT credit_tron');
    try{
      run('INSERT INTO tron_deposits(txid,user_id,address,amount_micro,source,block_time,credited) VALUES(?,?,?,?,?,?,?)',transfer.txid,user,address,Number(amount),transfer.from,transfer.timestamp,now());
      run('INSERT INTO tron_wallets(user_id,balance_micro,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance_micro=balance_micro+excluded.balance_micro,updated=excluded.updated',user,Number(amount),now());
      db.exec('RELEASE credit_tron');
    }catch(e){db.exec('ROLLBACK TO credit_tron');db.exec('RELEASE credit_tron');throw e;}
    send(user,'✅ USDT/TRC20 입금 확인\\n충전: '+usdtDisplay(amount)+' USDT\\n잔액: '+usdtDisplay(current+amount)+' USDT\\nTXID: '+transfer.txid.slice(0,16)+'…');
    return true;
  }
  async function queryJson(path,opts={}){
    const resp=await fetcher(base+path,{...opts,headers:{'TRON-PRO-API-KEY':apiKey,...(opts.headers||{})},signal:AbortSignal.timeout(15000)});
    if(!resp.ok)throw Error('TRONGRID_HTTP_'+resp.status);
    return resp.json();
  }
  async function solid(txid){
    const r=await queryJson('/walletsolidity/gettransactioninfobyid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:txid})});
    return !!r?.id&&String(r.id).toLowerCase()===txid&&r.receipt?.result==='SUCCESS'&&!r.resMessage;
  }
  async function scan(row){
    const pending=[];let cursor='',end=false;
    for(let page=0;page<12;page++){
      const query=new URLSearchParams({only_to:'true',only_confirmed:'true',limit:'200',order_by:'block_timestamp,desc',min_timestamp:String(row.active_from),contract_address:USDT_TRON});
      if(cursor)query.set('fingerprint',cursor);
      const r=await queryJson('/v1/accounts/'+encodeURIComponent(row.address)+'/transactions/trc20?'+query);
      if(!Array.isArray(r.data)||r.success===false)throw Error('TRONGRID_INVALID_RESPONSE');
      for(const t of r.data){
        const parsed=normalizeTransfer(t,row.address,row.active_from);
        if(parsed)pending.push(parsed);
      }
      const next=r.meta?.fingerprint;
      if(!next||r.data.length<200){end=true;break;}
      if(next===cursor)throw Error('TRONGRID_STUCK_CURSOR');
      cursor=next;
    }
    if(!end)throw Error('TRONGRID_PAGINATION_LIMIT'); // never silently skip pages
    // Credit only unambiguous transactions. Two equal transfers in one tx are quarantined.
    const count=new Map();
    for(const transfer of pending)count.set(transfer.txid,(count.get(transfer.txid)||0)+1);
    let credited=0;
    for(const t of pending.reverse()){
      if(count.get(t.txid)!==1){log('ambiguous_transfer','txid='+t.txid);continue;}
      if(one('SELECT 1 FROM tron_deposits WHERE txid=? AND address=?',t.txid,row.address))continue;
      if(!await solid(t.txid))continue;
      if(credit(row.user_id,row.address,t))credited++;
    }
    return credited;
  }
  async function poll(){
    if(running||!enabled()||!apiKey)return {active:false,checked:0,credited:0};
    running=true;let credited=0,checked=0;
    try{
      for(const row of all('SELECT * FROM tron_deposit_addresses ORDER BY user_id LIMIT 250')){
        if(db.prepare("SELECT value FROM treasury_settings WHERE key='address'").get()?.value===row.address){log('shared_address_conflict','Shared treasury excluded from legacy per-user watcher');continue;}
        try{credited+=await scan(row);checked++;}catch(e){lastError=String(e.message||e).slice(0,100);log('scan_error','user='+row.user_id+' '+lastError);}
      }
      lastChecked=now();return {active:true,checked,credited};
    }finally{running=false;}
  }
  function status(){return {enabled:enabled(),apiConfigured:!!apiKey,addressCount:one('SELECT COUNT(*) n FROM tron_deposit_addresses').n,credits:one('SELECT COUNT(*) n FROM tron_deposits').n,lastChecked,lastError};}
  function history(user){return all('SELECT txid,amount_micro,block_time FROM tron_deposits WHERE user_id=? ORDER BY credited DESC LIMIT 10',user);}
  function address(user){return one('SELECT address,active_from FROM tron_deposit_addresses WHERE user_id=?',user);}
  return {assign,balance,credit,poll,status,history,address,scan,solid};
}
