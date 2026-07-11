# Phase 2: 웹 UI + 서버 엔트리

@fidelity-check tokens: handleFrame, loadHistory, npm run serve, HOST

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext) — TS 파일에 적용, HTML 내 스크립트는 브라우저 표준 JS
2. `any` 타입 사용 금지 (TS 파일)
3. 런타임 의존성 추가 금지 — UI도 프레임워크 없는 바닐라 HTML/JS/CSS
4. 미사용 변수 금지
5. HTML 내 JS는 외부 입력을 `textContent`로만 렌더 (innerHTML 금지 — XSS 방지)

## 전제 조건

Phase 0~1이 노출한 인터페이스 (그대로 복사):

```ts
// src/app/bootstrap.ts
export function createApp(env: AppEnv, overrides?: AppOverrides): Promise<App>;
// App: { session, store, docsDir, indexFile, modelName, startupNotices, rebuildIndex(createdAt): Promise<number> }

// src/server/http-server.ts
export interface ChatServerConfig { app: App; indexHtmlPath?: string; }
export function createChatServer(config: ChatServerConfig): Server;
```

서버 API 계약 (Phase 1): `GET /` HTML, `POST /api/chat` SSE(data/done/error), `GET /api/history`, `POST /api/clear`, `POST /api/index`.

## 현재 상태

`src/server/http-server.ts`와 테스트만 존재. UI 파일(`src/server/public/index.html`)과 실행 엔트리(`src/server/main.ts`), `serve` npm 스크립트가 없다. `package.json`의 `build`는 tsc만 실행 — HTML 정적 파일을 dist로 복사하지 않는다.

## Step 1: 웹 UI (`src/server/public/index.html` — create)

### Context

프레임워크 없는 단일 파일. 학습 포인트: **fetch + ReadableStream으로 SSE wire format을 직접 파싱**(`\n\n` 프레임 분리 — 청크 경계 버퍼링은 ndjson 파서와 같은 원리). 모든 동적 텍스트는 `textContent`로 삽입 — 모델 출력/에러 메시지에 HTML이 섞여도 렌더되지 않는다 (XSS 방지).

### Code
```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>chatbot-engine</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 16px; background: #111; color: #eee; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  h1 { font-size: 16px; margin: 0 0 8px; display: flex; justify-content: space-between; align-items: center; }
  h1 .actions { display: flex; gap: 6px; }
  #log { flex: 1; overflow-y: auto; border: 1px solid #333; border-radius: 8px; padding: 12px; }
  .msg { margin: 8px 0; white-space: pre-wrap; line-height: 1.5; }
  .user { color: #8ab4ff; }
  .bot { color: #eee; }
  .sys { color: #888; font-size: 12px; }
  form { display: flex; gap: 8px; margin-top: 8px; }
  input[type=text] { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid #333; background: #1a1a1a; color: #eee; }
  button { padding: 8px 12px; border-radius: 8px; border: 1px solid #444; background: #222; color: #eee; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<h1>chatbot-engine
  <span class="actions">
    <button id="reindex" type="button">재인덱싱</button>
    <button id="clear" type="button">초기화</button>
  </span>
</h1>
<div id="log"></div>
<form id="form">
  <input id="input" type="text" placeholder="메시지를 입력하세요" autocomplete="off">
  <button id="send" type="submit">전송</button>
</form>
<script>
const log = document.getElementById('log');
const form = document.getElementById('form');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const clearBtn = document.getElementById('clear');
const reindexBtn = document.getElementById('reindex');

function append(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    for (const m of data.history) {
      append(m.role === 'user' ? 'user' : 'bot', (m.role === 'user' ? '나: ' : '') + m.content);
    }
  } catch {
    append('sys', '(히스토리 로드 실패)');
  }
}

function handleFrame(frame, botEl) {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return;
  if (event === 'message') {
    botEl.textContent += JSON.parse(data).piece;
    log.scrollTop = log.scrollHeight;
  } else if (event === 'error') {
    botEl.textContent += '\n오류: ' + JSON.parse(data).error + ' — 다시 시도하세요.';
  }
}

async function send(message) {
  append('user', '나: ' + message);
  const botEl = append('bot', '');
  sendBtn.disabled = true;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
      botEl.textContent = '오류: ' + err.error;
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        handleFrame(buffer.slice(0, idx), botEl);
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf('\n\n');
      }
    }
  } catch (err) {
    botEl.textContent += '\n(연결 오류: ' + err.message + ')';
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message || sendBtn.disabled) return;
  input.value = '';
  send(message);
});

clearBtn.addEventListener('click', async () => {
  await fetch('/api/clear', { method: 'POST' });
  log.replaceChildren();
  append('sys', '(히스토리를 초기화했습니다)');
});

reindexBtn.addEventListener('click', async () => {
  reindexBtn.disabled = true;
  const notice = append('sys', '(인덱싱 중...)');
  try {
    const res = await fetch('/api/index', { method: 'POST' });
    const data = await res.json();
    notice.textContent = '(인덱스 구축 완료: ' + data.chunks + '청크)';
  } catch {
    notice.textContent = '(인덱싱 오류)';
  } finally {
    reindexBtn.disabled = false;
  }
});

loadHistory();
input.focus();
</script>
</body>
</html>
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
echo "N/A: 정적 HTML — 서빙 검증은 Step 2 이후 최종 검증에서"
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 92 passed (무영향)
# 3. 의미 검증
grep -c "innerHTML" src/server/public/index.html
  # 기대: 0 (textContent만 사용 — XSS 방지 규칙 준수)
```

### 동반 변경 (Side Effects)

정적 파일 산출 → build 시 dist 복사 스텝 필요 (Step 3 package.json에서 처리).

### Do Not Touch

`src/server/http-server.ts`.

## Step 2: 서버 엔트리 (`src/server/main.ts` — create)

### Code
```ts
import { env, exit } from 'node:process';
import { createApp } from '../app/bootstrap.js';
import { createChatServer } from './http-server.js';

async function main(): Promise<void> {
  const host = env['HOST'] ?? '127.0.0.1';
  const port = Number(env['PORT'] ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`잘못된 PORT: ${env['PORT']}`);
    exit(1);
  }

  const app = await createApp(env);
  for (const notice of app.startupNotices) {
    console.log(`(${notice})`);
  }

  const server = createChatServer({ app });
  server.listen(port, host, () => {
    console.log(
      `chatbot-engine 웹 서버 (${app.modelName}): http://${host}:${port}`,
    );
  });

  process.on('SIGINT', () => {
    server.close();
    exit(0);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  exit(1);
});
```

### Context

CLI의 main.ts와 대칭 — createApp 위의 얇은 엔트리. `HOST` 기본 127.0.0.1 (로컬 전용), 맥미니에서 LAN 노출 시 `HOST=0.0.0.0`.

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 92 passed
# 3. 의미 검증
grep -c "127.0.0.1" src/server/main.ts
  # 기대: 1 (기본 로컬 바인딩 — 무단 노출 방지)
```

### 동반 변경 (Side Effects)

엔트리 추가 → 실행 명령(`serve` 스크립트)을 Step 3에서 등재.

### Do Not Touch

`src/server/http-server.ts`, `src/app/bootstrap.ts`.

## Step 3: 스크립트 등재 (`package.json` — modify, 전체 교체)

### Context

`serve` 추가 + `build`에 정적 파일 복사 추가 (tsc는 HTML을 복사하지 않음 — dist 실행 시 `GET /`가 404가 되는 부산물 차단).

### Code
```json
{
  "name": "chatbot-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev": "tsx src/cli/main.ts",
    "serve": "tsx src/server/main.ts",
    "build": "tsc -p tsconfig.build.json && mkdir -p dist/server/public && cp src/server/public/index.html dist/server/public/",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "sync-wiki": "bash scripts/sync-wiki.sh"
  },
  "devDependencies": {
    "@types/node": "^20.19.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

### Anchor

파일 전체 교체 (현재 파일과의 차이는 `serve` 스크립트 추가와 `build` 명령 확장뿐 — 그 외 키·값 불변 유지).

### Verify
```bash
# 1. 빌드
npm run build 2>&1 | tail -3 && test -f dist/server/public/index.html && echo "OK: html copied"
  # 기대: "OK: html copied"
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 92 passed
# 3. 의미 검증
node -e "const p=require('./package.json'); if(p.dependencies) throw new Error('런타임 의존성 금지'); if(!p.scripts.serve) throw new Error('serve 누락'); console.log('OK')"
  # 기대: "OK"
```

### 동반 변경 (Side Effects)

- CLAUDE.md 명령어 섹션에 `npm run serve` 1줄 추가 — 최종 검증에 포함

### Do Not Touch

`devDependencies` 버전, 기존 스크립트 명령 문자열.

## 실행 순서

Step 1 → 2 → 3.

## 입출력 예제

| 조작 (브라우저) | 기대 동작 |
|----------------|----------|
| 메시지 전송 | 봇 말풍선에 조각이 실시간 추가 (스트리밍) |
| 생성 중 전송 버튼 | disabled — 이중 요청 차단 (서버 409와 이중 방어) |
| 초기화 버튼 | 로그 비움 + 세션 파일 삭제 |
| 재인덱싱 버튼 | "(인덱스 구축 완료: N청크)" 표시 |
| 새로고침 | 히스토리 다시 로드되어 대화 유지 |

## 이 Phase 완료 후 노출 인터페이스

```ts
// 실행 명령
// npm run serve  → http://127.0.0.1:3000 (env HOST/PORT/RAG_DOCS_DIR/CHATBOT_* 적용)
// src/server/main.ts — 엔트리 (export 없음)
// src/server/public/index.html — 웹 UI 정적 파일
```

## Definition of Done

- [ ] DoD-21: 모든 Step 통과 + Verify ✓
- [ ] DoD-22: `npm run typecheck` exit 0
- [ ] DoD-23: `npm test` 92 passed
- [ ] DoD-24: UI는 테스트 면제 — 사유: 얇은 표현 레이어, SSE 파싱·라우트는 Phase 1 테스트가 커버, 브라우저 상호작용은 아래 수동 AC로 갈음 (전역 지침 예외 조항)
- [ ] DoD-25: CLAUDE.md에 serve 명령 추가
- [ ] DoD-26: 수동 AC 통과

## Observability plan

N/A — 개인 로컬 서버. 시작 배너 + 브라우저 개발자도구로 충분.

## 최종 검증

```bash
# 자동 검증
npm run typecheck && npm test && npm run build && test -f dist/server/public/index.html && echo "PHASE 2 PASS (자동)"

# CLAUDE.md 명령어 섹션에 다음 1줄 추가:
# - `npm run serve` — 웹 UI 서버 (기본 http://127.0.0.1:3000, env HOST/PORT)

# 수동 AC (Ollama 실행 상태)
RAG_DOCS_DIR=../dev-wiki CHATBOT_INDEX_FILE=.chatbot/wiki-index.json npm run serve
# 브라우저에서 http://127.0.0.1:3000 접속:
# AC1: 메시지 전송 → 스트리밍 렌더 확인
# AC2: 새로고침 → 대화 유지 / CLI(npm run dev, 같은 세션 파일)에서 이어서 질문 → 웹 대화 기억 확인
# AC5: 재인덱싱 버튼 → 청크 수 표시
```
