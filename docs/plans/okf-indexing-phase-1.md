# Phase 1: Metadata index v2와 source freshness

@fidelity-check tokens: sourceFingerprint, version: 2, computeSourceFingerprint, metadata: DocumentMetadata, stale

## 코드 예시 적용 규칙

1. 상대 ESM import에 `.js`를 붙인다.
2. fingerprint는 relative POSIX path와 raw file content를 SHA-256에 순서대로 넣는다.
3. index v1을 v2로 암묵 변환하지 않는다.
4. index file은 파생 artifact이므로 stale이면 load하지 않는다.
5. 일반 Markdown의 metadata는 `null`이다.

## 전제 조건

```typescript
export type KnowledgeStatus = 'draft' | 'verified' | 'deprecated';
export interface DocumentMetadata {
  type?: string;
  title?: string;
  description?: string;
  resource?: string;
  tags: string[];
  timestamp?: string;
  status?: KnowledgeStatus;
  category?: string;
  provenance?: string;
  reviewedAt?: string;
}
export interface MarkdownDocument {
  metadata: DocumentMetadata | null;
  body: string;
}
export function parseMarkdownDocument(markdown: string): MarkdownDocument;
export function serializeMarkdownDocument(
  metadata: DocumentMetadata & { type: string },
  body: string,
): string;
```

## 현재 상태

`Chunk`와 `IndexedChunk`는 source/heading/content/embedding만 가진다. persisted index v1은 model/createdAt만 확인하며 source 변경을 감지하지 않는다.

## Step 1: Chunk metadata 전파 (`src/rag/chunker.ts` — modify)

### Context

frontmatter를 body에서 제거한 후 동일 metadata reference를 각 section chunk에 붙인다.

### Code

```typescript
import type { DocumentMetadata } from '../okf/document.js';

export interface Chunk {
  source: string;
  heading: string;
  content: string;
  metadata: DocumentMetadata | null;
}
```

`chunkMarkdown` 시그니처와 push를 다음으로 교체한다.

```typescript
export function chunkMarkdown(
  markdown: string,
  source: string,
  options: ChunkOptions = {},
  metadata: DocumentMetadata | null = null,
): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = Math.min(
    options.overlapChars ?? DEFAULT_OVERLAP,
    maxChars - 1,
  );

  const chunks: Chunk[] = [];
  for (const section of splitByHeading(markdown)) {
    const body = section.content.trim();
    if (body.length === 0) {
      continue;
    }
    for (const piece of splitLong(body, maxChars, overlapChars)) {
      chunks.push({ source, heading: section.heading, content: piece, metadata });
    }
  }
  return chunks;
}
```

### Anchor

- import를 파일 첫 줄에 추가한다.
- 기존 `export interface Chunk` 전체와 `chunkMarkdown` 전체를 교체한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: test fixture 갱신 전 type error 위치가 식별됨

# 2. 테스트
npx vitest run src/rag/__tests__/chunker.test.ts
# 기대: Step 4 fixture 적용 후 PASS

# 3. 의미 검증
rg -n "metadata: DocumentMetadata|chunks.push.*metadata" src/rag/chunker.ts
# 기대: 2 hits
```

### 동반 변경 (Side Effects)

Step 4에서 모든 Chunk expected fixture에 `metadata: null`을 추가한다.

### Do Not Touch

heading/code fence/split overlap 로직.

## Step 2: Indexer fingerprint와 OKF parsing (`src/rag/indexer.ts` — modify)

### Context

각 file을 한 번 읽어 parse하고 raw content와 relative path로 deterministic fingerprint를 만든다.

### Code

```typescript
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { Embedder } from '../llm/types.js';
import { parseMarkdownDocument } from '../okf/document.js';
import type { Chunk } from './chunker.js';
import { chunkMarkdown } from './chunker.js';
import type { IndexedChunk } from './vector-index.js';
import { VectorIndex } from './vector-index.js';

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

interface LoadedDocument {
  source: string;
  relativePath: string;
  raw: string;
}

async function loadMarkdownDocuments(docsDir: string): Promise<LoadedDocument[]> {
  const files = (await listMarkdownFiles(docsDir)).filter(
    (source) => relative(docsDir, source).split(sep).join('/') !== 'INSTRUCTIONS.md',
  );
  return Promise.all(
    files.map(async (source) => ({
      source,
      relativePath: relative(docsDir, source).split(sep).join('/'),
      raw: await readFile(source, 'utf8'),
    })),
  );
}

function fingerprintDocuments(documents: readonly LoadedDocument[]): string {
  const hash = createHash('sha256');
  for (const document of documents) {
    hash.update(document.relativePath);
    hash.update('\0');
    hash.update(document.raw);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function computeSourceFingerprint(docsDir: string): Promise<string> {
  return fingerprintDocuments(await loadMarkdownDocuments(docsDir));
}

export interface BuildIndexOptions {
  model: string;
  createdAt: string;
}

export async function buildIndex(
  embedder: Embedder,
  docsDir: string,
  options: BuildIndexOptions,
): Promise<VectorIndex> {
  const documents = await loadMarkdownDocuments(docsDir);
  const chunks: Chunk[] = [];
  for (const document of documents) {
    const parsed = parseMarkdownDocument(document.raw);
    chunks.push(
      ...chunkMarkdown(parsed.body, document.source, {}, parsed.metadata),
    );
  }
  const inputs = chunks.map((chunk) => {
    const metadataText = [
      chunk.metadata?.type,
      chunk.metadata?.title,
      chunk.metadata?.description,
      ...(chunk.metadata?.tags ?? []),
    ].filter((value): value is string => value !== undefined && value.length > 0);
    return [...metadataText, chunk.heading, chunk.content]
      .filter((value) => value.length > 0)
      .join('\n');
  });
  const embeddings = await embedder.embed(inputs);
  const indexed: IndexedChunk[] = chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings.at(index) ?? [],
  }));
  return VectorIndex.create(
    options.model,
    options.createdAt,
    fingerprintDocuments(documents),
    indexed,
  );
}
```

### Anchor

`src/rag/indexer.ts` 전체를 교체한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: Step 3~4 완료 후 exit 0

# 2. 테스트
npx vitest run src/rag/__tests__/indexer.test.ts
# 기대: metadata/fingerprint tests PASS

# 3. 의미 검증
rg -n "createHash|computeSourceFingerprint|parseMarkdownDocument|relativePath" src/rag/indexer.ts
# 기대: 4 symbols match
```

### 동반 변경 (Side Effects)

Step 3에서 persisted index가 fingerprint를 저장하고 Step 5에서 startup이 비교한다.
`openwiki/INSTRUCTIONS.md`는 author-owned generation brief이므로 embedding과 fingerprint 양쪽에서 동일하게 제외된다.

### Do Not Touch

embedding batch implementation.

## Step 3: Persisted index v2 (`src/rag/vector-index.ts` — modify)

### Context

metadata와 fingerprint를 필수로 저장하고 search consumer가 visibility predicate를 선택적으로 전달할 수 있게 한다.

### Code

```typescript
import { readFile } from 'node:fs/promises';
import type { DocumentMetadata } from '../okf/document.js';
import { writeFileAtomic } from '../store/atomic-file.js';
import { cosineSimilarity } from './cosine.js';

export interface IndexedChunk {
  source: string;
  heading: string;
  content: string;
  metadata: DocumentMetadata | null;
  embedding: number[];
}

export interface PersistedIndex {
  version: 2;
  model: string;
  createdAt: string;
  sourceFingerprint: string;
  chunks: IndexedChunk[];
}

export interface SearchHit {
  chunk: IndexedChunk;
  score: number;
}

export type ChunkPredicate = (chunk: IndexedChunk) => boolean;

export type IndexLoadResult =
  | { status: 'loaded'; index: VectorIndex }
  | { status: 'missing' | 'invalid' | 'unsupported-version' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMetadata(value: unknown): value is DocumentMetadata | null {
  if (value === null) return true;
  if (!isRecord(value) || !Array.isArray(value['tags'])) return false;
  const optionalStrings = [
    'type',
    'title',
    'description',
    'resource',
    'timestamp',
    'category',
    'provenance',
    'reviewedAt',
  ] as const;
  if (!value['tags'].every((tag) => typeof tag === 'string')) return false;
  if (!optionalStrings.every((key) => value[key] === undefined || typeof value[key] === 'string')) {
    return false;
  }
  const status = value['status'];
  return status === undefined || status === 'draft' || status === 'verified' || status === 'deprecated';
}

function isIndexedChunk(value: unknown): value is IndexedChunk {
  if (!isRecord(value)) return false;
  return (
    typeof value['source'] === 'string' &&
    typeof value['heading'] === 'string' &&
    typeof value['content'] === 'string' &&
    isMetadata(value['metadata']) &&
    Array.isArray(value['embedding']) &&
    value['embedding'].every((number) => typeof number === 'number')
  );
}

function isPersistedIndex(value: unknown): value is PersistedIndex {
  if (!isRecord(value)) return false;
  return (
    value['version'] === 2 &&
    typeof value['model'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['sourceFingerprint'] === 'string' &&
    Array.isArray(value['chunks']) &&
    value['chunks'].every(isIndexedChunk)
  );
}

export class VectorIndex {
  private constructor(
    readonly model: string,
    readonly createdAt: string,
    readonly sourceFingerprint: string,
    private readonly chunks: IndexedChunk[],
  ) {}

  static create(
    model: string,
    createdAt: string,
    sourceFingerprint: string,
    chunks: IndexedChunk[],
  ): VectorIndex {
    return new VectorIndex(model, createdAt, sourceFingerprint, chunks);
  }

  get size(): number {
    return this.chunks.length;
  }

  allChunks(): IndexedChunk[] {
    return this.chunks.map((chunk) => ({
      ...chunk,
      metadata: chunk.metadata === null
        ? null
        : { ...chunk.metadata, tags: [...chunk.metadata.tags] },
      embedding: [...chunk.embedding],
    }));
  }

  search(
    queryEmbedding: readonly number[],
    topK: number,
    minScore: number,
    predicate: ChunkPredicate = () => true,
  ): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const chunk of this.chunks) {
      if (!predicate(chunk)) continue;
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (score >= minScore) hits.push({ chunk, score });
    }
    hits.sort((left, right) => right.score - left.score);
    return hits.slice(0, topK);
  }

  async save(filePath: string): Promise<void> {
    const data: PersistedIndex = {
      version: 2,
      model: this.model,
      createdAt: this.createdAt,
      sourceFingerprint: this.sourceFingerprint,
      chunks: this.chunks,
    };
    await writeFileAtomic(filePath, JSON.stringify(data));
  }

  static async loadWithStatus(filePath: string): Promise<IndexLoadResult> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      return isNodeError(error) && error.code === 'ENOENT'
        ? { status: 'missing' }
        : { status: 'invalid' };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && parsed['version'] !== 2) {
        return { status: 'unsupported-version' };
      }
      if (!isPersistedIndex(parsed)) return { status: 'invalid' };
      return {
        status: 'loaded',
        index: new VectorIndex(
          parsed.model,
          parsed.createdAt,
          parsed.sourceFingerprint,
          parsed.chunks,
        ),
      };
    } catch {
      return { status: 'invalid' };
    }
  }

  static async load(filePath: string): Promise<VectorIndex | null> {
    const result = await VectorIndex.loadWithStatus(filePath);
    return result.status === 'loaded' ? result.index : null;
  }
}
```

### Anchor

`src/rag/vector-index.ts` 전체를 교체한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: Step 4 완료 후 exit 0

# 2. 테스트
npx vitest run src/rag/__tests__/vector-index.test.ts
# 기대: v2 round-trip와 v1 reject PASS

# 3. 의미 검증
rg -n "version: 2|sourceFingerprint|ChunkPredicate|metadata: DocumentMetadata" src/rag/vector-index.ts
# 기대: 4 symbols match
```

### 동반 변경 (Side Effects)

Step 4에서 모든 `VectorIndex.create` 호출자와 `IndexedChunk` fixture를 갱신한다.

### Do Not Touch

atomic write implementation.

## Step 4: index 계약 tests와 호출자 갱신 (`src/rag/__tests__/**`, `src/knowledge/__tests__/novelty.test.ts` — modify)

### Context

모든 direct fixture에 `metadata: null`과 fingerprint 인자를 추가한다. 테스트 전용 helper가 새 schema의 단일 source다.

### 검증 대상
- spy: persisted JSON의 version/sourceFingerprint/metadata
- branch: v2 load, v1 reject, malformed metadata reject, predicate filter, metadata embedding
- state: search 결과와 index round-trip

### Code

각 `IndexedChunk` helper return을 다음 형태로 교체한다.

```typescript
function chunk(
  source: string,
  content: string,
  embedding: number[] = [],
): IndexedChunk {
  return { source, heading: '', content, metadata: null, embedding };
}
```

각 `VectorIndex.create('m', 't', chunks)` 호출을 다음 시그니처로 교체한다.

```typescript
VectorIndex.create('m', 't', 'fingerprint', chunks)
```

`src/rag/__tests__/vector-index.test.ts`에 다음 tests를 추가한다.

### 검증 대상
- spy: `sourceFingerprint`, copied tags array
- branch: predicate true/false와 version 1 load
- state: filtered hits, v1 null

```typescript
it('sourceFingerprint와 metadata를 v2로 왕복한다 (정상)', async () => {
  const path = join(dir, 'v2.json');
  const index = VectorIndex.create('m', 't', 'sha256', [
    {
      source: 'a.md',
      heading: 'A',
      content: '본문',
      metadata: { type: 'Reference', tags: ['rag'] },
      embedding: [1, 0],
    },
  ]);
  await index.save(path);
  const loaded = await VectorIndex.load(path);
  expect(loaded?.sourceFingerprint).toBe('sha256');
  expect(loaded?.allChunks().at(0)?.metadata?.tags).toEqual(['rag']);
});

it('predicate가 false인 chunk는 vector 결과에서 제외한다 (정상)', () => {
  const index = VectorIndex.create('m', 't', 'fp', [
    { source: 'draft.md', heading: '', content: 'x', metadata: { tags: [], status: 'draft' }, embedding: [1, 0] },
    { source: 'verified.md', heading: '', content: 'x', metadata: { tags: [], status: 'verified' }, embedding: [1, 0] },
  ]);
  const hits = index.search([1, 0], 10, 0, (item) => item.metadata?.status !== 'draft');
  expect(hits.map((hit) => hit.chunk.source)).toEqual(['verified.md']);
});

it('persisted version 1은 재색인이 필요하므로 load하지 않는다 (경계값)', async () => {
  const path = join(dir, 'v1.json');
  await writeFile(path, JSON.stringify({ version: 1, model: 'm', createdAt: 't', chunks: [] }));
  expect(await VectorIndex.load(path)).toBeNull();
  expect(await VectorIndex.loadWithStatus(path)).toEqual({ status: 'unsupported-version' });
});

it('known metadata field 타입이나 status가 잘못되면 load하지 않는다 (오류)', async () => {
  const path = join(dir, 'bad-metadata.json');
  await writeFile(path, JSON.stringify({
    version: 2,
    model: 'm',
    createdAt: 't',
    sourceFingerprint: 'fp',
    chunks: [{
      source: 'a.md', heading: '', content: 'x', embedding: [1, 0],
      metadata: { tags: [], title: { unsafe: true }, status: 'pending' },
    }],
  }));
  expect(await VectorIndex.load(path)).toBeNull();
});
```

`src/rag/__tests__/indexer.test.ts`에 추가한다.

### 검증 대상
- spy: fake embedder input과 fingerprint
- branch: frontmatter, 일반 Markdown, root `INSTRUCTIONS.md` 제외
- state: stripped body, metadata, fingerprint change, author brief 미색인

```typescript
it('OKF metadata를 chunk에 넣고 frontmatter는 content에서 제거한다 (정상)', async () => {
  await writeFile(
    join(dir, 'okf.md'),
    '---\ntype: Reference\ntitle: RAG\ntags: [rag]\n---\n\n# 검색\n본문',
  );
  const index = await buildIndex(embedder, dir, { model: 'm', createdAt: 't' });
  const item = index.allChunks().find((chunk) => chunk.source.endsWith('okf.md'));
  expect(item?.metadata).toMatchObject({ type: 'Reference', title: 'RAG', tags: ['rag'] });
  expect(item?.content).toBe('본문');
  expect(item?.content).not.toContain('type:');
});

it('문서 내용이 바뀌면 source fingerprint가 바뀐다 (정상)', async () => {
  const path = join(dir, 'fingerprint.md');
  await writeFile(path, '# A\n첫 내용');
  const before = await computeSourceFingerprint(dir);
  await writeFile(path, '# A\n바뀐 내용');
  const after = await computeSourceFingerprint(dir);
  expect(after).not.toBe(before);
});

it('root INSTRUCTIONS.md는 index와 fingerprint 입력에서 제외한다 (경계)', async () => {
  const before = await computeSourceFingerprint(dir);
  await writeFile(join(dir, 'INSTRUCTIONS.md'), '# generation-only-secret-marker');
  const after = await computeSourceFingerprint(dir);
  const index = await buildIndex(embedder, dir, { model: 'm', createdAt: 't' });
  expect(after).toBe(before);
  expect(index.allChunks().some((chunk) => chunk.source.endsWith('INSTRUCTIONS.md'))).toBe(false);
});
```

### Anchor

- helper 교체 대상: `src/rag/__tests__/{bm25,hybrid,retriever,vector-index}.test.ts`, `src/knowledge/__tests__/novelty.test.ts`.
- 신규 tests는 각 파일의 최상위 `describe` 마지막에 삽입한다.
- `src/rag/__tests__/chunker.test.ts` expected object마다 `metadata: null`을 추가한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/rag src/knowledge/__tests__/novelty.test.ts
# 기대: PASS

# 3. 의미 검증
rg -n "VectorIndex.create\(" src eval | wc -l && ! rg -n "VectorIndex.create\([^,]+,[^,]+,\s*\[" src eval
# 기대: 모든 호출이 fingerprint 인자를 가짐
```

### 동반 변경 (Side Effects)

모든 schema consumer를 같은 Phase에서 갱신한다.

### Do Not Touch

test assertion 의미와 기존 ranking expectations.

## Step 5: startup stale gate (`src/app/bootstrap.ts`, `src/app/__tests__/bootstrap.test.ts` — modify)

### Context

loaded model과 fingerprint가 모두 일치할 때만 retriever를 활성화한다. docs scan 실패도 stale index 사용으로 fallback하지 않는다.

### Code

import를 교체한다.

```typescript
import { buildIndex, computeSourceFingerprint } from '../rag/indexer.js';
```

기존 `const loadedIndex` block 전체를 교체한다.

```typescript
  const loadResult = await VectorIndex.loadWithStatus(indexFile);
  if (loadResult.status === 'unsupported-version') {
    startupNotices.push('RAG 인덱스 형식이 구버전이라 무시합니다 — /index로 재인덱싱하세요');
  } else if (loadResult.status === 'invalid') {
    startupNotices.push('RAG 인덱스 파일이 손상되어 무시합니다 — /index로 재인덱싱하세요');
  } else if (loadResult.status === 'loaded') {
    const loadedIndex = loadResult.index;
    if (loadedIndex.model !== embedderModel) {
      startupNotices.push(
        `RAG 인덱스의 임베딩 모델(${loadedIndex.model})이 현재(${embedderModel})와 달라 무시합니다 — 재인덱싱하세요`,
      );
    } else {
      try {
        const currentFingerprint = await computeSourceFingerprint(docsDir);
        if (loadedIndex.sourceFingerprint !== currentFingerprint) {
          startupNotices.push(
            'RAG 인덱스가 문서보다 오래되어 무시합니다 — /index로 재인덱싱하세요',
          );
        } else {
          currentIndex = loadedIndex;
          retriever = new HybridRetriever(embedder, loadedIndex);
          startupNotices.push(
            `RAG 인덱스 로드: ${loadedIndex.size}청크, 생성 ${loadedIndex.createdAt}`,
          );
        }
      } catch {
        startupNotices.push(
          'RAG 문서 fingerprint를 확인할 수 없어 저장된 인덱스를 무시합니다',
        );
      }
    }
  }
```

### 검증 대상
- spy: `startupNotices`
- branch: fingerprint match, mismatch, docs directory failure
- state: load notice 또는 stale notice

```typescript
it('문서가 index 저장 후 바뀌면 stale notice를 내고 load하지 않는다 (정상)', async () => {
  const app = await makeApp();
  await app.rebuildIndex('t0');
  await writeFile(join(dir, 'docs', 'a.md'), '# 제목\n변경됨');
  const stale = await makeApp();
  expect(stale.startupNotices.join(' ')).toContain('문서보다 오래되어');
  expect(stale.startupNotices.join(' ')).not.toContain('RAG 인덱스 로드:');
});
```

### Anchor

- import: 기존 `buildIndex` import 교체.
- load block: `const loadedIndex = await VectorIndex.load(indexFile);`부터 `const session` 직전까지 교체.
- test: `describe('createApp'...)` 마지막에 추가.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/app/__tests__/bootstrap.test.ts
# 기대: stale test 포함 PASS

# 3. 의미 검증
rg -n "computeSourceFingerprint|문서보다 오래되어|fingerprint를 확인할 수 없어" src/app/bootstrap.ts
# 기대: 3 branches match
```

### 동반 변경 (Side Effects)

README/CLAUDE의 재색인 안내는 knowledge-quality Phase 0에서 최종 갱신한다.

### Do Not Touch

LLM selection, session restore, capture implementation.

## 실행 순서

- [ ] Step 1
- [ ] Step 2
- [ ] Step 3
- [ ] Step 4
- [ ] Step 5

## 입출력 예제

| 입력 | 출력 |
|---|---|
| 일반 Markdown | metadata null chunk |
| OKF Markdown | metadata-bearing chunk, frontmatter 제거 |
| unchanged docs + v2 index | retriever load |
| changed docs + v2 index | stale notice, retriever disabled |
| v1 index | load null, `/index` 필요 |

## 이 Phase 완료 후 노출 인터페이스

```typescript
export interface IndexedChunk {
  source: string;
  heading: string;
  content: string;
  metadata: DocumentMetadata | null;
  embedding: number[];
}
export type ChunkPredicate = (chunk: IndexedChunk) => boolean;
export class VectorIndex {
  readonly model: string;
  readonly createdAt: string;
  readonly sourceFingerprint: string;
  static create(
    model: string,
    createdAt: string,
    sourceFingerprint: string,
    chunks: IndexedChunk[],
  ): VectorIndex;
  search(
    queryEmbedding: readonly number[],
    topK: number,
    minScore: number,
    predicate?: ChunkPredicate,
  ): SearchHit[];
}
export function computeSourceFingerprint(docsDir: string): Promise<string>;
```

## Definition of Done

- [ ] DoD-11: metadata/fingerprint index tests PASS
- [ ] DoD-12: all create calls v2 signature
- [ ] DoD-13: v1 load reject test PASS
- [ ] DoD-14: stale startup test PASS
- [ ] DoD-15: full suite/typecheck/build PASS
- [ ] DoD-16: rag-trust interface 노출

## Observability plan

- 로깅: startup notice에 model mismatch, stale, fingerprint failure 구분
- 메트릭: N/A
- 알림: N/A — local CLI/Web notice
- 대시보드: N/A

## 최종 검증

```bash
npm test
npm run typecheck
npm run build
git diff --check
```
