import os, json, sqlite3, urllib.request, time, logging
from contextlib import contextmanager
GAMES={'🎲':6,'🏀':5,'⚽':5,'🎯':6,'🎳':6,'🎰':64}
TOKEN=os.getenv('BOT_TOKEN','')
DB=os.getenv('DB_PATH','arena.db')
@contextmanager
def db():
    c=sqlite3.connect(DB, timeout=15); c.row_factory=sqlite3.Row
    try:
        c.execute('BEGIN IMMEDIATE'); yield c; c.commit()
    except Exception: c.rollback(); raise
    finally: c.close()
def init():
    with db() as c:
        c.execute('CREATE TABLE IF NOT EXISTS matches(id INTEGER PRIMARY KEY, chat INTEGER NOT NULL, owner INTEGER NOT NULL, guest INTEGER, game TEXT NOT NULL, mode TEXT NOT NULL, rounds INTEGER NOT NULL, state TEXT NOT NULL DEFAULT "waiting", turn INTEGER, round INTEGER NOT NULL DEFAULT 1, a INTEGER NOT NULL DEFAULT 0, b INTEGER NOT NULL DEFAULT 0)')
        c.execute('CREATE TABLE IF NOT EXISTS rolls(chat INTEGER, message INTEGER, match INTEGER, round INTEGER, player INTEGER, value INTEGER, PRIMARY KEY(chat,message), UNIQUE(match,round,player))')
def api(method, **kw):
    req=urllib.request.Request('https://api.telegram.org/bot'+TOKEN+'/'+method, data=json.dumps(kw).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=45) as r: result=json.load(r)
    if not result['ok']: raise RuntimeError('Telegram API error')
    return result['result']
def send(chat,text,buttons=None):
    kw={'chat_id':chat,'text':text}
    if buttons: kw['reply_markup']={'inline_keyboard':buttons}
    return api('sendMessage',**kw)
def button(text,data): return {'text':text,'callback_data':data}
def create(chat,user,game,mode,rounds):
    if game not in GAMES or mode not in ('wins','total','round') or rounds not in (1,3,5,7,9): raise ValueError('경기 조건 오류')
    with db() as c:
        return c.execute('INSERT INTO matches(chat,owner,game,mode,rounds) VALUES(?,?,?,?,?)',(chat,user,game,mode,rounds)).lastrowid
def action(chat,user,mid,op):
    with db() as c:
        m=c.execute('SELECT * FROM matches WHERE id=? AND chat=?',(mid,chat)).fetchone()
        if not m: return '존재하지 않는 경기입니다.'
        if op=='join' and m['state']=='waiting' and user!=m['owner']:
            c.execute('UPDATE matches SET guest=?,state="requested" WHERE id=?',(user,mid)); return '신청 완료. 개설자 수락 대기 중입니다.'
        if op=='accept' and m['state']=='requested' and user==m['owner']:
            busy=c.execute('SELECT 1 FROM matches WHERE chat=? AND state="active" AND (owner IN (?,?) OR guest IN (?,?))',(chat,user,m['guest'],user,m['guest'])).fetchone()
            if busy: return '참가자가 다른 경기 진행 중입니다.'
            c.execute('UPDATE matches SET state="active",turn=owner WHERE id=?',(mid,)); return f'경기 시작! 개설자부터 {m["game"]} 이모지를 단독 전송하세요. (참가자 ID {user})'
        if op=='reject' and m['state']=='requested' and user==m['owner']:
            c.execute('UPDATE matches SET guest=NULL,state="waiting" WHERE id=?',(mid,)); return '신청 거절. 다시 대기 중입니다.'
        if op=='cancel' and m['state'] in ('waiting','requested') and user==m['owner']:
            c.execute('UPDATE matches SET state="cancelled" WHERE id=?',(mid,)); return '매치 취소 완료.'
        return '현재 상태 또는 권한으로 실행할 수 없습니다.'
def roll(chat,user,message,game,value):
    if game not in GAMES or not 1<=value<=GAMES[game]: return None
    with db() as c:
        if c.execute('SELECT 1 FROM rolls WHERE chat=? AND message=?',(chat,message)).fetchone(): return None
        m=c.execute('SELECT * FROM matches WHERE chat=? AND state="active" AND turn=? AND game=?',(chat,user,game)).fetchone()
        if not m: return None
        mid,r=m['id'],m['round']; c.execute('INSERT INTO rolls VALUES(?,?,?,?,?,?)',(chat,message,mid,r,user,value))
        if user==m['owner']:
            c.execute('UPDATE matches SET turn=guest WHERE id=?',(mid,)); return f'{r}라운드 개설자: {value}점. 상대방 차례입니다. (ID {m["guest"]})'
        av=c.execute('SELECT value FROM rolls WHERE match=? AND round=? AND player=?',(mid,r,m['owner'])).fetchone()[0]
        a,b=m['a'],m['b']; mode=m['mode']
        if mode=='total': a+=av; b+=value
        else: a+=int(av>value); b+=int(value>av)
        done=r>=m['rounds'] or (mode=='wins' and max(a,b)>=m['rounds']//2+1)
        c.execute('UPDATE matches SET a=?,b=?,state=?,round=?,turn=? WHERE id=?',(a,b,'finished' if done else 'active',r if done else r+1,None if done else m['owner'],mid))
        outcome='무승부' if a==b else ('개설자 승리' if a>b else '신청자 승리')
        return f'{r}라운드: {av} : {value}\n누적 {a} : {b}\n'+(f'경기 종료 — {outcome}' if done else '다음 라운드: 개설자 차례')
def lobby(chat):
    with db() as c: rows=c.execute('SELECT * FROM matches WHERE chat=? AND state="waiting" ORDER BY id DESC LIMIT 20',(chat,)).fetchall()
    if not rows: send(chat,'대기 중인 매치가 없습니다. /create 로 개설하세요.'); return
    for m in rows:
        send(chat,f'#{m["id"]} {m["game"]} | {m["rounds"]}판 | '+{'wins':'선승제','total':'점수 합산','round':'매판 승패'}[m['mode']]+' | 무료 이벤트',[[button('매치 신청',f'join:{m["id"]}'),button('취소',f'cancel:{m["id"]}')]])
def handle(update):
    if 'callback_query' in update:
        q=update['callback_query']; chat=q['message']['chat']['id']; user=q['from']['id']; parts=q['data'].split(':')
        api('answerCallbackQuery',callback_query_id=q['id'])
        if parts[0]=='game' and len(parts)==2 and parts[1] in GAMES:
            send(chat,'경기 방식 선택',[[button(t,f'mode:{parts[1]}:{k}')] for k,t in [('wins','선승제'),('total','점수 합산'),('round','매판 승패')]]); return
        if parts[0]=='mode' and len(parts)==3:
            send(chat,'경기 횟수 선택',[[button(f'{n}판',f'new:{parts[1]}:{parts[2]}:{n}') for n in (1,3,5,7,9)]]); return
        if parts[0]=='new' and len(parts)==4:
            mid=create(chat,user,parts[1],parts[2],int(parts[3])); send(chat,f'#{mid} 매치 개설 완료',[[button('매치 신청',f'join:{mid}'),button('취소',f'cancel:{mid}')]]); return
        if len(parts)==2 and parts[0] in ('join','accept','reject','cancel'):
            mid=int(parts[1]); msg=action(chat,user,mid,parts[0]); send(chat,msg,[[button('수락',f'accept:{mid}'),button('거절',f'reject:{mid}')]] if msg.startswith('신청 완료') else None); return
    m=update.get('message',{}); chat=m.get('chat',{}); user=m.get('from',{}).get('id')
    if not user or chat.get('type') not in ('group','supergroup'): return
    cid=chat['id']; t=m.get('text','').split('@')[0]
    if t=='/start' or t=='/help': send(cid,'아레나 무료 대전\n/create 매치 개설\n/lobby 대기실\n공식 이모지 게임으로 대전합니다.'); return
    if t=='/create': send(cid,'게임 선택',[[button(g,f'game:{g}') for g in GAMES]]); return
    if t=='/lobby': lobby(cid); return
    if 'dice' in m and not m.get('forward_origin') and not m.get('via_bot'):
        d=m['dice']; result=roll(cid,user,m['message_id'],d['emoji'],d['value']);
        if result: send(cid,result)
def main():
    if not TOKEN: raise SystemExit('BOT_TOKEN 환경변수를 설정하세요.')
    init(); offset=0
    while True:
        try:
            for u in api('getUpdates',offset=offset,timeout=25,allowed_updates=['message','callback_query']):
                try: handle(u)
                except Exception as e: logging.error('업데이트 처리 오류: %s',type(e).__name__)
                offset=u['update_id']+1
        except Exception as e: logging.error('연결 오류: %s',type(e).__name__); time.sleep(3)
if __name__=='__main__': main()
