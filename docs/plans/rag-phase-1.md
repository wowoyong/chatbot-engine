# Phase 1: atomic write 유틸 추출 + OllamaEmbedder

@fidelity-check tokens: writeFileAtomic, OllamaEmbedder, embedBatch, batchSize

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어
5. `noUncheckedIndexedAccess` 활성
6. 테스트 파일 시스템은 `.test-tmp/<uuid>/`만 사용 (시스템 temp 금지 — 보안 정책)

## 전제 조건

Phase 0이 노출한 인터페이스: 본 Phase 미사용 (Phase 2에서 사용).

Segment 1~2 인터페이스 중 사용하는 것 (그대로 복사):

```ts
// src/llm/errors.ts
export class LlmConnectionError extends Error { constructor(baseUrl: string, cause?: unknown); }
export class LlmResponseError extends Error { readonly status: number; constructor(status: number, detail: string); }

// src/llm/ollama-client.ts
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

// src/store/session-store.ts — save()가 내부에서 mkdir + writeFile(tmp) + rename 수행 중 (추출 대상)
```

## 현재 상태

- `src/store/session-store.ts`의 `save()`에 atomic write 로직이 인라인으로 존재. RAG 인덱스 저장(Phase 2)도 같은 로직이 필요 — 중복 방지를 위해 공용 유틸로 추출한다. 기존 store 테스트 6개(왕복/tmp 잔존 없음 포함)가 리팩터의 회귀 검증이 된다.
- `src/llm/types.ts`에 `Embedder` 인터페이스 없음. `FetchLike`는 ollama-client.ts에 단일 정의 (sweep 확인: 3 hits 모두 그 파일) — 새 embedder는 import로 재사용한다.

## Step 1: atomic write 유틸 (`src/store/atomic-file.ts` — create)

### Code

```ts
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 원자적 파일 쓰기: 디렉토리 생성 → `<파일>.tmp`에 기록 → rename */
export async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, filePath);
}
```

### Context

SessionStore.save()의 인라인 로직을 함수로 승격 — 동작 동일 (mkdir recursive → tmp 기록 → rename).

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
echo "N/A: 테스트는 Step 3에서 동반 작성"
# 3. 의미 검증
grep -c "rename(tmpPath, filePath)" src/store/atomic-file.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

새 추상화 export → 호출처 갱신(Step 2 SessionStore) + 단위 테스트(Step 3)를 같은 Phase에서 수행.

### Do Not Touch

`src/llm/**`, `src/rag/**`, `src/chat/**`.

## Step 2: SessionStore 리팩터 (`src/store/session-store.ts` — modify, save 메서드 교체 + import 정리)

### Context

save()가 writeFileAtomic을 사용하도록 변경. 동작 불변 — 기존 테스트 6개가 그대로 통과해야 한다.

### Code

(a) 파일 상단 import 두 줄을 다음으로 교체:

교체 전:
```ts
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
```

교체 후:
```ts
import { readFile, rename, rm } from 'node:fs/promises';
import { writeFileAtomic } from './atomic-file.js';
```

(b) `save` 메서드 전체를 다음으로 교체:

```ts
  /** 원자적 저장: writeFileAtomic (tmp 기록 → rename) */
  async save(history: readonly ChatMessage[]): Promise<void> {
    const data: PersistedSession = {
      version: 1,
      history: history.map((m) => ({ ...m })),
      savedAt: new Date().toISOString(),
    };
    await writeFileAtomic(this.filePath, JSON.stringify(data, null, 2));
  }
```

### Anchor

- (a) 파일 최상단의 `import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';`부터 `import { dirname } from 'node:path';`까지 2줄 (유일)
- (b) `  async save(history: readonly ChatMessage[]): Promise<void> {`로 시작해 그 메서드의 닫는 `  }`까지 (메서드명 유일)

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0 (mkdir/writeFile/dirname 미사용 import가 남으면 여기서 잡히지 않으므로 3번에서 확인)
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 55 passed — session-store 기존 6개 회귀 없음 (왕복 + tmp 잔존 없음 포함)
# 3. 의미 검증
grep -c "mkdir\|dirname\|writeFile(" src/store/session-store.ts
  # 기대: 0 (인라인 atomic 로직과 미사용 import가 완전히 제거됨)
```

### 동반 변경 (Side Effects)

리팩터로 미사용이 된 import(mkdir, writeFile, dirname) 제거 — (a)에 포함됨.

### Do Not Touch

`load()`/`clear()` 메서드, 타입 가드 함수들, `src/store/__tests__/session-store.test.ts` (기존 테스트가 회귀 검증 그 자체 — 수정 금지).

## Step 3: atomic 유틸 테스트 (`src/store/__tests__/atomic-file.test.ts` — create)

### Code

### 검증 대상

- spy: N/A (실제 FS — 결과 파일로 검증)
- branch: 왕복 기록, 중첩 디렉토리 자동 생성, tmp 잔존 없음
- state: 파일 내용 일치, 디렉토리 내 파일 목록

```ts
import { readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../atomic-file.js';

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(() => {
    dir = join('.test-tmp', randomUUID());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('기록한 내용을 그대로 읽을 수 있다 (정상)', async () => {
    const path = join(dir, 'a.json');
    await writeFileAtomic(path, '{"x":1}');
    expect(await readFile(path, 'utf8')).toBe('{"x":1}');
  });

  it('중첩 디렉토리가 없어도 자동 생성한다 (경계값)', async () => {
    const path = join(dir, 'deep', 'nested', 'a.txt');
    await writeFileAtomic(path, 'v');
    expect(await readFile(path, 'utf8')).toBe('v');
  });

  it('완료 후 .tmp 중간 파일이 남지 않는다 (경계값)', async () => {
    const path = join(dir, 'a.json');
    await writeFileAtomic(path, 'data');
    expect(await readdir(dir)).toEqual(['a.json']);
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
  # 기대: 전체 58 passed (55 + 3)
# 3. 의미 검증
grep -c "randomUUID" src/store/__tests__/atomic-file.test.ts
  # 기대: 2 (고유 디렉토리 격리)
```

### 동반 변경 (Side Effects)

N/A (Step 1의 동반 테스트)

### Do Not Touch

`src/store/atomic-file.ts`, `src/store/session-store.ts` (Step 2 완료본).

## Step 4: Embedder 인터페이스 추가 (`src/llm/types.ts` — modify, 파일 끝에 추가)

### Context

임베딩도 LLM 호출과 같은 경계 원칙 — 인터페이스 뒤에 구현을 숨긴다. Phase 3에서 Retriever가, Segment 6에서 LangChain 구현체가 이 인터페이스만 본다.

### Code

파일 끝에 추가:

```ts

export interface Embedder {
  /** 각 입력 텍스트의 임베딩 벡터를 같은 순서로 반환 */
  embed(texts: string[]): Promise<number[][]>;
}
```

### Anchor

`src/llm/types.ts`의 `LlmClient` 인터페이스를 닫는 `}` 뒤, 파일 끝에 추가 (파일 마지막 줄 뒤).

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 58 passed (타입 추가 — 회귀 없음)
# 3. 의미 검증
grep -c "interface Embedder" src/llm/types.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

새 인터페이스 → 구현체(Step 5)와 테스트(Step 6)를 같은 Phase에서 작성. 기존 소비자 없음(신규 타입).

### Do Not Touch

`types.ts`의 기존 선언(ChatRole/ChatMessage/ChatOptions/LlmClient — 추가만).

## Step 5: Ollama 임베더 (`src/llm/ollama-embedder.ts` — create)

### Context

Ollama `/api/embed`(배치 지원: `{model, input: string[]}` → `{embeddings: number[][]}`, 로컬 실측 검증 완료). 대량 청크를 `batchSize`(기본 16)씩 나눠 순차 요청 — 단일 거대 요청의 메모리/타임아웃 위험 회피. 에러 계층은 OllamaClient와 동일(연결 실패 vs 응답 오류). `FetchLike`는 ollama-client에서 import (단일 소스).

### Code
```ts
import { LlmConnectionError, LlmResponseError } from './errors.js';
import type { FetchLike } from './ollama-client.js';
import type { Embedder } from './types.js';

export interface OllamaEmbedderConfig {
  /** 기본 http://localhost:11434 */
  baseUrl?: string;
  /** 기본 nomic-embed-text */
  model?: string;
  /** 테스트 주입용. 기본 globalThis.fetch */
  fetchFn?: FetchLike;
  /** 한 요청에 담는 텍스트 수. 기본 16 */
  batchSize?: number;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_BATCH_SIZE = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumberMatrix(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        Array.isArray(row) && row.every((n) => typeof n === 'number'),
    )
  );
}

export class OllamaEmbedder implements Embedder {
  private readonly baseUrl: string;
  readonly model: string;
  private readonly fetchFn: FetchLike;
  private readonly batchSize: number;

  constructor(config: OllamaEmbedderConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.model = config.model ?? DEFAULT_MODEL;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const result: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      result.push(...(await this.embedBatch(batch)));
    }
    return result;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (err) {
      throw new LlmConnectionError(this.baseUrl, err);
    }
    if (!response.ok) {
      throw new LlmResponseError(response.status, await response.text());
    }
    const parsed: unknown = await response.json();
    if (!isRecord(parsed)) {
      throw new LlmResponseError(response.status, '임베딩 응답 형식 불일치');
    }
    const embeddings = parsed['embeddings'];
    if (!isNumberMatrix(embeddings)) {
      throw new LlmResponseError(response.status, '임베딩 응답 형식 불일치');
    }
    if (embeddings.length !== texts.length) {
      throw new LlmResponseError(
        response.status,
        `임베딩 수 불일치: 요청 ${texts.length}, 응답 ${embeddings.length}`,
      );
    }
    return embeddings;
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
echo "N/A: 테스트는 Step 6에서 동반 작성"
# 3. 의미 검증
grep -c "import type { FetchLike } from './ollama-client.js'" src/llm/ollama-embedder.ts
  # 기대: 1 (FetchLike 재정의 없이 단일 소스 재사용)
```

### 동반 변경 (Side Effects)

새 가드(응답 형식/개수 불일치 throw) → throw 경로 테스트 Step 6. 호출처(indexer/retriever/CLI)는 Phase 2~3.

### Do Not Touch

`src/llm/ollama-client.ts`, `src/llm/ndjson.ts`, `src/llm/errors.ts`.

## Step 6: 임베더 테스트 (`src/llm/__tests__/ollama-embedder.test.ts` — create)

### Code

### 검증 대상

- spy: `fetchFn` mock — 호출 URL(`/api/embed`), body의 model/input, 배치 분할 시 호출 횟수
- branch: 연결 실패 → LlmConnectionError, HTTP 500 → LlmResponseError, 응답 개수 불일치 → LlmResponseError, 빈 입력 → fetch 미호출
- state: 반환 행렬이 응답 embeddings와 순서 포함 일치

```ts
import { describe, expect, it, vi } from 'vitest';
import { LlmConnectionError, LlmResponseError } from '../errors.js';
import { OllamaEmbedder } from '../ollama-embedder.js';

function embedResponse(embeddings: number[][]): Response {
  return new Response(JSON.stringify({ embeddings }), { status: 200 });
}

describe('OllamaEmbedder', () => {
  it('입력 순서대로 임베딩을 반환하고 올바른 요청을 보낸다 (정상)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      embedResponse([[1, 0], [0, 1]]),
    );
    const embedder = new OllamaEmbedder({ fetchFn });

    const result = await embedder.embed(['하나', '둘']);

    expect(result).toEqual([[1, 0], [0, 1]]);
    expect(String(fetchFn.mock.calls.at(0)?.[0])).toBe(
      'http://localhost:11434/api/embed',
    );
    const body: unknown = JSON.parse(String(fetchFn.mock.calls.at(0)?.[1]?.body));
    expect(body).toEqual({ model: 'nomic-embed-text', input: ['하나', '둘'] });
  });

  it('batchSize 단위로 나눠 요청하고 결과를 이어붙인다 (정상)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body));
      const input = (body as { input: string[] }).input;
      return embedResponse(input.map((_, i) => [i]));
    });
    const embedder = new OllamaEmbedder({ fetchFn, batchSize: 2 });

    const result = await embedder.embed(['a', 'b', 'c']);

    expect(fetchFn).toHaveBeenCalledTimes(2); // [a,b] + [c]
    expect(result).toEqual([[0], [1], [0]]);
  });

  it('연결 실패는 LlmConnectionError로 감싼다 (에러)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      throw new TypeError('fetch failed');
    });
    const embedder = new OllamaEmbedder({ fetchFn });

    await expect(embedder.embed(['x'])).rejects.toThrow(LlmConnectionError);
  });

  it('HTTP 에러 상태는 LlmResponseError를 던진다 (에러)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response('boom', { status: 500 }),
    );
    const embedder = new OllamaEmbedder({ fetchFn });

    const error = await embedder.embed(['x']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmResponseError);
    expect((error as LlmResponseError).status).toBe(500);
  });

  it('응답 임베딩 수가 요청과 다르면 LlmResponseError를 던진다 (에러)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      embedResponse([[1]]),
    );
    const embedder = new OllamaEmbedder({ fetchFn });

    await expect(embedder.embed(['a', 'b'])).rejects.toThrow('임베딩 수 불일치');
  });

  it('빈 입력이면 fetch 없이 빈 배열을 반환한다 (경계값)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      embedResponse([]),
    );
    const embedder = new OllamaEmbedder({ fetchFn });

    expect(await embedder.embed([])).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
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
  # 기대: 전체 64 passed (58 + 6)
# 3. 의미 검증
grep -c "toHaveBeenCalledTimes(2)" src/llm/__tests__/ollama-embedder.test.ts
  # 기대: 1 (배치 분할 spy 검증)
```

### 동반 변경 (Side Effects)

N/A (Step 5의 동반 테스트)

### Do Not Touch

`src/llm/ollama-embedder.ts`.

## 실행 순서

Step 1 → 2 → 3 → 4 → 5 → 6 (유틸 → 리팩터 → 유틸 테스트 → 인터페이스 → 구현 → 구현 테스트).

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `writeFileAtomic` | `('.chatbot/x.json', '{"a":1}')` | 파일 생성, `.tmp` 잔존 없음 |
| `embed` | `['하나','둘']` (mock 2벡터) | `[[1,0],[0,1]]` — 순서 유지 |
| `embed` | `['a','b','c']`, batchSize 2 | fetch 2회 호출 후 3벡터 |
| `embed` | `[]` | `[]` — fetch 미호출 |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/store/atomic-file.ts
export function writeFileAtomic(filePath: string, content: string): Promise<void>;

// src/llm/types.ts — 추가분
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

// src/llm/ollama-embedder.ts
export interface OllamaEmbedderConfig { baseUrl?: string; model?: string; fetchFn?: FetchLike; batchSize?: number; }
export class OllamaEmbedder implements Embedder {
  constructor(config?: OllamaEmbedderConfig);
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
```

## Definition of Done

- [ ] DoD-11: 모든 Step 통과 + Verify ✓
- [ ] DoD-12: `npm run typecheck` exit 0
- [ ] DoD-13: `npm test` 64 passed (session-store 기존 6개 회귀 없음)
- [ ] DoD-14: 리팩터가 만든 미사용 import 제거 완료 (Step 2 의미 검증)
- [ ] DoD-15: 문서 갱신 불필요
- [ ] DoD-16: Phase 2 전제 조건 만족

## Observability plan

N/A — 운영 영향 없음.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 1 PASS"
```
