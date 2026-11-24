// Persistent turn watchdog. Does not alter finished or historical matches.
// A missing watch record is armed from the current time (safe for upgrades).
export function createMatchWatch(db,send,options={}) {
  db.exec("CREATE TABLE IF NOT EXISTS match_turn_watch(match_id INTEGER PRIMARY KEY,turn_player INTEGER NOT NULL,turn_started INTEGER NOT NULL,warned_at INTEGER,alerted_at INTEGER,updated INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS arena_incidents(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,match_id INTEGER,room_code TEXT,detail TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'open',created INTEGER NOT NULL,resolved INTEGER)");
  const one=(q,...a)=>db.prepare(q).get(...a),all=(q,...a)=>db.prepare(q).all(...a),run=(q,...a)=>db.prepare(q).run(...a);
  const now=options.now||Date.now;
  const cfg=(key,defaultValue)=>Math.max(1,Math.min(1440,Number(options.getConfig?.(key)||defaultValue)||defaultValue));
  const warnMs=()=>cfg('turn_warn_minutes',3)*60000;
  const timeoutMs=()=>Math.max(warnMs()+60000,cfg('turn_timeout_minutes',20)*60000);
  const name=id=>{const u=one('SELECT name,username FROM arena_users WHERE id=?',id);return u?.username?'@'+u.username:u?.name||('참가자 '+String(id).slice(-4));};
  const roomCode=id=>one('SELECT code FROM match_requests WHERE match_id=?',id)?.code||null;
  function incident(kind,id,detail){
    const code=roomCode(id);
    const existing=one("SELECT id FROM arena_incidents WHERE kind=? AND match_id=? AND state='open' ORDER BY id DESC LIMIT 1",kind,id);
    if(existing)return existing.id;
    return Number(run('INSERT INTO arena_incidents(kind,match_id,room_code,detail,created) VALUES(?,?,?,?,?)',kind,id,code,String(detail).slice(0,300),now()).lastInsertRowid);
  }
  function arm(id){
    const m=one("SELECT * FROM matches WHERE id=? AND state='active'",id);
    if(!m||!m.turn)return false;
    run('INSERT INTO match_turn_watch(match_id,turn_player,turn_started,updated) VALUES(?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET turn_player=excluded.turn_player,turn_started=excluded.turn_started,warned_at=NULL,alerted_at=NULL,updated=excluded.updated',m.id,m.turn,now(),now());
    run("UPDATE arena_incidents SET state='resolved',resolved=? WHERE match_id=? AND kind IN ('turn_stalled','turn_timeout') AND state='open'",now(),m.id);
    return true;
  }
  function touch(id){
    const m=one('SELECT * FROM matches WHERE id=?',id);
    if(!m||m.state!=='active'){run('DELETE FROM match_turn_watch WHERE match_id=?',id);return;}
    arm(id);
  }
  function sync(){
    const rows=all("SELECT id,turn FROM matches WHERE state='active' AND turn IS NOT NULL");
    for(const m of rows){
      const prior=one('SELECT turn_player FROM match_turn_watch WHERE match_id=?',m.id);
      if(!prior||prior.turn_player!==m.turn)arm(m.id);
    }
    run("DELETE FROM match_turn_watch WHERE match_id NOT IN (SELECT id FROM matches WHERE state='active')");
    return rows.length;
  }
  function tick(){
    const active=all("SELECT m.id,m.chat,m.turn,w.turn_started,w.warned_at,w.alerted_at FROM matches m JOIN match_turn_watch w ON w.match_id=m.id WHERE m.state='active' AND m.turn=w.turn_player ORDER BY w.turn_started ASC LIMIT 100");
    const t=now();let warnings=0,expired=0;
    for(const m of active){
      const elapsed=t-m.turn_started;
      if(elapsed>=timeoutMs()){
        const applied=run('UPDATE match_turn_watch SET alerted_at=?,updated=? WHERE match_id=? AND alerted_at IS NULL AND turn_player=?',t,t,m.id,m.turn);
        if(!applied.changes)continue;
        expired++;
        incident('turn_timeout',m.id,'턴 제한시간 초과: '+name(m.turn));
        send(m.chat,'⏰ 경기 진행 제한시간이 초과되었습니다.\n'+name(m.turn)+' 님의 응답이 없어 경기를 중단합니다.\n완료된 과거 전적은 유지됩니다.');
        options.onTimeout?.(m.id);
      }else if(elapsed>=warnMs()&&!m.warned_at){
        const applied=run('UPDATE match_turn_watch SET warned_at=?,updated=? WHERE match_id=? AND warned_at IS NULL AND turn_player=?',t,t,m.id,m.turn);
        if(!applied.changes)continue;
        warnings++;
        incident('turn_stalled',m.id,'미응답: '+name(m.turn));
        send(m.chat,'⏳ '+name(m.turn)+' 님의 차례입니다.\n경기 진행이 지연되고 있습니다. 본인 계정에서 공식 게임을 전송해 주세요.\n응답이 없으면 제한시간 이후 경기가 종료됩니다.');
        if(m.turn>0)send(m.turn,'⏳ GLORY ARENA 경기 차례 안내\n현재 '+name(m.turn)+' 님 차례입니다. 경기방에서 공식 게임을 보내주세요.');
      }
    }
    return {warnings,expired};
  }
  function issueSummary(){
    return {
      active:one("SELECT COUNT(*) n FROM matches WHERE state='active'").n,
      warnings:one("SELECT COUNT(*) n FROM match_turn_watch WHERE warned_at IS NOT NULL").n,
      incidents:one("SELECT COUNT(*) n FROM arena_incidents WHERE state='open'").n,
      closeFailures:one("SELECT COUNT(*) n FROM match_continue_votes WHERE state='close_failed'").n,
      roomFailures:one("SELECT COUNT(*) n FROM generated_rooms WHERE status='close_failed'").n
    };
  }
  function resolve(id){
    return !!run("UPDATE arena_incidents SET state='resolved',resolved=? WHERE id=? AND state='open'",now(),id).changes;
  }
  return {arm,touch,sync,tick,incident,issueSummary,resolve,warnMs,timeoutMs};
}
