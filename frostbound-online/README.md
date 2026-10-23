# FROSTBOUND 온라인 서버

게임 페이지와 실시간 멀티플레이(WebSocket) 서버를 한 주소에서 함께 내주는 Node 서버입니다. 외부 패키지가 없어 `npm install` 이 필요 없습니다.

## 로컬 실행
```
node server.js            # http://localhost:8787 에서 게임, ws://localhost:8787/ws 로 접속
npm test                  # 자동 시험 (Node 22 이상)
```
브라우저 두 개(또는 일반 창 + 시크릿 창)로 http://localhost:8787 을 열어 각자 캐릭터를 만들고 같은 마을로 가면 서로 보입니다.

## Render 무료 배포
1. 이 폴더를 GitHub 저장소로 올립니다 (예: `frostbound-online`).
2. https://dashboard.render.com → **New → Blueprint** → 그 저장소 선택 → `render.yaml` 을 읽어 무료 웹 서비스 `frostbound` 를 만듭니다.
   (Blueprint 대신 **New → Web Service** 로 만들 때: Runtime `Node`, Build Command `echo no build needed`, Start Command `node server.js`, Instance Type `Free`, Health Check Path `/health`)
3. 배포가 끝나면 `https://<서비스 이름>.onrender.com` 이 생깁니다.
   - 게임: `https://<서비스 이름>.onrender.com/` (이 주소로 열면 자동으로 같은 서버에 접속)
   - 상태 확인: `https://<서비스 이름>.onrender.com/health`
4. claude.ai 아티팩트에서 이 서버로 붙이려면: 게임의 온라인 상자 → **서버** 버튼 → `<서비스 이름>.onrender.com` 입력 → 새로 고침.
   (아티팩트 페이지의 보안 정책이 외부 WebSocket 을 막으면 연결 실패로 표시됩니다. 그때는 위의 onrender.com 주소로 게임을 여세요.)

## 환경변수
| 이름 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 8787 | Render 가 자동으로 넣어 줍니다 |
| `ALLOWED_ORIGINS` | (비움 = 모두 허용) | 접속을 허용할 페이지 출처, 쉼표로 구분 (예: `https://frostbound.onrender.com`) |
| `MAX_CONN` | 300 | 동시 연결 상한 |
| `ROOM_CAP` | 60 | 룸(구역) 하나의 인원 상한 |

비밀키·API 키는 쓰지 않습니다.

## 프로토콜 (JSON 텍스트)
클라이언트→서버: `hello{nm,lv,race,cls,lk,resume?}` · `join{room,x,y}` · `st{x,y,f,mv,ps,lv,lk?}` · `chat{m}` · `emote{k}` · `ping{ts}` · `act` (아직 미구현 → `not_implemented`)
서버→클라이언트: `welcome{id,resume,online}` · `room{room,players}` · `pjoin{p}` · `pleave{id,why}` · `pst{id,…}` · `chat{id,nm,m,z}` · `emote{id,k}` · `fix{x,y}` · `pong` · `err{code,msg}`

## 무료 플랜 제한 (Render 문서 기준)
- 15분 동안 HTTP 요청·WebSocket 메시지가 없으면 잠들고, 다음 접속 때 깨어나는 데 약 1분 걸립니다 (게임은 "서버 깨우는 중"으로 표시).
- 워크스페이스당 월 750 무료 인스턴스 시간, 잠든 동안은 차감되지 않습니다.
- Render 가 언제든 재시작할 수 있고, 디스크는 남지 않습니다 (이 서버는 상태를 메모리에만 두므로 상관없음).
- 아웃바운드 트래픽은 워크스페이스 포함량에서 차감, 결제수단이 없으면 초과 시 그 달 동안 정지됩니다.
