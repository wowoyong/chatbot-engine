# Phase 0: Validator, wiki eval, CI, final documentation

@fidelity-check tokens: wiki:check, validateOpenWiki, okf_version, broken link, stale command, WIKI_GOLDEN_QUESTIONS, noAnswerAccuracy, eval:wiki

## 코드 예시 적용 규칙

1. CI validator는 network, embedding model, Ollama 없이 결정적으로 실행되어야 한다.
2. OpenWiki generated page의 내용은 수정하지 않고 bundle 구조와 metadata/link/command만 검사한다.
3. wiki retrieval eval은 운영과 같은 retriever 설정과 status filter를 사용한다.
4. answerable metric과 no-answer metric의 denominator를 분리한다.
5. README/CLAUDE/ROADMAP은 실제 구현·명령이 모두 통과한 마지막 Step에서만 갱신한다.

## 전제 조건

```typescript
export function parseMarkdownDocument(source: string): MarkdownDocument;
export class HybridRetriever {
  retrieve(query: string): Promise<SearchResult>;
}
export const DEFAULT_MIN_VECTOR_SCORE = 0.88;
```

OpenWiki Phase 1 완료 후 아래 required bundle이 존재한다.

```text
openwiki/index.md
openwiki/quickstart.md
openwiki/architecture/overview.md
openwiki/architecture/request-flow.md
openwiki/components/native-inference.md
openwiki/components/rag.md
openwiki/components/knowledge-capture.md
openwiki/interfaces/cli-and-http.md
openwiki/operations/openwiki-and-deployment.md
openwiki/testing/evaluation.md
openwiki/reference/configuration.md
openwiki/source-map.md
openwiki/log.md
```

## 현재 상태

CI는 typecheck/test/build만 실행한다. eval은 수동 corpus만 대상으로 하며 no-answer를 평가하지 않는다. generated OpenWiki의 required page, OKF metadata, 내부 링크, 실행 명령 drift를 자동 검출하는 gate가 없다.

## Testability Review

| seam | 관찰 방법 | 필요한 제어 | 판정 |
|---|---|---|---|
| bundle validation | temp directory issue array | root path argument | 양호 |
| command drift | source file/package script 조회 | repo root argument 또는 상수 | 양호 |
| metric | pure function output | ranked source fixtures | 양호 |
| wiki retrieval | real openwiki + embedder | Ollama 필요 | CI 제외, 수동 gate |
| workflow/doc sync | rg와 package scripts | N/A | 양호 |

validator는 library function과 CLI main을 분리한다. Ollama 의존 eval을 CI에 넣지 않아 개발 환경 불안정이 merge gate가 되지 않게 한다.

- 의존성: filesystem, package scripts, OKF codec, 수동 eval의 Ollama다.
- 주입 가능: validator root/repo path와 eval embedder 설정을 호출 경계에서 주입 가능하게 둔다.
- mock/stub: validator는 temp directory fixture, metric은 pure input, retrieval은 기존 fake embedder를 사용한다.
- 대안: Ollama가 없는 환경에서는 deterministic `wiki:check`만 실행하고 `eval:wiki`는 준비된 release 환경에서 수행한다.

## Step 1: OpenWiki bundle validator (`scripts/validate-openwiki.ts`, `scripts/__tests__/validate-openwiki.test.ts` — create)

### Context

required page 누락, OKF type 누락, 깨진 내부 Markdown link, repo에서 더 이상 유효하지 않은 명령을 하나의 deterministic command로 검출한다.

### Code

```typescript
export interface ValidationIssue {
  file: string;
  message: string;
}

export const REQUIRED_OPENWIKI_PATHS = [
  'index.md',
  'quickstart.md',
  'architecture/overview.md',
  'architecture/request-flow.md',
  'components/native-inference.md',
  'components/rag.md',
  'components/knowledge-capture.md',
  'interfaces/cli-and-http.md',
  'operations/openwiki-and-deployment.md',
  'testing/evaluation.md',
  'reference/configuration.md',
  'source-map.md',
  'log.md',
] as const;
```

validator entry point는 issue를 누적하여 한 번에 반환한다.

```typescript
export async function validateOpenWiki(
  openwikiRoot: string,
  repoRoot = resolve(openwikiRoot, '..'),
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  await validateRequiredFiles(openwikiRoot, issues);
  const markdownFiles = await listMarkdownFiles(openwikiRoot);
  await validateOkfMetadata(openwikiRoot, markdownFiles, issues);
  await validateInternalLinks(openwikiRoot, markdownFiles, issues);
  await validateDocumentedCommands(repoRoot, openwikiRoot, markdownFiles, issues);
  return issues;
}
```

검사 규칙은 다음으로 고정한다.

- `index.md`, `log.md`, `INSTRUCTIONS.md` 이외 Markdown은 parse 가능한 OKF `type`이 있어야 한다.
- root `index.md`에는 `okf_version: 0.1`이 있어야 한다.
- link target에서 query/hash를 제거하고 `http:`, `https:`, `mailto:`는 건너뛴다.
- `/foo.md`는 openwiki root 기준, `../foo.md`는 현재 문서 기준으로 resolve하며 root 밖이면 issue다.
- `.md` target이 없으면 issue다. directory link는 `<dir>/index.md` 존재를 검사한다.
- backtick의 `npm run <name>`과 lifecycle shorthand `npm start|test|stop|restart`는 `package.json#scripts` 존재를 검사한다.
- `npm install|ci`는 npm builtin으로 허용하고, `npx -y openwiki@0.2.1 ...`만 repository 문서의 허용된 pinned external command로 인정한다.
- `node|tsx <path>`와 `bash <path>`는 repo file 존재를 검사하며 다른 해석 불가능한 local command는 issue로 보고한다.

CLI main은 issue를 모두 출력하고 exit code만 설정한다.

```typescript
const issues = await validateOpenWiki(resolve(process.cwd(), 'openwiki'));
for (const issue of issues) console.error(`${issue.file}: ${issue.message}`);
if (issues.length > 0) process.exitCode = 1;
```

### 검증 대상
- spy: 반환 issue의 file/message
- branch: valid bundle, required missing, invalid/missing type, root escape/broken link, stale npm/file command
- state: valid fixture issue 0, 여러 오류 동시 누적

```typescript
it('유효한 최소 bundle은 issue가 없다 (정상)', async () => {
  const fixture = await createValidOpenWikiFixture();
  await expect(validateOpenWiki(fixture.openwiki, fixture.repo)).resolves.toEqual([]);
});

it('metadata, link, command drift를 한 번에 보고한다 (오류)', async () => {
  const fixture = await createValidOpenWikiFixture();
  await writeFile(join(fixture.openwiki, 'components', 'rag.md'), [
    '# RAG',
    '[missing]' + '(./missing.md)',
    '`npm run removed-script`',
    '`npm start`',
  ].join('\n'));
  const issues = await validateOpenWiki(fixture.openwiki, fixture.repo);
  expect(issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
    expect.stringContaining('type'),
    expect.stringContaining('missing.md'),
    expect.stringContaining('removed-script'),
    expect.stringContaining('npm start'),
  ]));
});
```

### Anchor

- test fixture helper는 `REQUIRED_OPENWIKI_PATHS`를 순회해 모든 required file을 생성한다.
- `import.meta.url` main guard를 사용해 test import 시 CLI가 실행되지 않게 한다.
- symlink follow는 하지 않는다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run scripts/__tests__/validate-openwiki.test.ts
# 기대: valid/error matrix PASS

# 3. 의미 검증
npx tsx scripts/validate-openwiki.ts
# 기대: 실제 generated openwiki 기준 exit 0
```

### 동반 변경 (Side Effects)

OpenWiki가 잘못 생성되면 CI 전에 로컬에서 동일한 원인을 확인할 수 있다.

### Do Not Touch

OpenWiki 페이지 자동 수정, link rewrite, generator 호출.

## Step 2: answerable/no-answer metric (`eval/metric.ts`, `eval/__tests__/metric.test.ts` — modify)

### Context

기존 metric을 보존하면서 expected source가 없는 질문의 abstention 성공률을 별도 집계한다. 빈 hit를 answerable 실패로, hit가 없는 것을 no-answer 성공으로 정의한다.

### Code

```typescript
export interface AbstentionEvalCase {
  ranked: string[];
  expected: string | null;
}

export interface AbstentionEvalSummary extends EvalSummary {
  answerableCount: number;
  noAnswerCount: number;
  noAnswerAccuracy: number;
}

export function summarizeWithAbstention(
  perQuestion: readonly AbstentionEvalCase[],
): AbstentionEvalSummary {
  const answerable = perQuestion.filter(
    (item): item is { ranked: string[]; expected: string } => item.expected !== null,
  );
  const noAnswer = perQuestion.filter((item) => item.expected === null);
  const answerSummary = summarize(answerable);
  return {
    ...answerSummary,
    count: perQuestion.length,
    answerableCount: answerable.length,
    noAnswerCount: noAnswer.length,
    noAnswerAccuracy: mean(noAnswer.map((item) => item.ranked.length === 0 ? 1 : 0)),
  };
}
```

`recallAt1`은 답변의 첫 citation이 기대 source인지 보는 deterministic citation@1 지표로 함께 표시한다.

### 검증 대상
- spy: pure summary return
- branch: mixed, all answerable, all no-answer, empty input
- state: denominator 분리와 count 합계

```typescript
it('answerable과 no-answer denominator를 분리한다 (정상)', () => {
  expect(summarizeWithAbstention([
    { ranked: ['a.md'], expected: 'a.md' },
    { ranked: [], expected: null },
    { ranked: ['noise.md'], expected: null },
  ])).toMatchObject({
    count: 3,
    answerableCount: 1,
    noAnswerCount: 2,
    recallAt1: 1,
    noAnswerAccuracy: 0.5,
  });
});
```

### Anchor

- 기존 `summarize` signature와 결과는 변경하지 않는다.
- 신규 interfaces/functions를 파일 끝에 추가한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run eval/__tests__/metric.test.ts
# 기대: 기존 + abstention tests PASS

# 3. 의미 검증
rg -n "summarizeWithAbstention|noAnswerAccuracy|answerableCount" eval/metric.ts
# 기대: 별도 denominator 계약 존재
```

### 동반 변경 (Side Effects)

기존 `npm run eval` 출력과 fixture는 변경하지 않는다.

### Do Not Touch

기존 recall/MRR 수식.

## Step 3: generated wiki golden eval (`eval/wiki-golden.ts`, `eval/run-wiki.ts` — create)

### Context

수동 corpus가 아니라 실제 `openwiki/` bundle을 운영 index/retriever로 검색해 source citation과 모르는 질문 억제를 측정한다.

### Code

```typescript
export interface WikiGoldenQuestion {
  question: string;
  expectedSource: string | null;
}

export const WIKI_GOLDEN_QUESTIONS: readonly WikiGoldenQuestion[] = [
  { question: 'CLI와 HTTP 서버의 진입점은 어디야?', expectedSource: 'interfaces/cli-and-http.md' },
  { question: 'native 추론에서 GGUF를 어떻게 읽어?', expectedSource: 'components/native-inference.md' },
  { question: '하이브리드 검색과 score threshold는 어떻게 동작해?', expectedSource: 'components/rag.md' },
  { question: '대화에서 지식을 추출하고 승인하는 흐름은?', expectedSource: 'components/knowledge-capture.md' },
  { question: '요청이 CLI에서 모델 응답까지 흐르는 과정은?', expectedSource: 'architecture/request-flow.md' },
  { question: 'OpenWiki를 cloud와 local에서 갱신하는 방법은?', expectedSource: 'operations/openwiki-and-deployment.md' },
  { question: '환경 변수와 기본 설정값은?', expectedSource: 'reference/configuration.md' },
  { question: '평가와 테스트를 실행하는 명령은?', expectedSource: 'testing/evaluation.md' },
  { question: '달 표면 배포 리전의 세금 정책은?', expectedSource: null },
  { question: '이 저장소의 모바일 앱 결제 환불 규정은?', expectedSource: null },
  { question: '화성 지사의 2035년 인사 담당자는?', expectedSource: null },
];
```

runner는 runtime과 같은 index/retriever를 사용한다.

```typescript
const openwikiRoot = resolve('openwiki');
const index = await buildIndex(embedder, openwikiRoot, {
  model: embedder.model,
  createdAt: 'wiki-eval',
});
const retriever = new HybridRetriever(embedder, index, {
  topK: 4,
  minVectorScore: DEFAULT_MIN_VECTOR_SCORE,
});
const perQuestion = [];
for (const item of WIKI_GOLDEN_QUESTIONS) {
  const hits = (await retriever.retrieve(item.question)).hits;
  perQuestion.push({
    ranked: hits.map((hit) => relative(openwikiRoot, hit.chunk.source).split(sep).join('/')),
    expected: item.expectedSource,
  });
}
console.table(perQuestion);
console.log(summarizeWithAbstention(perQuestion));
```

runner acceptance threshold는 `recallAt4 >= 0.75`, `mrr >= 0.55`, `noAnswerAccuracy >= 0.66`으로 고정하며 미달 시 `process.exitCode = 1`이다. retrieval `topK`와 metric ranking depth는 운영 기본값과 같은 4로 유지한다.

### Anchor

- embedder/env 생성은 기존 `eval/run.ts` helper를 추출할 가치가 없으면 동일 public constructor만 사용한다.
- expected source는 openwiki root-relative POSIX path로 정규화한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run eval/__tests__/metric.test.ts
# 기대: metric PASS

# 3. 의미 검증
npx tsx eval/run-wiki.ts
# 기대: Ollama 준비 환경에서 recall@4 >= 0.75, MRR >= 0.55, no-answer >= 0.66
```

### 동반 변경 (Side Effects)

Ollama/model availability가 필요한 수동 release gate다. CI deterministic gate와 의도적으로 분리한다.

### Do Not Touch

기존 corpus와 `GOLDEN_QUESTIONS` baseline.

## Step 4: package와 CI gate (`package.json`, `tsconfig.json`, `vitest.config.ts`, `.github/workflows/ci.yml` — modify)

### Context

validator를 표준 명령과 PR gate로 승격하고 wiki eval은 로컬/릴리스용 명령으로 노출한다.

### Code

```json
{
  "scripts": {
    "wiki:check": "tsx scripts/validate-openwiki.ts",
    "eval:wiki": "tsx eval/run-wiki.ts"
  }
}
```

CI 순서는 deterministic wiki check 이후 기존 build를 유지한다.

```yaml
      - run: npm run typecheck
      - run: npm test
      - run: npm run wiki:check
      - run: npm run build
```

tools/eval 코드가 표준 gate에서 빠지지 않도록 검사 범위를 확장한다. `tsconfig.build.json`은 `src` 전용 include를 유지한다.

```json
{
  "include": ["src", "eval", "scripts", "vitest.config.ts"]
}
```

```typescript
test: {
  include: [
    'src/**/__tests__/**/*.test.ts',
    'eval/**/__tests__/**/*.test.ts',
    'scripts/**/__tests__/**/*.test.ts',
  ],
}
```

### Anchor

- package scripts는 기존 `eval` 다음에 `eval:wiki`, `sync-wiki` 다음에 `wiki:check`를 둔다.
- `tsconfig.json` include에 `eval`, `scripts`를 추가하고 `tsconfig.build.json`은 `src` 전용으로 보존한다.
- Vitest include에 scripts test glob을 추가한다.
- CI의 Node/setup/cache/install 설정은 변경하지 않는다.
- `eval:wiki`는 CI workflow에 추가하지 않는다.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: exit 0

# 2. 테스트
npm test
# 기대: validator test를 포함한 전체 PASS

# 3. 의미 검증
npm run wiki:check
# 기대: exit 0, network/Ollama 호출 없음
```

### 동반 변경 (Side Effects)

OpenWiki update PR도 동일 CI gate를 거쳐 broken generated bundle merge를 차단한다.

### Do Not Touch

OpenWiki scheduled workflow와 provider secret.

## Step 5: 운영 문서와 roadmap 마감 (`README.md`, `CLAUDE.md`, `docs/ROADMAP.md` — modify)

### Context

구현 전 미래형 문구와 구현 후 실제 계약이 어긋나지 않도록 모든 gate가 통과한 뒤 사용자·에이전트·roadmap 관점을 한 번에 동기화한다.

### Code

README에는 다음 실행 흐름을 추가한다.

```markdown
## Repository knowledge

- 시작점: `openwiki/quickstart.md`
- 무결성 검사: `npm run wiki:check`
- 운영과 같은 retrieval 평가: `npm run eval:wiki` (Ollama 필요)
- 신규 대화 지식: draft 저장 → CLI/Web 승인 → verified 검색 노출
```

CLAUDE.md에는 generated page 직접 편집 금지, source/docs 수정 후 OpenWiki regenerate, OKF status 의미, 승인 없는 draft 비노출을 기록한다.

ROADMAP의 완료 항목은 실제 구현에 맞춰 아래만 체크한다.

```markdown
- [x] OpenWiki 기반 recurring repository documentation
- [x] OKF metadata-aware indexing and trusted retrieval
- [x] Captured knowledge draft/approval lifecycle
- [x] Wiki integrity and retrieval evaluation gates
```

### Anchor

- README 기존 quickstart와 command 표를 중복 생성하지 않고 해당 section에 병합한다.
- CLAUDE.md 기존 architecture 원칙 아래에 `Repository knowledge` subsection을 추가한다.
- ROADMAP 항목이 이미 있으면 문구를 새로 추가하지 않고 상태/설명만 갱신한다.
- `openwiki/*.md` generated page는 이 Step에서 편집하지 않는다.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: exit 0

# 2. 테스트
npm test && npm run wiki:check
# 기대: 전체 test와 wiki gate PASS

# 3. 의미 검증
rg -n "openwiki/quickstart.md|wiki:check|eval:wiki|draft|verified" README.md CLAUDE.md docs/ROADMAP.md
# 기대: 사용자/agent/roadmap 계약이 구현과 일치
```

### 동반 변경 (Side Effects)

README의 기능 목록과 ROADMAP 진행률이 바뀐다.

### Do Not Touch

generated OpenWiki pages와 과거 roadmap 완료 이력.

## 이 Phase 완료 후 노출 인터페이스

```typescript
export function validateOpenWiki(openwikiRoot: string, repoRoot?: string): Promise<ValidationIssue[]>;
export function summarizeWithAbstention(cases: readonly AbstentionEvalCase[]): AbstentionEvalSummary;
// npm run wiki:check — deterministic CI gate
// npm run eval:wiki — Ollama-backed manual/release gate
```

## Definition of Done

- required bundle, OKF metadata, internal links, documented command drift를 validator가 검출한다.
- validator 정상/복합 오류 tests가 통과하고 실제 `openwiki/`가 `wiki:check`를 통과한다.
- answerable recall/MRR/citation@1과 no-answer accuracy가 분리 집계된다.
- 실제 generated wiki eval이 명시된 최소 threshold를 통과한다.
- CI에 `wiki:check`가 추가되고 `eval:wiki`는 수동 gate로 유지된다.
- README, CLAUDE.md, ROADMAP이 최종 구현 및 generated-page 정책과 일치한다.
- typecheck, 전체 test, build가 통과한다.
