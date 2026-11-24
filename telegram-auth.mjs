import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

export function createTelegramAuth(db, secret, adminPassword) {
  const apiId=Number(process.env.TELEGRAM_API_ID), apiHash=process.env.TELEGRAM_API_HASH||'';
  const creds={apiId, apiHash};
  const configured=Number.isSafeInteger(apiId)&&apiId>0&&/^[a-fA-F0-9]{32}$/.test(apiHash.trim());
  const key=createHash('sha256').update(secret+':telegram-session:'+adminPassword).digest();
  db.exec("CREATE TABLE IF NOT EXISTS telegram_account_session(id INTEGER PRIMARY KEY CHECK(id=1), encrypted TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, username TEXT NOT NULL, saved_at INTEGER NOT NULL)");
  let pending=null;
  let lastError='';
  function seal(raw){const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(raw,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
  function unseal(raw){const bytes=Buffer.from(raw,'base64');if(bytes.length<30)throw Error('Session invalid');const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString();}
  function current(){return db.prepare('SELECT * FROM telegram_account_session WHERE id=1').get();}
  function info(){const row=current();return {configured,connected:!!row,id:row?.user_id||'',name:row?.name||'',username:row?.username||'',savedAt:row?.saved_at||null,stage:pending?.stage||'',lastError};}
  async function closePending(){if(pending?.client)await pending.client.disconnect().catch(()=>{});pending=null;}
  async function clientWith(session){const c=new TelegramClient(new StringSession(session),apiId,apiHash,{connectionRetries:2,requestRetries:1,autoReconnect:false});c.setLogLevel('none');await c.connect();return c;}
  async function persist(client){if(!(await client.checkAuthorization()))throw Error('UNAUTHORIZED');const me=await client.getMe();if(!me||me.bot)throw Error('USER_REQUIRED');const session=client.session.save();if(!session||session.length>20000)throw Error('SESSION_INVALID');const name=[me.firstName,me.lastName].filter(Boolean).join(' ').slice(0,100), username=String(me.username||'').slice(0,100);
  db.prepare('INSERT INTO telegram_account_session(id,encrypted,user_id,name,username,saved_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted,user_id=excluded.user_id,name=excluded.name,username=excluded.username,saved_at=excluded.saved_at').run(seal(session),String(me.id),name,username,Date.now());lastError='';return info();}
  async function start(phone){if(!configured)throw Error('API_MISSING');phone=String(phone).replace(/[\s()-]/g,'');if(/^010\d{8}$/.test(phone))phone='+82'+phone.slice(1);else if(/^82\d{9,10}$/.test(phone))phone='+'+phone;if(!/^\+[1-9]\d{7,14}$/.test(phone))throw Error('PHONE_INVALID');await closePending();const client=await clientWith('');try{const result=await client.sendCode(creds,phone);pending={client,phone,hash:result.phoneCodeHash,stage:'code',expires:Date.now()+5*60*1000,tries:0};lastError='';return info();}catch(e){await client.disconnect().catch(()=>{});throw e;}}
  function active(stage){if(!pending||pending.stage!==stage||Date.now()>pending.expires)throw Error('LOGIN_EXPIRED');if(++pending.tries>5)throw Error('TOO_MANY_ATTEMPTS');return pending;}
  async function code(value){if(!/^\d{4,8}$/.test(value))throw Error('CODE_INVALID');const p=active('code');try{await p.client.invoke(new Api.auth.SignIn({phoneNumber:p.phone,phoneCodeHash:p.hash,phoneCode:value}));await persist(p.client);await closePending();return info();}catch(e){if(String(e.errorMessage||e.message||'').includes('SESSION_PASSWORD_NEEDED')){p.stage='password';p.tries=0;return info();}throw e;}}
  async function password(value){if(!value||value.length>256)throw Error('PASSWORD_INVALID');const p=active('password');await p.client.signInWithPassword(creds,{password:async()=>value,onError:async e=>{throw e;}});await persist(p.client);await closePending();return info();}
  async function registerSession(value){if(!configured)throw Error('API_MISSING');if(!value||value.length>20000||!/^1[A-Za-z0-9_-]{40,}$/.test(value.trim()))throw Error('SESSION_INVALID');const client=await clientWith(value.trim());try{await persist(client);await closePending();return info();}finally{await client.disconnect().catch(()=>{});}}
  async function verify(){const row=current();if(!row)throw Error('NOT_CONNECTED');if(!configured)throw Error('API_MISSING');const client=await clientWith(unseal(row.encrypted));try{const data=await persist(client);return data;}finally{await client.disconnect().catch(()=>{});}}
  async function disconnect(){await closePending();db.prepare('DELETE FROM telegram_account_session WHERE id=1').run();lastError='';return info();}
  async function cancel(){await closePending();return info();}
  function error(e){
    const msg=String(e?.errorMessage||e?.message||'');
    const codes=[
      'PHONE_INVALID','PHONE_NUMBER_INVALID','PHONE_NUMBER_BANNED','PHONE_NUMBER_FLOOD',
      'PHONE_CODE_INVALID','PHONE_CODE_EXPIRED','PHONE_CODE_HASH_INVALID',
      'PASSWORD_HASH_INVALID','SESSION_PASSWORD_NEEDED','LOGIN_EXPIRED',
      'API_MISSING','API_ID_INVALID','API_ID_PUBLISHED_FLOOD','AUTH_RESTART',
      'SESSION_INVALID','USER_REQUIRED','UNAUTHORIZED','NOT_CONNECTED',
      'TOO_MANY_ATTEMPTS','PASSWORD_INVALID','CODE_INVALID',
      'PHONE_PASSWORD_FLOOD','SEND_CODE_UNAVAILABLE'
    ];
    const kind=codes.find(x=>msg.includes(x))||
      (/FLOOD_WAIT/i.test(msg)?'FLOOD_WAIT':
      /timeout|timed out|ECONN|ETIMEDOUT|ENETUNREACH|connection/i.test(msg)?'NETWORK_ERROR':
      /Invalid api|api hash|API hash|must be.*api/i.test(msg)?'API_ID_INVALID':
      'TELEGRAM_ERROR');
    lastError=kind;
    // A sanitized technical diagnostic — never log authentication codes, passwords,
    // phone numbers, saved sessions, or full exception objects.
    const safeName=String(e?.name||'Unknown').replace(/[^a-zA-Z0-9_]/g,'').slice(0,50);
    const safeCode=String(e?.code||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,20);
    const technical=msg.replace(/\+?\d{8,}/g,'[redacted]').replace(/[A-Fa-f0-9]{32,}/g,'[redacted]').replace(/[^a-zA-Z0-9 :._()[\]-]/g,'').slice(0,120);
    console.warn('Telegram authentication error',{kind,name:safeName,code:safeCode,detail:technical});
    return kind;
  }
  return {info,start,code,password,registerSession,verify,disconnect,cancel,error};
}
