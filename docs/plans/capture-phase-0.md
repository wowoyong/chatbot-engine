# Phase 0: 지식 추출기 + novelty 판정기

@fidelity-check tokens: extractKnowledge, parseCandidates, judgeNovelty, KNOWLEDGE_CATEGORIES, DEFAULT_NOVELTY_THRESHOLD

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어
5. `noUncheckedIndexedAccess` 활성 — `.at()` + `??` 가드

## 전제 조건

Segment 1~3 인터페이스 중 사용하는 것 (그대로 복사):

```ts
// src/llm/types.ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}
export interface Embedder { embed(texts: string[]): Promise<number[][]>; }

// src/rag/vector-index.ts
export class VectorIndex {
  get size(): number;
  search(queryEmbedding: readonly number[], topK: number, minScore: number): SearchHit[];
}
export interface SearchHit { chunk: IndexedChunk; score: number; }
```

## 현재 상태

`src/knowledge/` 디렉토리 없음. 본 Phase는 기존 파일을 일절 수정하지 않는다 (통합은 Phase 1).

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| LlmClient (추출) | ✓ (함수 인자) | ✓ (chat 반환값 제어 Fake) | — |
| Embedder / VectorIndex (novelty) | ✓ (함수 인자, index는 null 허용) | ✓ | — |
| 파일 시스템 (Phase 1 저장소) | ✓ (baseDir 인자) | ✗ (실제 FS) | `.test-tmp/<uuid>/` 격리 |
| 현재 시각 (Phase 1 capturedAt) | ✓ (인자 주입) | ✓ | 테스트는 고정 문자열 |

## Step 1: 지식 추출기 (`src/knowledge/extractor.ts` — create)

### Context

R1 대응이 이 파일의 핵심: 8B 모델의 JSON 출력은 코드펜스 감싸기·부가 설명 섞기·불량 항목이 흔하다. `parseCandidates`는 첫 `[`부터 마지막 `]`까지만 파싱하고(관대), 항목 단위 스키마 가드로 불량 항목만 조용히 드롭한다(전체 실패 방지). JSON 배열 자체를 못 찾으면 throw — 호출측이 "다시 시도" 안내. 잘못된 category는 가장 포괄적인 `concept`으로 정규화.

### Code
```ts
import type { ChatMessage, LlmClient } from '../llm/types.js';

export const KNOWLEDGE_CATEGORIES = [
  'concept',
  'fact',
  'preference',
  'howto',
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export interface KnowledgeCandidate {
  title: string;
  category: KnowledgeCategory;
  content: string;
}

const EXTRACT_SYSTEM_PROMPT = [
  '다음 대화에서 이후에도 재사용할 가치가 있는 지식을 추출하라.',
  '- 각 항목은 대화 맥락 없이도 이해되는 자기완결적 설명으로 작성하라',
  '- category는 다음 중 하나만: concept(개념/원리), fact(사실/수치), preference(사용자 선호/결정), howto(방법/절차)',
  '- 추출할 것이 없으면 빈 배열 []',
  '- 다른 텍스트 없이 JSON 배열만 출력: [{"title":"...","category":"...","content":"..."}]',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toCategory(value: unknown): KnowledgeCategory {
  return typeof value === 'string' &&
    (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value)
    ? (value as KnowledgeCategory)
    : 'concept';
}

/** LLM 출력에서 JSON 배열을 관대하게 파싱한다 (코드펜스/부가 텍스트 방어) */
export function parseCandidates(raw: string): KnowledgeCandidate[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) {
    throw new Error(
      `지식 추출 응답에서 JSON 배열을 찾지 못했습니다: ${raw.slice(0, 80)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('지식 추출 응답의 JSON 파싱에 실패했습니다');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('지식 추출 응답이 배열이 아닙니다');
  }
  const candidates: KnowledgeCandidate[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue; // 불량 항목은 드롭 — 전체 실패 방지
    }
    const title = item['title'];
    const content = item['content'];
    if (typeof title !== 'string' || title.trim().length === 0) {
      continue;
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      continue;
    }
    candidates.push({
      title: title.trim(),
      category: toCategory(item['category']),
      content: content.trim(),
    });
  }
  return candidates;
}

/** 대화 히스토리에서 지식 후보를 추출한다. 빈 히스토리면 LLM 호출 없이 빈 배열 */
export async function extractKnowledge(
  client: LlmClient,
  history: readonly ChatMessage[],
): Promise<KnowledgeCandidate[]> {
  if (history.length === 0) {
    return [];
  }
  const transcript = history
    .map((m) => `${m.role === 'user' ? '사용자' : '어시스턴트'}: ${m.content}`)
    .join('\n');
  const raw = await client.chat([
    { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
    { role: 'user', content: transcript },
  ]);
  return parseCandidates(raw);
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
echo "N/A: 테스트는 Step 3에서 동반 작성"
# 3. 의미 검증
grep -c "continue; // 불량 항목은 드롭" src/knowledge/extractor.ts
  # 기대: 1 (항목 단위 방어 존재)
```

### 동반 변경 (Side Effects)

새 상수(`KNOWLEDGE_CATEGORIES`)/가드(파싱 실패 throw) → 테스트가 src에서 import + throw 경로 테스트 (Step 3, 단일 소스).

### Do Not Touch

`src/llm/**`, `src/rag/**`, `src/chat/**`, `src/app/**`.

## Step 2: novelty 판정기 (`src/knowledge/novelty.ts` — create)

### Context

"우리가 갖고 있지 못한 지식"의 판정 기준. 후보를 임베딩해 기존 인덱스 최고 유사도를 측정 — threshold(기본 0.75) 이상이면 이미 아는 지식. 인덱스가 없거나 비었으면 정의상 전부 신규. 판정 점수는 저장 파일에 기록되어 threshold 튜닝의 관찰 데이터가 된다 (R2 완화).

### Code
```ts
import type { Embedder } from '../llm/types.js';
import type { VectorIndex } from '../rag/vector-index.js';
import type { KnowledgeCandidate } from './extractor.js';

export interface NoveltyVerdict {
  candidate: KnowledgeCandidate;
  /** 기존 인덱스와의 최고 유사도 (인덱스 없으면 0) */
  maxScore: number;
  isNew: boolean;
}

export const DEFAULT_NOVELTY_THRESHOLD = 0.75;

/**
 * 후보별 기존 인덱스 최고 유사도로 신규 여부를 판정한다.
 * threshold 이상 → 이미 아는 지식(스킵 대상). 인덱스 없음/빈 인덱스 → 전부 신규.
 */
export async function judgeNovelty(
  embedder: Embedder,
  index: VectorIndex | null,
  candidates: readonly KnowledgeCandidate[],
  threshold: number = DEFAULT_NOVELTY_THRESHOLD,
): Promise<NoveltyVerdict[]> {
  if (candidates.length === 0) {
    return [];
  }
  if (index === null || index.size === 0) {
    return candidates.map((candidate) => ({
      candidate,
      maxScore: 0,
      isNew: true,
    }));
  }
  const embeddings = await embedder.embed(
    candidates.map((c) => `${c.title}\n${c.content}`),
  );
  return candidates.map((candidate, i) => {
    const embedding = embeddings.at(i) ?? [];
    const top = embedding.length > 0 ? index.search(embedding, 1, 0) : [];
    const maxScore = top.at(0)?.score ?? 0;
    return { candidate, maxScore, isNew: maxScore < threshold };
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
echo "N/A: 테스트는 Step 4에서 동반 작성"
# 3. 의미 검증
grep -c "DEFAULT_NOVELTY_THRESHOLD = 0.75" src/knowledge/novelty.ts
  # 기대: 1 (테스트가 import할 단일 소스)
```

### 동반 변경 (Side Effects)

새 상수 export → 테스트가 src에서 import (Step 4). 호출처(App.captureKnowledge)는 Phase 1.

### Do Not Touch

`src/knowledge/extractor.ts` (Step 1 완료본), `src/rag/**`.

## Step 3: 추출기 테스트 (`src/knowledge/__tests__/extractor.test.ts` — create)

### Code

### 검증 대상

- spy: `FakeLlmClient.calls` — 빈 히스토리 시 LLM 미호출, 시스템 프롬프트에 카테고리 정의 포함
- branch: 정상 JSON, 코드펜스 감싼 출력, 부가 텍스트 섞임, JSON 없음 throw, 불량 항목 드롭 + category 정규화
- state: 반환 후보 배열의 내용/개수

```ts
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, LlmClient } from '../../llm/types.js';
import { KNOWLEDGE_CATEGORIES, extractKnowledge, parseCandidates } from '../extractor.js';

class FakeLlmClient implements LlmClient {
  readonly calls: ChatMessage[][] = [];
  chatResult = '[]';

  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    this.calls.push(messages);
    return this.chatResult;
  }

  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string> {
    yield 'ok';
  }
}

const HISTORY: ChatMessage[] = [
  { role: 'user', content: '파란색이 좋아' },
  { role: 'assistant', content: '기억할게요' },
];

describe('parseCandidates', () => {
  it('정상 JSON 배열을 파싱한다 (정상)', () => {
    const raw = '[{"title":"선호 색","category":"preference","content":"사용자는 파란색을 선호한다"}]';
    expect(parseCandidates(raw)).toEqual([
      { title: '선호 색', category: 'preference', content: '사용자는 파란색을 선호한다' },
    ]);
  });

  it('코드펜스와 부가 텍스트가 섞여도 배열 부분만 파싱한다 (경계값)', () => {
    const raw = '추출 결과입니다:\n```json\n[{"title":"t","category":"fact","content":"c"}]\n```\n끝';
    expect(parseCandidates(raw)).toHaveLength(1);
  });

  it('JSON 배열이 없으면 throw한다 (에러)', () => {
    expect(() => parseCandidates('추출할 지식이 없습니다.')).toThrow('찾지 못했습니다');
    expect(() => parseCandidates('[깨진 json')).toThrow();
  });

  it('불량 항목은 드롭하고 잘못된 category는 concept으로 정규화한다 (경계값)', () => {
    const raw = JSON.stringify([
      { title: 't1', category: 'invalid-cat', content: 'c1' },
      { title: '', category: 'fact', content: 'c2' },
      { notitle: true },
      { title: 't3', category: 'howto', content: 'c3' },
    ]);
    const result = parseCandidates(raw);
    expect(result).toEqual([
      { title: 't1', category: 'concept', content: 'c1' },
      { title: 't3', category: 'howto', content: 'c3' },
    ]);
  });

  it('빈 배열 출력은 빈 결과다 (경계값)', () => {
    expect(parseCandidates('[]')).toEqual([]);
  });
});

describe('extractKnowledge', () => {
  it('빈 히스토리면 LLM을 호출하지 않고 빈 배열을 반환한다 (경계값)', async () => {
    const fake = new FakeLlmClient();
    expect(await extractKnowledge(fake, [])).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('시스템 프롬프트에 모든 카테고리가 정의되고 대화가 전달된다 (정상)', async () => {
    const fake = new FakeLlmClient();
    fake.chatResult = '[]';

    await extractKnowledge(fake, HISTORY);

    const sysContent = fake.calls.at(0)?.at(0)?.content ?? '';
    for (const category of KNOWLEDGE_CATEGORIES) {
      expect(sysContent).toContain(category);
    }
    expect(fake.calls.at(0)?.at(1)?.content).toContain('파란색이 좋아');
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
  # 기대: 전체 99 passed (92 + 7)
# 3. 의미 검증
grep -c "KNOWLEDGE_CATEGORIES" src/knowledge/__tests__/extractor.test.ts
  # 기대: 2 (src 상수 import — 단일 소스)
```

### 동반 변경 (Side Effects)

N/A (Step 1의 동반 테스트)

### Do Not Touch

`src/knowledge/extractor.ts`.

## Step 4: novelty 테스트 (`src/knowledge/__tests__/novelty.test.ts` — create)

### Code

### 검증 대상

- spy: `FakeEmbedder.calls` — 빈 후보 시 embed 미호출, 임베딩 입력이 제목+내용
- branch: 인덱스 null(전부 신규), 유사 항목 스킵, threshold 경계, 빈 후보
- state: verdict의 maxScore/isNew

```ts
import { describe, expect, it } from 'vitest';
import type { Embedder } from '../../llm/types.js';
import { VectorIndex } from '../../rag/vector-index.js';
import type { KnowledgeCandidate } from '../extractor.js';
import { DEFAULT_NOVELTY_THRESHOLD, judgeNovelty } from '../novelty.js';

class FakeEmbedder implements Embedder {
  readonly calls: string[][] = [];
  vectors: number[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return this.vectors;
  }
}

function candidate(title: string): KnowledgeCandidate {
  return { title, category: 'fact', content: `${title} 내용` };
}

const INDEX = VectorIndex.create('m', 't', [
  { source: 'a.md', heading: '기존', content: '기존 지식', embedding: [1, 0] },
]);

describe('judgeNovelty', () => {
  it('인덱스가 없으면 전부 신규다 (경계값)', async () => {
    const embedder = new FakeEmbedder();
    const verdicts = await judgeNovelty(embedder, null, [candidate('새것')]);
    expect(verdicts).toEqual([
      { candidate: candidate('새것'), maxScore: 0, isNew: true },
    ]);
    expect(embedder.calls).toHaveLength(0);
  });

  it('기존과 유사하면 스킵, 다르면 신규로 판정한다 (정상)', async () => {
    const embedder = new FakeEmbedder();
    embedder.vectors = [
      [1, 0],
      [0, 1],
    ];

    const verdicts = await judgeNovelty(embedder, INDEX, [
      candidate('중복'),
      candidate('신규'),
    ]);

    expect(verdicts.at(0)?.isNew).toBe(false);
    expect(verdicts.at(0)?.maxScore).toBeCloseTo(1, 10);
    expect(verdicts.at(1)?.isNew).toBe(true);
    expect(embedder.calls.at(0)?.at(0)).toBe('중복\n중복 내용');
  });

  it('threshold 자체는 스킵, 그 미만은 신규다 — 경계 포함 (경계값)', async () => {
    const embedder = new FakeEmbedder();
    embedder.vectors = [[1, 0]];
    const exactly = await judgeNovelty(embedder, INDEX, [candidate('c')], 1.0);
    expect(exactly.at(0)?.isNew).toBe(false); // maxScore 1 >= threshold 1

    const embedder2 = new FakeEmbedder();
    embedder2.vectors = [[1, 0]];
    const below = await judgeNovelty(embedder2, INDEX, [candidate('c')], 1.01);
    expect(below.at(0)?.isNew).toBe(true);
    expect(DEFAULT_NOVELTY_THRESHOLD).toBeGreaterThan(0);
  });

  it('빈 후보면 embed 없이 빈 배열 (경계값)', async () => {
    const embedder = new FakeEmbedder();
    expect(await judgeNovelty(embedder, INDEX, [])).toEqual([]);
    expect(embedder.calls).toHaveLength(0);
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
  # 기대: 전체 103 passed (99 + 4)
# 3. 의미 검증
grep -c "isNew" src/knowledge/__tests__/novelty.test.ts
  # 기대: 5 이상 (판정 assertion 존재)
```

### 동반 변경 (Side Effects)

N/A (Step 2의 동반 테스트)

### Do Not Touch

`src/knowledge/novelty.ts`.

## 실행 순서

Step 1 → 2 → 3 → 4.

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `parseCandidates` | ` ```json\n[{...}]\n``` ` (코드펜스) | 후보 1건 |
| `parseCandidates` | `'추출할 지식이 없습니다.'` | throw |
| `judgeNovelty` | 인덱스 null + 후보 1 | `[{maxScore: 0, isNew: true}]` |
| `judgeNovelty` | 기존 [1,0]과 동일 벡터 후보 | `isNew: false, maxScore≈1` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/knowledge/extractor.ts
export const KNOWLEDGE_CATEGORIES: readonly ['concept', 'fact', 'preference', 'howto'];
export type KnowledgeCategory = 'concept' | 'fact' | 'preference' | 'howto';
export interface KnowledgeCandidate { title: string; category: KnowledgeCategory; content: string; }
export function parseCandidates(raw: string): KnowledgeCandidate[];
export function extractKnowledge(client: LlmClient, history: readonly ChatMessage[]): Promise<KnowledgeCandidate[]>;

// src/knowledge/novelty.ts
export interface NoveltyVerdict { candidate: KnowledgeCandidate; maxScore: number; isNew: boolean; }
export const DEFAULT_NOVELTY_THRESHOLD = 0.75;
export function judgeNovelty(embedder: Embedder, index: VectorIndex | null, candidates: readonly KnowledgeCandidate[], threshold?: number): Promise<NoveltyVerdict[]>;
```

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify ✓
- [ ] DoD-02: `npm run typecheck` exit 0
- [ ] DoD-03: `npm test` 103 passed (기존 92 회귀 없음)
- [ ] DoD-04: 파싱 실패/불량 항목/경계 threshold 테스트 동반
- [ ] DoD-05: 문서 갱신 불필요
- [ ] DoD-06: Phase 1 전제 조건 만족

## Observability plan

N/A — 운영 영향 없음. novelty 점수는 Phase 1에서 저장 파일에 기록되어 관찰 가능.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 0 PASS"
```
