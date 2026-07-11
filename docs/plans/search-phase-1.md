# Phase 1: BM25 키워드 검색 (밑바닥)

@fidelity-check tokens: Bm25Index, tokenize, idf, allChunks, bm25Search

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지 (BM25는 표준 라이브러리로 밑바닥 구현)
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성 — Map/배열 접근은 `?? 0` / `.at()` 가드

## 전제 조건

Phase 0이 노출한 인터페이스 (그대로 복사):

```ts
// eval/run.ts
export type SearchFn = (query: string, topK: number) => Promise<string[]>;
export function runEval(label: string, search: SearchFn): Promise<void>;

// eval/golden.ts — GOLDEN_QUESTIONS
```

Segment 3 인터페이스:

```ts
// src/rag/vector-index.ts
export interface IndexedChunk { source: string; heading: string; content: string; embedding: number[]; }
export interface SearchHit { chunk: IndexedChunk; score: number; }
export class VectorIndex { get size(): number; search(...): SearchHit[]; }
```

## 현재 상태

`VectorIndex`는 청크를 `private readonly chunks`로 감춰 벡터 검색만 노출한다 — BM25는 같은 청크 집합에 키워드 검색을 얹어야 하므로 `allChunks()` 읽기 접근자를 추가한다. `src/rag/bm25.ts` 없음.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| BM25 (순수 자료구조) | ✓ (청크 배열로 생성) | ✓ | 임베딩 불필요 — 완전 결정적 |
| VectorIndex.allChunks | ✓ (기존 인스턴스) | ✓ | — |

## Step 1: VectorIndex.allChunks 접근자 (`src/rag/vector-index.ts` — modify, 메서드 1개 추가)

### Context

BM25 인덱스가 같은 청크 집합을 읽도록 읽기 전용 접근자 추가. 복사본 반환으로 내부 배열 캡슐화 유지.

### Code

`get size(): number { ... }` 메서드 바로 아래에 삽입:

```ts

  /** 인덱싱된 청크 전체 (읽기 전용 복사본) — BM25 등 대체 검색용 */
  allChunks(): IndexedChunk[] {
    return this.chunks.map((c) => ({ ...c }));
  }
```

### Anchor

`  get size(): number {`로 시작하는 메서드의 닫는 `  }` 뒤 (size getter는 파일 내 유일).

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 120 passed (기존 vector-index 테스트 회귀 없음)
# 3. 의미 검증
grep -c "allChunks()" src/rag/vector-index.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

새 접근자 → 소비자(Step 2 Bm25Index) + 테스트(Step 3, Phase 2 하이브리드).

### Do Not Touch

`search`/`save`/`load`/생성자, 타입 가드.

## Step 2: BM25 인덱스 (`src/rag/bm25.ts` — create)

### Context

BM25 랭킹 함수 밑바닥 구현. 토크나이저는 유니코드 단어 경계 기반(한글/영문/숫자 런) + 소문자화. IDF는 표준 BM25 공식(음수 방지 변형), k1=1.5·b=0.75 관례값. 임베딩과 무관하게 완전 결정적이라 단위 테스트가 쉽다.

### Code
```ts
import type { IndexedChunk, SearchHit } from './vector-index.js';

const K1 = 1.5;
const B = 0.75;

/** 유니코드 단어 런(한글/영문/숫자)으로 토큰화 + 소문자화 */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ?? [];
}

/** BM25 IDF (음수 방지 변형): log(1 + (N - df + 0.5) / (df + 0.5)) */
export function idf(totalDocs: number, docFreq: number): number {
  return Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
}

interface DocStats {
  chunk: IndexedChunk;
  termFreq: Map<string, number>;
  length: number;
}

export class Bm25Index {
  private readonly docs: DocStats[];
  private readonly docFreq: Map<string, number>;
  private readonly avgLength: number;

  constructor(chunks: readonly IndexedChunk[]) {
    this.docs = chunks.map((chunk) => {
      const tokens = tokenize(`${chunk.heading} ${chunk.content}`);
      const termFreq = new Map<string, number>();
      for (const token of tokens) {
        termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
      }
      return { chunk, termFreq, length: tokens.length };
    });
    this.docFreq = new Map();
    for (const doc of this.docs) {
      for (const term of doc.termFreq.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
    const totalLength = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgLength = this.docs.length > 0 ? totalLength / this.docs.length : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  /** 질의 토큰의 BM25 점수 합으로 상위 topK 청크 반환 (점수 0 제외) */
  search(query: string, topK: number): SearchHit[] {
    const queryTerms = tokenize(query);
    const totalDocs = this.docs.length;
    const hits: SearchHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.termFreq.get(term) ?? 0;
        if (tf === 0) {
          continue;
        }
        const df = this.docFreq.get(term) ?? 0;
        const norm =
          tf * (K1 + 1) /
          (tf + K1 * (1 - B + (B * doc.length) / (this.avgLength || 1)));
        score += idf(totalDocs, df) * norm;
      }
      if (score > 0) {
        hits.push({ chunk: doc.chunk, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
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
echo "N/A: 테스트는 Step 3에서 동반 작성"
# 3. 의미 검증
grep -c "K1\|avgLength" src/rag/bm25.ts
  # 기대: 4 이상 (BM25 정규화 로직 존재)
```

### 동반 변경 (Side Effects)

새 export → 단위 테스트(Step 3) + 하이브리드 소비(Phase 2).

### Do Not Touch

`src/rag/vector-index.ts` (Step 1 완료본), `src/rag/cosine.ts`.

## Step 3: BM25 테스트 (`src/rag/__tests__/bm25.test.ts` — create)

### Code

### 검증 대상

- spy: N/A (결정적 자료구조)
- branch: 토큰화(한/영/숫자·특수문자 제거), 키워드 정확 매칭 상위, 없는 단어 0, 빈 인덱스, 흔한 단어 IDF 낮음
- state: 검색 순위·점수 부호

```ts
import { describe, expect, it } from 'vitest';
import type { IndexedChunk } from '../vector-index.js';
import { Bm25Index, idf, tokenize } from '../bm25.js';

function chunk(source: string, content: string): IndexedChunk {
  return { source, heading: '', content, embedding: [] };
}

describe('tokenize', () => {
  it('한글·영문·숫자 런으로 나누고 특수문자를 버린다 (정상)', () => {
    expect(tokenize('Ollama의 num_ctx는 4096!')).toEqual(['ollama', '의', 'num', 'ctx는', '4096']);
  });

  it('빈 문자열은 빈 배열 (경계값)', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!!! @#$')).toEqual([]);
  });
});

describe('idf', () => {
  it('흔한 단어일수록 IDF가 낮다 (정상)', () => {
    expect(idf(100, 1)).toBeGreaterThan(idf(100, 50));
  });
});

describe('Bm25Index', () => {
  const docs = [
    chunk('a.md', '양자화는 모델 메모리를 줄인다'),
    chunk('b.md', '임베딩은 텍스트를 벡터로 바꾼다'),
    chunk('c.md', '청킹은 문서를 조각으로 나눈다'),
  ];

  it('질의 키워드가 담긴 문서를 상위로 반환한다 (정상)', () => {
    const index = new Bm25Index(docs);
    const hits = index.search('양자화 메모리', 3);
    expect(hits.at(0)?.chunk.source).toBe('a.md');
    expect(hits.at(0)?.score).toBeGreaterThan(0);
  });

  it('질의 단어가 어느 문서에도 없으면 빈 결과 (에러/경계)', () => {
    const index = new Bm25Index(docs);
    expect(index.search('블록체인 채굴', 3)).toEqual([]);
  });

  it('빈 인덱스는 항상 빈 결과 (경계값)', () => {
    const index = new Bm25Index([]);
    expect(index.size).toBe(0);
    expect(index.search('아무거나', 3)).toEqual([]);
  });

  it('topK로 결과 수를 제한한다 (경계값)', () => {
    const many = [
      chunk('1.md', '검색 검색'),
      chunk('2.md', '검색'),
      chunk('3.md', '검색'),
    ];
    expect(new Bm25Index(many).search('검색', 2)).toHaveLength(2);
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
  # 기대: 전체 128 passed (120 + 8)
# 3. 의미 검증
grep -c "toBe('a.md')\|toEqual(\[\])" src/rag/__tests__/bm25.test.ts
  # 기대: 3 이상 (순위·빈결과 검증)
```

### 동반 변경 (Side Effects)

N/A (Step 2의 동반 테스트)

### Do Not Touch

`src/rag/bm25.ts`.

## 실행 순서

Step 1 → 2 → 3.

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `tokenize` | `'Ollama의 num_ctx는 4096!'` | `['ollama','의','num','ctx는','4096']` |
| `Bm25Index.search` | 질의 `'양자화 메모리'` | `a.md`(양자화 문서) 최상위 |
| `Bm25Index.search` | 없는 단어 | `[]` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/rag/vector-index.ts — 추가분
// VectorIndex.allChunks(): IndexedChunk[]

// src/rag/bm25.ts
export function tokenize(text: string): string[];
export function idf(totalDocs: number, docFreq: number): number;
export class Bm25Index {
  constructor(chunks: readonly IndexedChunk[]);
  get size(): number;
  search(query: string, topK: number): SearchHit[];
}
```

## Definition of Done

- [ ] DoD-11: 모든 Step 통과 + Verify ✓
- [ ] DoD-12: `npm run typecheck` exit 0
- [ ] DoD-13: `npm test` 128 passed (기존 120 회귀 없음)
- [ ] DoD-14: 토큰화·랭킹·빈입력 테스트 동반
- [ ] DoD-15: 문서 갱신 불필요
- [ ] DoD-16: Phase 2 전제 조건 만족

## Observability plan

N/A — 검색 품질은 Phase 2 eval로 측정.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 1 PASS"
```
