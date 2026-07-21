# Phase 1: App/API/CLI/Web approval orchestration

@fidelity-check tokens: MutationQueue, rebuildNow, CaptureApprovalResult, indexUpdated, /approve N, POST /api/captured/approve, INVALID_ID 400, NOT_FOUND 404, NOT_DRAFT 409

## 코드 예시 적용 규칙

1. capture·approve·manual rebuild는 하나의 process-local FIFO mutation queue를 공유한다.
2. queue 내부에서는 public queued `rebuildIndex`를 다시 호출하지 않고 private `rebuildNow`를 호출한다.
3. 실패한 operation은 다음 operation의 실행을 막지 않는다.
4. 승인 저장 후 재색인이 실패해도 승인은 durable하며 `indexUpdated: false`와 복구 명령을 반환한다.
5. CLI는 번호를 id로 변환하고 HTTP는 id를 문자열로 받는다.
6. browser는 captured content를 `innerHTML`로 렌더하지 않는다.

## 전제 조건

```typescript
export function approveCaptured(baseDir: string, id: string, reviewedAt: string): Promise<CapturedEntry>;
export class CapturedApprovalError extends Error {
  readonly code: 'INVALID_ID' | 'NOT_FOUND' | 'NOT_DRAFT';
}
```

## 현재 상태

capture 저장과 index rebuild가 별도 await chain이며 동시에 들어온 rebuild/capture 요청을 직렬화하지 않는다. CLI/Web은 목록만 제공하고 승인 명령·endpoint·review UI가 없다.

## Testability Review

| seam | 관찰 방법 | 필요한 제어 | 판정 |
|---|---|---|---|
| FIFO 직렬화 | deferred promise 실행 순서 | operation closures | 양호 |
| queue 오류 회복 | 첫 operation reject 후 두 번째 실행 | operation closures | 양호 |
| capture/approve rebuild | fake embedder와 temp dirs | 기존 AppConfig | 양호 |
| 승인 후 rebuild 실패 | fail-toggle fake embedder | 기존 AppOverrides | 양호 |
| HTTP status mapping | ephemeral server request | typed store errors | 양호 |
| browser DOM 안전성 | static source assertion + server contract | N/A | 제한적, 현행 test 수준 유지 |

## Step 1: 실패 복구 가능한 mutation queue (`src/app/mutation-queue.ts`, `src/app/__tests__/mutation-queue.test.ts` — create)

### Context

동일 index 파일에 대한 rebuild와 capture 상태 전이를 프로세스 안에서 직렬화한다. 반환 promise는 해당 operation 결과를 유지하되 내부 tail은 성공/실패 모두 settled 상태로 복구한다.

### Code

```typescript
export class MutationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
```

### 검증 대상
- spy: operation start/end event array
- branch: 앞 작업 성공과 실패
- state: FIFO 순서와 generic return/rejection 보존

```typescript
it('동시 요청을 FIFO로 실행한다 (정상)', async () => {
  const queue = new MutationQueue();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.run(async () => {
    events.push('first:start');
    await gate;
    events.push('first:end');
  });
  const second = queue.run(async () => events.push('second'));
  await Promise.resolve();
  expect(events).toEqual(['first:start']);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(['first:start', 'first:end', 'second']);
});

it('실패 후 다음 작업을 실행한다 (오류 회복)', async () => {
  const queue = new MutationQueue();
  await expect(queue.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  await expect(queue.run(async () => 42)).resolves.toBe(42);
});
```

### Anchor

- dependency 없는 단일 class 파일로 생성한다.
- test는 real timers만 사용한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/app/__tests__/mutation-queue.test.ts
# 기대: FIFO와 오류 회복 PASS

# 3. 의미 검증
rg -n "class MutationQueue|this.tail.then\(operation, operation\)" src/app/mutation-queue.ts
# 기대: 단일 FIFO 구현
```

### 동반 변경 (Side Effects)

Step 2에서 app mutation entry point 3개가 이 class를 공유한다.

### Do Not Touch

cross-process lock과 filesystem lock은 단일 프로세스 앱 범위를 넘으므로 추가하지 않는다.

## Step 2: App lifecycle 직렬화 (`src/app/bootstrap.ts`, `src/app/__tests__/bootstrap-capture.test.ts` — modify)

### Context

capture 저장→rebuild, approve→rebuild를 각각 하나의 queue operation으로 만든다. public rebuild를 queue 내부에서 재호출하면 자기 자신을 기다리는 deadlock이 생기므로 실제 작업은 private `rebuildNow`로 분리한다.

### Code

```typescript
export interface App {
  // existing members
  approveCaptured(id: string, reviewedAt: string): Promise<CaptureApprovalResult>;
}

export interface CaptureApprovalResult {
  entry: CapturedEntry;
  indexUpdated: boolean;
  warning?: string;
}

export interface CaptureResult {
  extracted: number;
  saved: string[];
  skipped: string[];
  indexUpdated: boolean;
  warning?: string;
}

const mutations = new MutationQueue();

async function rebuildNow(createdAt: string): Promise<number> {
  const built = await buildIndex(embedder, docsDir, {
    model: embedderModel,
    createdAt,
  });
  await built.save(indexFile);
  currentIndex = built;
  retriever = new HybridRetriever(embedder, built, { minVectorScore });
  return built.size;
}

const rebuildIndex = (createdAt: string) => mutations.run(() => rebuildNow(createdAt));
```

capture와 approve 구현은 queue 전체에서 실행한다.

```typescript
captureKnowledge: (capturedAt) => mutations.run(async () => {
  const candidates = await extractKnowledge(client, session.getHistory());
  const verdicts = await judgeNovelty(embedder, currentIndex, candidates);
  const saved: string[] = [];
  const skipped: string[] = [];
  for (const verdict of verdicts) {
    if (verdict.isNew) {
      saved.push(await saveCaptured(capturedDir, verdict, capturedAt));
    } else {
      skipped.push(verdict.candidate.title);
    }
  }
  if (saved.length === 0) {
    return { extracted: candidates.length, saved, skipped, indexUpdated: true };
  }
  try {
    await rebuildNow(capturedAt);
    return { extracted: candidates.length, saved, skipped, indexUpdated: true };
  } catch {
    return {
      extracted: candidates.length,
      saved,
      skipped,
      indexUpdated: false,
      warning: 'draft는 저장됐지만 재색인에 실패했습니다. /index로 재시도하세요.',
    };
  }
}),
approveCaptured: (id, reviewedAt) => mutations.run(async () => {
  const entry = await approveCapturedStore(capturedDir, id, reviewedAt);
  try {
    await rebuildNow(reviewedAt);
    return { entry, indexUpdated: true };
  } catch {
    return {
      entry,
      indexUpdated: false,
      warning: '승인은 저장됐지만 재색인에 실패했습니다. /index로 재시도하세요.',
    };
  }
}),
```

### 검증 대상
- spy: fake embedder/build observable calls
- branch: draft capture, approve success, approve 후 rebuild failure
- state: draft 비검색, 승인/rebuild 후 verified 검색, rebuild 실패 시 durable verified + 복구 안내

```typescript
it('capture draft는 검색에서 제외되고 승인 후 노출된다 (상태 전이)', async () => {
  const { app, embedder } = await bootstrapTestApp();
  const captured = await app.captureKnowledge(capturedAt);
  const [entry] = await app.listCaptured();
  if (entry === undefined) throw new Error('expected captured entry');
  expect(entry.status).toBe('draft');
  const before = await VectorIndex.load(app.indexFile);
  const draftRetriever = new HybridRetriever(embedder, before!, { minVectorScore: 0 });
  expect((await draftRetriever.retrieve(entry.title)).hits).toHaveLength(0);
  const approval = await app.approveCaptured(entry.id, reviewedAt);
  expect(approval.indexUpdated).toBe(true);
  const after = await VectorIndex.load(app.indexFile);
  const verifiedRetriever = new HybridRetriever(embedder, after!, { minVectorScore: 0 });
  expect((await verifiedRetriever.retrieve(entry.title)).hits[0]?.chunk.metadata?.status).toBe('verified');
  expect(captured.saved).toHaveLength(1);
});

it('승인 후 rebuild 실패를 durable approval과 복구 안내로 반환한다 (오류 회복)', async () => {
  const { app, embedder } = await bootstrapTestAppWithDraft();
  embedder.fail = true;
  const result = await app.approveCaptured('fact/item.md', reviewedAt);
  expect(result).toMatchObject({ indexUpdated: false, entry: { status: 'verified' } });
  expect(result.warning).toContain('/index');
  expect((await app.listCaptured())[0]?.status).toBe('verified');
  embedder.fail = false;
  await expect(app.rebuildIndex(reviewedAt)).resolves.toBeGreaterThan(0);
});

it('capture 후 rebuild 실패를 durable draft와 복구 안내로 반환한다 (오류 회복)', async () => {
  const { app, embedder } = await bootstrapTestApp();
  embedder.fail = true;
  const result = await app.captureKnowledge(capturedAt);
  expect(result).toMatchObject({ indexUpdated: false, saved: [expect.any(String)] });
  expect(result.warning).toContain('/index');
  expect((await app.listCaptured())[0]?.status).toBe('draft');
});
```

### Anchor

- store import `approveCaptured`는 `approveCapturedStore`로 alias한다.
- 현재 rebuild body를 `rebuildNow`로 옮긴 뒤 기존 exported/public behavior를 보존한다.
- `captureKnowledge` 내부에서는 `rebuildIndex` 문자열이 나타나지 않아야 한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/app/__tests__/bootstrap-capture.test.ts src/app/__tests__/mutation-queue.test.ts
# 기대: lifecycle와 queue PASS

# 3. 의미 검증
rg -n "MutationQueue|rebuildNow|approveCaptured:" src/app/bootstrap.ts
# 기대: 세 mutation이 하나의 queue를 공유하고 private rebuild 사용
```

### 동반 변경 (Side Effects)

capture 응답 latency에 rebuild 시간이 이미 포함되던 기존 semantics는 유지한다. draft도 index에는 들어갈 수 있으나 retriever에서 제외된다. approval rebuild 실패는 HTTP 500으로 모호하게 만들지 않고 verified 상태와 복구 필요를 함께 반환한다.

### Do Not Touch

ChatSession streaming과 model loading lifecycle.

## Step 3: testable CLI review commands (`src/cli/main.ts` — modify, `src/cli/__tests__/main.test.ts` — create)

### Context

operator가 filesystem 경로를 직접 입력하지 않도록 `/captured`의 안정적인 번호와 `/approve N`을 제공한다.

### Code

```typescript
export async function handleKnowledgeReviewCommand(
  input: string,
  app: App,
  write: (text: string) => void,
  now: () => string,
): Promise<boolean> {
  if (input === '/captured') {
    const entries = await app.listCaptured();
    entries.forEach((entry, index) => {
      write(`${index + 1}. [${entry.status}] ${entry.title} (${entry.category})\n`);
    });
    return true;
  }
  const approveMatch = input.match(/^\/approve\s+(\d+)$/);
  if (approveMatch === null) return false;
  const entries = (await app.listCaptured()).filter((entry) => entry.status === 'draft');
  const entry = entries[Number(approveMatch[1]) - 1];
  if (!entry) {
    write('유효한 항목 번호를 입력하세요.\n');
    return true;
  }
  try {
    const result = await app.approveCaptured(entry.id, now());
    write(`승인됨: ${result.entry.title}\n`);
    if (result.warning !== undefined) write(`${result.warning}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write(`승인 오류: ${message}\n`);
  }
  return true;
}
```

main loop는 일반 chat 분기 전에 helper를 호출한다.

```typescript
if (await handleKnowledgeReviewCommand(
  line,
  app,
  (text) => stdout.write(text),
  () => new Date().toISOString(),
)) continue;
```

test import 시 실행되지 않도록 `fileURLToPath(import.meta.url)` entry guard를 적용하고 현재 fatal error body는 `handleFatalError`로 추출한다.

### 검증 대상
- spy: fake App `approveCaptured`와 write buffer
- branch: draft list, verified 제외, valid/invalid number, approval error, unrelated command
- state: status/number 출력, ISO timestamp 전달, warning 출력

```typescript
it('approve 번호를 id로 바꾸고 주입한 시간을 전달한다 (정상)', async () => {
  const output: string[] = [];
  const app = fakeApp({
    captured: [{ id: 'fact/item.md', title: 'Item', category: 'fact', status: 'draft' }],
    approval: { entry: { id: 'fact/item.md', title: 'Item', category: 'fact', status: 'verified' }, indexUpdated: true },
  });
  await expect(
    handleKnowledgeReviewCommand('/approve 1', app, (text) => output.push(text), () => '2026-07-21T00:00:00Z'),
  ).resolves.toBe(true);
  expect(app.approveCaptured).toHaveBeenCalledWith('fact/item.md', '2026-07-21T00:00:00Z');
  expect(output.join('')).toContain('승인됨: Item');
});
```

### Anchor

- help/banner에 `/approve N` 한 줄 추가.
- 기존 `/captured` 출력 loop를 `handleKnowledgeReviewCommand`로 교체.
- 파일 끝의 무조건 `main()` 호출을 ESM entry guard로 감싼다.
- broad catch는 기존 top-level 정책을 유지하고 typed error의 raw stack을 출력하지 않는다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/cli/__tests__/main.test.ts
# 기대: list status, invalid number, approve 호출 PASS

# 3. 의미 검증
rg -n "/approve N|handleKnowledgeReviewCommand|entry.id|fileURLToPath" src/cli/main.ts
# 기대: 번호→id 변환, 주입 seam, import-safe entry guard 존재
```

### 동반 변경 (Side Effects)

`/captured` 출력 snapshot이 있다면 status/number를 포함하도록 갱신한다.

### Do Not Touch

기존 `/capture`, `/reindex`, `/stats`, 종료 command semantics.

## Step 4: 승인 HTTP 계약 (`src/server/http-server.ts`, `src/server/__tests__/http-server.test.ts` — modify)

### Context

browser와 자동화가 공유할 최소 endpoint를 추가하고 store error code를 일관된 HTTP status로 번역한다.

### Code

```typescript
if (route === 'POST /api/captured/approve') {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: '잘못된 JSON 본문' });
    return;
  }
  if (!isRecord(body) || typeof body['id'] !== 'string' || body['id'].trim().length === 0) {
    sendJson(res, 400, { error: 'id is required' });
    return;
  }
  try {
    sendJson(res, 200, await app.approveCaptured(body['id'], new Date().toISOString()));
    return;
  } catch (error) {
    if (error instanceof CapturedApprovalError) {
      const status = { INVALID_ID: 400, NOT_FOUND: 404, NOT_DRAFT: 409 }[error.code];
      sendJson(res, status, { error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}
```

### 검증 대상
- spy: 현재 real `createApp` server fixture의 HTTP response와 captured files
- branch: 200, malformed/empty/traversal 400, missing 404, non-draft 409
- state: response JSON code, verified file, `indexUpdated` flag

```typescript
it.each([
  ['../secret.md', 400, 'INVALID_ID'],
  ['concept/missing.md', 404, 'NOT_FOUND'],
  ['concept/legacy.md', 409, 'NOT_DRAFT'],
] as const)('approve id=%s를 %i로 매핑한다 (오류)', async (id, status, code) => {
  const response = await postJson(baseUrl, '/api/captured/approve', { id });
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ code });
});

it('malformed JSON과 empty id는 400이다 (입력 오류)', async () => {
  expect((await postRaw(baseUrl, '/api/captured/approve', '{')).status).toBe(400);
  expect((await postJson(baseUrl, '/api/captured/approve', { id: '' })).status).toBe(400);
});

it('draft id를 승인하고 index 결과를 반환한다 (정상)', async () => {
  await seedDraftCaptured(join(dir, 'docs', 'captured'), 'fact/item.md');
  const response = await postJson(baseUrl, '/api/captured/approve', { id: 'fact/item.md' });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    entry: { id: 'fact/item.md', status: 'verified' },
    indexUpdated: true,
  });
});
```

### Anchor

- `GET /api/captured` branch 바로 뒤, generic 404 전에 추가.
- 기존 body size/error handling helper를 재사용한다.
- server test `beforeEach`에서 `concept/legacy.md`를 frontmatter 없는 문서로 seed하고, draft success는 OKF serializer를 쓰는 `seedDraftCaptured` helper로 준비한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/server/__tests__/http-server.test.ts
# 기대: 200/400/404/409 PASS

# 3. 의미 검증
rg -n "api/captured/approve|INVALID_ID: 400|NOT_FOUND: 404|NOT_DRAFT: 409" src/server/http-server.ts
# 기대: wire status mapping 정확
```

### 동반 변경 (Side Effects)

`GET /api/captured` JSON item은 Phase 0 계약대로 `id,title,category,status`가 된다.

### Do Not Touch

SSE endpoint와 static file routing.

## Step 5: browser review panel (`src/server/public/index.html`, `src/server/__tests__/public-ui.test.ts` — modify)

### Context

draft 목록을 조회하고 항목별 승인 버튼을 제공한다. id와 title은 DOM property로만 반영해 captured content가 HTML로 실행되지 않게 한다.

### Code

```javascript
async function loadCaptured() {
  const response = await fetch('/api/captured');
  const payload = await response.json();
  const entries = payload.items;
  capturedList.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = '[' + entry.status + '] ' + entry.title;
    row.appendChild(label);
    if (entry.status === 'draft') {
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.textContent = '승인';
      approve.addEventListener('click', async () => {
        const response = await fetch('/api/captured/approve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: entry.id }),
        });
        const result = await response.json();
        if (!response.ok) {
          showCapturedNotice(result.error || '승인에 실패했습니다.');
          return;
        }
        if (result.warning) showCapturedNotice(result.warning);
        await loadCaptured();
      });
      row.appendChild(approve);
    }
    capturedList.appendChild(row);
  }
}

function showCapturedNotice(message) {
  capturedNotice.textContent = message;
}
```

### Anchor

- 기존 header controls에 `지식 검토` button을 추가.
- chat log와 분리된 hidden panel/list/notice container를 추가.
- panel open 시 `loadCaptured`, 승인 완료 시 reload한다.
- error response는 기존 status/error presentation helper가 있으면 재사용하고 없으면 panel text node로 표시한다.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: exit 0

# 2. 테스트
npx vitest run src/server/__tests__/public-ui.test.ts src/server/__tests__/http-server.test.ts
# 기대: review controls와 endpoint contract PASS

# 3. 의미 검증
rg -n "loadCaptured|api/captured/approve|textContent|replaceChildren" src/server/public/index.html
# 기대: DOM-only rendering, approve wiring 존재
```

### 동반 변경 (Side Effects)

승인 후 index rebuild 동안 button을 disable하여 중복 POST를 막는 작은 UX 보완은 허용한다.

### Do Not Touch

Markdown rendering, source citation UI, message streaming layout.

## 이 Phase 완료 후 노출 인터페이스

```typescript
export class MutationQueue {
  run<T>(operation: () => Promise<T>): Promise<T>;
}
export interface CaptureApprovalResult {
  entry: CapturedEntry;
  indexUpdated: boolean;
  warning?: string;
}
export interface App {
  approveCaptured(id: string, reviewedAt: string): Promise<CaptureApprovalResult>;
}
// POST /api/captured/approve { id: string }
// 200 CaptureApprovalResult | 400 INVALID_ID | 404 NOT_FOUND | 409 NOT_DRAFT
```

## Definition of Done

- capture, approve, manual rebuild가 하나의 FIFO queue에서 직렬화된다.
- queue operation 실패 후 다음 operation이 정상 실행된다.
- draft capture는 검색되지 않고 승인/rebuild 후 검색된다.
- 승인 후 rebuild 실패는 200 `indexUpdated: false`와 `/index` 복구 안내를 반환하며 verified 파일을 잃지 않는다.
- CLI `/approve N`, HTTP approve endpoint, browser review panel이 같은 id/status 계약을 사용한다.
- HTTP error mapping과 DOM-only rendering 검증이 통과한다.
- 관련 단위/통합 테스트, typecheck, build가 통과한다.
