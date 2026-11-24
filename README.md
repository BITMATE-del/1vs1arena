# 아레나 무료 대전 MVP
Python 3.11 이상, 외부 패키지 없음. 텔레그램 그룹용 봇이며 미니앱은 포함하지 않습니다.
BotFather에서 봇 생성 후 /setprivacy Disable 설정. BOT_TOKEN 환경변수 설정 후 python arena.py 실행. /create 또는 /lobby 입력. 슬롯은 원시 숫자 비교이며 실제 슬롯 조합 판정은 미구현입니다.
테스트: python -m unittest -v. Railway Dockerfile 배포, /data 영구 볼륨, DB_PATH=/data/arena.db, 단일 인스턴스.
실제 Telegram 연동 미검증. 미니앱, 관리자 페이지, 타임아웃 및 복구, 랭킹, 공개 검증용 원장, 포인트 지갑, 실물 결제/USDT 기능은 포함하지 않습니다. 무료 경기만 지원합니다.
