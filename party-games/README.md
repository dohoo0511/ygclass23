# 🎲 친구랑 파티 게임

방 코드 하나로 친구들과 바로 같이 하는 실시간 미니 게임 모음입니다.
Cloudflare Workers + Durable Objects 로 돌아가고, 설치·가입이 없습니다.

## 들어 있는 게임

| 게임 | 인원 | 한 줄 설명 |
|---|---|---|
| 🤥 라이어 게임 | 3~8명 | 나만 모르는 제시어! 힌트로 라이어를 찾아라 |
| 👀 눈치 게임 | 3~8명 | 1부터 아무나 외치기. 겹치거나 마지막이면 탈락 |
| ⚡ 반응속도 대결 | 2~8명 | 초록불이 켜지면 가장 빨리 터치 (5판) |
| ✌️ 가위바위보 서바이벌 | 2~8명 | 모두 동시에 내고, 진 쪽은 탈락 |
| 🍦 베스킨라빈스 31 | 2~8명 | 숫자 1~3개씩 이어 말하기, 31을 말하면 패배 |
| 💣 업다운 폭탄 | 2~8명 | 1~100 속 폭탄 숫자를 피해 범위 좁히기 |
| ⚫ 오목 | 2명 | 다섯 알을 먼저 잇는 사람이 승리 |

## 노는 방법

1. 한 사람이 이름을 쓰고 **새 방 만들기** → 4자리 방 코드가 나옵니다.
2. **🔗 초대 링크**를 친구에게 보내거나, 친구가 방 코드를 직접 입력해 들어옵니다.
3. 방장(👑)이 게임을 고르고 **인원 선택**에서 참가할 자리 수를 정합니다.
   - 자리보다 늦게 들어온 사람은 자동으로 관전, 자리가 생기면 먼저 온 순서대로 앉습니다.
   - 누구나 **관전하기 / 참가하기**로 이번 판에 빠지거나 들어갈 수 있어요.
4. **게임 시작**. 끝나면 방장이 **한 번 더** 또는 **다른 게임**을 고릅니다.
   이긴 횟수(🏆)는 방이 살아 있는 동안 쌓입니다.

새로고침하거나 잠깐 끊겨도 20초 안에 돌아오면 같은 자리로 다시 들어갑니다.
방장이 나가면 다음 사람이 방장이 됩니다. 한 방에는 관전자 포함 12명까지 들어올 수 있어요.

## Cloudflare 에 올리기

학급 사이트(Cloudflare Pages)와는 **별개의 Worker** 로 올립니다. 학급 사이트에는 영향이 없습니다.

### 방법 A — 대시보드에서 저장소 연결 (추천)

1. Cloudflare → **Workers & Pages** → **Create** → **Import a repository**
2. 이 저장소를 고르고, 아래처럼 설정합니다.

   | 항목 | 값 |
   |---|---|
   | Project name | `party-games` (아무거나) |
   | **Root directory** (Advanced settings) | `party-games` ← **꼭 이 폴더** |
   | Build command | 비워 두기 |
   | Deploy command | `npx wrangler deploy` |

3. **Deploy** 를 누르면 `https://party-games.<내 계정>.workers.dev` 주소가 생깁니다.
   이후 저장소에 push 하면 자동으로 다시 배포됩니다.

### 방법 B — 내 컴퓨터에서 명령어로

```bash
cd party-games
npm install
npx wrangler login
npx wrangler deploy
```

### 비용

무료 요금제로 충분합니다. 방 하나가 Durable Object 하나이고(SQLite 기반이라 무료 요금제에서 사용 가능),
아무도 없는 방은 저절로 사라집니다. 친구끼리 노는 정도로는 무료 한도(하루 요청 10만 회 등)에 닿기 어렵습니다.

## 내 컴퓨터에서 해 보기

```bash
cd party-games
npm install
npm run dev     # http://localhost:8787 — 창을 여러 개 열어 혼자서도 시험할 수 있어요
npm test        # 게임 규칙·방 규칙 테스트
```

## 폴더 구조

```
party-games/
├─ wrangler.jsonc        Worker 설정 (Durable Object 바인딩 ROOMS)
├─ src/
│  ├─ index.js           주소 나누기 + Room(Durable Object) — 방 하나 = 객체 하나
│  ├─ room-core.js       방 규칙: 입장·방장·자리(인원)·관전·채팅·게임 진행
│  └─ games/             게임마다 파일 하나 (서버가 모든 판정을 함)
├─ public/               화면 (index.html, app.js, games.js, style.css)
└─ test/                 node --test 로 도는 테스트
```

## 게임 하나 더 넣기

1. `src/games/새게임.js` 에 아래 모양으로 만듭니다.
   ```js
   export default {
     id, name, emoji, min, max, short, rules: [...],
     setup(players, ctx) { return state },          // players: [{id, name}]
     action(state, pid, a, ctx) { /* 틀리면 오류 문장을 return */ },
     timer(state, key, ctx) {},                      // ctx.schedule(ms, key) 로 건 타이머
     view(state, pid, ctx) { return 그 사람에게 보여 줄 것 },  // 비밀은 여기서 걸러 낸다
   };
   ```
   끝나면 `state.over = { winners: [...], losers: [...], text }` 를 넣습니다.
2. `src/games/index.js` 의 `GAME_LIST` 에 추가합니다.
3. `public/games.js` 의 `RENDER` 에 같은 `id` 로 화면 그리는 함수를 추가합니다.
