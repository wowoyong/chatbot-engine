# Phase 0: Captured lifecycle store

@fidelity-check tokens: status: draft, legacy verified, CapturedApprovalError, INVALID_ID, NOT_FOUND, NOT_DRAFT, writeFileAtomic

## 코드 예시 적용 규칙

1. 신규 capture는 OKF frontmatter의 `status: draft`로 저장한다.
2. frontmatter 없는 기존 capture는 마이그레이션 없이 `verified`로 읽는다.
3. 외부 입력인 `id`는 파일 접근 전에 정확한 `category/file.md` 형식, 허용 category, 정규화·확장자·realpath baseDir 경계를 모두 검증한다.
4. 승인은 기존 파일을 atomic rewrite하며 draft 이외 상태는 덮어쓰지 않는다.
5. OKF parse/serialize는 `src/okf/document.ts`만 사용하고 별도 YAML 구현을 만들지 않는다.

## 전제 조건

```typescript
export type KnowledgeStatus = 'draft' | 'verified' | 'deprecated';
export function parseMarkdownDocument(source: string): MarkdownDocument;
export function serializeMarkdownDocument(
  metadata: DocumentMetadata & { type: string },
  body: string,
): string;
```

## 현재 상태

`saveCaptured`는 plain Markdown을 저장하고 `listCaptured`는 path/title/category만 반환한다. 저장 즉시 rebuild 대상이 되므로 검토되지 않은 지식도 검색될 수 있고, 승인 상태와 안전한 id 기반 파일 접근 계약이 없다.

## Testability Review

| seam | 관찰 방법 | 필요한 제어 | 판정 |
|---|---|---|---|
| 저장 포맷 | temp dir 파일을 parse | `capturedAt` 주입 | 양호 |
| legacy 호환 | frontmatter 없는 fixture | temp dir | 양호 |
| 승인 상태 전이 | 승인 전후 metadata 비교 | `reviewedAt` 주입 | 양호 |
| traversal 방어 | invalid id matrix | baseDir temp path | 양호 |
| atomic write | 최종 파일과 임시 파일 부재 | temp dir | 양호 |

- 의존성: filesystem과 OKF codec이다.
- 주입 가능: 시간은 method argument, 경로는 temp `baseDir`로 주입 가능하다.
- mock/stub: filesystem mock 대신 실제 temp directory를 사용하며 codec은 pure function으로 직접 검증한다.
- 대안: atomic rename 자체의 장애 주입이 필요해지면 file adapter를 도입하되 이번 범위에는 추가하지 않는다.

## Step 1: 공개 lifecycle 계약과 안전한 id (`src/knowledge/capture-store.ts` — modify)

### Context

UI/API가 filesystem path를 직접 전달하지 않도록 `category/file.md` 상대 id를 공개 계약으로 삼고, 예상 가능한 승인 실패를 typed error로 구분한다.

### Code

```typescript
export interface CapturedEntry {
  id: string;
  title: string;
  category: string;
  status: KnowledgeStatus;
}

export type CapturedApprovalErrorCode =
  | 'INVALID_ID'
  | 'NOT_FOUND'
  | 'NOT_DRAFT';

export class CapturedApprovalError extends Error {
  constructor(
    readonly code: CapturedApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CapturedApprovalError';
  }
}
```

id resolver는 다음 순서로 거부한다.

```typescript
async function resolveCapturedId(baseDir: string, id: string): Promise<string> {
  if (id.length === 0 || isAbsolute(id) || extname(id) !== '.md') {
    throw new CapturedApprovalError('INVALID_ID', 'invalid captured id');
  }
  const normalized = normalize(id).replaceAll('\\\\', '/');
  const parts = id.split('/');
  if (
    normalized !== id ||
    parts.length !== 2 ||
    !(KNOWLEDGE_CATEGORIES as readonly string[]).includes(parts[0] ?? '')
  ) {
    throw new CapturedApprovalError('INVALID_ID', 'invalid captured id');
  }
  const base = resolve(baseDir);
  const candidate = resolve(base, id);
  if (!candidate.startsWith(base + sep)) {
    throw new CapturedApprovalError('INVALID_ID', 'invalid captured id');
  }
  try {
    const [realBase, realCandidate] = await Promise.all([
      realpath(base),
      realpath(candidate),
    ]);
    if (!realCandidate.startsWith(realBase + sep)) {
      throw new CapturedApprovalError('INVALID_ID', 'captured id escapes base directory');
    }
    return realCandidate;
  } catch (error) {
    if (error instanceof CapturedApprovalError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CapturedApprovalError('NOT_FOUND', 'captured entry not found');
    }
    throw error;
  }
}
```

### Anchor

- 기존 `CapturedEntry`를 전체 교체한다.
- import에 `realpath`, `extname`, `isAbsolute`, `normalize`, `resolve`, `sep`, `KNOWLEDGE_CATEGORIES`와 OKF types/functions를 추가한다.
- `resolveCapturedId`는 exported functions 위에 둔다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/knowledge/__tests__/capture-store.test.ts
# 기대: 기존 test가 계약 변경에 맞춰 PASS

# 3. 의미 검증
rg -n "CapturedApprovalError|KNOWLEDGE_CATEGORIES|realpath|startsWith\(realBase \+ sep\)" src/knowledge/capture-store.ts
# 기대: typed error, category 형식, symlink-aware baseDir 경계 검증 존재
```

### 동반 변경 (Side Effects)

Phase 1의 CLI와 HTTP consumer는 path 대신 id를 사용한다.

### Do Not Touch

capture extractor의 분류 prompt와 novelty 계산.

## Step 2: draft 저장과 legacy-aware list (`src/knowledge/capture-store.ts`, `src/knowledge/__tests__/capture-store.test.ts` — modify)

### Context

신규 파일은 검토 대기 상태와 provenance를 기계 판독 가능한 OKF metadata로 저장한다. 과거 plain Markdown 파일은 서비스 중단 없이 verified로 노출한다.

### Code

```typescript
const metadata: DocumentMetadata & { type: string } = {
  type: 'Captured Knowledge',
  title: verdict.candidate.title,
  description: verdict.candidate.content.replaceAll(/\s+/g, ' ').trim().slice(0, 160),
  tags: ['captured', verdict.candidate.category],
  timestamp: capturedAt,
  status: 'draft',
  category: verdict.candidate.category,
  provenance: 'conversation',
};

const body = [
  `# ${verdict.candidate.title}`,
  '',
  verdict.candidate.content,
  '',
  `> novelty: ${verdict.maxScore.toFixed(3)}`,
  '',
].join('\n');
```

`listCaptured`는 `KNOWLEDGE_CATEGORIES`에 포함된 category directory 아래 `.md`만 읽고 다음 규칙으로 반환한다. 알 수 없는 directory는 UI에 노출하지 않는 legacy read-only 영역으로 둔다.

```typescript
const parsed = parseMarkdownDocument(source);
const status = parsed.metadata?.status ?? 'verified';
const title = parsed.metadata?.title ?? firstMarkdownHeading(parsed.body) ?? basename(file, '.md');
entries.push({ id: `${category}/${file}`, title, category, status });
```

### 검증 대상
- spy: serialized file을 `parseMarkdownDocument`로 재해석
- branch: 신규 OKF와 legacy plain Markdown
- state: id/title/category/status 및 slug collision suffix

```typescript
it('신규 capture를 draft OKF로 저장한다 (정상)', async () => {
  const saved = await saveCaptured(baseDir, verdict, '2026-07-21T00:00:00Z');
  const parsed = parseMarkdownDocument(await readFile(saved, 'utf8'));
  expect(parsed.metadata).toMatchObject({
    type: 'Captured Knowledge',
    title: verdict.candidate.title,
    status: 'draft',
    category: verdict.candidate.category,
    provenance: 'conversation',
  });
});

it('legacy Markdown은 verified로 목록화하고 unknown category는 제외한다 (경계)', async () => {
  await writeFile(join(baseDir, 'concept', 'legacy.md'), '# Legacy\n\nBody');
  await mkdir(join(baseDir, 'unknown'), { recursive: true });
  await writeFile(join(baseDir, 'unknown', 'hidden.md'), '# Hidden\n\nBody');
  await expect(listCaptured(baseDir)).resolves.toContainEqual({
    id: 'concept/legacy.md',
    title: 'Legacy',
    category: 'concept',
    status: 'verified',
  });
  expect((await listCaptured(baseDir)).some((entry) => entry.id === 'unknown/hidden.md')).toBe(false);
});
```

### Anchor

- `saveCaptured`의 Markdown assembly만 OKF serializer 호출로 교체한다.
- `listCaptured` return mapping 전체를 교체하되 category 정렬과 filename 정렬은 유지한다.
- 기존 중복 slug test는 삭제하지 않고 expected content만 frontmatter-aware로 변경한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/knowledge/__tests__/capture-store.test.ts
# 기대: draft, legacy, collision test PASS

# 3. 의미 검증
rg -n "status: 'draft'|provenance: 'conversation'|\?\? 'verified'" src/knowledge/capture-store.ts
# 기대: 신규/legacy 상태 규칙이 모두 보임
```

### 동반 변경 (Side Effects)

RAG Phase 0의 `isRetrievableChunk`가 신규 draft를 제외한다.

### Do Not Touch

category enum과 filename slug 규칙.

## Step 3: atomic approval transition (`src/knowledge/capture-store.ts`, `src/knowledge/__tests__/capture-store.test.ts` — modify)

### Context

승인은 draft 문서만 verified로 바꾸는 단방향 명시 작업이다. 존재하지 않음과 이미 처리됨을 분리하여 API가 404/409를 안정적으로 매핑할 수 있게 한다.

### Code

```typescript
export async function approveCaptured(
  baseDir: string,
  id: string,
  reviewedAt: string,
): Promise<CapturedEntry> {
  const path = await resolveCapturedId(baseDir, id);
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CapturedApprovalError('NOT_FOUND', 'captured entry not found');
    }
    throw error;
  }
  const parsed = parseMarkdownDocument(source);
  const current = parsed.metadata;
  if (current?.status !== 'draft') {
    throw new CapturedApprovalError('NOT_DRAFT', 'captured entry is not draft');
  }
  const type = current.type?.trim();
  const title = current.title?.trim();
  if (!type || !title) {
    throw new CapturedApprovalError('NOT_DRAFT', 'captured draft metadata is incomplete');
  }
  const metadata: DocumentMetadata & { type: string; title: string } = {
    ...current,
    type,
    title,
    status: 'verified' as const,
    reviewedAt,
  };
  await writeFileAtomic(path, serializeMarkdownDocument(metadata, parsed.body));
  return {
    id,
    title: metadata.title,
    category: metadata.category ?? id.split('/')[0] ?? 'concept',
    status: 'verified',
  };
}
```

### 검증 대상
- spy: atomic rewrite 이후 parse 결과
- branch: success, traversal, missing, legacy/already verified
- state: body 불변, status/reviewedAt 변경, 임시 파일 잔존 없음

```typescript
it.each([
  '../secret.md',
  '/tmp/secret.md',
  'item.md',
  'concept/nested/item.md',
  'unknown/item.md',
  'concept/item.txt',
])(
  'invalid id %s를 거부한다 (오류)',
  async (id) => {
    await expect(approveCaptured(baseDir, id, reviewedAt)).rejects.toMatchObject({
      code: 'INVALID_ID',
    });
  },
);

it('baseDir 밖을 가리키는 symlink id를 거부한다 (보안)', async () => {
  const outside = join(dirname(baseDir), 'outside.md');
  await writeFile(outside, '# outside');
  await mkdir(join(baseDir, 'concept'), { recursive: true });
  await symlink(resolve(outside), join(baseDir, 'concept', 'escape.md'));
  await expect(
    approveCaptured(baseDir, 'concept/escape.md', reviewedAt),
  ).rejects.toMatchObject({ code: 'INVALID_ID' });
});

it('draft를 verified로 승인하고 body를 보존한다 (정상)', async () => {
  const path = await saveCaptured(baseDir, verdict, capturedAt);
  const before = parseMarkdownDocument(await readFile(path, 'utf8'));
  const id = `${verdict.candidate.category}/${slugify(verdict.candidate.title)}.md`;
  const approved = await approveCaptured(baseDir, id, reviewedAt);
  const after = parseMarkdownDocument(await readFile(path, 'utf8'));
  expect(approved.status).toBe('verified');
  expect(after.body).toBe(before.body);
  expect(after.metadata).toMatchObject({ status: 'verified', reviewedAt });
});
```

### Anchor

- `approveCaptured`를 `listCaptured` 뒤에 export한다.
- 기존 private `writeFileAtomic`을 재사용한다.
- Node error type guard가 없다면 이 파일에 최소 helper를 추가한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/knowledge/__tests__/capture-store.test.ts
# 기대: success와 3개 typed error branch PASS

# 3. 의미 검증
rg -n "export async function approveCaptured|NOT_FOUND|NOT_DRAFT|reviewedAt" src/knowledge/capture-store.ts
# 기대: 승인 전이 계약과 error mapping 준비 완료
```

### 동반 변경 (Side Effects)

Phase 1 app mutation queue가 승인과 index rebuild를 하나의 직렬 작업으로 묶는다.

### Do Not Touch

deprecated 전이와 reject/delete 기능은 이번 범위에 추가하지 않는다.

## 이 Phase 완료 후 노출 인터페이스

```typescript
export interface CapturedEntry {
  id: string;
  title: string;
  category: string;
  status: KnowledgeStatus;
}
export class CapturedApprovalError extends Error {
  readonly code: 'INVALID_ID' | 'NOT_FOUND' | 'NOT_DRAFT';
}
export function saveCaptured(baseDir: string, verdict: NoveltyVerdict, capturedAt: string): Promise<string>;
export function listCaptured(baseDir: string): Promise<CapturedEntry[]>;
export function approveCaptured(baseDir: string, id: string, reviewedAt: string): Promise<CapturedEntry>;
```

## Definition of Done

- 신규 capture가 draft OKF로 저장된다.
- legacy plain Markdown이 verified로 목록화된다.
- 승인이 body를 보존하며 verified/reviewedAt를 atomic 저장한다.
- traversal, missing, non-draft가 각각 안정적인 error code로 구분된다.
- capture-store 단위 테스트와 typecheck가 통과한다.
