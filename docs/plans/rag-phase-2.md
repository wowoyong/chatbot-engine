# Phase 2: VectorIndex + Indexer

@fidelity-check tokens: VectorIndex, buildIndex, listMarkdownFiles, minScore

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성 — 인덱스 접근은 `.at()` + `??` 가드
6. 테스트 파일 시스템은 `.test-tmp/<uuid>/`만 사용

## 전제 조건

Phase 0~1이 노출한 인터페이스 (그대로 복사):

```ts
// src/rag/chunker.ts
export interface Chunk { source: string; heading: string; content: string; }
export function chunkMarkdown(markdown: string, source: string, options?: ChunkOptions): Chunk[];

// src/rag/cosine.ts
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number;

// src/store/atomic-file.ts
export function writeFileAtomic(filePath: string, content: string): Promise<void>;

// src/llm/types.ts
export interface Embedder { embed(texts: string[]): Promise<number[][]>; }
```

## 현재 상태

`src/rag/`에 chunker.ts, cosine.ts와 테스트만 존재. 검색 가능한 인덱스 자료구조와 문서 스캔·임베딩 파이프라인이 없다.

## Step 1: 벡터 인덱스 (`src/rag/vector-index.ts` — create)

### Context

in-memory 배열 + 전수 코사인 비교 — 수백 청크 규모에 충분하며 원리가 그대로 드러난다. 저장은 writeFileAtomic 재사용. 손상 파일은 null 반환 — 세션과 달리 인덱스는 `/index`로 재생성 가능한 파생물이라 .bak 보존이 불필요하다. `createdAt`은 인자로 주입받는다 (테스트 결정성).

### Code
```ts
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../store/atomic-file.js';
import { cosineSimilarity } from './cosine.js';

export interface IndexedChunk {
  source: string;
  heading: string;
  content: string;
  embedding: number[];
}

export interface PersistedIndex {
  version: 1;
  model: string;
  createdAt: string;
  chunks: IndexedChunk[];
}

export interface SearchHit {
  chunk: IndexedChunk;
  score: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIndexedChunk(value: unknown): value is IndexedChunk {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['source'] === 'string' &&
    typeof value['heading'] === 'string' &&
    typeof value['content'] === 'string' &&
    Array.isArray(value['embedding']) &&
    value['embedding'].every((n) => typeof n === 'number')
  );
}

function isPersistedIndex(value: unknown): value is PersistedIndex {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value['version'] === 1 &&
    typeof value['model'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    Array.isArray(value['chunks']) &&
    value['chunks'].every(isIndexedChunk)
  );
}

export class VectorIndex {
  private constructor(
    readonly model: string,
    readonly createdAt: string,
    private readonly chunks: IndexedChunk[],
  ) {}

  static create(
    model: string,
    createdAt: string,
    chunks: IndexedChunk[],
  ): VectorIndex {
    return new VectorIndex(model, createdAt, chunks);
  }

  get size(): number {
    return this.chunks.length;
  }

  /** 질의 벡터와 유사한 청크를 점수 내림차순 최대 topK개 반환 (minScore 미만 제외) */
  search(
    queryEmbedding: readonly number[],
    topK: number,
    minScore: number,
  ): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const chunk of this.chunks) {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (score >= minScore) {
        hits.push({ chunk, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  async save(filePath: string): Promise<void> {
    const data: PersistedIndex = {
      version: 1,
      model: this.model,
      createdAt: this.createdAt,
      chunks: this.chunks,
    };
    await writeFileAtomic(filePath, JSON.stringify(data));
  }

  /** 파일 없음/손상/스키마 불일치 → null (인덱스는 /index로 재생성 가능한 파생물) */
  static async load(filePath: string): Promise<VectorIndex | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedIndex(parsed)) {
        return null;
      }
      return new VectorIndex(parsed.model, parsed.createdAt, parsed.chunks);
    } catch {
      return null;
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
echo "N/A: 테스트는 Step 3에서 동반 작성"
# 3. 의미 검증
grep -c "writeFileAtomic" src/rag/vector-index.ts
  # 기대: 2 (import + 사용 — Phase 1 유틸 재사용, 인라인 재구현 없음)
```

### 동반 변경 (Side Effects)

새 가드(isPersistedIndex 실패 → null) → 손상 파일 테스트 Step 3.

### Do Not Touch

`src/rag/chunker.ts`, `src/rag/cosine.ts`, `src/store/**`, `src/llm/**`.

## Step 2: 인덱서 (`src/rag/indexer.ts` — create)

### Context

디렉토리 재귀 스캔(.md, 이름순 정렬 — 결정적 순서) → 청킹 → 배치 임베딩 → VectorIndex. 임베딩 입력에 헤딩을 접두어로 포함해 짧은 본문 청크의 검색 품질을 높인다.

### Code
```ts
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Embedder } from '../llm/types.js';
import type { Chunk } from './chunker.js';
import { chunkMarkdown } from './chunker.js';
import type { IndexedChunk } from './vector-index.js';
import { VectorIndex } from './vector-index.js';

/** dir 이하의 .md 파일 경로를 재귀 수집 (이름순 정렬 — 결정적 순서) */
export async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(path)));
    } else if (extname(entry.name) === '.md') {
      files.push(path);
    }
  }
  return files;
}

export interface BuildIndexOptions {
  /** 인덱스에 기록할 임베딩 모델명 */
  model: string;
  /** 인덱스 생성 시각 (ISO 문자열 — 호출측에서 주입) */
  createdAt: string;
}

/** docsDir의 md 전체를 청킹·임베딩해 VectorIndex를 만든다. md가 없으면 빈 인덱스 */
export async function buildIndex(
  embedder: Embedder,
  docsDir: string,
  options: BuildIndexOptions,
): Promise<VectorIndex> {
  const files = await listMarkdownFiles(docsDir);
  const chunks: Chunk[] = [];
  for (const file of files) {
    const markdown = await readFile(file, 'utf8');
    chunks.push(...chunkMarkdown(markdown, file));
  }
  const inputs = chunks.map((c) =>
    c.heading.length > 0 ? `${c.heading}\n${c.content}` : c.content,
  );
  const embeddings = await embedder.embed(inputs);
  const indexed: IndexedChunk[] = chunks.map((chunk, i) => ({
    ...chunk,
    embedding: embeddings.at(i) ?? [],
  }));
  return VectorIndex.create(options.model, options.createdAt, indexed);
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
grep -c "localeCompare" src/rag/indexer.ts
  # 기대: 1 (결정적 파일 순서)
```

### 동반 변경 (Side Effects)

새 export → 테스트 Step 4, 호출처(CLI `/index`)는 Phase 3.

### Do Not Touch

`src/rag/vector-index.ts` (Step 1 완료본), `src/rag/chunker.ts`.

## Step 3: 벡터 인덱스 테스트 (`src/rag/__tests__/vector-index.test.ts` — create)

### Code

### 검증 대상

- spy: N/A (자료구조 — 결과값으로 검증)
- branch: 점수 정렬+topK 절단, minScore 필터, save/load 왕복, 손상 파일 → null, 파일 없음 → null
- state: hits의 순서/점수, 왕복 후 model/createdAt/size 보존

```ts
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IndexedChunk } from '../vector-index.js';
import { VectorIndex } from '../vector-index.js';

function chunk(id: string, embedding: number[]): IndexedChunk {
  return { source: `${id}.md`, heading: id, content: `본문 ${id}`, embedding };
}

describe('VectorIndex', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('유사도 내림차순으로 최대 topK개를 반환한다 (정상)', () => {
    const index = VectorIndex.create('m', 't', [
      chunk('a', [1, 0]),
      chunk('b', [0.9, 0.1]),
      chunk('c', [0, 1]),
    ]);
    const hits = index.search([1, 0], 2, 0);
    expect(hits.map((h) => h.chunk.heading)).toEqual(['a', 'b']);
    expect(hits.at(0)?.score).toBeCloseTo(1, 10);
  });

  it('minScore 미만은 결과에서 제외한다 (정상)', () => {
    const index = VectorIndex.create('m', 't', [
      chunk('관련', [1, 0]),
      chunk('무관', [0, 1]),
    ]);
    const hits = index.search([1, 0], 10, 0.5);
    expect(hits.map((h) => h.chunk.heading)).toEqual(['관련']);
  });

  it('save 후 load하면 model/createdAt/청크가 보존된다 (정상)', async () => {
    const path = join(dir, 'index.json');
    const index = VectorIndex.create('nomic-embed-text', '2026-07-11', [
      chunk('a', [1, 0]),
    ]);
    await index.save(path);

    const loaded = await VectorIndex.load(path);
    expect(loaded?.model).toBe('nomic-embed-text');
    expect(loaded?.createdAt).toBe('2026-07-11');
    expect(loaded?.size).toBe(1);
    expect(loaded?.search([1, 0], 1, 0).at(0)?.chunk.heading).toBe('a');
  });

  it('손상된 파일은 null을 반환한다 (에러)', async () => {
    const path = join(dir, 'index.json');
    await writeFile(path, '{ 깨짐', 'utf8');
    expect(await VectorIndex.load(path)).toBeNull();
    await writeFile(path, JSON.stringify({ version: 2 }), 'utf8');
    expect(await VectorIndex.load(path)).toBeNull();
  });

  it('파일이 없으면 null을 반환한다 (경계값)', async () => {
    expect(await VectorIndex.load(join(dir, 'none.json'))).toBeNull();
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
  # 기대: 전체 69 passed (64 + 5)
# 3. 의미 검증
grep -c "toBeNull" src/rag/__tests__/vector-index.test.ts
  # 기대: 3 (손상 2 + 부재 1 경로)
```

### 동반 변경 (Side Effects)

N/A (Step 1의 동반 테스트)

### Do Not Touch

`src/rag/vector-index.ts`.

## Step 4: 인덱서 테스트 (`src/rag/__tests__/indexer.test.ts` — create)

### Code

### 검증 대상

- spy: `FakeEmbedder.calls` — 임베딩 입력에 헤딩 접두어 포함 여부, 호출 횟수
- branch: 재귀 수집+정렬, 빈 디렉토리 → 빈 인덱스, 청크↔임베딩 순서 매핑
- state: 파일 목록 순서, 인덱스 size/model/createdAt

```ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Embedder } from '../../llm/types.js';
import { buildIndex, listMarkdownFiles } from '../indexer.js';

class FakeEmbedder implements Embedder {
  readonly calls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((_, i) => [i + 1, 0]);
  }
}

describe('indexer', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(join(dir, 'sub'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('md 파일을 재귀·이름순으로 수집하고 다른 확장자는 제외한다 (정상)', async () => {
    await writeFile(join(dir, 'b.md'), '# B', 'utf8');
    await writeFile(join(dir, 'a.md'), '# A', 'utf8');
    await writeFile(join(dir, 'skip.txt'), 'x', 'utf8');
    await writeFile(join(dir, 'sub', 'c.md'), '# C', 'utf8');

    const files = await listMarkdownFiles(dir);
    expect(files).toEqual([join(dir, 'a.md'), join(dir, 'b.md'), join(dir, 'sub', 'c.md')]);
  });

  it('buildIndex는 헤딩을 임베딩 입력에 접두어로 포함한다 (정상)', async () => {
    await writeFile(join(dir, 'a.md'), '# 제목\n본문', 'utf8');
    const embedder = new FakeEmbedder();

    const index = await buildIndex(embedder, dir, { model: 'm', createdAt: 't' });

    expect(embedder.calls.at(0)).toEqual(['제목\n본문']);
    expect(index.size).toBe(1);
    expect(index.model).toBe('m');
    expect(index.createdAt).toBe('t');
  });

  it('청크와 임베딩이 순서대로 매핑된다 (정상)', async () => {
    await writeFile(join(dir, 'a.md'), '# 하나\n일\n# 둘\n이', 'utf8');
    const embedder = new FakeEmbedder();

    const index = await buildIndex(embedder, dir, { model: 'm', createdAt: 't' });

    // FakeEmbedder는 i번째 입력에 [i+1, 0]을 반환 — 첫 청크가 [1,0]과 정확히 일치해야 함
    const hits = index.search([1, 0], 2, 0);
    expect(hits.at(0)?.chunk.heading).toBe('하나');
  });

  it('md가 없는 디렉토리는 빈 인덱스를 만든다 (경계값)', async () => {
    const embedder = new FakeEmbedder();
    const index = await buildIndex(embedder, dir, { model: 'm', createdAt: 't' });
    expect(index.size).toBe(0);
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
  # 기대: 전체 73 passed (69 + 4)
# 3. 의미 검증
grep -c "제목\\\\n본문" src/rag/__tests__/indexer.test.ts
  # 기대: 1 (헤딩 접두어 spy 검증)
```

### 동반 변경 (Side Effects)

N/A (Step 2의 동반 테스트)

### Do Not Touch

`src/rag/indexer.ts`.

## 실행 순서

Step 1 → 2 → 3 → 4.

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `search` | 질의 `[1,0]`, topK 2, minScore 0 (3청크) | 유사도 내림차순 상위 2건 |
| `search` | minScore 0.5, 무관 청크 포함 | 무관 청크 제외 |
| `VectorIndex.load` | 손상 JSON 파일 | `null` |
| `buildIndex` | `# 제목\n본문` 1파일 | size 1, 임베딩 입력 `'제목\n본문'` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/rag/vector-index.ts
export interface IndexedChunk { source: string; heading: string; content: string; embedding: number[]; }
export interface SearchHit { chunk: IndexedChunk; score: number; }
export class VectorIndex {
  static create(model: string, createdAt: string, chunks: IndexedChunk[]): VectorIndex;
  static load(filePath: string): Promise<VectorIndex | null>;
  readonly model: string;
  readonly createdAt: string;
  get size(): number;
  search(queryEmbedding: readonly number[], topK: number, minScore: number): SearchHit[];
  save(filePath: string): Promise<void>;
}

// src/rag/indexer.ts
export function listMarkdownFiles(dir: string): Promise<string[]>;
export interface BuildIndexOptions { model: string; createdAt: string; }
export function buildIndex(embedder: Embedder, docsDir: string, options: BuildIndexOptions): Promise<VectorIndex>;
```

## Definition of Done

- [ ] DoD-21: 모든 Step 통과 + Verify ✓
- [ ] DoD-22: `npm run typecheck` exit 0
- [ ] DoD-23: `npm test` 73 passed (기존 64 회귀 없음)
- [ ] DoD-24: 새 가드(인덱스 스키마 검증)에 손상 테스트 동반
- [ ] DoD-25: 문서 갱신 불필요
- [ ] DoD-26: Phase 3 전제 조건 만족

## Observability plan

N/A — 운영 영향 없음.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 2 PASS"
```
