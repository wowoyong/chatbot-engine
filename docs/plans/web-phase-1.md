# Phase 1: HTTP 서버 — SSE 스트리밍 + API 라우트

@fidelity-check tokens: createChatServer, text/event-stream, readBody, chatting, MAX_BODY_BYTES

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드 (타입 단언 `as`는 노드 표준 API의 알려진 반환 좁히기에만 허용 — 예: `server.address() as AddressInfo`)
3. 런타임 의존성 추가 금지 — `node:http` 내장만
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성
6. 테스트 파일 시스템은 `.test-tmp/<uuid>/`만 사용

## 전제 조건

Phase 0이 노출한 인터페이스 (그대로 복사):

```ts
// src/app/bootstrap.ts
export type AppEnv = Record<string, string | undefined>;
export interface AppOverrides { client?: LlmClient; embedder?: Embedder; }
export interface App {
  session: ChatSession;
  store: SessionStore;
  docsDir: string;
  indexFile: string;
  modelName: string;
  startupNotices: string[];
  rebuildIndex(createdAt: string): Promise<number>;
}
export function createApp(env: AppEnv, overrides?: AppOverrides): Promise<App>;
```

## 현재 상태

`src/server/` 없음. App은 인터페이스(단일 공유 세션)로 준비 완료 — 서버는 CLI와 같은 App 위의 또 다른 얇은 레이어다.

## Step 1: HTTP 서버 (`src/server/http-server.ts` — create)

### Context

`node:http` 밑바닥 구현. 설계 결정:
- **SSE 스트리밍**: `data: {"piece":...}\n\n` 프레임, 종료는 `event: done`, 실패는 `event: error` — HTTP 200 이후의 오류는 상태코드로 전달 불가하므로 이벤트로 전달.
- **단일 진행 가드**: `chatting` 불리언 — 생성 중 새 채팅은 409 (단일 사용자 개인 서버).
- **클라이언트 중단 감지**: 조각 쓰기 전 `res.destroyed` 확인 — 중단 시 제너레이터 조기 종료 → ChatSession의 "완주 시에만 히스토리 기록" 원칙이 그대로 적용됨.
- **서버 생존**: CLI와 달리 `LlmConnectionError`에도 프로세스를 죽이지 않는다 — error 이벤트 후 다음 요청 처리.
- 신뢰 경계 입력 검증: body 크기 상한(1MB) + `message` 비어있지 않은 문자열 강제.

### Code
```ts
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from '../app/bootstrap.js';

export interface ChatServerConfig {
  app: App;
  /** 정적 UI 파일 경로. 기본: 이 파일 기준 ./public/index.html */
  indexHtmlPath?: string;
}

const MAX_BODY_BYTES = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('요청 본문이 너무 큽니다');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createChatServer(config: ChatServerConfig): Server {
  const { app } = config;
  const htmlPath =
    config.indexHtmlPath ??
    join(dirname(fileURLToPath(import.meta.url)), 'public', 'index.html');
  let chatting = false;

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (chatting) {
      sendJson(res, 409, { error: '이미 응답을 생성 중입니다. 잠시 후 다시 시도하세요.' });
      return;
    }
    let message: string;
    try {
      const parsed: unknown = JSON.parse(await readBody(req));
      if (
        !isRecord(parsed) ||
        typeof parsed['message'] !== 'string' ||
        parsed['message'].trim().length === 0
      ) {
        sendJson(res, 400, { error: 'message(비어있지 않은 문자열)가 필요합니다' });
        return;
      }
      message = parsed['message'].trim();
    } catch {
      sendJson(res, 400, { error: '잘못된 JSON 본문' });
      return;
    }

    chatting = true;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    try {
      for await (const piece of app.session.send(message)) {
        if (res.destroyed) {
          return; // 클라이언트 중단 — 제너레이터 조기 종료로 히스토리 미기록
        }
        res.write(`data: ${JSON.stringify({ piece })}\n\n`);
      }
      await app.store.save(app.session.getHistory());
      res.write('event: done\ndata: {}\n\n');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      res.write(`event: error\ndata: ${JSON.stringify({ error: detail })}\n\n`);
    } finally {
      chatting = false;
      res.end();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method ?? 'GET'} ${url.pathname}`;

    if (route === 'GET /') {
      let html: string;
      try {
        html = await readFile(htmlPath, 'utf8');
      } catch {
        sendJson(res, 404, { error: 'UI 파일이 없습니다' });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (route === 'GET /api/history') {
      sendJson(res, 200, { history: app.session.getHistory() });
      return;
    }
    if (route === 'POST /api/clear') {
      app.session.clear();
      await app.store.clear();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (route === 'POST /api/index') {
      const chunks = await app.rebuildIndex(new Date().toISOString());
      sendJson(res, 200, { chunks });
      return;
    }
    if (route === 'POST /api/chat') {
      await handleChat(req, res);
      return;
    }
    sendJson(res, 404, { error: `알 수 없는 경로: ${route}` });
  }

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: detail });
      } else {
        res.end();
      }
    });
  });
}
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
echo "N/A: 테스트는 Step 2에서 동반 작성"
# 3. 의미 검증
grep -c "res.destroyed" src/server/http-server.ts
  # 기대: 1 (클라이언트 중단 감지 경로 존재)
```

### 동반 변경 (Side Effects)

- 새 가드(409/400/본문 상한/error 이벤트) → 각 경로 테스트를 Step 2에서 동반
- 외부 호출(LLM 스트림) 실패 설계: error 이벤트 전송 + 서버 생존 (재시도는 클라이언트 몫) — Code에 명시
- 호출처(엔트리 main.ts, 웹 UI)는 Phase 2

### Do Not Touch

`src/app/bootstrap.ts`, `src/cli/**`, `src/llm/**`.

## Step 2: 서버 테스트 (`src/server/__tests__/http-server.test.ts` — create)

### Code

### 검증 대상

- spy: FakeLlmClient 스트림 제어(지연/실패) — 409 동시성·error 이벤트 유발
- branch: SSE 정상 완주(+세션 파일 저장), 400 검증, 409 동시 요청, error 이벤트 후 서버 생존, history/clear/index 라우트, GET / 정적 서빙, 404
- state: SSE 프레임 순서(data…→done), 파일 산출물, JSON 응답

```ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app/bootstrap.js';
import type { ChatMessage, ChatOptions, Embedder, LlmClient } from '../../llm/types.js';
import { createChatServer } from '../http-server.js';

class FakeLlmClient implements LlmClient {
  pieces: string[] = ['안녕', '하세요'];
  delayMs = 0;
  fail = false;

  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return '요약';
  }

  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string> {
    for (const piece of this.pieces) {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.fail) {
        throw new Error('llm down');
      }
      yield piece;
    }
  }
}

class FakeEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0]);
  }
}

describe('createChatServer', () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;
  let fake: FakeLlmClient;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'a.md'), '# 제목\n본문', 'utf8');
    fake = new FakeLlmClient();
    const app = await createApp(
      {
        CHATBOT_SESSION_FILE: join(dir, 'session.json'),
        CHATBOT_INDEX_FILE: join(dir, 'index.json'),
        RAG_DOCS_DIR: join(dir, 'docs'),
      },
      { client: fake, embedder: new FakeEmbedder() },
    );
    server = createChatServer({ app, indexHtmlPath: join(dir, 'index.html') });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  function postChat(message: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  }

  it('SSE로 조각을 스트리밍하고 done 이벤트로 끝나며 세션을 저장한다 (정상)', async () => {
    const res = await postChat('질문');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data: {"piece":"안녕"}');
    expect(text).toContain('data: {"piece":"하세요"}');
    expect(text.indexOf('event: done')).toBeGreaterThan(text.indexOf('하세요'));

    const saved: unknown = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'));
    expect((saved as { history: ChatMessage[] }).history).toHaveLength(2);
  });

  it('message가 없거나 빈 문자열이면 400 (에러)', async () => {
    expect((await postChat('')).status).toBe(400);
    expect((await postChat(123)).status).toBe(400);
  });

  it('응답 생성 중 새 채팅 요청은 409 (에러)', async () => {
    fake.delayMs = 40;
    const first = postChat('느린 질문');
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await postChat('끼어들기');
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
    await (await first).text();
  });

  it('스트림 실패 시 error 이벤트를 보내고 서버는 살아있다 (에러)', async () => {
    fake.fail = true;
    const res = await postChat('질문');
    const text = await res.text();
    expect(text).toContain('event: error');
    expect(text).toContain('llm down');

    fake.fail = false;
    const retry = await postChat('재시도');
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('event: done');
  });

  it('GET /api/history가 대화 후 히스토리를 반환한다 (정상)', async () => {
    await (await postChat('질문')).text();
    const res = await fetch(`${baseUrl}/api/history`);
    const data = (await res.json()) as { history: ChatMessage[] };
    expect(data.history).toHaveLength(2);
    expect(data.history.at(1)?.content).toBe('안녕하세요');
  });

  it('POST /api/clear가 히스토리와 세션 파일을 비운다 (정상)', async () => {
    await (await postChat('질문')).text();
    const res = await fetch(`${baseUrl}/api/clear`, { method: 'POST' });
    expect(res.status).toBe(200);
    const history = (await (await fetch(`${baseUrl}/api/history`)).json()) as {
      history: ChatMessage[];
    };
    expect(history.history).toEqual([]);
  });

  it('POST /api/index가 재인덱싱하고 청크 수를 반환한다 (정상)', async () => {
    const res = await fetch(`${baseUrl}/api/index`, { method: 'POST' });
    const data = (await res.json()) as { chunks: number };
    expect(data.chunks).toBe(1);
  });

  it('GET /는 UI 파일을 서빙하고, 없으면 404, 미지정 경로도 404 (경계값)', async () => {
    expect((await fetch(`${baseUrl}/`)).status).toBe(404);
    await writeFile(join(dir, 'index.html'), '<h1>ui</h1>', 'utf8');
    const ok = await fetch(`${baseUrl}/`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('<h1>ui</h1>');
    expect((await fetch(`${baseUrl}/none`)).status).toBe(404);
  });
});
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 전체 92 passed (84 + 8)
# 3. 의미 검증
grep -c "toBe(409)\|event: error" src/server/__tests__/http-server.test.ts
  # 기대: 3 (동시성·실패 경로 assertion)
```

### 동반 변경 (Side Effects)

N/A (Step 1의 동반 테스트)

### Do Not Touch

`src/server/http-server.ts`.

## 실행 순서

Step 1 → 2.

## 입출력 예제

| 요청 | 응답 |
|------|------|
| `POST /api/chat {"message":"질문"}` | 200 SSE: `data: {"piece":"안녕"}` … `event: done` |
| 생성 중 `POST /api/chat` | 409 `{"error":"이미 응답을 생성 중..."}` |
| `POST /api/chat {}` | 400 |
| 스트림 실패 | `event: error` + 서버 생존 |
| `GET /api/history` | `{"history":[...]}` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/server/http-server.ts
export interface ChatServerConfig { app: App; indexHtmlPath?: string; }
export function createChatServer(config: ChatServerConfig): Server; // node:http Server
```

## Definition of Done

- [ ] DoD-11: 모든 Step 통과 + Verify ✓
- [ ] DoD-12: `npm run typecheck` exit 0
- [ ] DoD-13: `npm test` 92 passed (기존 84 회귀 없음)
- [ ] DoD-14: 신뢰 경계(HTTP 입력) 검증 가드에 테스트 동반 (400/409/error 이벤트)
- [ ] DoD-15: 문서 갱신 불필요 (엔트리/명령은 Phase 2)
- [ ] DoD-16: Phase 2 전제 조건 만족

## Observability plan

N/A — 개인 로컬 서버. 요청/오류는 HTTP 응답 자체로 노출, 프로세스 로그는 Phase 2 엔트리의 시작 배너뿐.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 1 PASS"
```
