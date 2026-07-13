# Phase 0: 스트리밍 메타데이터 채널 (파서 stats + 세션 TurnMeta)

@fidelity-check tokens: NdjsonStats, TurnMeta, SourceRef, promptTokens, responseTokens, sources

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성 — `.at()`/`?? ` 가드

## 전제 조건

Segment 1·3 인터페이스 (그대로 복사):

```ts
// src/llm/types.ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatOptions { think?: boolean; timeoutMs?: number; }
export interface LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}
// src/rag/retriever.ts — RetrievedContext { block: string | null; hits: SearchHit[] }
// src/rag/vector-index.ts — SearchHit { chunk: IndexedChunk; score: number }, IndexedChunk { source; heading; content; embedding }
```

## 현재 상태

`parseNdjsonStream`은 done 청크의 `prompt_eval_count`/`eval_count`를 버린다. `chatStream`/`send`는 `AsyncGenerator<string>`이라 완료 메타를 전달할 채널이 없다. 설계: **generator는 content를 yield하고 완료 시 메타를 return** — `for await`로 소비하는 기존 코드(CLI·서버·테스트)는 return을 무시하므로 무변경 통과.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| ndjson 파서 (순수) | ✓ | ✓ (ReadableStream) | — |
| OllamaClient (fetchFn) | ✓ | ✓ | 기존 패턴 |
| ChatSession (LlmClient) | ✓ | ✓ (Fake) | — |

## Step 1: 파서가 done 통계를 return (`src/llm/ndjson.ts` — modify, 전체 교체)

### Context

`extractContent`가 content만 뽑던 것을, done 라인의 `prompt_eval_count`/`eval_count`도 포착하도록 확장. generator는 content 조각을 yield하고 완료 시 `NdjsonStats`를 return. content 라인 처리는 불변(기존 8 테스트 회귀 없음).

### Code
```ts
import { LlmResponseError } from './errors.js';

export interface NdjsonStats {
  promptTokens?: number;
  responseTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** ndjson 한 라인에서 content 조각을 추출. error면 throw, content 없으면 null */
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

/** ndjson 한 라인에서 done 통계를 추출 (없으면 빈 객체) */
function extractStats(line: string): NdjsonStats {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  return {
    promptTokens: numberOrUndefined(parsed['prompt_eval_count']),
    responseTokens: numberOrUndefined(parsed['eval_count']),
  };
}

/**
 * ReadableStream을 ndjson으로 파싱해 content 조각을 yield하고, 완료 시 토큰 통계를 return.
 * 청크가 라인/멀티바이트 경계와 무관하게 잘려도 안전.
 */
export async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, NdjsonStats> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stats: NdjsonStats = {};
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
          const lineStats = extractStats(line);
          if (lineStats.promptTokens !== undefined) {
            stats = lineStats;
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
      const restStats = extractStats(rest);
      if (restStats.promptTokens !== undefined) {
        stats = restStats;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return stats;
}
```

### Anchor

파일 전체 교체.

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 133 passed — 기존 ndjson 8 테스트 회귀 없음 (content yield 불변)
# 3. 의미 검증
grep -c "return stats" src/llm/ndjson.ts
  # 기대: 1 (완료 시 통계 반환)
```

### 동반 변경 (Side Effects)

새 return 타입 → 소비자(Step 2 OllamaClient) + 통계 테스트(Step 4).

### Do Not Touch

`src/llm/errors.ts`, `src/llm/types.ts`.

## Step 2: OllamaClient가 통계를 return (`src/llm/ollama-client.ts` — modify, chatStream 반환 타입)

### Context

`chatStream`이 파서의 return(NdjsonStats)을 그대로 return. `yield*`는 위임 generator의 return을 전파한다. `chat()`은 통계 불필요 — 기존대로 content만 합산.

### Code

(a) 파일 상단 import에 타입 추가 —

교체 전:
```ts
import { parseNdjsonStream } from './ndjson.js';
```
교체 후:
```ts
import { parseNdjsonStream } from './ndjson.js';
import type { NdjsonStats } from './ndjson.js';
```

(b) `chatStream` 시그니처 반환 타입 교체 —

교체 전:
```ts
  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<string> {
```
교체 후:
```ts
  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<string, NdjsonStats> {
```

(c) `yield* parseNdjsonStream(response.body);` 교체 —

교체 전:
```ts
      yield* parseNdjsonStream(response.body);
```
교체 후:
```ts
      return yield* parseNdjsonStream(response.body);
```

### Anchor

각 교체 전 텍스트는 파일 내 유일.

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 133 passed (기존 ollama-client 6 테스트 회귀 없음)
# 3. 의미 검증
grep -c "return yield\* parseNdjsonStream" src/llm/ollama-client.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

LlmClient 인터페이스의 `chatStream` 반환은 `AsyncIterable<string>`으로 유지(Step 3에서 통계 소비는 OllamaClient 구체 타입 또는 옵셔널) — 인터페이스 광의 호환. 통계 소비는 Step 3.

### Do Not Touch

`chat` 메서드, 에러 처리 로직.

## Step 3: ChatSession이 TurnMeta를 return (`src/chat/session.ts` — modify, send 반환 + lastSources)

### Context

`send`가 content를 yield하고 완료 시 `TurnMeta`(출처 + 토큰)를 return. 출처는 retriever의 hits에서 경량 `SourceRef`로 추출. 토큰은 client의 chatStream이 통계를 return하면 포착(옵셔널 — Fake client는 통계 없음). 기존 send 소비자(for await)는 return 무시로 무변경.

### Code

(a) 파일 상단, ContextRetriever 인터페이스 위에 타입 추가:
```ts
export interface SourceRef {
  source: string;
  heading: string;
}

export interface TurnMeta {
  sources: SourceRef[];
  promptTokens?: number;
  responseTokens?: number;
}
```

(b) `ContextRetriever` 인터페이스 교체 (hits 노출) —

교체 전:
```ts
export interface ContextRetriever {
  retrieve(query: string): Promise<{ block: string | null }>;
}
```
교체 후:
```ts
export interface ContextRetriever {
  retrieve(query: string): Promise<{ block: string | null; hits?: { chunk: { source: string; heading: string } }[] }>;
}
```

(c) `send` 메서드 전체 교체:
```ts
  async *send(userInput: string, options?: ChatOptions): AsyncGenerator<string, TurnMeta> {
    let contextBlock: string | null = null;
    let sources: SourceRef[] = [];
    if (this.retriever !== null) {
      try {
        const retrieved = await this.retriever.retrieve(userInput);
        contextBlock = retrieved.block;
        sources = (retrieved.hits ?? []).map((h) => ({
          source: h.chunk.source,
          heading: h.chunk.heading,
        }));
      } catch {
        contextBlock = null;
      }
    }

    const prepared = await this.contextManager.prepare(
      this.systemPrompt,
      this.history,
      userInput,
      contextBlock,
    );

    let assistantContent = '';
    const stats = yield* this.streamContent(prepared.messages, options, (piece) => {
      assistantContent += piece;
    });

    this.history.push({ role: 'user', content: userInput });
    this.history.push({ role: 'assistant', content: assistantContent });
    return {
      sources,
      promptTokens: stats.promptTokens,
      responseTokens: stats.responseTokens,
    };
  }

  private async *streamContent(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    onPiece: (piece: string) => void,
  ): AsyncGenerator<string, { promptTokens?: number; responseTokens?: number }> {
    const iterator = this.client.chatStream(messages, options)[Symbol.asyncIterator]();
    let result = await iterator.next();
    while (result.done !== true) {
      onPiece(result.value);
      yield result.value;
      result = await iterator.next();
    }
    const ret: unknown = result.value;
    if (ret !== null && typeof ret === 'object') {
      const r = ret as { promptTokens?: number; responseTokens?: number };
      return { promptTokens: r.promptTokens, responseTokens: r.responseTokens };
    }
    return {};
  }
```

### Anchor

- (a)(b) `export interface ContextRetriever {` 블록 (유일)
- (c) `async *send(` 메서드 전체 (유일)

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 133 passed — 기존 session 테스트(for await 소비)는 return 무시로 회귀 없음
# 3. 의미 검증
grep -c "return {" src/chat/session.ts
  # 기대: 3 이상 (send/streamContent의 메타 반환)
```

### 동반 변경 (Side Effects)

새 반환 타입 → 소비자(Phase 1 서버·CLI)가 메타 활용. 통계 경로 테스트는 Step 4.

### Do Not Touch

`restore`/`getHistory`/`clear`, `src/context/**`.

## Step 4: 메타 채널 테스트 (`src/llm/__tests__/ndjson-stats.test.ts`, `src/chat/__tests__/session-meta.test.ts` — create)

### Code

### 검증 대상

- spy: N/A / Fake generator return
- branch: done 통계 파싱, 통계 없는 스트림, session이 출처·토큰 return
- state: NdjsonStats·TurnMeta 값

(a) `src/llm/__tests__/ndjson-stats.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseNdjsonStream } from '../ndjson.js';

function textStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

async function drain(iter: AsyncGenerator<string, { promptTokens?: number; responseTokens?: number }>) {
  const pieces: string[] = [];
  let r = await iter.next();
  while (r.done !== true) {
    pieces.push(r.value);
    r = await iter.next();
  }
  return { pieces, stats: r.value };
}

describe('parseNdjsonStream 통계', () => {
  it('done 라인의 prompt_eval_count/eval_count를 return한다 (정상)', async () => {
    const stream = textStream([
      '{"message":{"content":"안녕"}}\n{"done":true,"prompt_eval_count":12,"eval_count":34}\n',
    ]);
    const { pieces, stats } = await drain(parseNdjsonStream(stream));
    expect(pieces).toEqual(['안녕']);
    expect(stats).toEqual({ promptTokens: 12, responseTokens: 34 });
  });

  it('통계가 없으면 빈 객체를 return한다 (경계값)', async () => {
    const stream = textStream(['{"message":{"content":"x"}}\n']);
    const { stats } = await drain(parseNdjsonStream(stream));
    expect(stats.promptTokens).toBeUndefined();
  });
});
```

(b) `src/chat/__tests__/session-meta.test.ts`:

### 검증 대상
- spy: N/A (Fake client return)
- branch: 통계 있는 client → TurnMeta 토큰 포함, retriever 없음 → sources 빈 배열
- state: meta.sources / promptTokens / responseTokens

```ts
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, LlmClient } from '../../llm/types.js';
import { ChatSession } from '../session.js';

class StatsClient implements LlmClient {
  async chat(): Promise<string> {
    return 'x';
  }
  async *chatStream(
    _m: ChatMessage[],
    _o?: ChatOptions,
  ): AsyncGenerator<string, { promptTokens?: number; responseTokens?: number }> {
    yield '안';
    yield '녕';
    return { promptTokens: 5, responseTokens: 2 };
  }
}

async function drainSend(gen: AsyncGenerator<string, unknown>) {
  const pieces: string[] = [];
  let r = await gen.next();
  while (r.done !== true) {
    pieces.push(r.value);
    r = await gen.next();
  }
  return { pieces, meta: r.value };
}

describe('ChatSession TurnMeta', () => {
  it('완료 시 출처와 토큰 수를 return한다 (정상)', async () => {
    const session = new ChatSession(new StatsClient(), {
      retriever: {
        retrieve: async () => ({
          block: '[doc.md]\n발췌',
          hits: [{ chunk: { source: 'doc.md', heading: '설치' } }],
        }),
      },
    });
    const { pieces, meta } = await drainSend(session.send('질문'));
    expect(pieces).toEqual(['안', '녕']);
    expect(meta).toEqual({
      sources: [{ source: 'doc.md', heading: '설치' }],
      promptTokens: 5,
      responseTokens: 2,
    });
  });

  it('retriever가 없으면 출처는 빈 배열 (경계값)', async () => {
    const session = new ChatSession(new StatsClient());
    const { meta } = await drainSend(session.send('질문'));
    expect((meta as { sources: unknown[] }).sources).toEqual([]);
  });
});
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 전체 137 passed (133 + 4)
# 3. 의미 검증
grep -c "promptTokens: 5\|promptTokens: 12" src/chat/__tests__/session-meta.test.ts src/llm/__tests__/ndjson-stats.test.ts
  # 기대: 2 (통계 assertion)
```

### 동반 변경 (Side Effects)

N/A (Step 1·3의 동반 테스트)

### Do Not Touch

구현 파일(ndjson.ts, session.ts).

## 실행 순서

Step 1 → 2 → 3 → 4.

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `parseNdjsonStream` | done에 `prompt_eval_count:12` | yield content, return `{promptTokens:12,...}` |
| `session.send` | retriever hits 1건 + 통계 client | yield 조각, return `{sources:[1건], promptTokens, responseTokens}` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/llm/ndjson.ts
export interface NdjsonStats { promptTokens?: number; responseTokens?: number; }
export function parseNdjsonStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string, NdjsonStats>;

// src/llm/ollama-client.ts — chatStream: AsyncGenerator<string, NdjsonStats>

// src/chat/session.ts
export interface SourceRef { source: string; heading: string; }
export interface TurnMeta { sources: SourceRef[]; promptTokens?: number; responseTokens?: number; }
// send(...): AsyncGenerator<string, TurnMeta>
// ContextRetriever.retrieve → { block; hits? }
```

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify ✓
- [ ] DoD-02: typecheck exit 0
- [ ] DoD-03: `npm test` 137 passed (기존 133 회귀 없음)
- [ ] DoD-04: 통계 파싱·TurnMeta return 테스트 동반
- [ ] DoD-05: 문서 갱신 불필요
- [ ] DoD-06: Phase 1 전제 만족

## Observability plan

N/A — 토큰 수 자체가 관찰 데이터 (Phase 1에서 노출).

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 0 PASS"
```
