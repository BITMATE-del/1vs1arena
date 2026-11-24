# VALHALLA 무료 대전
Node.js 22 / 공식 Telegram Bot API Webhook / SQLite. 기존 Python 코드는 참고용으로 보존합니다.
환경변수 BOT_TOKEN, PUBLIC_URL(또는 RAILWAY_PUBLIC_DOMAIN), 선택 BOT_USERNAME, DB_PATH. /health는 HTTP 서버 및 웹훅 등록 상태를 구분해 표시합니다. 429 발생 시 retry_after를 준수하며 재시도합니다. 토큰을 로그에 출력하지 않습니다. 단일 인스턴스, 영구 볼륨 /data 권장.
무료 이벤트 대전 전용. 실물 결제 및 USDT 정산, 미니앱 및 관리자 페이지는 포함하지 않습니다. 슬롯은 원시 숫자 비교이며 실제 조합 판정은 미구현입니다.
