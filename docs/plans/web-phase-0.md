# Phase 0: 공용 bootstrap 추출 + CLI 리팩터

@fidelity-check tokens: createApp, startupNotices, rebuildIndex, modelName

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어
5. `noUncheckedIndexedAccess` 활성 — `.at()` + `??` 가드
6. 테스트 파일 시스템은 `.test-tmp/<uuid>/`만 사용

## 전제 조건

Segment 1~3이 노출한 인터페이스 중 사용하는 것 (그대로 복사):

```ts
// src/chat/session.ts
export class ChatSession {
  constructor(client: LlmClient, config?: ChatSessionConfig);
  send(userInput: string, options?: ChatOptions): AsyncGenerator<string>;
  restore(history: readonly ChatMessage[]): void;
  getHistory(): readonly ChatMessage[];
  clear(): void;
}
export interface ChatSessionConfig { systemPrompt?: string; context?: ContextManagerConfig; retriever?: ContextRetriever; }

// src/store/session-store.ts
export class SessionStore {
  constructor(filePath: string);
  load(): Promise<ChatMessage[] | null>;
  save(history: readonly ChatMessage[]): Promise<void>;
  clear(): Promise<void>;
}

// src/rag — VectorIndex.load / buildIndex / Retriever (Segment 3 노출 시그니처)
// src/llm — OllamaClient(config), OllamaEmbedder(config, readonly model), LlmClient, Embedder
```

## 현재 상태

`src/cli/main.ts`에 조립 로직(클라이언트/임베더/스토어/인덱스 로드/retriever 위임/세션 복원/`/index` 재구축)이 인라인으로 존재 — Phase 1의 HTTP 서버가 같은 로직을 필요로 하므로 추출한다. `OllamaClient.model`은 private이라 배너 표시용 모델명을 노출할 수 없다 → readonly로 공개 (OllamaEmbedder는 이미 `readonly model`).

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| LlmClient / Embedder | ✓ (`createApp` overrides 파라미터) | ✓ (Fake 구현) | — |
| 파일 경로 (세션/인덱스/docs) | ✓ (env 객체 인자 — `process.env` 직접 참조 금지) | ✗ (실제 FS) | `.test-tmp/<uuid>/` 격리 |
| 현재 시각 (rebuildIndex) | ✓ (`createdAt` 인자) | ✓ | 테스트는 고정 문자열 |
| stdin/stdout (CLI) | ✗ | ✗ | 얇은 레이어 유지 — 조립 로직이 bootstrap으로 빠져 CLI는 더 얇아짐 |

## Step 1: OllamaClient.model 공개 (`src/llm/ollama-client.ts` — modify, 1줄)

### Context

배너 표시용 모델명의 단일 소스. 동작 변경 없음 (private → public readonly).

### Code

교체 전:
```ts
  private readonly model: string;
```

교체 후:
```ts
  readonly model: string;
```

### Anchor

`  private readonly model: string;` (파일 내 유일 — OllamaClient 클래스 필드)

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 80 passed (동작 불변)
# 3. 의미 검증
grep -c "^  readonly model: string;" src/llm/ollama-client.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

N/A (접근 제한 완화 — 소비자는 Step 2 bootstrap)

### Do Not Touch

`ollama-client.ts`의 그 외 모든 코드.

## Step 2: 공용 bootstrap (`src/app/bootstrap.ts` — create)

### Context

CLI와 HTTP 서버가 공유하는 조립 지점. `env`를 인자로 받아(전역 `process.env` 직접 참조 금지) 테스트 가능하게 하고, `overrides`로 Fake 클라이언트/임베더 주입을 허용한다. retriever는 클로저의 let 바인딩 — `rebuildIndex()`가 교체하면 세션의 위임 객체가 즉시 새 인덱스를 사용한다.

### Code
```ts
import { ChatSession } from '../chat/session.js';
import type { Embedder, LlmClient } from '../llm/types.js';
import { OllamaClient } from '../llm/ollama-client.js';
import { OllamaEmbedder } from '../llm/ollama-embedder.js';
import { buildIndex } from '../rag/indexer.js';
import { Retriever } from '../rag/retriever.js';
import { VectorIndex } from '../rag/vector-index.js';
import { SessionStore } from '../store/session-store.js';

export type AppEnv = Record<string, string | undefined>;

export interface AppOverrides {
  /** 테스트 주입용 */
  client?: LlmClient;
  embedder?: Embedder;
}

export interface App {
  session: ChatSession;
  store: SessionStore;
  docsDir: string;
  indexFile: string;
  /** 배너 표시용 채팅 모델명 */
  modelName: string;
  /** 시작 시 상태 안내 (인덱스 로드/모델 불일치/세션 복원) */
  startupNotices: string[];
  /** docsDir를 재인덱싱하고 retriever를 교체. 청크 수 반환 */
  rebuildIndex(createdAt: string): Promise<number>;
}

const SYSTEM_PROMPT =
  '당신은 간결하고 정확하게 답하는 한국어 어시스턴트입니다.';
const DEFAULT_SESSION_FILE = '.chatbot/session.json';
const DEFAULT_INDEX_FILE = '.chatbot/rag-index.json';
const DEFAULT_DOCS_DIR = 'docs';

export async function createApp(
  env: AppEnv,
  overrides: AppOverrides = {},
): Promise<App> {
  const client =
    overrides.client ??
    new OllamaClient({
      baseUrl: env['OLLAMA_BASE_URL'],
      model: env['OLLAMA_MODEL'],
    });
  const embedder =
    overrides.embedder ?? new OllamaEmbedder({ baseUrl: env['OLLAMA_BASE_URL'] });
  const embedderModel =
    embedder instanceof OllamaEmbedder ? embedder.model : 'fake-embedder';
  const modelName =
    client instanceof OllamaClient ? client.model : 'fake-llm';

  const store = new SessionStore(
    env['CHATBOT_SESSION_FILE'] ?? DEFAULT_SESSION_FILE,
  );
  const indexFile = env['CHATBOT_INDEX_FILE'] ?? DEFAULT_INDEX_FILE;
  const docsDir = env['RAG_DOCS_DIR'] ?? DEFAULT_DOCS_DIR;
  const startupNotices: string[] = [];

  let retriever: Retriever | null = null;
  const loadedIndex = await VectorIndex.load(indexFile);
  if (loadedIndex !== null) {
    if (loadedIndex.model === embedderModel) {
      retriever = new Retriever(embedder, loadedIndex);
      startupNotices.push(
        `RAG 인덱스 로드: ${loadedIndex.size}청크, 생성 ${loadedIndex.createdAt}`,
      );
    } else {
      startupNotices.push(
        `RAG 인덱스의 임베딩 모델(${loadedIndex.model})이 현재(${embedderModel})와 달라 무시합니다 — 재인덱싱하세요`,
      );
    }
  }

  const session = new ChatSession(client, {
    systemPrompt: SYSTEM_PROMPT,
    retriever: {
      retrieve: async (query: string) =>
        retriever !== null ? retriever.retrieve(query) : { block: null },
    },
  });

  const restored = await store.load();
  if (restored !== null && restored.length > 0) {
    session.restore(restored);
    startupNotices.push(
      `이전 세션을 복원했습니다 — ${Math.floor(restored.length / 2)}턴`,
    );
  }

  return {
    session,
    store,
    docsDir,
    indexFile,
    modelName,
    startupNotices,
    async rebuildIndex(createdAt: string): Promise<number> {
      const built = await buildIndex(embedder, docsDir, {
        model: embedderModel,
        createdAt,
      });
      await built.save(indexFile);
      retriever = new Retriever(embedder, built);
      return built.size;
    },
  };
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
echo "N/A: 테스트는 Step 4에서 동반 작성"
# 3. 의미 검증
grep -c "process.env" src/app/bootstrap.ts
  # 기대: 0 (env는 인자로만 — 테스트 가능성)
```

### 동반 변경 (Side Effects)

새 추상화 → 호출처 갱신(Step 3 CLI) + 단위 테스트(Step 4)를 같은 Phase에서 수행. HTTP 서버 호출처는 Phase 1.

### Do Not Touch

`src/chat/**`, `src/rag/**`, `src/store/**`, `src/context/**`.

## Step 3: CLI 리팩터 (`src/cli/main.ts` — modify, 전체 교체)

### Context

조립 로직을 createApp으로 위임 — CLI는 REPL 입출력만 남는다. 사용자 가시 출력(배너/안내 문구)은 기존과 동일하게 유지.

### Code
```ts
import * as readline from 'node:readline/promises';
import { env, exit, stdin, stdout } from 'node:process';
import { createApp } from '../app/bootstrap.js';
import { LlmConnectionError } from '../llm/errors.js';

async function main(): Promise<void> {
  const app = await createApp(env);
  for (const notice of app.startupNotices) {
    stdout.write(`(${notice})\n`);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  rl.on('SIGINT', () => {
    rl.close();
    stdout.write('\n');
    exit(0);
  });

  stdout.write(
    `chatbot-engine — ${app.modelName} (명령: /exit 종료, /clear 히스토리 초기화, /index RAG 인덱스 구축)\n`,
  );

  while (true) {
    let line: string;
    try {
      line = (await rl.question('you> ')).trim();
    } catch {
      break; // Ctrl-D 등 입력 스트림 종료
    }
    if (line.length === 0) {
      continue;
    }
    if (line === '/exit') {
      break;
    }
    if (line === '/clear') {
      app.session.clear();
      await app.store.clear();
      stdout.write('(히스토리를 초기화했습니다)\n');
      continue;
    }
    if (line === '/index') {
      try {
        stdout.write(`(${app.docsDir}/ 문서를 인덱싱합니다...)\n`);
        const size = await app.rebuildIndex(new Date().toISOString());
        stdout.write(`(인덱스 구축 완료: ${size}청크 → ${app.indexFile})\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stdout.write(`인덱싱 오류: ${message}\n`);
      }
      continue;
    }

    stdout.write('bot> ');
    try {
      for await (const piece of app.session.send(line)) {
        stdout.write(piece);
      }
      stdout.write('\n');
      await app.store.save(app.session.getHistory());
    } catch (err) {
      if (err instanceof LlmConnectionError) {
        stdout.write(`\n오류: ${err.message}\n`);
        rl.close();
        exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(
        `\n오류: ${message} — 히스토리는 보존되었으니 다시 시도하세요.\n`,
      );
    }
  }

  rl.close();
}

main().catch((err: unknown) => {
  console.error(err);
  exit(1);
});
```

### Anchor

파일 전체를 위 Code로 교체.

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 80 passed (회귀 없음)
# 3. 의미 검증
printf '/exit\n' | npx tsx src/cli/main.ts && grep -c "OllamaClient\|SessionStore\|VectorIndex\|Retriever\|buildIndex" src/cli/main.ts
  # 기대: 배너 정상 출력 후 종료, grep 결과 0 (조립 로직이 CLI에서 사라짐)
```

### 동반 변경 (Side Effects)

리팩터로 미사용이 된 import 제거 — 전체 교체본에 반영됨.

### Do Not Touch

`src/app/bootstrap.ts` (Step 2 완료본), `src/llm/**` (Step 1 외).

## Step 4: bootstrap 테스트 (`src/app/__tests__/bootstrap.test.ts` — create)

### Code

### 검증 대상

- spy: N/A (반환 App 상태와 파일 산출물로 검증)
- branch: 세션 복원 notice, 인덱스 모델 불일치 notice, rebuildIndex 후 재로드, 파일 전무(빈 시작)
- state: startupNotices 내용, getHistory, 인덱스 파일 생성, rebuildIndex 반환값

```ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, Embedder, LlmClient } from '../../llm/types.js';
import { createApp } from '../bootstrap.js';

class FakeLlmClient implements LlmClient {
  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return '요약';
  }

  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string> {
    yield 'ok';
  }
}

class FakeEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0]);
  }
}

describe('createApp', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'a.md'), '# 제목\n본문', 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function envFor(): Record<string, string> {
    return {
      CHATBOT_SESSION_FILE: join(dir, 'session.json'),
      CHATBOT_INDEX_FILE: join(dir, 'index.json'),
      RAG_DOCS_DIR: join(dir, 'docs'),
    };
  }

  it('저장된 세션이 있으면 복원하고 notice를 남긴다 (정상)', async () => {
    const saved: ChatMessage[] = [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '답변' },
    ];
    await writeFile(
      join(dir, 'session.json'),
      JSON.stringify({ version: 1, history: saved, savedAt: 't' }),
      'utf8',
    );

    const app = await createApp(envFor(), {
      client: new FakeLlmClient(),
      embedder: new FakeEmbedder(),
    });

    expect(app.session.getHistory()).toEqual(saved);
    expect(app.startupNotices.join(' ')).toContain('이전 세션을 복원했습니다 — 1턴');
  });

  it('인덱스의 임베딩 모델이 다르면 무시하고 notice를 남긴다 (에러)', async () => {
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({ version: 1, model: '다른모델', createdAt: 't', chunks: [] }),
      'utf8',
    );

    const app = await createApp(envFor(), {
      client: new FakeLlmClient(),
      embedder: new FakeEmbedder(),
    });

    expect(app.startupNotices.join(' ')).toContain('달라 무시합니다');
  });

  it('rebuildIndex는 인덱스를 만들어 저장하고, 다음 createApp이 로드한다 (정상)', async () => {
    const app = await createApp(envFor(), {
      client: new FakeLlmClient(),
      embedder: new FakeEmbedder(),
    });

    const size = await app.rebuildIndex('2026-07-11');
    expect(size).toBe(1);

    const app2 = await createApp(envFor(), {
      client: new FakeLlmClient(),
      embedder: new FakeEmbedder(),
    });
    expect(app2.startupNotices.join(' ')).toContain('RAG 인덱스 로드: 1청크');
  });

  it('아무 파일도 없으면 notice 없이 빈 세션으로 시작한다 (경계값)', async () => {
    const app = await createApp(envFor(), {
      client: new FakeLlmClient(),
      embedder: new FakeEmbedder(),
    });

    expect(app.startupNotices).toEqual([]);
    expect(app.session.getHistory()).toEqual([]);
    expect(app.modelName).toBe('fake-llm');
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
  # 기대: 전체 84 passed (80 + 4)
# 3. 의미 검증
grep -c "startupNotices" src/app/__tests__/bootstrap.test.ts
  # 기대: 4 이상 (notice 경로 검증 존재)
```

### 동반 변경 (Side Effects)

N/A (Step 2의 동반 테스트)

### Do Not Touch

`src/app/bootstrap.ts`.

## 실행 순서

Step 1 → 2 → 3 → 4.

## 입출력 예제

| 시나리오 | 결과 |
|---------|------|
| 세션 파일 존재 | history 복원 + notice "이전 세션을 복원했습니다 — N턴" |
| 인덱스 모델 불일치 | retriever 비활성 + notice "…달라 무시합니다…" |
| rebuildIndex('t') | 인덱스 파일 생성, 청크 수 반환, retriever 즉시 교체 |
| 파일 전무 | notices=[], 빈 히스토리 |

## 이 Phase 완료 후 노출 인터페이스

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

// src/llm/ollama-client.ts — 변경분
// OllamaClient.model: readonly 공개 (기존 private)
```

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify ✓
- [ ] DoD-02: `npm run typecheck` exit 0
- [ ] DoD-03: `npm test` 84 passed (기존 80 회귀 없음)
- [ ] DoD-04: CLI에서 조립 로직 제거 확인 (Step 3 의미 검증 grep 0)
- [ ] DoD-05: 문서 갱신 불필요
- [ ] DoD-06: Phase 1 전제 조건 만족

## Observability plan

N/A — 운영 영향 없음 (내부 리팩터, CLI 출력 불변).

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 0 PASS"
```
