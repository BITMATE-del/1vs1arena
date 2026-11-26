export const OFFICIAL_GAMES=['🎲','🏀','⚽','🎯','🎳','🎰'];
export function summarizeReadiness(input){
 const checks=[
  {id:'server',label:'운영 웹서버',ok:Boolean(input.serverOnline),kind:'service',detail:input.serverOnline?'서버 프로세스 정상':'서버 상태 확인 필요'},
  {id:'telegram',label:'게임봇 웹훅',ok:Boolean(input.webhookReady),kind:'service',detail:input.webhookReady?'텔레그램 웹훅 연결 완료':'텔레그램 웹훅 연결 확인 필요'},
  {id:'games',label:'게임 6종 활성화',ok:input.enabledGames===OFFICIAL_GAMES.length,kind:'free',detail:input.enabledGames+'/'+OFFICIAL_GAMES.length+'종 활성화'},
  {id:'matches',label:'무료 대전 신청',ok:input.matchesEnabled===true,kind:'free',detail:input.matchesEnabled?'신규 대전 허용':'신규 대전 중단'},
  {id:'rooms',label:'텔레그램 대전방 생성 계정',ok:input.roomAccountConnected===true,kind:'free',detail:input.roomAccountConnected?'그룹 생성 계정 연결됨':'텔레그램 사용자 계정 세션 연결 필요'},
  {id:'admin',label:'입출금 알림 수신 관리자',ok:input.adminRecipients>0,kind:'operations',detail:input.adminRecipients+'명 등록'},
  {id:'tron',label:'TronGrid API',ok:Boolean(input.tronKey),kind:'finance',detail:input.tronKey?'API 키 등록됨':'API 키 미등록'},
  {id:'treasury',label:'공용 USDT 입금주소',ok:Boolean(input.treasuryAddress),kind:'finance',detail:input.treasuryAddress?'고정 주소 등록됨':'공용 입금주소 미등록'},
  {id:'deposits',label:'공용 USDT 자동 입금',ok:input.sharedDepositsEnabled===true&&Boolean(input.tronKey)&&Boolean(input.treasuryAddress),kind:'finance',detail:input.sharedDepositsEnabled&&input.tronKey&&input.treasuryAddress?'설정 활성 · 실거래 검증 별도':'미활성 · 주소/API 키/환경변수 확인'},
  {id:'withdrawals',label:'USDT 자동 출금 송금',ok:false,kind:'finance',detail:'송금 서명·검증 기능 미연동, 신청/보류만 가능'},
  {id:'settlement',label:'USDT 참가금·승리금 실제 정산',ok:false,kind:'finance',detail:'3% 수수료 계산·판정 감사만 활성, 실제 금전 이동 차단'}
 ];
 return {checks,freeReady:checks.filter(x=>x.kind==='free').every(x=>x.ok)&&checks.find(x=>x.id==='telegram').ok,allReady:checks.every(x=>x.ok)};
}
