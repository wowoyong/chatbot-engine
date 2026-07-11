# Phase 1: capture 저장소 + App.captureKnowledge 통합

@fidelity-check tokens: saveCaptured, slugify, captureKnowledge, currentIndex, CaptureResult

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성
6. 테스트 파일 시스템은 `.test-tmp/<uuid>/`만 사용

## 전제 조건

Phase 0이 노출한 인터페이스 (그대로 복사):

```ts
// src/knowledge/extractor.ts
export interface KnowledgeCandidate { title: string; category: KnowledgeCategory; content: string; }
export function extractKnowledge(client: LlmClient, history: readonly ChatMessage[]): Promise<KnowledgeCandidate[]>;

// src/knowledge/novelty.ts
export interface NoveltyVerdict { candidate: KnowledgeCandidate; maxScore: number; isNew: boolean; }
export function judgeNovelty(embedder: Embedder, index: VectorIndex | null, candidates: readonly KnowledgeCandidate[], threshold?: number): Promise<NoveltyVerdict[]>;
```

Segment 3~5 인터페이스 (수정 대상 bootstrap이 사용 중):

```ts
// src/store/atomic-file.ts
export function writeFileAtomic(filePath: string, content: string): Promise<void>;

// src/app/bootstrap.ts — 현재 App: { session, store, docsDir, indexFile, modelName, startupNotices, rebuildIndex }
// 내부 클로저: let retriever (인덱스 원본은 미보관 — 본 Phase에서 currentIndex 추가)
```

## 현재 상태

bootstrap은 `retriever`만 보관하고 `VectorIndex` 원본을 놓는다 — novelty 판정이 `index.search`를 직접 쓰므로 `currentIndex` 클로저 변수를 추가한다. rebuild 로직은 `rebuildIndex`와 `captureKnowledge` 양쪽에서 쓰므로 내부 함수로 승격한다.

## Step 1: capture 저장소 (`src/knowledge/capture-store.ts` — create)

### Context

새 지식을 `<baseDir>/<category>/<슬러그>.md`로 저장. 슬러그는 한글 보존(파일명 가독성), 특수문자는 `-`로, 충돌 시 `-2`, `-3` 부여. novelty 점수를 파일에 기록 — threshold 튜닝의 관찰 데이터.

### Code
```ts
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../store/atomic-file.js';
import type { NoveltyVerdict } from './novelty.js';

/** 제목 → 파일명 슬러그 (한글 보존, 특수문자 '-', 최대 50자) */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : 'knowledge';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 신규 지식을 카테고리 디렉토리에 md로 저장하고 경로를 반환한다 (파일명 충돌 시 -2, -3…) */
export async function saveCaptured(
  baseDir: string,
  verdict: NoveltyVerdict,
  capturedAt: string,
): Promise<string> {
  const dir = join(baseDir, verdict.candidate.category);
  const base = slugify(verdict.candidate.title);
  let path = join(dir, `${base}.md`);
  let suffix = 2;
  while (await exists(path)) {
    path = join(dir, `${base}-${suffix}.md`);
    suffix += 1;
  }
  const body = [
    `# ${verdict.candidate.title}`,
    '',
    verdict.candidate.content,
    '',
    `> 수집: ${capturedAt} · 분류: ${verdict.candidate.category} · novelty 최고 유사도: ${verdict.maxScore.toFixed(3)}`,
    '',
  ].join('\n');
  await writeFileAtomic(path, body);
  return path;
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
grep -c "writeFileAtomic" src/knowledge/capture-store.ts
  # 기대: 2 (import + 사용 — 공용 유틸 재사용, 인라인 재구현 없음)
```

### 동반 변경 (Side Effects)

새 export → 테스트(Step 2) + 호출처(Step 3 bootstrap)를 같은 Phase에서 작성.

### Do Not Touch

`src/knowledge/extractor.ts`, `src/knowledge/novelty.ts`, `src/store/**`.

## Step 2: 저장소 테스트 (`src/knowledge/__tests__/capture-store.test.ts` — create)

### Code

### 검증 대상

- spy: N/A (실제 FS — 산출 파일로 검증)
- branch: 슬러그 정규화(한글/특수문자/빈 제목), 파일명 충돌 -2 부여, 파일 본문 포맷(제목/내용/메타 라인)
- state: 반환 경로, 파일 내용

```ts
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NoveltyVerdict } from '../novelty.js';
import { saveCaptured, slugify } from '../capture-store.js';

function verdict(title: string, maxScore = 0.123): NoveltyVerdict {
  return {
    candidate: { title, category: 'fact', content: `${title}에 대한 내용` },
    maxScore,
    isNew: true,
  };
}

describe('slugify', () => {
  it('한글은 보존하고 특수문자·공백은 하이픈으로 바꾼다 (정상)', () => {
    expect(slugify('Ollama의 기본 num_ctx는 4096!')).toBe('ollama의-기본-num-ctx는-4096');
  });

  it('의미 있는 문자가 없으면 knowledge로 대체한다 (경계값)', () => {
    expect(slugify('!!! ***')).toBe('knowledge');
    expect(slugify('')).toBe('knowledge');
  });
});

describe('saveCaptured', () => {
  let dir: string;

  beforeEach(() => {
    dir = join('.test-tmp', randomUUID());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('카테고리 디렉토리에 제목·내용·메타를 담아 저장한다 (정상)', async () => {
    const path = await saveCaptured(dir, verdict('테스트 지식'), '2026-07-11');
    expect(path).toBe(join(dir, 'fact', '테스트-지식.md'));

    const body = await readFile(path, 'utf8');
    expect(body).toContain('# 테스트 지식');
    expect(body).toContain('테스트 지식에 대한 내용');
    expect(body).toContain('수집: 2026-07-11 · 분류: fact · novelty 최고 유사도: 0.123');
  });

  it('같은 제목이 이미 있으면 -2, -3을 붙인다 (경계값)', async () => {
    const p1 = await saveCaptured(dir, verdict('중복'), 't');
    const p2 = await saveCaptured(dir, verdict('중복'), 't');
    const p3 = await saveCaptured(dir, verdict('중복'), 't');
    expect(p1).toBe(join(dir, 'fact', '중복.md'));
    expect(p2).toBe(join(dir, 'fact', '중복-2.md'));
    expect(p3).toBe(join(dir, 'fact', '중복-3.md'));
  });

  it('디렉토리가 없어도 자동 생성된다 — writeFileAtomic 경유 (경계값)', async () => {
    const path = await saveCaptured(join(dir, 'deep'), verdict('중첩'), 't');
    expect(await readFile(path, 'utf8')).toContain('# 중첩');
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
  # 기대: 전체 108 passed (103 + 5)
# 3. 의미 검증
grep -c "중복-2" src/knowledge/__tests__/capture-store.test.ts
  # 기대: 1 (충돌 처리 검증)
```

### 동반 변경 (Side Effects)

N/A (Step 1의 동반 테스트)

### Do Not Touch

`src/knowledge/capture-store.ts`.

## Step 3: bootstrap 통합 (`src/app/bootstrap.ts` — modify, 전체 교체)

### Context

변경 3가지: ① `currentIndex` 클로저 변수 추가 (novelty가 인덱스 원본 필요) ② rebuild 로직을 내부 함수 `rebuild()`로 승격 (rebuildIndex·captureKnowledge 공용 — `this` 바인딩 회피) ③ `captureKnowledge()` 추가 — 추출→판정→저장→(저장분 있으면) 재인덱싱. capture 디렉토리는 `<docsDir>/captured` 고정 — RAG 소스 안에 저장되어 재인덱싱 즉시 novelty 기준이 갱신된다. 기존 public 시그니처 불변(추가만) — 기존 테스트 무수정.

### Code
```ts
import { join } from 'node:path';
import { ChatSession } from '../chat/session.js';
import { extractKnowledge } from '../knowledge/extractor.js';
import { judgeNovelty } from '../knowledge/novelty.js';
import { saveCaptured } from '../knowledge/capture-store.js';
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

export interface CaptureResult {
  /** 추출된 후보 수 */
  extracted: number;
  /** 저장된 파일 경로들 */
  saved: string[];
  /** 기존 지식으로 판정되어 스킵된 제목들 */
  skipped: string[];
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
  /** 대화에서 새 지식을 추출·novelty 판정·저장하고, 저장분이 있으면 재인덱싱 */
  captureKnowledge(capturedAt: string): Promise<CaptureResult>;
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

  let currentIndex: VectorIndex | null = null;
  let retriever: Retriever | null = null;

  const loadedIndex = await VectorIndex.load(indexFile);
  if (loadedIndex !== null) {
    if (loadedIndex.model === embedderModel) {
      currentIndex = loadedIndex;
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

  async function rebuild(createdAt: string): Promise<number> {
    const built = await buildIndex(embedder, docsDir, {
      model: embedderModel,
      createdAt,
    });
    await built.save(indexFile);
    currentIndex = built;
    retriever = new Retriever(embedder, built);
    return built.size;
  }

  return {
    session,
    store,
    docsDir,
    indexFile,
    modelName,
    startupNotices,
    rebuildIndex: rebuild,
    async captureKnowledge(capturedAt: string): Promise<CaptureResult> {
      const candidates = await extractKnowledge(client, session.getHistory());
      const verdicts = await judgeNovelty(embedder, currentIndex, candidates);
      const captureDir = join(docsDir, 'captured');
      const saved: string[] = [];
      const skipped: string[] = [];
      for (const verdict of verdicts) {
        if (verdict.isNew) {
          saved.push(await saveCaptured(captureDir, verdict, capturedAt));
        } else {
          skipped.push(verdict.candidate.title);
        }
      }
      if (saved.length > 0) {
        await rebuild(capturedAt);
      }
      return { extracted: candidates.length, saved, skipped };
    },
  };
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
  # 기대: 108 passed — bootstrap 기존 4개·서버 8개 회귀 없음 (public 시그니처 추가만)
# 3. 의미 검증
grep -c "currentIndex = " src/app/bootstrap.ts
  # 기대: 3 (초기 null + 로드 시 + rebuild 시 — 인덱스 추적 완전)
```

### 동반 변경 (Side Effects)

- 새 메서드 `captureKnowledge` → 통합 테스트 Step 4 (같은 Phase), 인터페이스 호출처(CLI·서버·UI)는 Phase 2
- rebuild 승격은 동작 불변 — 기존 rebuildIndex 테스트(bootstrap.test.ts 3번 케이스)가 회귀 검증

### Do Not Touch

`src/app/__tests__/bootstrap.test.ts`의 기존 케이스, `src/cli/**`, `src/server/**` (Phase 2에서), `src/knowledge/*.ts` (Step 1~2 완료본).

## Step 4: capture 통합 테스트 (`src/app/__tests__/bootstrap-capture.test.ts` — create)

### Code

### 검증 대상

- spy: FakeLlmClient.chatResult 제어 — 추출 JSON/불량 출력 시나리오
- branch: 새 지식 저장+재인덱싱, 기존 지식 스킵(재인덱싱 없음), 추출 실패 throw, 빈 히스토리(LLM 미호출)
- state: CaptureResult 필드, captured 파일 존재, 인덱스 파일 갱신

```ts
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, Embedder, LlmClient } from '../../llm/types.js';
import { createApp } from '../bootstrap.js';

class FakeLlmClient implements LlmClient {
  chatResult = '[]';

  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return this.chatResult;
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

const HISTORY: ChatMessage[] = [
  { role: 'user', content: '질문' },
  { role: 'assistant', content: '답변' },
];

const CANDIDATE_JSON =
  '[{"title":"새 지식","category":"fact","content":"완전히 새로운 내용"}]';

describe('App.captureKnowledge', () => {
  let dir: string;
  let fake: FakeLlmClient;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(join(dir, 'docs'), { recursive: true });
    fake = new FakeLlmClient();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeApp() {
    const app = await createApp(
      {
        CHATBOT_SESSION_FILE: join(dir, 'session.json'),
        CHATBOT_INDEX_FILE: join(dir, 'index.json'),
        RAG_DOCS_DIR: join(dir, 'docs'),
      },
      { client: fake, embedder: new FakeEmbedder() },
    );
    return app;
  }

  it('새 지식을 저장하고 재인덱싱한다 (정상)', async () => {
    fake.chatResult = CANDIDATE_JSON;
    const app = await makeApp();
    app.session.restore(HISTORY);

    const result = await app.captureKnowledge('2026-07-11');

    expect(result.extracted).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.saved).toEqual([join(dir, 'docs', 'captured', 'fact', '새-지식.md')]);
    await access(result.saved.at(0) ?? ''); // 파일 실재
    await access(join(dir, 'index.json')); // 재인덱싱 산출

    const app2 = await makeApp();
    expect(app2.startupNotices.join(' ')).toContain('RAG 인덱스 로드: 1청크');
  });

  it('기존 인덱스와 유사한 지식은 스킵하고 재인덱싱하지 않는다 (정상)', async () => {
    fake.chatResult = CANDIDATE_JSON;
    // 기존 지식이 담긴 인덱스 구성 (FakeEmbedder는 모든 텍스트를 [1,0]으로 — 유사도 1)
    await writeFile(join(dir, 'docs', 'existing.md'), '# 기존\n지식', 'utf8');
    const seed = await makeApp();
    await seed.rebuildIndex('t0');

    const app = await makeApp();
    app.session.restore(HISTORY);
    const result = await app.captureKnowledge('2026-07-11');

    expect(result.saved).toEqual([]);
    expect(result.skipped).toEqual(['새 지식']);
    let capturedExists = true;
    try {
      await access(join(dir, 'docs', 'captured'));
    } catch {
      capturedExists = false;
    }
    expect(capturedExists).toBe(false);
  });

  it('추출 출력이 불량이면 throw한다 — 호출측 안내 책임 (에러)', async () => {
    fake.chatResult = '추출할 지식이 없네요.';
    const app = await makeApp();
    app.session.restore(HISTORY);

    await expect(app.captureKnowledge('t')).rejects.toThrow('찾지 못했습니다');
  });

  it('빈 히스토리면 추출 0건으로 조용히 끝난다 (경계값)', async () => {
    const app = await makeApp();
    const result = await app.captureKnowledge('t');
    expect(result).toEqual({ extracted: 0, saved: [], skipped: [] });
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
  # 기대: 전체 112 passed (108 + 4)
# 3. 의미 검증
grep -c "rejects.toThrow" src/app/__tests__/bootstrap-capture.test.ts
  # 기대: 1 (추출 실패 경로)
```

### 동반 변경 (Side Effects)

N/A (Step 3의 동반 테스트)

### Do Not Touch

`src/app/bootstrap.ts`, `src/app/__tests__/bootstrap.test.ts`.

## 실행 순서

Step 1 → 2 → 3 → 4.

## 입출력 예제

| 시나리오 | CaptureResult |
|---------|---------------|
| 새 지식 1건 (인덱스 없음) | `{extracted: 1, saved: ['…/captured/fact/새-지식.md'], skipped: []}` + 재인덱싱 |
| 기존과 유사도 1.0 | `{extracted: 1, saved: [], skipped: ['새 지식']}` — 재인덱싱 없음 |
| 추출 출력 불량 | throw (호출측이 "다시 시도" 안내) |
| 빈 히스토리 | `{extracted: 0, saved: [], skipped: []}` — LLM 미호출 |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/knowledge/capture-store.ts
export function slugify(title: string): string;
export function saveCaptured(baseDir: string, verdict: NoveltyVerdict, capturedAt: string): Promise<string>;

// src/app/bootstrap.ts — 추가분
export interface CaptureResult { extracted: number; saved: string[]; skipped: string[]; }
// App.captureKnowledge(capturedAt: string): Promise<CaptureResult>
// 기존 App 필드·메서드 시그니처 불변
```

## Definition of Done

- [ ] DoD-11: 모든 Step 통과 + Verify ✓
- [ ] DoD-12: `npm run typecheck` exit 0
- [ ] DoD-13: `npm test` 112 passed (기존 103 회귀 없음)
- [ ] DoD-14: 저장·스킵·실패·빈 입력 4경로 테스트 동반
- [ ] DoD-15: 문서 갱신 불필요 (사용자 명령은 Phase 2)
- [ ] DoD-16: Phase 2 전제 조건 만족

## Observability plan

N/A — 저장 파일의 메타 라인(수집 시각·분류·novelty 점수)이 관찰 데이터.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 1 PASS"
```
