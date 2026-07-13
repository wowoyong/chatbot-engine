# Phase 2: 웹 UI — 출처·토큰·중단·마크다운

@fidelity-check tokens: renderMarkdown, AbortController, event === 'sources', escapeHtml

## 코드 예시 적용 규칙

1. HTML 내 JS는 외부/모델 텍스트를 반드시 escape 후 사용 (마크다운 렌더는 escape → 화이트리스트 변환 → innerHTML)
2. 런타임 의존성 추가 금지 — 마크다운 렌더러 자작
3. `any` 없음 (브라우저 JS)

## 전제 조건

Phase 1 SSE 계약 (그대로 복사):

```
data: {"piece": string}                              # content 조각
event: sources\ndata: {"sources": [{source,heading}]} # 관련 문서 (content 후, 있을 때)
event: done\ndata: {"promptTokens"?, "responseTokens"?} # 완료 + 토큰
event: error\ndata: {"error": string}                 # 실패
```

## 현재 상태

`src/server/public/index.html`은 답변을 `textContent`로만 렌더(마크다운 미적용), sources/usage 이벤트 미처리, 중단 불가. 전체 교체.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| 브라우저 DOM/fetch | ✗ | ✗ | 정적 UI — 서버 테스트(Phase 1)가 wire 커버, 브라우저 동작은 수동 AC |
| renderMarkdown (순수) | ✓ | ✓ | grep으로 escape 우선 검증 |
| SSE 파싱 | ✗ | ✗ | Phase 1 서버 테스트가 프레임 형식 고정 |

## Step 1: index.html 전체 교체 (`src/server/public/index.html` — modify)

### Context

마크다운 렌더러(escape 우선 → 코드블록/인라인코드/헤딩/볼드/이탤릭/링크/목록), AbortController 기반 중단(전송 중 버튼이 "중단"), sources 접이식 표시, 토큰 푸터. 스트리밍 중엔 원문 textContent(빠름), done 시 마크다운 렌더로 교체.

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
  .msg { margin: 8px 0; line-height: 1.5; }
  .msg.user, .msg.bot { white-space: pre-wrap; }
  .msg.rendered { white-space: normal; }
  .user { color: #8ab4ff; }
  .bot { color: #eee; }
  .sys { color: #888; font-size: 12px; }
  .meta { color: #888; font-size: 12px; margin: 2px 0 10px; }
  .meta summary { cursor: pointer; }
  .bot pre { background: #1a1a1a; padding: 8px; border-radius: 6px; overflow-x: auto; }
  .bot code { background: #1a1a1a; padding: 1px 4px; border-radius: 4px; }
  .bot pre code { padding: 0; }
  .bot a { color: #8ab4ff; }
  form { display: flex; gap: 8px; margin-top: 8px; }
  input[type=text] { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid #333; background: #1a1a1a; color: #eee; }
  button { padding: 8px 12px; border-radius: 8px; border: 1px solid #444; background: #222; color: #eee; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<h1>chatbot-engine
  <span class="actions">
    <button id="capture" type="button">지식 저장</button>
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
const captureBtn = document.getElementById('capture');

let activeController = null;

function append(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 경량 마크다운 → 안전 HTML (입력을 먼저 escape하므로 XSS 없음) */
function renderMarkdown(raw) {
  const blocks = raw.split(/```/);
  let html = '';
  for (let i = 0; i < blocks.length; i++) {
    if (i % 2 === 1) {
      // 코드펜스 (짝수 인덱스 사이) — 통째 escape
      html += '<pre><code>' + escapeHtml(blocks[i].replace(/^\n/, '')) + '</code></pre>';
      continue;
    }
    let text = escapeHtml(blocks[i]);
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    text = text.replace(/^[-*]\s+(.+)$/gm, '• $1');
    text = text.replace(/\n/g, '<br>');
    html += text;
  }
  return html;
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    for (const m of data.history) {
      if (m.role === 'user') {
        append('user', '나: ' + m.content);
      } else {
        const el = append('bot rendered', '');
        el.innerHTML = renderMarkdown(m.content);
      }
    }
  } catch {
    append('sys', '(히스토리 로드 실패)');
  }
}

function handleFrame(frame, ctx) {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return;
  if (event === 'message') {
    ctx.raw += JSON.parse(data).piece;
    ctx.botEl.textContent = ctx.raw;
    log.scrollTop = log.scrollHeight;
  } else if (event === 'sources') {
    ctx.sources = JSON.parse(data).sources || [];
  } else if (event === 'done') {
    ctx.usage = JSON.parse(data);
  } else if (event === 'error') {
    ctx.raw += '\n오류: ' + JSON.parse(data).error + ' — 다시 시도하세요.';
    ctx.botEl.textContent = ctx.raw;
  }
}

function finalize(ctx) {
  ctx.botEl.className = 'msg bot rendered';
  ctx.botEl.innerHTML = renderMarkdown(ctx.raw);
  const parts = [];
  if (ctx.sources && ctx.sources.length > 0) {
    const labels = ctx.sources
      .map((s) => (s.heading ? s.source + ' > ' + s.heading : s.source))
      .join(', ');
    const det = document.createElement('details');
    det.className = 'meta';
    const sum = document.createElement('summary');
    sum.textContent = '참조 문서 ' + ctx.sources.length + '건';
    const body = document.createElement('div');
    body.textContent = labels;
    det.appendChild(sum);
    det.appendChild(body);
    log.appendChild(det);
  }
  if (ctx.usage && ctx.usage.responseTokens !== undefined) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = '토큰: prompt ' + (ctx.usage.promptTokens ?? '?') + ' / response ' + ctx.usage.responseTokens;
    log.appendChild(meta);
  }
  log.scrollTop = log.scrollHeight;
}

async function send(message) {
  append('user', '나: ' + message);
  const ctx = { botEl: append('bot', ''), raw: '', sources: [], usage: null };
  activeController = new AbortController();
  sendBtn.textContent = '중단';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: activeController.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
      ctx.botEl.textContent = '오류: ' + err.error;
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
        handleFrame(buffer.slice(0, idx), ctx);
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf('\n\n');
      }
    }
    finalize(ctx);
  } catch (err) {
    if (err.name === 'AbortError') {
      ctx.botEl.textContent = ctx.raw + '\n(중단됨)';
    } else {
      ctx.botEl.textContent += '\n(연결 오류: ' + err.message + ')';
    }
  } finally {
    activeController = null;
    sendBtn.textContent = '전송';
    input.focus();
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (activeController) {
    activeController.abort();
    return;
  }
  const message = input.value.trim();
  if (!message) return;
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

captureBtn.addEventListener('click', async () => {
  captureBtn.disabled = true;
  const notice = append('sys', '(대화에서 지식 추출 중...)');
  try {
    const res = await fetch('/api/capture', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      notice.textContent = '(지식 추출 오류: ' + data.error + ' — 다시 시도하세요)';
      return;
    }
    notice.textContent =
      '(추출 ' + data.extracted + '건 → 저장 ' + data.saved.length + '건, 기존 지식 ' + data.skipped.length + '건)';
  } catch {
    notice.textContent = '(지식 추출 오류 — 다시 시도하세요)';
  } finally {
    captureBtn.disabled = false;
  }
});

loadHistory();
input.focus();
</script>
</body>
</html>
```

### Anchor

파일 전체 교체.

### Verify
```bash
# 1. 빌드
npm run build 2>&1 | tail -2 && test -f dist/server/public/index.html && echo "OK: 빌드 복사"
  # 기대: "OK: 빌드 복사"
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 139 passed (UI 무영향)
# 3. 의미 검증
grep -c "escapeHtml(blocks\|escapeHtml(text\|escapeHtml(raw" src/server/public/index.html && grep -c "AbortController\|event === 'sources'" src/server/public/index.html
  # 기대: escape가 renderMarkdown에서 입력에 먼저 적용됨(≥1), AbortController+sources 처리(≥2)
```

### 동반 변경 (Side Effects)

- CLAUDE.md에 웹 UI 기능 1줄 (최종 검증)
- build html 복사 스텝은 Segment 5에서 이미 존재

### Do Not Touch

`src/server/http-server.ts`, `src/server/main.ts`.

## 실행 순서

Step 1 (단일).

## 입출력 예제

| 조작 | 동작 |
|------|------|
| 답변에 코드블록 | 마크다운 렌더 (pre/code) |
| 관련 문서 있음 | "참조 문서 N건" 접이식 |
| 응답 완료 | "토큰: prompt X / response Y" |
| 전송 중 버튼 클릭 | AbortController.abort → "(중단됨)" |
| `<script>` 포함 답변 | escape되어 텍스트로 표시 (XSS 없음) |

## 이 Phase 완료 후 노출 인터페이스

```
웹 UI: 마크다운 렌더 + 출처 접이식 + 토큰 표시 + 중단 버튼
(신규 export 없음 — 정적 UI)
```

## Definition of Done

- [ ] DoD-21: Step 통과 + Verify ✓
- [ ] DoD-22: typecheck exit 0 (UI는 typecheck 무관하나 전체 통과)
- [ ] DoD-23: `npm test` 139 passed
- [ ] DoD-24: UI 테스트 면제 — 얇은 표현 레이어, wire는 Phase 1 서버 테스트, 렌더 안전성은 grep(escape 우선) + 수동 AC
- [ ] DoD-25: CLAUDE.md 갱신
- [ ] DoD-26: 수동 AC 통과

## Observability plan

N/A — 브라우저 개발자도구.

## 최종 검증

```bash
npm run typecheck && npm test && npm run build && echo "PHASE 2 PASS (자동)"

# CLAUDE.md 컨벤션 섹션에 1줄 추가:
# - 웹 UI: 마크다운 렌더 + 출처/토큰 표시 + 응답 중단(전송 버튼 재클릭)

# 수동 AC (Ollama 실행, 메인 세션 수행)
# 브라우저에서 코드블록 포함 답변 렌더, 참조 문서/토큰 표시, 중단 버튼 확인
```
