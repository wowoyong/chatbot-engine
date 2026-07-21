# Phase 1: Source metadata wire와 안전한 UI

@fidelity-check tokens: title?: string, resource?: string, safeHttpUrl, appendSource, rel = 'noopener noreferrer'

## 코드 예시 적용 규칙

1. chat layer는 rag module을 import하지 않고 structural type만 선언한다.
2. 신규 source field는 optional로 유지한다.
3. browser source rendering은 `innerHTML`을 사용하지 않는다.
4. `http:`과 `https:` resource만 anchor로 만든다.
5. anchor에는 `target="_blank"`, `rel="noopener noreferrer"`를 지정한다.

## 전제 조건

```typescript
export const DEFAULT_MIN_VECTOR_SCORE = 0.88;
export interface HybridConfig {
  topK?: number;
  candidateDepth?: number;
  minVectorScore?: number;
}
export function isRetrievableChunk(chunk: IndexedChunk): boolean;
export function formatRetrievedContext(hits: readonly SearchHit[]): string | null;
```

## 현재 상태

`SourceRef`는 source/heading만 반환하며 CLI와 browser는 filesystem path를 plain text로 표시한다.

## Step 1: SourceRef optional metadata (`src/chat/session.ts`, `src/chat/__tests__/session-meta.test.ts` — modify)

### Context

retrieved chunk metadata title/resource를 TurnMeta로 전달한다. undefined는 JSON에서 생략되어 old client와 호환된다.

### Code

```typescript
export interface SourceRef {
  source: string;
  heading: string;
  title?: string;
  resource?: string;
}
```

`ContextRetriever.retrieve` structural type을 교체한다.

```typescript
export interface ContextRetriever {
  retrieve(query: string): Promise<{
    block: string | null;
    hits?: {
      chunk: {
        source: string;
        heading: string;
        metadata?: { title?: string; resource?: string } | null;
      };
    }[];
  }>;
}
```

source mapping을 교체한다.

```typescript
        sources = (retrieved.hits ?? []).map((hit) => ({
          source: hit.chunk.source,
          heading: hit.chunk.heading,
          title: hit.chunk.metadata?.title,
          resource: hit.chunk.metadata?.resource,
        }));
```

### 검증 대상
- spy: generator return TurnMeta
- branch: metadata present와 absent
- state: optional title/resource 보존

```typescript
it('retrieved metadata title/resource를 TurnMeta로 반환한다 (정상)', async () => {
  const session = new ChatSession(new FakeClient(), {
    retriever: {
      async retrieve() {
        return {
          block: 'context',
          hits: [{
            chunk: {
              source: 'doc.md',
              heading: '설치',
              metadata: {
                title: '설치 가이드',
                resource: 'https://example.com/docs/install',
              },
            },
          }],
        };
      },
    },
  });
  const iterator = session.send('질문')[Symbol.asyncIterator]();
  let result = await iterator.next();
  while (!result.done) result = await iterator.next();
  expect(result.value.sources).toEqual([{
    source: 'doc.md',
    heading: '설치',
    title: '설치 가이드',
    resource: 'https://example.com/docs/install',
  }]);
});
```

### Anchor

- interface 2개 전체 교체.
- `sources =` mapping 전체 교체.
- test를 session meta describe 마지막에 추가하고 기존 expected에는 optional key를 추가하지 않는다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/chat/__tests__/session-meta.test.ts
# 기대: 신규 test 포함 PASS

# 3. 의미 검증
rg -n "title\?: string|resource\?: string|metadata\?\.resource" src/chat/session.ts
# 기대: optional wire fields match
```

### 동반 변경 (Side Effects)

Step 2~3에서 CLI와 Web consumer를 갱신한다.

### Do Not Touch

history, token stats, stream atomicity.

## Step 2: CLI source label (`src/cli/main.ts` — modify)

### Context

title을 우선 표시하고 resource가 있으면 괄호로 덧붙인다. terminal hyperlink escape는 사용하지 않는다.

### Code

```typescript
function sourceLabel(source: TurnMeta['sources'][number]): string {
  const base = source.title ?? source.source;
  const withHeading = source.heading.length > 0
    ? `${base} > ${source.heading}`
    : base;
  return source.resource === undefined
    ? withHeading
    : `${withHeading} (${source.resource})`;
}
```

기존 labels mapping을 교체한다.

```typescript
        const labels = meta.sources.map(sourceLabel).join(', ');
```

### Anchor

- import 바로 아래에 helper 삽입.
- `.map((s) =>`부터 `.join(', ')`까지 교체.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npm test
# 기대: PASS

# 3. 의미 검증
rg -n "function sourceLabel|meta.sources.map\(sourceLabel\)" src/cli/main.ts
# 기대: helper와 단일 consumer
```

### 동반 변경 (Side Effects)

N/A — optional wire consumer 갱신.

### Do Not Touch

CLI command branches.

## Step 3: browser source DOM (`src/server/public/index.html` — modify)

### Context

resource를 URL parser로 검증하고 DOM API로만 렌더한다.

### Code

```javascript
function safeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function sourceLabel(source) {
  const base = source.title || source.source;
  return source.heading ? base + ' > ' + source.heading : base;
}

function appendSource(parent, source) {
  const row = document.createElement('div');
  const label = sourceLabel(source);
  const href = safeHttpUrl(source.resource);
  if (href) {
    const anchor = document.createElement('a');
    anchor.textContent = label;
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    row.appendChild(anchor);
  } else {
    row.textContent = label;
  }
  parent.appendChild(row);
}
```

`finalize`의 source labels/body block을 교체한다.

```javascript
  if (ctx.sources && ctx.sources.length > 0) {
    const det = document.createElement('details');
    det.className = 'meta';
    const sum = document.createElement('summary');
    sum.textContent = '참조 문서 ' + ctx.sources.length + '건';
    const body = document.createElement('div');
    for (const source of ctx.sources) appendSource(body, source);
    det.appendChild(sum);
    det.appendChild(body);
    log.appendChild(det);
  }
```

### Anchor

- `renderMarkdown` 함수 바로 위에 helper 3개 삽입.
- `finalize` 안의 `if (ctx.sources` 전체 block 교체.

### Verify

```bash
# 1. 빌드
npm run build
# 기대: public HTML copy 포함 exit 0

# 2. 테스트
npx vitest run src/server
# 기대: Step 4 tests 포함 PASS

# 3. 의미 검증
rg -n "safeHttpUrl|appendSource|noopener noreferrer|new URL\(value\)" src/server/public/index.html
# 기대: 4 safety markers
```

### 동반 변경 (Side Effects)

Step 4 static UI contract test를 추가한다.

### Do Not Touch

bot Markdown `innerHTML`은 escape-first renderer의 기존 동작으로 유지한다. source renderer에서는 사용 금지.

## Step 4: source wire integration tests (`src/server/__tests__/source-ui.test.ts`, `src/server/__tests__/http-server.test.ts` — create/modify)

### Context

HTML safety marker와 SSE optional fields를 각각 정적/HTTP 수준에서 검증한다.

### 검증 대상
- spy: source HTML text, SSE response text
- branch: HTTPS, `javascript:`, `data:`, malformed resource와 source event
- state: HTTPS만 URL 반환, unsafe protocol null, serialized optional fields

```typescript
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('source UI contract', () => {
  it('source resource는 protocol validation과 DOM API로 렌더한다 (정상)', async () => {
    const html = await readFile(
      fileURLToPath(new URL('../public/index.html', import.meta.url)),
      'utf8',
    );
    expect(html).toContain('function safeHttpUrl(value)');
    expect(html).toContain("url.protocol === 'http:' || url.protocol === 'https:'");
    expect(html).toContain("anchor.rel = 'noopener noreferrer'");
    expect(html).toContain('for (const source of ctx.sources) appendSource(body, source)');
    const source = html.match(/function safeHttpUrl\(value\) \{[\s\S]*?\n\}/)?.[0];
    if (source === undefined) throw new Error('safeHttpUrl source not found');
    const safeHttpUrl = runInNewContext(`(${source})`, { URL }) as (value: unknown) => string | null;
    expect(safeHttpUrl('https://example.com/docs')).toBe('https://example.com/docs');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,x')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
  });
});
```

HTTP test의 setup document를 OKF로 바꾸고 source event assertion을 추가한다. 현재 `beforeEach`의 지역 `const app`은 describe scope의 `let app: App`으로 승격하고 `beforeEach`에서 대입한다.

### 검증 대상
- spy: SSE source event JSON
- branch: indexed OKF resource present
- state: title/resource serialized

```typescript
it('sources SSE에 OKF title/resource를 포함한다 (정상)', async () => {
  await writeFile(
    join(dir, 'docs', 'a.md'),
    '---\ntype: Reference\ntitle: "설치 가이드"\nresource: "https://example.com/install"\ntags: [install]\n---\n\n# 설치\n본문',
  );
  await app.rebuildIndex('t');
  const res = await postChat('설치 본문');
  const text = await res.text();
  expect(text).toContain('event: sources');
  expect(text).toContain('"title":"설치 가이드"');
  expect(text).toContain('"resource":"https://example.com/install"');
});
```

### Anchor

- source UI test는 새 파일.
- HTTP test는 server describe 마지막에 추가한다. setup의 기존 `a.md` write는 이 test 안에서 overwrite한다.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/server src/chat/__tests__/session-meta.test.ts
# 기대: source UI/SSE tests PASS

# 3. 의미 검증
rg -n "safeHttpUrl|title/resource|noopener noreferrer" src/server/__tests__
# 기대: safety와 wire tests match
```

### 동반 변경 (Side Effects)

N/A — source contract direct tests다.

### Do Not Touch

SSE token/done/error event shapes.

## 실행 순서

- [ ] Step 1
- [ ] Step 2
- [ ] Step 3
- [ ] Step 4

## 입출력 예제

| source | CLI | Web |
|---|---|---|
| title/resource 있음 | `설치 가이드 > 설치 (https://...)` | safe anchor |
| resource `javascript:` | plain text | plain text |
| metadata 없음 | source path | source path |

## 이 Phase 완료 후 노출 인터페이스

```typescript
export interface SourceRef {
  source: string;
  heading: string;
  title?: string;
  resource?: string;
}
export interface TurnMeta {
  sources: SourceRef[];
  promptTokens?: number;
  responseTokens?: number;
}
```

## Definition of Done

- [ ] DoD-11: SourceRef metadata test PASS
- [ ] DoD-12: SSE integration test PASS
- [ ] DoD-13: source DOM에 innerHTML 0건
- [ ] DoD-14: unsafe protocol plain text
- [ ] DoD-15: full suite/typecheck/build PASS
- [ ] DoD-16: capture-governance 전제 만족

## Observability plan

- 로깅: 기존 source SSE와 CLI source line
- 메트릭: source count 기존 UI에 표시
- 알림: N/A
- 대시보드: N/A

## 최종 검증

```bash
npm test
npm run typecheck
npm run build
git diff --check
```
