# Phase 3: Retriever + 대화 통합 (/index)

@fidelity-check tokens: Retriever, ContextRetriever, contextBlock, retrieve

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성 — `.at()` + `??` 가드

## 전제 조건

Phase 1~2가 노출한 인터페이스 (그대로 복사):

```ts
// src/llm/types.ts
export interface Embedder { embed(texts: string[]): Promise<number[][]>; }

// src/llm/ollama-embedder.ts
export class OllamaEmbedder implements Embedder {
  constructor(config?: OllamaEmbedderConfig);
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

// src/rag/vector-index.ts
export interface SearchHit { chunk: IndexedChunk; score: number; }
export class VectorIndex {
  static load(filePath: string): Promise<VectorIndex | null>;
  readonly model: string;
  readonly createdAt: string;
  get size(): number;
  search(queryEmbedding: readonly number[], topK: number, minScore: number): SearchHit[];
  save(filePath: string): Promise<void>;
}

// src/rag/indexer.ts
export function buildIndex(embedder: Embedder, docsDir: string, options: BuildIndexOptions): Promise<VectorIndex>;
```

Segment 2 인터페이스 (수정 대상):

```ts
// src/context/context-manager.ts — prepare(systemPrompt, history, userInput) 3-인자
// src/chat/session.ts — ChatSessionConfig { systemPrompt?, context? }, send/getHistory/restore/clear
```

## 현재 상태

- `src/context/context-manager.ts`의 `prepare()`는 3-인자 — 검색 컨텍스트를 받을 자리가 없다. **선택적 4번째 인자**로 확장 (기존 호출처·테스트 무수정 컴파일).
- `src/chat/session.ts`는 retriever 개념이 없다. rag 모듈에 직접 의존하지 않도록 **구조적 인터페이스(`ContextRetriever`)를 session에 정의**하고 Retriever가 이를 구조적으로 만족하게 한다 (chat 레이어가 rag 레이어를 모르는 상태 유지).
- `src/cli/main.ts`에 `/index` 명령 없음.

## Step 1: Retriever (`src/rag/retriever.ts` — create)

### Context

질의 임베딩 → 인덱스 검색 → 프롬프트 주입용 블록 포맷. 유사도 임계값(기본 0.35) 미만이면 block=null — 무관한 질문에 발췌를 주입하지 않는다.

### Code
```ts
import type { Embedder } from '../llm/types.js';
import type { SearchHit, VectorIndex } from './vector-index.js';

export interface RetrieverConfig {
  /** 반환할 최대 발췌 수. 기본 4 */
  topK?: number;
  /** 이 유사도 미만은 제외. 기본 0.35 */
  minScore?: number;
}

export interface RetrievedContext {
  /** 프롬프트에 주입할 발췌 블록 (관련 발췌 없으면 null) */
  block: string | null;
  hits: SearchHit[];
}

const DEFAULT_TOP_K = 4;
const DEFAULT_MIN_SCORE = 0.35;

export class Retriever {
  private readonly embedder: Embedder;
  private readonly index: VectorIndex;
  private readonly topK: number;
  private readonly minScore: number;

  constructor(
    embedder: Embedder,
    index: VectorIndex,
    config: RetrieverConfig = {},
  ) {
    this.embedder = embedder;
    this.index = index;
    this.topK = config.topK ?? DEFAULT_TOP_K;
    this.minScore = config.minScore ?? DEFAULT_MIN_SCORE;
  }

  async retrieve(query: string): Promise<RetrievedContext> {
    const embeddings = await this.embedder.embed([query]);
    const queryEmbedding = embeddings.at(0) ?? [];
    if (queryEmbedding.length === 0) {
      return { block: null, hits: [] };
    }
    const hits = this.index.search(queryEmbedding, this.topK, this.minScore);
    if (hits.length === 0) {
      return { block: null, hits: [] };
    }
    const sections = hits.map((h) => {
      const label =
        h.chunk.heading.length > 0
          ? `${h.chunk.source} > ${h.chunk.heading}`
          : h.chunk.source;
      return `[${label}]\n${h.chunk.content}`;
    });
    const block =
      '다음은 질문과 관련된 문서 발췌다. 답변에 활용하되, 관련이 없으면 무시하라.\n\n' +
      sections.join('\n\n---\n\n');
    return { block, hits };
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
echo "N/A: 테스트는 Step 5에서 동반 작성"
# 3. 의미 검증
grep -c "DEFAULT_MIN_SCORE = 0.35" src/rag/retriever.ts
  # 기대: 1 (임계값 기본 존재)
```

### 동반 변경 (Side Effects)

새 추상화 → 호출처(Step 3 session, Step 4 CLI) + 테스트(Step 5)를 같은 Phase에서 작성.

### Do Not Touch

`src/rag/vector-index.ts`, `src/rag/indexer.ts`.

## Step 2: ContextManager 확장 (`src/context/context-manager.ts` — modify, prepare 메서드 교체)

### Context

검색 발췌도 컨텍스트 예산에 포함되어야 한다 — `contextBlock`을 fixed 메시지에 넣으면 overhead 산정에 자동 반영되어 트리밍·요약과 공존한다. 기본값 null인 선택 인자라 기존 호출처·테스트는 무수정.

### Code

`prepare` 메서드 전체를 다음으로 교체:

```ts
  /**
   * [system?, 검색 발췌?, 요약?, 최근 히스토리, 새 질문] 형태로 예산에 맞는 메시지 배열을 만든다.
   * 요약 실패 시: 이전 캐시가 dropped 범위 일부라도 덮으면 재사용, 없으면 트리밍만.
   */
  async prepare(
    systemPrompt: string | null,
    history: readonly ChatMessage[],
    userInput: string,
    contextBlock: string | null = null,
  ): Promise<PreparedContext> {
    const fixed: ChatMessage[] = [];
    if (systemPrompt !== null) {
      fixed.push({ role: 'system', content: systemPrompt });
    }
    if (contextBlock !== null) {
      fixed.push({ role: 'system', content: contextBlock });
    }
    const userMessage: ChatMessage = { role: 'user', content: userInput };

    const overhead = estimateMessagesTokens([...fixed, userMessage]);
    const historyBudget = Math.max(
      this.maxContextTokens - this.reserveTokens - overhead - SUMMARY_ALLOWANCE,
      0,
    );

    const { kept, dropped } = trimToBudget(history, historyBudget);

    if (dropped.length > 0) {
      if (this.summary === null || this.summaryCoveredCount !== dropped.length) {
        try {
          this.summary = await summarizeMessages(this.client, dropped);
          this.summaryCoveredCount = dropped.length;
        } catch {
          // 요약 실패 — 이전 캐시(있으면) 재사용, 없으면 트리밍만으로 진행
        }
      }
    }

    const messages: ChatMessage[] = [...fixed];
    const useSummary = dropped.length > 0 && this.summary !== null;
    if (useSummary && this.summary !== null) {
      messages.push({ role: 'system', content: `이전 대화 요약: ${this.summary}` });
    }
    messages.push(...kept);
    messages.push(userMessage);
    return { messages, summarized: useSummary };
  }
```

### Anchor

`  async prepare(`로 시작해 그 메서드를 닫는 `  }`까지 전체 (메서드명 유일). 클래스의 다른 멤버(생성자, reset)와 파일 상단 import·상수는 변경하지 않는다.

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 73 passed — context-manager 기존 6개 회귀 없음 (기본값 null이 기존 동작 보존)
# 3. 의미 검증
grep -c "contextBlock: string | null = null" src/context/context-manager.ts
  # 기대: 1 (선택 인자 — 시그니처 하위 호환)
```

### 동반 변경 (Side Effects)

시그니처 확장(선택 인자) — 호출처(session.ts 1곳)는 Step 3에서 갱신, contextBlock 경로 테스트는 Step 6에서 동반.

### Do Not Touch

`prepare` 외 모든 멤버, `src/context/__tests__/context-manager.test.ts`의 기존 케이스.

## Step 3: ChatSession retriever 연결 (`src/chat/session.ts` — modify, 전체 교체)

### Context

`ContextRetriever`를 session 파일에 구조적 인터페이스로 정의 — chat 레이어는 rag 모듈을 import하지 않는다 (Retriever가 구조적으로 만족). 검색 실패는 대화를 막지 않는다(블록 없이 진행). 기존 public 시그니처 불변.

### Code
```ts
import { ContextManager } from '../context/context-manager.js';
import type { ContextManagerConfig } from '../context/context-manager.js';
import type { ChatMessage, ChatOptions, LlmClient } from '../llm/types.js';

/** 검색 컨텍스트 공급자 — rag의 Retriever가 구조적으로 만족 (chat→rag 의존 없음) */
export interface ContextRetriever {
  retrieve(query: string): Promise<{ block: string | null }>;
}

export interface ChatSessionConfig {
  systemPrompt?: string;
  /** 컨텍스트 예산 설정 (기본: maxContextTokens 4096, reserveTokens 1024) */
  context?: ContextManagerConfig;
  /** 검색 컨텍스트 공급자 (없으면 검색 없이 동작) */
  retriever?: ContextRetriever;
}

export class ChatSession {
  private readonly client: LlmClient;
  private readonly systemPrompt: string | null;
  private readonly contextManager: ContextManager;
  private readonly retriever: ContextRetriever | null;
  private history: ChatMessage[] = [];

  constructor(client: LlmClient, config: ChatSessionConfig = {}) {
    this.client = client;
    this.systemPrompt = config.systemPrompt ?? null;
    this.contextManager = new ContextManager(client, config.context ?? {});
    this.retriever = config.retriever ?? null;
  }

  /**
   * 사용자 입력을 보내고 assistant 응답 조각을 스트리밍으로 yield.
   * retriever가 있으면 관련 문서 발췌를 검색해 함께 보낸다 (검색 실패는 무시).
   * 히스토리가 컨텍스트 예산을 넘으면 오래된 대화를 요약으로 압축해 보낸다.
   * 스트림이 끝까지 성공한 경우에만 히스토리에 (user, assistant) 쌍을 기록한다.
   */
  async *send(userInput: string, options?: ChatOptions): AsyncGenerator<string> {
    let contextBlock: string | null = null;
    if (this.retriever !== null) {
      try {
        contextBlock = (await this.retriever.retrieve(userInput)).block;
      } catch {
        contextBlock = null; // 검색 실패는 대화를 막지 않는다
      }
    }

    const prepared = await this.contextManager.prepare(
      this.systemPrompt,
      this.history,
      userInput,
      contextBlock,
    );

    let assistantContent = '';
    for await (const piece of this.client.chatStream(prepared.messages, options)) {
      assistantContent += piece;
      yield piece;
    }

    this.history.push({ role: 'user', content: userInput });
    this.history.push({ role: 'assistant', content: assistantContent });
  }

  /** 저장된 히스토리로 교체하고 요약 캐시를 리셋한다 (세션 복원용) */
  restore(history: readonly ChatMessage[]): void {
    this.history = history.map((m) => ({ ...m }));
    this.contextManager.reset();
  }

  getHistory(): readonly ChatMessage[] {
    return this.history;
  }

  clear(): void {
    this.history = [];
    this.contextManager.reset();
  }
}
```

### Anchor

파일 전체를 위 Code로 교체.

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 73 passed — session 기존 8개 회귀 없음 (retriever 미지정 시 기존 동작)
# 3. 의미 검증
grep -c "from '../rag" src/chat/session.ts
  # 기대: 0 (chat 레이어가 rag를 import하지 않음 — 구조적 인터페이스로 격리)
```

### 동반 변경 (Side Effects)

새 선택 필드 — 기존 호출처 무수정. retriever 경로 테스트는 Step 6에서 동반.

### Do Not Touch

`src/context/**` (Step 2 완료본), `src/llm/**`.

## Step 4: CLI 통합 (`src/cli/main.ts` — modify, 전체 교체)

### Context

시작 시 인덱스 자동 로드(모델 불일치면 무시+안내), `/index`로 (재)구축. retriever는 let 바인딩 + 위임 객체로 연결 — `/index` 후 재시작 없이 즉시 활성화된다.

### Code
```ts
import * as readline from 'node:readline/promises';
import { env, exit, stdin, stdout } from 'node:process';
import { ChatSession } from '../chat/session.js';
import { LlmConnectionError } from '../llm/errors.js';
import { OllamaClient } from '../llm/ollama-client.js';
import { OllamaEmbedder } from '../llm/ollama-embedder.js';
import { buildIndex } from '../rag/indexer.js';
import { Retriever } from '../rag/retriever.js';
import { VectorIndex } from '../rag/vector-index.js';
import { SessionStore } from '../store/session-store.js';

const SYSTEM_PROMPT =
  '당신은 간결하고 정확하게 답하는 한국어 어시스턴트입니다.';
const DEFAULT_SESSION_FILE = '.chatbot/session.json';
const DEFAULT_INDEX_FILE = '.chatbot/rag-index.json';
const DEFAULT_DOCS_DIR = 'docs';

async function main(): Promise<void> {
  const client = new OllamaClient({
    baseUrl: env['OLLAMA_BASE_URL'],
    model: env['OLLAMA_MODEL'],
  });
  const embedder = new OllamaEmbedder({ baseUrl: env['OLLAMA_BASE_URL'] });
  const store = new SessionStore(
    env['CHATBOT_SESSION_FILE'] ?? DEFAULT_SESSION_FILE,
  );
  const indexFile = env['CHATBOT_INDEX_FILE'] ?? DEFAULT_INDEX_FILE;
  const docsDir = env['RAG_DOCS_DIR'] ?? DEFAULT_DOCS_DIR;

  let retriever: Retriever | null = null;
  const loadedIndex = await VectorIndex.load(indexFile);
  if (loadedIndex !== null) {
    if (loadedIndex.model === embedder.model) {
      retriever = new Retriever(embedder, loadedIndex);
      stdout.write(
        `(RAG 인덱스 로드: ${loadedIndex.size}청크, 생성 ${loadedIndex.createdAt})\n`,
      );
    } else {
      stdout.write(
        `(RAG 인덱스의 임베딩 모델(${loadedIndex.model})이 현재(${embedder.model})와 달라 무시합니다 — /index로 재구축하세요)\n`,
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
    stdout.write(
      `(이전 세션을 복원했습니다 — ${Math.floor(restored.length / 2)}턴)\n`,
    );
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  rl.on('SIGINT', () => {
    rl.close();
    stdout.write('\n');
    exit(0);
  });

  stdout.write(
    `chatbot-engine — ${env['OLLAMA_MODEL'] ?? 'qwen3:8b'} (명령: /exit 종료, /clear 히스토리 초기화, /index RAG 인덱스 구축)\n`,
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
      session.clear();
      await store.clear();
      stdout.write('(히스토리를 초기화했습니다)\n');
      continue;
    }
    if (line === '/index') {
      try {
        stdout.write(`(${docsDir}/ 문서를 인덱싱합니다...)\n`);
        const built = await buildIndex(embedder, docsDir, {
          model: embedder.model,
          createdAt: new Date().toISOString(),
        });
        await built.save(indexFile);
        retriever = new Retriever(embedder, built);
        stdout.write(`(인덱스 구축 완료: ${built.size}청크 → ${indexFile})\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stdout.write(`인덱싱 오류: ${message}\n`);
      }
      continue;
    }

    stdout.write('bot> ');
    try {
      for await (const piece of session.send(line)) {
        stdout.write(piece);
      }
      stdout.write('\n');
      await store.save(session.getHistory());
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
  # 기대: 73 passed (CLI는 테스트 면제 — Segment 1과 동일 사유: 얇은 I/O 레이어, 로직은 Retriever/Session 테스트가 커버)
# 3. 의미 검증
printf '/exit\n' | npx tsx src/cli/main.ts
  # 기대: 배너에 "/index RAG 인덱스 구축" 포함, 정상 종료
```

### 동반 변경 (Side Effects)

- CLAUDE.md에 `/index` 명령·env 안내 갱신 — 최종 검증에 포함
- 인덱스 파일은 `.chatbot/` 내 — .gitignore 기존 등재로 커버 (추가 변경 없음)

### Do Not Touch

`src/chat/session.ts` (Step 3 완료본), `src/llm/**`, `src/rag/**` 구현 파일.

## Step 5: Retriever 테스트 (`src/rag/__tests__/retriever.test.ts` — create)

### Code

### 검증 대상

- spy: `FakeEmbedder.calls` — 질의가 임베딩 입력으로 전달되는지
- branch: 정상 발췌 블록 생성, minScore로 전부 걸러짐 → null, 질의 임베딩 빈 벡터 → null
- state: block 포맷([source > heading] 라벨, 구분자), hits 순서

```ts
import { describe, expect, it } from 'vitest';
import type { Embedder } from '../../llm/types.js';
import { Retriever } from '../retriever.js';
import { VectorIndex } from '../vector-index.js';

class FakeEmbedder implements Embedder {
  readonly calls: string[][] = [];
  vectors: number[][] = [[1, 0]];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return this.vectors;
  }
}

const INDEX = VectorIndex.create('m', 't', [
  { source: 'a.md', heading: '설치', content: '설치 방법', embedding: [1, 0] },
  { source: 'b.md', heading: '', content: '무관한 내용', embedding: [0, 1] },
]);

describe('Retriever', () => {
  it('관련 청크를 라벨과 함께 블록으로 포맷한다 (정상)', async () => {
    const embedder = new FakeEmbedder();
    const retriever = new Retriever(embedder, INDEX);

    const result = await retriever.retrieve('설치 어떻게 해?');

    expect(embedder.calls.at(0)).toEqual(['설치 어떻게 해?']);
    expect(result.hits).toHaveLength(1);
    expect(result.block).toContain('[a.md > 설치]');
    expect(result.block).toContain('설치 방법');
    expect(result.block).not.toContain('무관한 내용');
  });

  it('minScore를 넘는 청크가 없으면 block은 null이다 (경계값)', async () => {
    const embedder = new FakeEmbedder();
    embedder.vectors = [[0.5, 0.5]];
    const retriever = new Retriever(embedder, INDEX, { minScore: 0.99 });

    const result = await retriever.retrieve('아무 질문');

    expect(result.block).toBeNull();
    expect(result.hits).toEqual([]);
  });

  it('질의 임베딩이 빈 벡터면 검색 없이 null을 반환한다 (에러)', async () => {
    const embedder = new FakeEmbedder();
    embedder.vectors = [];
    const retriever = new Retriever(embedder, INDEX);

    const result = await retriever.retrieve('질문');

    expect(result.block).toBeNull();
  });

  it('topK로 발췌 수를 제한한다 (경계값)', async () => {
    const many = VectorIndex.create('m', 't', [
      { source: 'x.md', heading: 'h1', content: 'c1', embedding: [1, 0] },
      { source: 'y.md', heading: 'h2', content: 'c2', embedding: [0.9, 0.1] },
      { source: 'z.md', heading: 'h3', content: 'c3', embedding: [0.8, 0.2] },
    ]);
    const embedder = new FakeEmbedder();
    const retriever = new Retriever(embedder, many, { topK: 2, minScore: 0 });

    const result = await retriever.retrieve('질문');

    expect(result.hits).toHaveLength(2);
    expect(result.hits.at(0)?.chunk.source).toBe('x.md');
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
  # 기대: 전체 77 passed (73 + 4)
# 3. 의미 검증
grep -c "toBeNull" src/rag/__tests__/retriever.test.ts
  # 기대: 3 (null 경로 3종)
```

### 동반 변경 (Side Effects)

N/A (Step 1의 동반 테스트)

### Do Not Touch

`src/rag/retriever.ts`.

## Step 6: 통합 경로 테스트 (`src/context/__tests__/context-manager.test.ts` — modify / `src/chat/__tests__/session.test.ts` — modify, 케이스 추가)

### Code

(a) `context-manager.test.ts` — describe 닫는 `});` 바로 위에 추가:

### 검증 대상

- spy: N/A (반환 messages로 검증)
- branch: contextBlock 지정 경로
- state: 발췌 블록이 system 메시지로 fixed 위치(시스템 프롬프트 다음)에 포함

```ts
  it('contextBlock이 system 메시지로 포함된다 (정상)', async () => {
    const fake = new FakeLlmClient();
    const manager = new ContextManager(fake);

    const result = await manager.prepare('SYS', [], USER.content, '발췌 블록');

    expect(result.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'system', content: '발췌 블록' },
      USER,
    ]);
  });
```

(b) `session.test.ts` — describe 닫는 `});` 바로 위에 추가:

### 검증 대상

- spy: streamCalls — retriever의 block이 전송 메시지에 포함되는지
- branch: retriever 정상 경로, retriever throw 경로(대화 계속)
- state: 전송 메시지 구성, 예외 미전파

```ts
  it('retriever의 발췌 블록이 전송 메시지에 포함된다 (정상)', async () => {
    const streamCalls: ChatMessage[][] = [];
    const ragClient: LlmClient = {
      async chat() {
        return '요약';
      },
      async *chatStream(messages: ChatMessage[]) {
        streamCalls.push(messages);
        yield 'ok';
      },
    };
    const session = new ChatSession(ragClient, {
      retriever: { retrieve: async () => ({ block: '[doc.md]\n발췌' }) },
    });

    await collect(session.send('질문'));

    expect(streamCalls.at(0)).toEqual([
      { role: 'system', content: '[doc.md]\n발췌' },
      { role: 'user', content: '질문' },
    ]);
  });

  it('retriever가 실패해도 발췌 없이 대화가 계속된다 (에러)', async () => {
    const streamCalls: ChatMessage[][] = [];
    const ragClient: LlmClient = {
      async chat() {
        return '요약';
      },
      async *chatStream(messages: ChatMessage[]) {
        streamCalls.push(messages);
        yield 'ok';
      },
    };
    const session = new ChatSession(ragClient, {
      retriever: {
        retrieve: async () => {
          throw new Error('embed down');
        },
      },
    });

    const pieces = await collect(session.send('질문'));

    expect(pieces).toEqual(['ok']);
    expect(streamCalls.at(0)).toEqual([{ role: 'user', content: '질문' }]);
  });
```

### Anchor

두 파일 모두 describe를 닫는 `});` 바로 위 (기존 케이스·fake 정의 수정 금지, 추가만).

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 전체 80 passed (77 + 3)
# 3. 의미 검증
grep -c "retriever" src/chat/__tests__/session.test.ts
  # 기대: 4 이상 (retriever 경로 2케이스 존재)
```

### 동반 변경 (Side Effects)

N/A (Step 2~3의 동반 테스트)

### Do Not Touch

기존 케이스 본문.

## 실행 순서

Step 1 → 2 → 3 → 4 → 5 → 6 (Retriever → prepare 확장 → session → CLI → 테스트).

## 입출력 예제

| 시나리오 | 입력 | 결과 |
|---------|------|------|
| 관련 질문 + 인덱스 있음 | "설치 어떻게 해?" | `[a.md > 설치]` 발췌 블록이 system 메시지로 주입 |
| 무관 질문 | 유사도 전부 < 0.35 | 발췌 없이 순수 대화 |
| 검색 실패 (임베딩 서버 다운) | 임의 질문 | 발췌 없이 대화 계속 (크래시 없음) |
| `/index` | — | docs/ 스캔 → 임베딩 → 저장 → 즉시 활성 |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/rag/retriever.ts
export interface RetrieverConfig { topK?: number; minScore?: number; }
export interface RetrievedContext { block: string | null; hits: SearchHit[]; }
export class Retriever {
  constructor(embedder: Embedder, index: VectorIndex, config?: RetrieverConfig);
  retrieve(query: string): Promise<RetrievedContext>;
}

// src/chat/session.ts — 추가분
export interface ContextRetriever { retrieve(query: string): Promise<{ block: string | null }>; }
// ChatSessionConfig에 retriever?: ContextRetriever 추가 (기존 시그니처 불변)

// src/context/context-manager.ts — 변경분
// prepare(systemPrompt, history, userInput, contextBlock?: string | null) — 선택 4번째 인자
```

## Definition of Done

- [ ] DoD-31: 모든 Step 통과 + Verify ✓
- [ ] DoD-32: `npm run typecheck` exit 0
- [ ] DoD-33: `npm test` 80 passed (기존 73 회귀 없음)
- [ ] DoD-34: retriever 실패 경로 테스트 동반
- [ ] DoD-35: CLAUDE.md 갱신 (`/index`, env 안내)
- [ ] DoD-36: 수동 AC 시나리오 통과

## Observability plan

N/A — 운영 영향 없음. 인덱스 상태는 시작 배너와 `/index` 출력으로 노출.

## 최종 검증

```bash
# 자동 검증
npm run typecheck && npm test && npm run build && echo "PHASE 3 PASS (자동)"

# CLAUDE.md 컨벤션 섹션 끝에 다음 1줄 추가:
# - RAG: `/index`로 `docs/` 인덱싱 (`.chatbot/rag-index.json`, env `RAG_DOCS_DIR`/`CHATBOT_INDEX_FILE`)

# 수동 AC 시나리오 (Ollama 실행 상태)
npm run dev
# /index 입력 → "(인덱스 구축 완료: N청크 ...)" 확인
# "이 프로젝트의 컨텍스트 예산 기본값은 몇 토큰이야?" → docs/plans 근거(4096)로 답하는지 확인
# /exit 후 재실행 → "(RAG 인덱스 로드: N청크...)" 배너 확인
```
