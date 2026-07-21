# Phase 0: OKF document parser와 serializer

@fidelity-check tokens: MAX_FRONTMATTER_CHARS, parseMarkdownDocument, serializeMarkdownDocument, KnowledgeStatus, reviewedAt

## 코드 예시 적용 규칙

1. 상대 import에는 `.js` 확장자를 붙인다.
2. `unknown`을 parse하고 type guard로 좁힌다.
3. 외부 YAML dependency를 추가하지 않는다.
4. frontmatter는 64KiB를 초과하면 오류로 종료한다.
5. unknown metadata key는 소비하지 않지만 문서 body는 보존한다.

## 전제 조건

```text
OKF bundle root: openwiki/index.md
Required concept paths: openwiki/INSTRUCTIONS.md의 Required paths
Generated change history: openwiki/log.md
```

## 현재 상태

Markdown은 heading 기준으로 바로 chunk되며 frontmatter parser가 없다. captured 문서도 heading/body/footer 문자열만 저장한다.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|---|---|---|---|
| Markdown string | ✓ 함수 인자 | ✓ inline fixture | N/A |
| YAML subset | ✓ 순수 함수 | ✓ scalar/list fixtures | N/A |
| filesystem | N/A | N/A | Phase 1 indexer tests에서 temp directory 사용 |

## Step 1: OKF document codec 생성 (`src/okf/document.ts` — create)

### Context

OpenWiki와 captured knowledge가 쓰는 scalar, quoted scalar, flow-list만 파싱한다. 일반 Markdown은 metadata `null`로 유지한다.

### Code

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

export const MAX_FRONTMATTER_CHARS = 64 * 1024;

function parseQuotedScalar(raw: string): string {
  if (raw.startsWith('"')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('OKF frontmatter의 double-quoted 값이 올바르지 않습니다');
    }
    if (typeof parsed !== 'string') {
      throw new Error('OKF frontmatter scalar는 문자열이어야 합니다');
    }
    return parsed;
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) {
      throw new Error('OKF frontmatter의 single-quoted 값이 닫히지 않았습니다');
    }
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function splitFlowList(inner: string): string[] {
  const values: string[] = [];
  let buffer = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of inner) {
    if (escaped) {
      buffer += char;
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      buffer += char;
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      if (quote === null) {
        quote = char;
      } else if (quote === char) {
        quote = null;
      }
      buffer += char;
      continue;
    }
    if (char === ',' && quote === null) {
      values.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += char;
  }
  if (quote !== null) {
    throw new Error('OKF frontmatter flow-list의 quote가 닫히지 않았습니다');
  }
  if (buffer.trim().length > 0) {
    values.push(buffer.trim());
  }
  return values;
}

function parseTags(raw: string): string[] {
  if (!raw.startsWith('[') || !raw.endsWith(']')) {
    throw new Error('OKF tags는 flow-list 형식이어야 합니다');
  }
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) {
    return [];
  }
  return splitFlowList(inner).map(parseQuotedScalar).filter((tag) => tag.length > 0);
}

function parseStatus(raw: string): KnowledgeStatus {
  const status = parseQuotedScalar(raw);
  if (status === 'draft' || status === 'verified' || status === 'deprecated') {
    return status;
  }
  throw new Error(`지원하지 않는 knowledge status입니다: ${status}`);
}

function setScalar(metadata: DocumentMetadata, key: string, raw: string): void {
  const value = parseQuotedScalar(raw);
  if (value.length === 0) {
    return;
  }
  if (key === 'type') metadata.type = value;
  else if (key === 'title') metadata.title = value;
  else if (key === 'description') metadata.description = value;
  else if (key === 'resource') metadata.resource = value;
  else if (key === 'timestamp') metadata.timestamp = value;
  else if (key === 'category') metadata.category = value;
  else if (key === 'provenance') metadata.provenance = value;
  else if (key === 'reviewed_at') metadata.reviewedAt = value;
}

export function parseMarkdownDocument(markdown: string): MarkdownDocument {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') {
    return { metadata: null, body: normalized };
  }
  const closing = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closing < 0) {
    throw new Error('OKF frontmatter closing delimiter가 없습니다');
  }
  const frontmatter = lines.slice(1, closing).join('\n');
  if (frontmatter.length > MAX_FRONTMATTER_CHARS) {
    throw new Error(`OKF frontmatter가 ${MAX_FRONTMATTER_CHARS}자를 초과했습니다`);
  }

  const metadata: DocumentMetadata = { tags: [] };
  for (const line of lines.slice(1, closing)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match === null) {
      throw new Error(`지원하지 않는 OKF frontmatter 줄입니다: ${trimmed}`);
    }
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined) {
      throw new Error(`OKF frontmatter key/value를 읽지 못했습니다: ${trimmed}`);
    }
    if (key === 'tags') metadata.tags = parseTags(raw);
    else if (key === 'status') metadata.status = parseStatus(raw);
    else setScalar(metadata, key, raw);
  }
  const bodyLines = lines.slice(closing + 1);
  if (bodyLines[0] === '') {
    bodyLines.shift();
  }
  return { metadata, body: bodyLines.join('\n') };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function serializeMarkdownDocument(
  metadata: DocumentMetadata & { type: string },
  body: string,
): string {
  if (metadata.type.trim().length === 0) {
    throw new Error('OKF metadata type은 비어있을 수 없습니다');
  }
  const lines = ['---', `type: ${yamlString(metadata.type)}`];
  if (metadata.title !== undefined) lines.push(`title: ${yamlString(metadata.title)}`);
  if (metadata.description !== undefined) lines.push(`description: ${yamlString(metadata.description)}`);
  if (metadata.resource !== undefined) lines.push(`resource: ${yamlString(metadata.resource)}`);
  if (metadata.tags.length > 0) lines.push(`tags: ${JSON.stringify(metadata.tags)}`);
  if (metadata.timestamp !== undefined) lines.push(`timestamp: ${yamlString(metadata.timestamp)}`);
  if (metadata.status !== undefined) lines.push(`status: ${metadata.status}`);
  if (metadata.category !== undefined) lines.push(`category: ${yamlString(metadata.category)}`);
  if (metadata.provenance !== undefined) lines.push(`provenance: ${yamlString(metadata.provenance)}`);
  if (metadata.reviewedAt !== undefined) lines.push(`reviewed_at: ${yamlString(metadata.reviewedAt)}`);
  lines.push('---', '', body.replace(/^\n+/, ''), '');
  return lines.join('\n');
}
```

### Anchor

N/A — 새 파일.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/okf/__tests__/document.test.ts
# 기대: test file PASS

# 3. 의미 검증
rg -n "MAX_FRONTMATTER_CHARS|parseMarkdownDocument|serializeMarkdownDocument|reviewed_at" src/okf/document.ts
# 기대: 4 symbols match
```

### 동반 변경 (Side Effects)

Step 2에서 정상/오류/경계값 tests를 추가한다.

### Do Not Touch

RAG와 captured store는 Phase 1과 capture-governance Phase 0 owner다.

## Step 2: codec tests (`src/okf/__tests__/document.test.ts` — create)

### Context

일반 Markdown, OKF round-trip, quote/list, malformed delimiter/status, 64KiB cap을 고정한다.

### 검증 대상
- spy: N/A — 순수 함수
- branch: no-frontmatter, valid-frontmatter, malformed, size-limit
- state: metadata/body 또는 명시적 Error

```typescript
import { describe, expect, it } from 'vitest';
import {
  MAX_FRONTMATTER_CHARS,
  parseMarkdownDocument,
  serializeMarkdownDocument,
} from '../document.js';

describe('OKF document codec', () => {
  it('frontmatter가 없는 Markdown은 body를 그대로 보존한다 (정상)', () => {
    expect(parseMarkdownDocument('# 제목\n본문')).toEqual({
      metadata: null,
      body: '# 제목\n본문',
    });
  });

  it('known scalar와 flow-list를 파싱한다 (정상)', () => {
    const parsed = parseMarkdownDocument(
      '---\ntype: "Reference"\ntitle: \'CLI\'\ntags: [cli, "http api"]\nstatus: draft\nreviewed_at: "2026-07-21T00:00:00Z"\n---\n\n# 본문',
    );
    expect(parsed.metadata).toEqual({
      type: 'Reference',
      title: 'CLI',
      tags: ['cli', 'http api'],
      status: 'draft',
      reviewedAt: '2026-07-21T00:00:00Z',
    });
    expect(parsed.body).toBe('# 본문');
  });

  it('serialize 결과를 다시 parse하면 metadata와 body가 보존된다 (정상)', () => {
    const markdown = serializeMarkdownDocument(
      {
        type: 'Captured Knowledge',
        title: '제목',
        description: '설명',
        resource: 'conversation://local',
        tags: ['captured', 'fact'],
        timestamp: '2026-07-21T00:00:00Z',
        status: 'verified',
        category: 'fact',
        provenance: 'conversation',
        reviewedAt: '2026-07-21T01:00:00Z',
      },
      '# 제목\n본문',
    );
    expect(parseMarkdownDocument(markdown)).toEqual({
      metadata: {
        type: 'Captured Knowledge',
        title: '제목',
        description: '설명',
        resource: 'conversation://local',
        tags: ['captured', 'fact'],
        timestamp: '2026-07-21T00:00:00Z',
        status: 'verified',
        category: 'fact',
        provenance: 'conversation',
        reviewedAt: '2026-07-21T01:00:00Z',
      },
      body: '# 제목\n본문\n',
    });
  });

  it('closing delimiter가 없으면 오류다 (에러)', () => {
    expect(() => parseMarkdownDocument('---\ntype: Reference')).toThrow(
      'closing delimiter',
    );
  });

  it('unknown status는 오류다 (에러)', () => {
    expect(() =>
      parseMarkdownDocument('---\ntype: Reference\nstatus: pending\n---\nbody'),
    ).toThrow('지원하지 않는 knowledge status');
  });

  it('64KiB를 초과한 frontmatter는 거부한다 (경계값)', () => {
    const value = 'x'.repeat(MAX_FRONTMATTER_CHARS + 1);
    expect(() =>
      parseMarkdownDocument(`---\ndescription: ${value}\n---\nbody`),
    ).toThrow('초과했습니다');
  });
});
```

### Anchor

N/A — 새 파일.

### Verify

```bash
# 1. 빌드
npm run typecheck
# 기대: exit 0

# 2. 테스트
npx vitest run src/okf/__tests__/document.test.ts
# 기대: 6 tests PASS

# 3. 의미 검증
rg -c "it\(" src/okf/__tests__/document.test.ts
# 기대: 6
```

### 동반 변경 (Side Effects)

N/A — 새 codec의 direct unit tests다.

### Do Not Touch

filesystem, network.

## 실행 순서

- [ ] Step 1
- [ ] Step 2

## 입출력 예제

| 입력 | 출력 |
|---|---|
| `# 제목` | `{metadata:null, body:'# 제목'}` |
| OKF scalar/list | typed `DocumentMetadata` |
| `status: pending` | Error |
| frontmatter 65537+ chars | Error |

## 이 Phase 완료 후 노출 인터페이스

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

## Definition of Done

- [ ] DoD-01: codec 6 tests PASS
- [ ] DoD-02: runtime dependency 추가 0
- [ ] DoD-03: typecheck/build PASS
- [ ] DoD-04: malformed input 명시 오류
- [ ] DoD-05: frontmatter cap 적용
- [ ] DoD-06: Phase 1 interface 노출

## Observability plan

N/A — 순수 parser/serializer, 운영 I/O 없음.

## 최종 검증

```bash
npx vitest run src/okf/__tests__/document.test.ts
npm run typecheck
npm run build
```
