// Admin display helpers. Read-only: no mutation to historic scores.
export function resultForMatch(m,players={}) {
  const a=Number(m.a),b=Number(m.b);
  const owner=players.owner||String(m.owner),guest=players.guest||String(m.guest||'미정');
  if(m.state==='finished'){
    if(a===b)return {state:'종료',result:'무승부',winner:'무승부',detail:owner+' '+a+' : '+b+' '+guest,kind:'draw'};
    return {state:'종료',result:a>b?'개설자 승리':'참가자 승리',winner:a>b?owner:guest,detail:owner+' '+a+' : '+b+' '+guest,kind:'win'};
  }
  if(m.state==='cancelled')return {state:'중단',result:'승패 미확정',winner:'없음',detail:owner+' '+a+' : '+b+' '+guest,kind:'cancelled'};
  if(m.state==='active')return {state:'진행 중',result:'판정 대기',winner:'미정',detail:owner+' '+a+' : '+b+' '+guest,kind:'active'};
  return {state:m.state==='waiting'?'대기':'신청 접수',result:'미시작',winner:'미정',detail:owner+' '+a+' : '+b+' '+guest,kind:'pending'};
}
export function managedRoomStatus(row){
  // This is never an assertion that Telegram deleted a room: only closed means confirmed.
  if(row.generated_status==='closed')return {label:'종료 · 삭제 확인',kind:'closed'};
  if(row.generated_status==='close_failed')return {label:'삭제 실패 · 확인 필요',kind:'error'};
  if(row.generated_status==='closing'||row.close_state==='closing')return {label:'종료 처리 중',kind:'closing'};
  if(row.close_state==='close_failed')return {label:'삭제 실패 · 확인 필요',kind:'error'};
  if(row.open>0||row.request_status==='playing'||row.request_status==='room_ready')return {label:'대전 진행·대기',kind:'active'};
  if(row.generated_status==='finished'||row.request_status==='finished'||row.latest_match_state==='finished')return {label:'경기 종료 · 방 유지',kind:'finished'};
  if(row.generated_status==='ready')return {label:'방 사용 가능',kind:'ready'};
  if(row.request_status==='cancelled'||row.latest_match_state==='cancelled')return {label:'대전 중단 · 방 확인',kind:'cancelled'};
  return {label:row.enabled?'사용 중':'봇 중단',kind:'unknown'};
}
