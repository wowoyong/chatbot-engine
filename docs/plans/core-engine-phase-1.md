# Phase 1: LLM 레이어 — LlmClient 인터페이스 + OllamaClient

@fidelity-check tokens: parseNdjsonStream, LlmConnectionError, LlmResponseError, releaseLock, think

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
   - 위반: `import { x } from './types'`
   - 수정: `import { x } from './types.js'`
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
   - 위반: `const data: any = JSON.parse(line)`
   - 수정: `const data: unknown = JSON.parse(line)` 후 타입 가드로 좁히기
3. 런타임 의존성 추가 금지 — fetch/스트림은 Node 20 내장 API만 사용
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어
5. `noUncheckedIndexedAccess` 활성 — 인덱스 접근 결과는 `undefined` 가드 필수

## 전제 조건

Phase 0이 노출한 인터페이스 (그대로 복사):

```ts
// src/index.ts
export const ENGINE_VERSION = '0.1.0';
```

설정: `package.json`(scripts: dev/build/typecheck/test), `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` (테스트 위치 `src/**/__tests__/**/*.test.ts`).

## 현재 상태

`src/index.ts`만 존재. `src/llm/` 디렉토리 없음. Ollama native API 계약 (로컬 확인 완료):

- `POST http://localhost:11434/api/chat` body: `{ model, messages, stream: true, think: false }`
- 응답: ndjson 스트림 — 각 라인 `{"message":{"role":"assistant","content":"조각"},"done":false}` 마지막 라인 `"done":true`
- 에러 시: `{"error":"메시지"}` 라인 또는 HTTP 4xx/5xx
- 설치 확인된 모델: `qwen3:8b` (thinking capability 있음 → `think: false`로 비활성)

## Step 1: 코어 타입 정의 (`src/llm/types.ts` — create)

### Context

엔진 전체의 가장 중요한 경계선. 이후 모든 Phase(세션, RAG, LangChain 전환)가 이 인터페이스에만 의존한다.

### Code
```ts
export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  /** 모델의 thinking(chain-of-thought) 활성 여부. 기본 false — CLI 대화 UX 보호 */
  think?: boolean;
  /** 요청 타임아웃(ms). 기본 120_000 */
  timeoutMs?: number;
}

export interface LlmClient {
  /** 전체 응답을 한 번에 반환 */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  /** 응답 content 조각을 도착 순서대로 yield */
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
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
echo "N/A: 타입-only 파일 — typecheck로 갈음"
# 3. 의미 검증
grep -c "interface LlmClient" src/llm/types.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

N/A (새 인터페이스의 소비자는 Step 4 OllamaClient와 Phase 2 ChatSession — 각 Step에서 import)

### Do Not Touch

`src/index.ts`, 설정 파일 전체.

## Step 2: 에러 타입 (`src/llm/errors.ts` — create)

### Context

신뢰 경계(외부 프로세스 Ollama)에서 발생하는 실패를 두 계층으로 구분: 연결 자체 실패(`LlmConnectionError` — 서버 미기동) vs 서버가 응답했으나 오류(`LlmResponseError` — 4xx/5xx, 스트림 내 error 라인). CLI가 전자를 잡아 친절한 안내 후 종료한다 (AC3).

### Code
```ts
export class LlmConnectionError extends Error {
  constructor(baseUrl: string, cause?: unknown) {
    super(
      `Ollama 서버(${baseUrl})에 연결할 수 없습니다. 'ollama serve' 실행 여부를 확인하세요.`,
      { cause },
    );
    this.name = 'LlmConnectionError';
  }
}

export class LlmResponseError extends Error {
  readonly status: number;

  /** status 0 = 스트림 내부 오류 (HTTP 레벨은 200이었으나 본문에 error 라인) */
  constructor(status: number, detail: string) {
    super(`Ollama 응답 오류(status ${status}): ${detail}`);
    this.name = 'LlmResponseError';
    this.status = status;
  }
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
echo "N/A: 에러 클래스 — throw 경로 테스트는 Step 5~6에서 동반"
# 3. 의미 검증
grep -c "class Llm.*Error extends Error" src/llm/errors.ts
  # 기대: 2
```

### 동반 변경 (Side Effects)

새 가드/throw 추가 → throw 경로 단위 테스트는 Step 5(스트림 error 라인), Step 6(연결 실패/404)에서 작성 (같은 Phase 내 동반).

### Do Not Touch

`src/llm/types.ts`.

## Step 3: ndjson 스트림 파서 (`src/llm/ndjson.ts` — create)

### Context

이 Segment의 핵심 학습 포인트. HTTP 청크는 ndjson 라인 경계와 무관하게 잘려 도착하므로(멀티바이트 문자 중간 포함) 버퍼링이 필수다. `TextDecoder(stream: true)`가 UTF-8 경계를, 라인 버퍼가 JSON 경계를 각각 책임진다.

### Code
```ts
import { LlmResponseError } from './errors.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * ndjson 한 라인에서 content 조각을 추출한다.
 * - error 라인이면 LlmResponseError(0) throw
 * - content 없는 라인(done 마커 등)이면 null
 */
function extractContent(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new LlmResponseError(0, `잘못된 ndjson 라인: ${line}`);
  }
  if (!isRecord(parsed)) {
    throw new LlmResponseError(0, `객체가 아닌 ndjson 라인: ${line}`);
  }
  const errorField = parsed['error'];
  if (typeof errorField === 'string') {
    throw new LlmResponseError(0, errorField);
  }
  const message = parsed['message'];
  if (!isRecord(message)) {
    return null;
  }
  const content = message['content'];
  return typeof content === 'string' && content.length > 0 ? content : null;
}

/**
 * ReadableStream<Uint8Array>를 ndjson으로 파싱해 content 조각을 yield.
 * 청크가 라인/멀티바이트 문자 경계와 무관하게 잘려도 안전하다.
 */
export async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          const piece = extractContent(line);
          if (piece !== null) {
            yield piece;
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest.length > 0) {
      const piece = extractContent(rest);
      if (piece !== null) {
        yield piece;
      }
    }
  } finally {
    reader.releaseLock();
  }
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
echo "N/A: 테스트는 Step 5에서 동반 작성 후 npm test로 검증"
# 3. 의미 검증
grep -c "releaseLock" src/llm/ndjson.ts
  # 기대: 1 (finally에서 리소스 해제)
```

### 동반 변경 (Side Effects)

새 추상화/export → 호출처(Step 4 OllamaClient)와 단위 테스트(Step 5)를 같은 Phase에서 작성.

### Do Not Touch

`src/llm/types.ts`, `src/llm/errors.ts`.

## Step 4: Ollama 클라이언트 (`src/llm/ollama-client.ts` — create)

### Context

`LlmClient`의 첫 구현체. `fetchFn` 생성자 주입으로 테스트에서 실서버 없이 검증한다 (Testability Review 참조). `chat()`은 `chatStream()`을 소비해 합치는 구조 — 스트리밍이 단일 소스.

### Code
```ts
import { LlmConnectionError, LlmResponseError } from './errors.js';
import { parseNdjsonStream } from './ndjson.js';
import type { ChatMessage, ChatOptions, LlmClient } from './types.js';

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OllamaClientConfig {
  /** 기본 http://localhost:11434 */
  baseUrl?: string;
  /** 기본 qwen3:8b */
  model?: string;
  /** 테스트 주입용. 기본 globalThis.fetch */
  fetchFn?: FetchLike;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen3:8b';
const DEFAULT_TIMEOUT_MS = 120_000;

export class OllamaClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: FetchLike;

  constructor(config: OllamaClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.model = config.model ?? DEFAULT_MODEL;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    let result = '';
    for await (const piece of this.chatStream(messages, options)) {
      result += piece;
    }
    return result;
  }

  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<string> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`요청이 ${timeoutMs}ms 안에 완료되지 않았습니다`));
    }, timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          think: options.think ?? false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new LlmConnectionError(this.baseUrl, err);
    }

    try {
      if (!response.ok) {
        const detail = await response.text();
        throw new LlmResponseError(response.status, detail);
      }
      if (response.body === null) {
        throw new LlmResponseError(response.status, '응답 본문이 비어 있습니다');
      }
      yield* parseNdjsonStream(response.body);
    } finally {
      clearTimeout(timer);
    }
  }
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
echo "N/A: 테스트는 Step 6에서 동반 작성 후 npm test로 검증"
# 3. 의미 검증
grep -c "clearTimeout" src/llm/ollama-client.ts
  # 기대: 2 (연결 실패 경로 + finally — 타이머 누수 없음)
```

### 동반 변경 (Side Effects)

- 새 추상화/export → 호출처는 Phase 2 CLI (Segment 내 후속 Phase), 단위 테스트는 Step 6 (같은 Phase)
- `src/index.ts`에 재수출 추가는 하지 않음 (YAGNI — 외부 패키지 소비자 없음)

### Do Not Touch

`src/llm/types.ts`, `src/llm/errors.ts`, `src/llm/ndjson.ts` (Step 1~3 완료본).

## Step 5: ndjson 파서 테스트 (`src/llm/__tests__/ndjson.test.ts` — create)

### Code

### 검증 대상

- spy: N/A (순수 파서 — 부작용 없음)
- branch: 라인 버퍼링(청크 경계 분리), 멀티바이트 문자 중간 분리, error 라인 throw, content 없는 done 라인 skip, 마지막 개행 없는 잔여 버퍼 처리
- state: yield된 조각 배열이 기대 순서/내용과 일치

```ts
import { describe, expect, it } from 'vitest';
import { LlmResponseError } from '../errors.js';
import { parseNdjsonStream } from '../ndjson.js';

function bytesStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function textStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return bytesStream(chunks.map((c) => encoder.encode(c)));
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of iter) {
    out.push(piece);
  }
  return out;
}

describe('parseNdjsonStream', () => {
  it('완전한 라인들에서 content 조각을 순서대로 yield한다 (정상)', async () => {
    const stream = textStream([
      '{"message":{"content":"Hel"}}\n{"message":{"content":"lo"}}\n{"done":true}\n',
    ]);
    expect(await collect(parseNdjsonStream(stream))).toEqual(['Hel', 'lo']);
  });

  it('청크가 라인 중간에서 잘려도 버퍼링으로 복원한다 (경계값)', async () => {
    const stream = textStream([
      '{"message":{"con',
      'tent":"Hel"}}\n{"message',
      '":{"content":"lo"}}\n{"done":true}\n',
    ]);
    expect(await collect(parseNdjsonStream(stream))).toEqual(['Hel', 'lo']);
  });

  it('멀티바이트 문자(UTF-8 3바이트) 중간에서 잘려도 복원한다 (경계값)', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('{"message":{"content":"안녕"}}\n');
    // '{"message":{"content":"' 는 ASCII 23바이트, 그 다음 3바이트가 '안' — 24에서 자르면 문자 중간
    const splitAt = 24;
    const stream = bytesStream([bytes.slice(0, splitAt), bytes.slice(splitAt)]);
    expect(await collect(parseNdjsonStream(stream))).toEqual(['안녕']);
  });

  it('마지막 라인에 개행이 없어도 잔여 버퍼를 파싱한다 (경계값)', async () => {
    const stream = textStream(['{"message":{"content":"tail"}}']);
    expect(await collect(parseNdjsonStream(stream))).toEqual(['tail']);
  });

  it('error 라인을 만나면 LlmResponseError를 던진다 (에러)', async () => {
    const stream = textStream(['{"error":"model not found"}\n']);
    await expect(collect(parseNdjsonStream(stream))).rejects.toThrow(
      LlmResponseError,
    );
    const stream2 = textStream(['{"error":"model not found"}\n']);
    await expect(collect(parseNdjsonStream(stream2))).rejects.toThrow(
      'model not found',
    );
  });

  it('JSON이 아닌 라인을 만나면 LlmResponseError를 던진다 (에러)', async () => {
    const stream = textStream(['not-json\n']);
    await expect(collect(parseNdjsonStream(stream))).rejects.toThrow(
      LlmResponseError,
    );
  });

  it('content 없는 done 라인은 yield하지 않는다 (경계값)', async () => {
    const stream = textStream([
      '{"message":{"content":""},"done":false}\n{"done":true}\n',
    ]);
    expect(await collect(parseNdjsonStream(stream))).toEqual([]);
  });

  it('빈 스트림이면 아무것도 yield하지 않는다 (경계값)', async () => {
    const stream = textStream([]);
    expect(await collect(parseNdjsonStream(stream))).toEqual([]);
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
  # 기대: ndjson.test.ts 8 passed
# 3. 의미 검증
grep -c "rejects.toThrow" src/llm/__tests__/ndjson.test.ts
  # 기대: 3 (에러 경로 assertion 존재)
```

### 동반 변경 (Side Effects)

N/A (Step 2~3의 동반 테스트가 본 Step)

### Do Not Touch

`src/llm/ndjson.ts` (테스트가 실패하면 계획의 Code를 재확인 — 구현을 임의 수정하지 않음).

## Step 6: OllamaClient 테스트 (`src/llm/__tests__/ollama-client.test.ts` — create)

### Code

### 검증 대상

- spy: `fetchFn` mock — 호출 URL(`/api/chat`), body의 `model`/`stream`/`think` 값
- branch: 연결 실패(reject) → `LlmConnectionError`, HTTP 404 → `LlmResponseError(404)`, body null → `LlmResponseError`, `think: true` 옵션 전달
- state: `chat()` 반환값이 스트림 조각의 연결 문자열과 일치

```ts
import { describe, expect, it, vi } from 'vitest';
import { LlmConnectionError, LlmResponseError } from '../errors.js';
import { OllamaClient } from '../ollama-client.js';
import type { ChatMessage } from '../types.js';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: '안녕' }];

function ndjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe('OllamaClient', () => {
  it('스트림 조각을 합쳐 전체 응답을 반환하고 올바른 요청을 보낸다 (정상)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      ndjsonResponse([
        '{"message":{"content":"안녕"}}',
        '{"message":{"content":"하세요"}}',
        '{"done":true}',
      ]),
    );
    const client = new OllamaClient({ fetchFn });

    const result = await client.chat(MESSAGES);

    expect(result).toBe('안녕하세요');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls[0];
    expect(call).toBeDefined();
    expect(String(call?.[0])).toBe('http://localhost:11434/api/chat');
    const body: unknown = JSON.parse(String(call?.[1]?.body));
    expect(body).toMatchObject({
      model: 'qwen3:8b',
      stream: true,
      think: false,
      messages: [{ role: 'user', content: '안녕' }],
    });
  });

  it('think 옵션이 body에 그대로 전달된다 (정상)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      ndjsonResponse(['{"done":true}']),
    );
    const client = new OllamaClient({ fetchFn });

    await client.chat(MESSAGES, { think: true });

    const body: unknown = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ think: true });
  });

  it('연결이 거부되면 LlmConnectionError로 감싸 던진다 (에러)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      throw new TypeError('fetch failed');
    });
    const client = new OllamaClient({ fetchFn, baseUrl: 'http://localhost:9' });

    await expect(client.chat(MESSAGES)).rejects.toThrow(LlmConnectionError);
    await expect(client.chat(MESSAGES)).rejects.toThrow('연결할 수 없습니다');
  });

  it('HTTP 에러 상태면 LlmResponseError에 status를 담아 던진다 (에러)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response('model "x" not found', { status: 404 }),
    );
    const client = new OllamaClient({ fetchFn });

    const error = await client.chat(MESSAGES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmResponseError);
    expect((error as LlmResponseError).status).toBe(404);
  });

  it('응답 본문이 null이면 LlmResponseError를 던진다 (경계값)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
    );
    const client = new OllamaClient({ fetchFn });

    await expect(client.chat(MESSAGES)).rejects.toThrow(LlmResponseError);
  });

  it('baseUrl과 model 설정이 요청에 반영된다 (경계값)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      ndjsonResponse(['{"done":true}']),
    );
    const client = new OllamaClient({
      fetchFn,
      baseUrl: 'http://mac-mini:11434',
      model: 'qwen3:14b',
    });

    await client.chat(MESSAGES);

    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      'http://mac-mini:11434/api/chat',
    );
    const body: unknown = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ model: 'qwen3:14b' });
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
  # 기대: 2개 테스트 파일, 14 passed
# 3. 의미 검증
grep -c "toHaveBeenCalledTimes\|toMatchObject" src/llm/__tests__/ollama-client.test.ts
  # 기대: 5 이상 (spy 검증 존재)
```

### 동반 변경 (Side Effects)

N/A (Step 4의 동반 테스트가 본 Step)

### Do Not Touch

`src/llm/ollama-client.ts` (테스트 실패 시 계획의 Code 재확인).

## 실행 순서

Step 1 → 2 → 3 → 4 → 5 → 6 (타입 → 에러 → 파서 → 클라이언트 → 테스트 순 의존).

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `parseNdjsonStream` | 청크 `['{"message":{"con', 'tent":"Hi"}}\n']` | yield `'Hi'` |
| `parseNdjsonStream` | `'{"error":"x"}\n'` | throw `LlmResponseError(0, 'x')` |
| `OllamaClient.chat` | `[{role:'user',content:'안녕'}]` (mock: 조각 `안녕`,`하세요`) | `'안녕하세요'` |
| `OllamaClient.chat` | fetch reject | throw `LlmConnectionError` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/llm/types.ts
export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage { role: ChatRole; content: string; }
export interface ChatOptions { think?: boolean; timeoutMs?: number; }
export interface LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}

// src/llm/errors.ts
export class LlmConnectionError extends Error {
  constructor(baseUrl: string, cause?: unknown);
}
export class LlmResponseError extends Error {
  readonly status: number;
  constructor(status: number, detail: string);
}

// src/llm/ndjson.ts
export function parseNdjsonStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string>;

// src/llm/ollama-client.ts
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface OllamaClientConfig { baseUrl?: string; model?: string; fetchFn?: FetchLike; }
export class OllamaClient implements LlmClient {
  constructor(config?: OllamaClientConfig);
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string>;
}
```

## Definition of Done

- [ ] DoD-11: 모든 Step 통과 + Verify 명령 ✓
- [ ] DoD-12: `npm run typecheck` exit 0
- [ ] DoD-13: `npm test` — 14 테스트 전체 통과 (Ollama 불필요)
- [ ] DoD-14: 새 함수/클래스에 단위 테스트 동반 (Step 5~6)
- [ ] DoD-15: 문서 갱신 불필요 (CLAUDE.md의 LlmClient 언급 이미 존재)
- [ ] DoD-16: Phase 2 전제 조건 만족 (노출 인터페이스 위 명세와 일치)

## Observability plan

N/A — 운영 영향 없음 (로컬 학습 프로젝트). 로깅은 CLI 레이어(Phase 2)의 stdout이 유일한 출력.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 1 PASS"
```
