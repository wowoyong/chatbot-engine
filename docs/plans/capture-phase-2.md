# Phase 2: 인터페이스 연결 — CLI /capture + POST /api/capture + 웹 버튼

@fidelity-check tokens: /capture, api/capture, captureBtn, 지식 저장

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 (TS 파일)
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지
5. HTML 내 JS는 동적 텍스트를 `textContent`로만 렌더 (innerHTML 금지)

## 전제 조건

Phase 1이 노출한 인터페이스 (그대로 복사):

```ts
// src/app/bootstrap.ts
export interface CaptureResult { extracted: number; saved: string[]; skipped: string[]; }
// App.captureKnowledge(capturedAt: string): Promise<CaptureResult>
```

Segment 5 인터페이스: CLI 명령 dispatch 패턴(src/cli/main.ts), 서버 라우트 if 분기(src/server/http-server.ts), UI 버튼 패턴(index.html).

## 현재 상태

`App.captureKnowledge`는 존재하지만 어느 인터페이스에서도 호출되지 않는다. CLI 배너와 명령 목록에 `/capture` 없음, 서버에 `/api/capture` 라우트 없음, UI에 버튼 없음.

## Step 1: CLI `/capture` (`src/cli/main.ts` — modify, `/index` 블록 뒤에 삽입 + 배너 교체)

### Context

기존 명령 dispatch 패턴 그대로. 추출 실패(8B JSON 불량)는 대화에 영향 없이 "다시 시도" 안내.

### Code

(a) 배너 라인 교체 —

교체 전:
```ts
  stdout.write(
    `chatbot-engine — ${app.modelName} (명령: /exit 종료, /clear 히스토리 초기화, /index RAG 인덱스 구축)\n`,
  );
```

교체 후:
```ts
  stdout.write(
    `chatbot-engine — ${app.modelName} (명령: /exit 종료, /clear 히스토리 초기화, /index RAG 인덱스 구축, /capture 지식 저장)\n`,
  );
```

(b) `/index` 명령 블록(`if (line === '/index') { ... continue; }`)이 닫힌 뒤, `stdout.write('bot> ');` 직전에 삽입:

```ts
    if (line === '/capture') {
      try {
        stdout.write('(대화에서 지식을 추출합니다...)\n');
        const result = await app.captureKnowledge(new Date().toISOString());
        stdout.write(
          `(추출 ${result.extracted}건 → 저장 ${result.saved.length}건, 기존 지식 ${result.skipped.length}건)\n`,
        );
        for (const path of result.saved) {
          stdout.write(`  + ${path}\n`);
        }
        for (const title of result.skipped) {
          stdout.write(`  = ${title} (이미 알고 있음)\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stdout.write(`지식 추출 오류: ${message} — 다시 시도하세요.\n`);
      }
      continue;
    }

```

### Anchor

- (a) 배너 `stdout.write` 블록 (파일 내 `/index RAG 인덱스 구축` 문자열 유일)
- (b) `/index` 블록을 닫는 `      continue;\n    }` 뒤 빈 줄 다음, `    stdout.write('bot> ');` 바로 위 (이 텍스트는 파일 내 유일)

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 112 passed
# 3. 의미 검증
printf '/exit\n' | npx tsx src/cli/main.ts | grep -c "/capture 지식 저장"
  # 기대: 1 (배너에 명령 노출)
```

### 동반 변경 (Side Effects)

CLAUDE.md 명령 안내는 본 Phase 최종 검증에서 일괄 갱신.

### Do Not Touch

CLI의 기존 명령 블록 본문(/exit·/clear·/index), `src/app/**`.

## Step 2: 서버 라우트 (`src/server/http-server.ts` — modify, 라우트 1개 삽입)

### Context

라우트 dispatch 패턴 그대로. captureKnowledge의 throw는 기존 outer catch가 500 JSON으로 변환 — 추가 에러 처리 불필요.

### Code

`if (route === 'POST /api/chat') {` 바로 위에 삽입:

```ts
    if (route === 'POST /api/capture') {
      const result = await app.captureKnowledge(new Date().toISOString());
      sendJson(res, 200, result);
      return;
    }
```

### Anchor

`    if (route === 'POST /api/chat') {` (파일 내 유일) 바로 위.

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 112 passed (라우트 테스트는 Step 3에서 추가)
# 3. 의미 검증
grep -c "POST /api/capture" src/server/http-server.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

새 라우트 → 테스트를 Step 3에서 동반.

### Do Not Touch

기존 라우트 블록 본문, `handleChat`.

## Step 3: 서버 라우트 테스트 (`src/server/__tests__/http-server.test.ts` — modify, Fake 확장 + 케이스 2개 추가)

### Context

기존 FakeLlmClient.chat이 고정 문자열 `'요약'`을 반환 — capture 테스트가 추출 JSON을 제어할 수 있도록 필드 주도로 교체(기본값 `'요약'` 유지 — 기존 요약 경로 무영향). 새 케이스는 describe 닫힘 직전에 추가.

### Code

(a) FakeLlmClient의 chat 메서드 교체 —

교체 전:
```ts
  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return '요약';
  }
```

교체 후:
```ts
  chatResult = '요약';

  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return this.chatResult;
  }
```

(b) describe를 닫는 `});` 바로 위에 추가:

### 검증 대상

- spy: `fake.chatResult` 제어 — 추출 JSON/불량 출력
- branch: capture 정상(파일 저장 + 결과 JSON), 추출 불량 → 500 (서버 생존)
- state: 응답 JSON 필드, captured 파일 존재

```ts
  it('POST /api/capture가 새 지식을 저장하고 결과를 반환한다 (정상)', async () => {
    await (await postChat('질문')).text(); // 히스토리 생성
    fake.chatResult =
      '[{"title":"캡처 지식","category":"fact","content":"새 내용"}]';

    const res = await fetch(`${baseUrl}/api/capture`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      extracted: number;
      saved: string[];
      skipped: string[];
    };
    expect(data.extracted).toBe(1);
    expect(data.saved).toHaveLength(1);
    expect(data.saved.at(0)).toContain(join('captured', 'fact'));
  });

  it('추출 출력이 불량이면 500을 반환하고 서버는 살아있다 (에러)', async () => {
    await (await postChat('질문')).text();
    fake.chatResult = '지식 없음';

    const res = await fetch(`${baseUrl}/api/capture`, { method: 'POST' });
    expect(res.status).toBe(500);

    expect((await fetch(`${baseUrl}/api/history`)).status).toBe(200);
  });
```

### Anchor

- (a) FakeLlmClient 클래스 안의 chat 메서드 (교체 전 텍스트가 파일 내 유일)
- (b) describe를 닫는 `});` 바로 위 (기존 케이스 수정 금지, 추가만)

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 전체 114 passed (112 + 2)
# 3. 의미 검증
grep -c "api/capture" src/server/__tests__/http-server.test.ts
  # 기대: 2 (정상+에러 케이스)
```

### 동반 변경 (Side Effects)

테스트 파일 상단 import에 `join`이 이미 있는지 확인 — 있음(`node:path`에서 import 중). 추가 import 불필요.

### Do Not Touch

기존 8개 케이스 본문.

## Step 4: 웹 UI 버튼 (`src/server/public/index.html` — modify, 버튼 1개 + 핸들러 1개 삽입)

### Code

(a) 헤더 버튼 — 교체 전:
```html
  <span class="actions">
    <button id="reindex" type="button">재인덱싱</button>
    <button id="clear" type="button">초기화</button>
  </span>
```

교체 후:
```html
  <span class="actions">
    <button id="capture" type="button">지식 저장</button>
    <button id="reindex" type="button">재인덱싱</button>
    <button id="clear" type="button">초기화</button>
  </span>
```

(b) 스크립트 — `const reindexBtn = document.getElementById('reindex');` 라인 바로 아래에 추가:

```js
const captureBtn = document.getElementById('capture');
```

(c) 스크립트 — `reindexBtn.addEventListener(...)` 블록이 닫힌 뒤(`});`), `loadHistory();` 바로 위에 추가:

```js
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

```

### Context

기존 재인덱싱 버튼과 동일한 패턴 — disabled 가드 + sys 라인 갱신. 렌더는 전부 textContent.

### Anchor

- (a) actions span 블록 (파일 내 유일)
- (b) `const reindexBtn = document.getElementById('reindex');` (유일)
- (c) `loadHistory();` 호출 라인 (파일 끝부분, 유일) 바로 위

### Verify
```bash
# 1. 빌드
echo "N/A: 정적 HTML"
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 114 passed (무영향)
# 3. 의미 검증
grep -c "innerHTML" src/server/public/index.html && grep -c "api/capture" src/server/public/index.html
  # 기대: 0 그리고 1
```

### 동반 변경 (Side Effects)

build의 html 복사 스텝은 Segment 5에서 이미 존재 — 추가 변경 없음.

### Do Not Touch

기존 send/clear/reindex 핸들러 본문, CSS.

## 실행 순서

Step 1 → 2 → 3 → 4.

## 입출력 예제

| 조작 | 기대 출력 |
|------|----------|
| CLI `/capture` (새 지식 있음) | `(추출 2건 → 저장 1건, 기존 지식 1건)` + 경로/제목 목록 |
| CLI `/capture` (추출 불량) | `지식 추출 오류: … — 다시 시도하세요.` (대화 계속) |
| 웹 "지식 저장" 버튼 | sys 라인 `(추출 N건 → 저장 N건, 기존 지식 N건)` |
| `POST /api/capture` | `{"extracted":1,"saved":["…/captured/fact/….md"],"skipped":[]}` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// CLI: /capture 명령
// HTTP: POST /api/capture → CaptureResult JSON
// UI: "지식 저장" 버튼
// (신규 export 없음 — 인터페이스 연결만)
```

## Definition of Done

- [ ] DoD-21: 모든 Step 통과 + Verify ✓
- [ ] DoD-22: `npm run typecheck` exit 0
- [ ] DoD-23: `npm test` 114 passed (기존 112 회귀 없음)
- [ ] DoD-24: UI는 테스트 면제 — 사유: Segment 5와 동일 (얇은 표현 레이어, 라우트는 Step 3이 커버, 브라우저 상호작용은 수동 AC)
- [ ] DoD-25: CLAUDE.md 갱신 (아래 최종 검증)
- [ ] DoD-26: 수동 AC 통과

## Observability plan

N/A — capture 결과는 CLI/UI 출력과 저장 파일 메타 라인으로 노출.

## 최종 검증

```bash
# 자동 검증
npm run typecheck && npm test && npm run build && echo "PHASE 2 PASS (자동)"

# CLAUDE.md 컨벤션 섹션 끝에 다음 1줄 추가:
# - 지식 캡처: CLI `/capture` 또는 웹 "지식 저장" — 대화에서 새 지식만 novelty 판정 후 `<RAG_DOCS_DIR>/captured/<분류>/`에 저장 + 자동 재인덱싱

# 수동 AC (Ollama 실행 상태, 메인 세션이 수행)
# CLI에서 새로운 사실을 알려주는 대화 후 /capture → 저장 확인 → 같은 대화로 재실행 → 스킵 확인
```
