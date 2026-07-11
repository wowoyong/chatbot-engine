# Phase 0: 평가 하네스 — 골든 세트 + recall@K / MRR

@fidelity-check tokens: runEval, recallAtK, meanReciprocalRank, GOLDEN_QUESTIONS

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어
5. `noUncheckedIndexedAccess` 활성 — `.at()` + `??` 가드

## 전제 조건

Segment 3 인터페이스 중 사용하는 것 (그대로 복사):

```ts
// src/rag/vector-index.ts
export interface IndexedChunk { source: string; heading: string; content: string; embedding: number[]; }
export interface SearchHit { chunk: IndexedChunk; score: number; }
export class VectorIndex {
  static create(model: string, createdAt: string, chunks: IndexedChunk[]): VectorIndex;
  get size(): number;
  search(queryEmbedding: readonly number[], topK: number, minScore: number): SearchHit[];
}

// src/rag/indexer.ts
export function buildIndex(embedder: Embedder, docsDir: string, options: { model: string; createdAt: string }): Promise<VectorIndex>;

// src/llm/ollama-embedder.ts
export class OllamaEmbedder implements Embedder { constructor(config?: OllamaEmbedderConfig); readonly model: string; embed(texts: string[]): Promise<number[][]>; }
```

## 현재 상태

`eval/` 디렉토리 없음. 검색 품질을 측정할 방법이 없어 개선 전후 비교가 불가능하다. 본 Phase는 **고정 스냅샷 코퍼스**(dev-wiki 지식 문서를 레포 내부로 동결)와 **골든 질문 세트**, 그리고 지표 산출기를 추가한다. `metric.ts`는 순수 함수라 단위 테스트하고, `run.ts`(실제 Ollama 임베딩으로 인덱싱)는 `npm run eval`로 수동 실행한다.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| 지표 계산 (metric.ts) | ✓ (순수 함수) | ✓ | 입출력만으로 검증 |
| Embedder / 인덱싱 (run.ts) | ✗ (실제 Ollama) | — | run.ts는 수동 `npm run eval` — 단위 테스트 대상 아님 (실행 AC로 갈음) |
| 코퍼스 파일 | ✓ (레포 내 동결 fixture) | — | eval/corpus/ 커밋 — 재현성 확보 |

## Step 1: 스냅샷 코퍼스 동결 (`eval/corpus/` — create, 7파일 복사)

### Context

`../dev-wiki/knowledge/`의 7개 지식 문서를 레포 내부 `eval/corpus/`로 복사해 커밋한다. 코퍼스가 고정되어야 개선 전후 점수가 항상 비교 가능하다(재현성). 복사는 결정적 — 아래 명령의 파일 목록 그대로.

### Code
```bash
mkdir -p eval/corpus
cp ../dev-wiki/knowledge/llm-basics.md eval/corpus/
cp ../dev-wiki/knowledge/chatbot-architecture.md eval/corpus/
cp ../dev-wiki/knowledge/rag.md eval/corpus/
cp ../dev-wiki/knowledge/local-llm-serving.md eval/corpus/
cp ../dev-wiki/knowledge/prompt-engineering.md eval/corpus/
cp ../dev-wiki/knowledge/langchain-overview.md eval/corpus/
cp ../dev-wiki/knowledge/langchain-comparison.md eval/corpus/
```

### Anchor

N/A — 파일 복사 (새 디렉토리)

### Verify
```bash
# 1. 빌드
echo "N/A: 데이터 파일 복사"
# 2. 테스트
echo "N/A: fixture"
# 3. 의미 검증
ls eval/corpus/*.md | wc -l | tr -d ' '
  # 기대: 7
```

### 동반 변경 (Side Effects)

새 fixture → 골든 질문(Step 2)이 이 파일명을 expectedSource로 참조 (단일 소스).

### Do Not Touch

`src/**`, `../dev-wiki/**` (읽기만).

## Step 2: 골든 질문 세트 (`eval/golden.ts` — create)

### Context

각 질문은 정답이 담긴 문서(`expectedSource` = corpus 파일명)와 매핑된다. 지표는 "top-K 안에 expectedSource 청크가 있는가"로 계산 — 정확한 청크 동일성 대신 소스 단위라 청킹 방식이 바뀌어도 견고하다. 질문은 corpus 실제 내용 기반(작성자 큐레이션).

### Code
```ts
export interface GoldenQuestion {
  question: string;
  /** 정답이 담긴 corpus 파일명 */
  expectedSource: string;
}

export const GOLDEN_QUESTIONS: GoldenQuestion[] = [
  { question: '토큰이 뭐야? 영어랑 한국어 토큰 효율이 어떻게 달라?', expectedSource: 'llm-basics.md' },
  { question: '컨텍스트 윈도우가 뭐고 왜 관리해야 해?', expectedSource: 'llm-basics.md' },
  { question: 'temperature 파라미터는 무슨 역할이야?', expectedSource: 'llm-basics.md' },
  { question: 'LLM은 왜 stateless라고 해?', expectedSource: 'llm-basics.md' },
  { question: '챗봇의 최소 구성 요소는 뭐가 있어?', expectedSource: 'chatbot-architecture.md' },
  { question: '스트림이 중간에 끊기면 히스토리를 어떻게 처리해?', expectedSource: 'chatbot-architecture.md' },
  { question: '요약 압축으로 메모리를 관리하는 방법은?', expectedSource: 'chatbot-architecture.md' },
  { question: '임베딩이 뭐고 색인이랑 질의에 같은 모델을 써야 하는 이유는?', expectedSource: 'rag.md' },
  { question: '청킹할 때 겹침을 두는 이유가 뭐야?', expectedSource: 'rag.md' },
  { question: '하이브리드 검색이 왜 필요해?', expectedSource: 'rag.md' },
  { question: 'top-K랑 최소 유사도 임계값은 무슨 역할이야?', expectedSource: 'rag.md' },
  { question: '16GB 메모리에서 14b 모델을 못 돌리는 이유가 뭐야?', expectedSource: 'local-llm-serving.md' },
  { question: '양자화가 뭐고 메모리를 얼마나 줄여줘?', expectedSource: 'local-llm-serving.md' },
  { question: 'Ollama의 OpenAI 호환 API는 어떻게 써?', expectedSource: 'local-llm-serving.md' },
  { question: '시스템 프롬프트를 작성할 때 소형 모델 주의점은?', expectedSource: 'prompt-engineering.md' },
  { question: 'RAG 발췌를 프롬프트에 넣을 때 출처 인용을 유도하는 방법은?', expectedSource: 'prompt-engineering.md' },
  { question: 'LangGraph는 뭐고 언제 써?', expectedSource: 'langchain-overview.md' },
  { question: 'DeepAgents가 뭐야?', expectedSource: 'langchain-overview.md' },
  { question: '밑바닥 구현과 LangChain의 코드량 차이가 얼마나 나?', expectedSource: 'langchain-comparison.md' },
  { question: '구조화 출력은 어떤 오류를 없애고 어떤 건 못 없애?', expectedSource: 'langchain-comparison.md' },
];
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
echo "N/A: 테스트는 Step 4에서 metric과 함께"
# 3. 의미 검증
grep -c "expectedSource:" eval/golden.ts
  # 기대: 20 (질문 20개)
```

### 동반 변경 (Side Effects)

새 상수(GOLDEN_QUESTIONS) → run.ts(Step 3)와 테스트(Step 4)가 import.

### Do Not Touch

`eval/corpus/**`.

## Step 3: 지표 계산기 (`eval/metric.ts` — create)

### Context

검색 결과(순위대로 정렬된 source 목록)와 정답 source로 recall@K와 MRR을 계산하는 순수 함수. run.ts와 테스트가 공유.

### Code
```ts
/** 순위 결과(source 배열, 0=최상위)에 expectedSource가 topK 안에 있으면 1 */
export function recallAtK(
  rankedSources: readonly string[],
  expectedSource: string,
  k: number,
): number {
  return rankedSources.slice(0, k).includes(expectedSource) ? 1 : 0;
}

/** expectedSource가 처음 등장하는 순위의 역수 (없으면 0) */
export function reciprocalRank(
  rankedSources: readonly string[],
  expectedSource: string,
): number {
  const idx = rankedSources.indexOf(expectedSource);
  return idx < 0 ? 0 : 1 / (idx + 1);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total / values.length;
}

export interface EvalSummary {
  count: number;
  recallAt1: number;
  recallAt4: number;
  mrr: number;
}

/** 질문별 순위 결과 목록 → 집계 지표 */
export function summarize(
  perQuestion: readonly { ranked: string[]; expected: string }[],
): EvalSummary {
  return {
    count: perQuestion.length,
    recallAt1: mean(perQuestion.map((q) => recallAtK(q.ranked, q.expected, 1))),
    recallAt4: mean(perQuestion.map((q) => recallAtK(q.ranked, q.expected, 4))),
    mrr: mean(perQuestion.map((q) => reciprocalRank(q.ranked, q.expected))),
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
grep -c "export function" eval/metric.ts
  # 기대: 4 (recallAtK, reciprocalRank, mean, summarize)
```

### 동반 변경 (Side Effects)

새 export → 테스트(Step 4) + run.ts(Step 5) 소비.

### Do Not Touch

`eval/golden.ts`, `eval/corpus/**`.

## Step 4: 지표 테스트 (`eval/__tests__/metric.test.ts` — create)

### Code

### 검증 대상

- spy: N/A (순수 함수)
- branch: 정답 top-1/top-4 포함·미포함, 정답 없음(MRR 0), 빈 입력, 순위별 역수
- state: 지표 수치가 산식과 일치

```ts
import { describe, expect, it } from 'vitest';
import { mean, recallAtK, reciprocalRank, summarize } from '../metric.js';

describe('recallAtK', () => {
  it('정답이 topK 안에 있으면 1, 밖이면 0 (정상/경계)', () => {
    expect(recallAtK(['a', 'b', 'c'], 'b', 1)).toBe(0);
    expect(recallAtK(['a', 'b', 'c'], 'b', 2)).toBe(1);
    expect(recallAtK(['a', 'b', 'c'], 'z', 4)).toBe(0);
  });
});

describe('reciprocalRank', () => {
  it('정답 순위의 역수를 반환하고 없으면 0이다 (정상/에러)', () => {
    expect(reciprocalRank(['a', 'b', 'c'], 'a')).toBe(1);
    expect(reciprocalRank(['a', 'b', 'c'], 'c')).toBeCloseTo(1 / 3, 10);
    expect(reciprocalRank(['a', 'b'], 'z')).toBe(0);
  });
});

describe('mean', () => {
  it('빈 배열은 0이다 (경계값)', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 0, 1, 0])).toBe(0.5);
  });
});

describe('summarize', () => {
  it('질문별 순위를 집계 지표로 변환한다 (정상)', () => {
    const result = summarize([
      { ranked: ['x.md', 'y.md'], expected: 'x.md' }, // r@1=1, rr=1
      { ranked: ['y.md', 'x.md'], expected: 'x.md' }, // r@1=0, r@4=1, rr=0.5
    ]);
    expect(result.count).toBe(2);
    expect(result.recallAt1).toBe(0.5);
    expect(result.recallAt4).toBe(1);
    expect(result.mrr).toBeCloseTo(0.75, 10);
  });

  it('빈 세트는 모두 0이다 (경계값)', () => {
    expect(summarize([])).toEqual({ count: 0, recallAt1: 0, recallAt4: 0, mrr: 0 });
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
  # 기대: 전체 120 passed (114 + 6)
# 3. 의미 검증
grep -c "toBeCloseTo\|toBe\|toEqual" eval/__tests__/metric.test.ts
  # 기대: 10 이상
```

### 동반 변경 (Side Effects)

N/A (Step 3의 동반 테스트). vitest include가 `src/**`라 `eval/**` 테스트를 잡도록 Step 6에서 config 확장.

### Do Not Touch

`eval/metric.ts`.

## Step 5: eval 러너 (`eval/run.ts` — create)

### Context

corpus를 실제 Ollama 임베딩으로 인덱싱하고, 각 골든 질문을 벡터 검색해 순위별 source 목록을 만들어 지표를 출력한다. Phase 1~2의 하이브리드도 이 러너에 검색기만 갈아끼워 재사용한다 — 검색 함수를 인자로 받는 구조.

### Code
```ts
import { env, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OllamaEmbedder } from '../src/llm/ollama-embedder.js';
import { buildIndex } from '../src/rag/indexer.js';
import type { VectorIndex } from '../src/rag/vector-index.js';
import { GOLDEN_QUESTIONS } from './golden.js';
import { summarize } from './metric.js';

/** 질의 → 순위대로 정렬된 source 목록 (상위 K) */
export type SearchFn = (query: string, topK: number) => Promise<string[]>;

const RANK_DEPTH = 10;

export async function runEval(label: string, search: SearchFn): Promise<void> {
  const perQuestion: { ranked: string[]; expected: string }[] = [];
  for (const q of GOLDEN_QUESTIONS) {
    const ranked = await search(q.question, RANK_DEPTH);
    perQuestion.push({ ranked, expected: q.expectedSource });
  }
  const s = summarize(perQuestion);
  stdout.write(
    `[${label}] n=${s.count} recall@1=${s.recallAt1.toFixed(3)} recall@4=${s.recallAt4.toFixed(3)} MRR=${s.mrr.toFixed(3)}\n`,
  );
}

/** 벡터 검색기: 인덱스를 임베딩 검색해 source 순위 반환 */
export function vectorSearch(embedder: OllamaEmbedder, index: VectorIndex): SearchFn {
  return async (query: string, topK: number) => {
    const [embedding] = await embedder.embed([query]);
    const hits = index.search(embedding ?? [], topK, 0);
    return hits.map((h) => h.chunk.source);
  };
}

async function main(): Promise<void> {
  const corpusDir = join(dirname(fileURLToPath(import.meta.url)), 'corpus');
  const embedder = new OllamaEmbedder({ baseUrl: env['OLLAMA_BASE_URL'] });
  stdout.write('(corpus 인덱싱 중...)\n');
  const index = await buildIndex(embedder, corpusDir, {
    model: embedder.model,
    createdAt: 'eval',
  });
  await runEval('vector', vectorSearch(embedder, index));
}

main().catch((err: unknown) => {
  stdout.write(`eval 오류: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
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
echo "N/A: run.ts는 수동 npm run eval (실제 Ollama)"
# 3. 의미 검증
npm run eval 2>&1 | tail -2
  # 기대: "[vector] n=20 recall@1=... recall@4=... MRR=..." 형식 출력 (베이스라인 기록)
```

### 동반 변경 (Side Effects)

`eval` npm 스크립트 등재(Step 6). 이 베이스라인 수치를 Phase 2 하이브리드와 비교.

### Do Not Touch

`eval/metric.ts`, `eval/golden.ts`.

## Step 6: 스크립트·설정 (`package.json` — modify / `vitest.config.ts` — modify / `tsconfig.build.json` — modify)

### Context

`eval` 스크립트 추가, vitest include에 `eval/**` 추가(지표 테스트 수집), 빌드 산출에서 eval 제외(런타임 무관 — dist 오염 방지).

### Code

(a) `package.json` scripts에 추가 (build 스크립트 뒤, typecheck 앞 아무 위치):
```json
    "eval": "tsx eval/run.ts",
```

(b) `vitest.config.ts` include 교체 —

교체 전:
```ts
    include: ['src/**/__tests__/**/*.test.ts'],
```

교체 후:
```ts
    include: ['src/**/__tests__/**/*.test.ts', 'eval/**/__tests__/**/*.test.ts'],
```

(c) `tsconfig.build.json` exclude에 추가 —

교체 전:
```json
  "exclude": ["src/**/__tests__/**"]
```

교체 후:
```json
  "exclude": ["src/**/__tests__/**", "eval/**"]
```

### Anchor

- (a) `package.json`의 `"build":` 스크립트 라인 뒤
- (b) `vitest.config.ts`의 include 라인 (유일)
- (c) `tsconfig.build.json`의 exclude 라인 (유일)

### Verify
```bash
# 1. 빌드
npm run build 2>&1 | tail -3 && test ! -d dist/eval && echo "OK: eval 빌드 제외"
  # 기대: "OK: eval 빌드 제외"
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 120 passed (eval 지표 테스트 수집됨)
# 3. 의미 검증
node -e "const p=require('./package.json'); if(!p.scripts.eval) throw new Error('eval 누락'); if(p.dependencies) throw new Error('런타임 의존성 금지'); console.log('OK')"
  # 기대: "OK"
```

### 동반 변경 (Side Effects)

N/A

### Do Not Touch

`devDependencies`, 기존 스크립트 명령 문자열.

## 실행 순서

Step 1 → 2 → 3 → 4 → 5 → 6.

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `recallAtK` | `['a','b'], 'b', 1` | `0` |
| `reciprocalRank` | `['a','b','c'], 'c'` | `0.333` |
| `summarize` | 2질문(1개 top1 적중) | `recallAt1: 0.5` |
| `npm run eval` | (corpus + 골든 20) | `[vector] recall@1=… MRR=…` 베이스라인 |

## 이 Phase 완료 후 노출 인터페이스

```ts
// eval/golden.ts
export interface GoldenQuestion { question: string; expectedSource: string; }
export const GOLDEN_QUESTIONS: GoldenQuestion[];

// eval/metric.ts
export function recallAtK(ranked: readonly string[], expected: string, k: number): number;
export function reciprocalRank(ranked: readonly string[], expected: string): number;
export function mean(values: readonly number[]): number;
export interface EvalSummary { count: number; recallAt1: number; recallAt4: number; mrr: number; }
export function summarize(perQuestion: readonly { ranked: string[]; expected: string }[]): EvalSummary;

// eval/run.ts
export type SearchFn = (query: string, topK: number) => Promise<string[]>;
export function runEval(label: string, search: SearchFn): Promise<void>;
export function vectorSearch(embedder: OllamaEmbedder, index: VectorIndex): SearchFn;
```

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify ✓
- [ ] DoD-02: `npm run typecheck` exit 0
- [ ] DoD-03: `npm test` 120 passed (기존 114 회귀 없음)
- [ ] DoD-04: 지표 함수에 정상/에러/경계 테스트 동반
- [ ] DoD-05: `npm run eval`이 벡터 베이스라인 수치 출력 (Phase 2 비교 기준)
- [ ] DoD-06: Phase 1 전제 조건 만족

## Observability plan

N/A — eval 자체가 관찰 도구. 베이스라인 수치를 Phase 2 완료 시 비교 기록.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 0 PASS" && npm run eval
```
