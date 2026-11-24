import os, json, sqlite3, urllib.request, urllib.error, time, logging
from contextlib import contextmanager
GAMES={'🎲':6,'🏀':5,'⚽':5,'🎯':6,'🎳':6,'🎰':64}
TOKEN=os.getenv('BOT_TOKEN','').strip()
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
    req=urllib.request.Request('https://api.telegram.org/bot'+TOKEN+'/'+method, data=json.dumps(kw).encode(),headers={'Content-Type':'application/json','Accept':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=45) as r: result=json.load(r)
    except urllib.error.HTTPError as e:
        logging.warning('Telegram method %s returned HTTP %s',method,e.code)
        raise
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
def menu(chat):
    return api('sendMessage',chat_id=chat,text='⚔ VALHALLA | 발할라\n최강자에게 허락된 전장\n아래 메뉴에서 원하는 기능을 선택하세요.\n무료 이벤트 대전',reply_markup={'keyboard':[['⚔ 매치 개설','🏛 매치 대기실'],['📖 이용 안내','🏠 메인 메뉴']],'resize_keyboard':True,'is_persistent':True})
def choose_game(chat):
    send(chat,'게임을 선택하세요.',[[button(g+' '+name,f'game:{g}')] for g,name in [('🎲','다이스'),('🏀','농구'),('⚽','축구'),('🎯','다트'),('🎳','볼링'),('🎰','슬롯')]]+[[button('메인 메뉴','menu')]])
def handle(update):
    if 'callback_query' in update:
        q=update['callback_query']; chat=q['message']['chat']['id']; user=q['from']['id']; parts=q['data'].split(':')
        api('answerCallbackQuery',callback_query_id=q['id'])
        if parts[0]=='menu': menu(chat); return
        if q['message']['chat']['type'] not in ('group','supergroup'): send(chat,'그룹에 봇을 추가한 후 대전을 시작할 수 있습니다.'); return
        if parts[0]=='game' and len(parts)==2 and parts[1] in GAMES:
            send(chat,'경기 방식 선택',[[button(t,f'mode:{parts[1]}:{k}')] for k,t in [('wins','선승제'),('total','점수 합산'),('round','매판 승패')]]); return
        if parts[0]=='mode' and len(parts)==3:
            send(chat,'경기 횟수 선택',[[button(f'{n}판',f'new:{parts[1]}:{parts[2]}:{n}') for n in (1,3,5,7,9)]]); return
        if parts[0]=='new' and len(parts)==4:
            mid=create(chat,user,parts[1],parts[2],int(parts[3])); send(chat,f'#{mid} 매치 개설 완료',[[button('매치 신청',f'join:{mid}'),button('취소',f'cancel:{mid}')]]); return
        if len(parts)==2 and parts[0] in ('join','accept','reject','cancel'):
            mid=int(parts[1]); msg=action(chat,user,mid,parts[0]); send(chat,msg,[[button('수락',f'accept:{mid}'),button('거절',f'reject:{mid}')]] if msg.startswith('신청 완료') else None); return
    m=update.get('message',{}); chat=m.get('chat',{}); user=m.get('from',{}).get('id')
    if not user or chat.get('type') not in ('group','supergroup','private'): return
    cid=chat['id']; t=m.get('text','').split('@')[0]
    if t in ('/start','/help','🏠 메인 메뉴'): menu(cid); return
    if t=='📖 이용 안내':
        send(cid,'1. 그룹에 발할라 봇을 추가하세요.\n2. 매치 개설 버튼에서 게임과 조건을 선택하세요.\n3. 상대가 매치 신청하면 개설자가 수락하세요.\n4. 차례에 맞춰 해당 이모지를 단독 전송하세요.\n모든 대전은 무료입니다.'); return
    if t in ('/create','⚔ 매치 개설','/lobby','🏛 매치 대기실'):
        if chat['type']=='private':
            api('sendMessage',chat_id=cid,text='대전은 텔레그램 그룹에서 진행합니다. 아래 버튼으로 봇을 그룹에 추가하세요.',reply_markup={'inline_keyboard':[[{'text':'그룹에 발할라 추가','url':'https://t.me/ValhallaBattle_bot?startgroup=true'}]]}); return
        if t in ('/create','⚔ 매치 개설'): choose_game(cid)
        else: lobby(cid)
        return
    if m.get('new_chat_members'):
        if any(x.get('username','').lower()=='valhallabattle_bot' for x in m['new_chat_members']): menu(cid)
        return
    if chat['type']=='private': return
    if 'dice' in m and not m.get('forward_origin') and not m.get('via_bot'):
        d=m['dice']; result=roll(cid,user,m['message_id'],d['emoji'],d['value']);
        if result: send(cid,result)
def main():
    if not TOKEN: raise SystemExit('BOT_TOKEN 환경변수를 설정하세요.')
    init(); offset=0
    logging.basicConfig(level=logging.INFO)
    def retry_delay(e):
        try:
            raw=e.read(8192)
            content_type=e.headers.get('Content-Type','').split(';')[0]
            try:
                payload=json.loads(raw.decode())
                retry=payload.get('parameters',{}).get('retry_after')
                logging.warning('Rate-limit response: Telegram JSON=%s; API error_code=%s; retry_after=%s', isinstance(payload,dict) and payload.get('ok') is False, payload.get('error_code'), retry)
            except (ValueError, AttributeError):
                retry=None
                logging.warning('Rate-limit response is not Bot API JSON; content type=%s', content_type)
            header=e.headers.get('Retry-After','')
            header_delay=int(header) if header.isdigit() else 0
            return max(120,int(retry or 0)+5,header_delay+5)
        except Exception:
            return 120
    while True:
        try:
            identity=api('getMe')
            logging.info('Telegram bot identity: @%s',identity.get('username'))
            if identity.get('username','').lower()!='valhallabattle_bot':
                logging.error('BOT_TOKEN belongs to a different bot')
                time.sleep(300)
                continue
            info=api('getWebhookInfo')
            if info.get('url'):
                api('deleteWebhook',drop_pending_updates=False)
            logging.info('Telegram polling ready')
            break
        except urllib.error.HTTPError as e:
            delay=retry_delay(e) if e.code==429 else 120
            logging.warning('Telegram initialization HTTP %s; retry in %s seconds',e.code,delay)
            time.sleep(delay)
        except Exception as e:
            logging.warning('Telegram initialization error: %s',type(e).__name__)
            time.sleep(60)
    while True:
        try:
            for u in api('getUpdates',offset=offset,timeout=25,allowed_updates=['message','callback_query']):
                try: handle(u)
                except Exception as e: logging.error('업데이트 처리 오류: %s',type(e).__name__)
                offset=u['update_id']+1
        except urllib.error.HTTPError as e:
            delay=retry_delay(e) if e.code==429 else 60
            logging.warning('Telegram polling HTTP %s; retry in %s seconds',e.code,delay)
            time.sleep(delay)
        except Exception as e: logging.error('연결 오류: %s',type(e).__name__); time.sleep(3)
if __name__=='__main__': main()
