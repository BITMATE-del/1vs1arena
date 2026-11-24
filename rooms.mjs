import { randomBytes } from 'node:crypto';
import { Api } from 'telegram';
export function createRoomService(db,telegramAuth,botUsername,send){
  db.exec("CREATE TABLE IF NOT EXISTS generated_rooms(code TEXT PRIMARY KEY, owner INTEGER NOT NULL, chat INTEGER UNIQUE, title TEXT, link TEXT, status TEXT NOT NULL, error TEXT, created INTEGER NOT NULL)");
  const one=(q,...p)=>db.prepare(q).get(...p);
  const run=(q,...p)=>db.prepare(q).run(...p);
  let busy=false,allowed=0;
  function request(owner){
    if(!telegramAuth.info().connected){send(owner,'전용 그룹 생성 계정을 관리자에서 먼저 연결해 주세요.');return;}
    const old=one("SELECT * FROM generated_rooms WHERE owner=? AND status IN ('queued','creating','ready') ORDER BY created DESC LIMIT 1",owner);
    if(old){send(owner,old.status==='ready'?'이미 생성된 대전방: '+old.code:'대전방 생성 요청 처리 중: '+old.code,old.status==='ready'&&old.link?[[{text:'내 그룹 입장',url:old.link}]]:undefined);return;}
    const code='GA-'+randomBytes(4).toString('hex').toUpperCase();
    run("INSERT INTO generated_rooms(code,owner,status,created) VALUES(?,?,'queued',?)",code,owner,Date.now());
    send(owner,'⚔️ '+code+' 비공개 대전방 생성 요청 접수. 생성이 완료되면 입장 링크를 보내드립니다.');
    void work();
  }
  async function work(){
    if(busy||Date.now()<allowed)return;
    const job=one("SELECT * FROM generated_rooms WHERE status='queued' ORDER BY created LIMIT 1");
    if(!job)return;busy=true;allowed=Date.now()+10000;
    run("UPDATE generated_rooms SET status='creating' WHERE code=?",job.code);
    let chat=null;
    try{
      await telegramAuth.withClient(async c=>{
        const result=await c.invoke(new Api.channels.CreateChannel({title:'GLORY ARENA '+job.code,about:'GLORY ARENA 무료 대전 · '+job.code,megagroup:true}));
        const channel=result.chats?.find(x=>x.megagroup);
        if(!channel)throw Error('GROUP_CREATE_FAILED');
        chat=Number('-100'+String(channel.id));
        if(!Number.isSafeInteger(chat))throw Error('GROUP_ID_INVALID');
        run("UPDATE generated_rooms SET chat=?,title=? WHERE code=?",chat,'GLORY ARENA '+job.code,job.code);
        const peer=await c.getInputEntity(channel);
        const bot=await c.getInputEntity('@'+botUsername);
        await c.invoke(new Api.channels.EditAdmin({channel:peer,userId:bot,adminRights:new Api.ChatAdminRights({deleteMessages:true,banUsers:true,inviteUsers:true,pinMessages:true,other:true}),rank:'Arena'}));
        const invitation=await c.invoke(new Api.messages.ExportChatInvite({peer,expireDate:Math.floor(Date.now()/1000)+86400,usageLimit:1,title:job.code+' creator'}));
        if(!/^https:\/\/t\.me\//.test(invitation.link||''))throw Error('INVITE_FAILED');
        run("UPDATE generated_rooms SET status='ready',link=? WHERE code=?",invitation.link,job.code);
        send(job.owner,'✅ 전용 그룹 '+job.code+' 생성 완료! 입장 후 그룹에서 /create로 게임을 설정하세요.',[[{text:'내 그룹 입장',url:invitation.link}]]);
        send(chat,'⚜️ GLORY ARENA '+job.code+'\n생성자가 입장한 뒤 /create로 경기 설정을 진행합니다.');
      });
    }catch(e){
      const reason=String(e?.errorMessage||e?.message||'TELEGRAM_FAILED').replace(/\+?\d{8,}/g,'[redacted]').slice(0,90);
      run("UPDATE generated_rooms SET status='failed',error=? WHERE code=?",reason,job.code);
      send(job.owner,'대전방 생성 실패: '+job.code+' · 관리자에게 문의해 주세요.');
      console.warn('Room creation failed',{code:job.code,reason,created:!!chat});
    }finally{busy=false;}
  }
  return {request,work};
}
