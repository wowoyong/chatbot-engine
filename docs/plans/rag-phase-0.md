# Phase 0: 마크다운 청킹 + 코사인 유사도 (순수 로직)

@fidelity-check tokens: chunkMarkdown, cosineSimilarity, overlapChars

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어
5. `noUncheckedIndexedAccess` 활성 — 인덱스 접근은 `?? 0` / `.at()` / 옵셔널 체인으로 가드

## 전제 조건

Segment 1~2가 노출한 인터페이스 중 본 Phase가 사용하는 것: 없음 (완전 독립 순수 모듈).

## 현재 상태

`src/rag/` 디렉토리 없음. 본 Phase는 기존 파일을 일절 수정하지 않는다.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| (본 Phase — 순수 함수) | ✓ | ✓ | 입출력만으로 완전 검증 |
| Embedder (Phase 1~) | ✓ (인터페이스 + 생성자/인자 주입) | ✓ (FakeEmbedder) | — |
| fetch (Phase 1 OllamaEmbedder) | ✓ (`fetchFn` 주입 — 기존 OllamaClient 패턴) | ✓ | — |
| 파일 시스템 (Phase 2 인덱스 저장/스캔) | ✓ (경로 인자) | ✗ (실제 FS) | `.test-tmp/<uuid>/` 고유 디렉토리 격리 |
| 현재 시각 (Phase 2 createdAt) | ✓ (`BuildIndexOptions.createdAt` 인자 주입) | ✓ | 테스트는 고정 문자열 사용 |
| stdin/stdout (Phase 3 CLI) | ✗ (전역 스트림) | ✗ | 얇은 I/O 레이어 유지 — 로직은 Retriever/Session에서 검증 |

## Step 1: 마크다운 청커 (`src/rag/chunker.ts` — create)

### Context

RAG의 첫 단계. 헤딩 단위로 섹션을 나누고, 긴 섹션은 겹침(overlap)을 두고 재분할한다 — 겹침은 조각 경계에서 문맥이 끊기는 것을 완화한다. 코드펜스(```) 안의 `#`은 헤딩으로 오인하지 않는다. `overlapChars >= maxChars`면 전진량이 0 이하가 되어 무한 루프가 되므로 클램프한다.

### Code
```ts
export interface Chunk {
  /** 원본 파일 경로 */
  source: string;
  /** 청크가 속한 헤딩 텍스트 (헤딩 이전 본문이면 '') */
  heading: string;
  content: string;
}

export interface ChunkOptions {
  /** 청크 최대 길이(문자). 기본 1500 */
  maxChars?: number;
  /** 재분할 시 앞 조각 꼬리를 겹치는 길이(문자). 기본 200 */
  overlapChars?: number;
}

const DEFAULT_MAX_CHARS = 1500;
const DEFAULT_OVERLAP = 200;

interface Section {
  heading: string;
  content: string;
}

function splitByHeading(markdown: string): Section[] {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  let heading = '';
  let buffer: string[] = [];
  let inCodeFence = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeFence = !inCodeFence;
    }
    if (!inCodeFence && line.match(/^#{1,6}\s/) !== null) {
      sections.push({ heading, content: buffer.join('\n') });
      heading = line.replace(/^#{1,6}\s+/, '').trim();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  sections.push({ heading, content: buffer.join('\n') });
  return sections;
}

function splitLong(
  text: string,
  maxChars: number,
  overlapChars: number,
): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    pieces.push(text.slice(start, end));
    if (end >= text.length) {
      break;
    }
    start = end - overlapChars;
  }
  return pieces;
}

/**
 * 마크다운을 헤딩 단위 섹션으로 나누고, 긴 섹션은 maxChars 이하로 재분할한다.
 * overlapChars는 maxChars - 1로 클램프 — 전진량 0 이하(무한 루프) 방지.
 */
export function chunkMarkdown(
  markdown: string,
  source: string,
  options: ChunkOptions = {},
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
      chunks.push({ source, heading: section.heading, content: piece });
    }
  }
  return chunks;
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
grep -c "maxChars - 1" src/rag/chunker.ts
  # 기대: 1 (overlap 클램프 — 무한 루프 가드)
```

### 동반 변경 (Side Effects)

새 export → 단위 테스트 Step 3, 호출처(indexer)는 Phase 2.

### Do Not Touch

`src/llm/**`, `src/chat/**`, `src/context/**`, `src/store/**`, `src/cli/**`.

## Step 2: 코사인 유사도 (`src/rag/cosine.ts` — create)

### Context

시맨틱 검색의 수학적 핵심 — 두 벡터 사이 각도의 코사인. 차원 불일치는 프로그래밍 오류이므로 throw, 영벡터는 방향이 없으므로 0.

### Code
```ts
/** 두 벡터의 코사인 유사도. 차원 불일치는 throw, 영벡터는 0 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length) {
    throw new Error(`벡터 차원 불일치: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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
grep -c "차원 불일치" src/rag/cosine.ts
  # 기대: 1 (가드 존재)
```

### 동반 변경 (Side Effects)

새 가드(차원 불일치 throw) → throw 경로 테스트 Step 4.

### Do Not Touch

`src/rag/chunker.ts` (Step 1 완료본).

## Step 3: 청커 테스트 (`src/rag/__tests__/chunker.test.ts` — create)

### Code

### 검증 대상

- spy: N/A (순수 함수)
- branch: 헤딩 분할, 장문 재분할+겹침, 코드펜스 내 `#` 무시, 빈 문서, overlap ≥ max 클램프, 헤딩 없는 문서
- state: 청크의 source/heading/content 구성과 겹침 내용 일치

```ts
import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../chunker.js';

describe('chunkMarkdown', () => {
  it('헤딩 단위로 섹션을 나누고 heading을 기록한다 (정상)', () => {
    const md = '서문\n\n# 제목A\n본문A\n\n## 제목B\n본문B';
    const chunks = chunkMarkdown(md, 'doc.md');
    expect(chunks).toEqual([
      { source: 'doc.md', heading: '', content: '서문' },
      { source: 'doc.md', heading: '제목A', content: '본문A' },
      { source: 'doc.md', heading: '제목B', content: '본문B' },
    ]);
  });

  it('maxChars를 넘는 섹션은 겹침을 두고 재분할한다 (정상)', () => {
    const body = 'a'.repeat(30);
    const chunks = chunkMarkdown(`# 긴글\n${body}`, 'doc.md', {
      maxChars: 20,
      overlapChars: 5,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks.at(0)?.content).toBe('a'.repeat(20));
    expect(chunks.at(1)?.content).toBe('a'.repeat(15)); // 15~30 구간 (겹침 5)
  });

  it('코드펜스 안의 #은 헤딩으로 취급하지 않는다 (경계값)', () => {
    const md = '# 실제 헤딩\n```\n# 주석이지 헤딩 아님\n```\n본문';
    const chunks = chunkMarkdown(md, 'doc.md');
    expect(chunks).toHaveLength(1);
    expect(chunks.at(0)?.heading).toBe('실제 헤딩');
    expect(chunks.at(0)?.content).toContain('# 주석이지 헤딩 아님');
  });

  it('빈 문서는 빈 배열을 반환한다 (경계값)', () => {
    expect(chunkMarkdown('', 'doc.md')).toEqual([]);
    expect(chunkMarkdown('\n\n\n', 'doc.md')).toEqual([]);
  });

  it('overlapChars가 maxChars 이상이어도 무한 루프 없이 종료한다 (경계값)', () => {
    const chunks = chunkMarkdown(`# t\n${'b'.repeat(50)}`, 'doc.md', {
      maxChars: 10,
      overlapChars: 99,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(60);
  });

  it('헤딩이 전혀 없는 문서는 heading 빈 문자열 청크가 된다 (경계값)', () => {
    const chunks = chunkMarkdown('그냥 본문', 'doc.md');
    expect(chunks).toEqual([{ source: 'doc.md', heading: '', content: '그냥 본문' }]);
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
  # 기대: 전체 51 passed (45 + 6)
# 3. 의미 검증
grep -c "toHaveLength\|toEqual\|toBe\|toContain" src/rag/__tests__/chunker.test.ts
  # 기대: 12 이상 (assertion 존재)
```

### 동반 변경 (Side Effects)

N/A (Step 1의 동반 테스트)

### Do Not Touch

`src/rag/chunker.ts`.

## Step 4: 코사인 테스트 (`src/rag/__tests__/cosine.test.ts` — create)

### Code

### 검증 대상

- spy: N/A (순수 함수)
- branch: 동일 방향, 직교, 차원 불일치 throw, 영벡터
- state: 유사도 수치가 수학적 기대값과 일치

```ts
import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '../cosine.js';

describe('cosineSimilarity', () => {
  it('같은 방향 벡터는 1에 수렴한다 (정상)', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('직교 벡터는 0이다 (정상)', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('차원이 다르면 throw한다 (에러)', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow('차원 불일치');
  });

  it('영벡터는 0을 반환한다 (경계값)', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
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
  # 기대: 전체 55 passed (51 + 4)
# 3. 의미 검증
grep -c "toThrow" src/rag/__tests__/cosine.test.ts
  # 기대: 1 (에러 경로 assertion)
```

### 동반 변경 (Side Effects)

N/A (Step 2의 동반 테스트)

### Do Not Touch

`src/rag/cosine.ts`.

## 실행 순서

Step 1 → 2 → 3 → 4 (상호 독립 — 1↔2 순서 무관, 테스트는 구현 뒤).

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `chunkMarkdown` | `'# A\n본문'` | `[{source, heading:'A', content:'본문'}]` |
| `chunkMarkdown` | 30자 본문, max 20·overlap 5 | 2청크 (20자 + 15자, 5자 겹침) |
| `cosineSimilarity` | `[1,0]`, `[0,1]` | `0` |
| `cosineSimilarity` | `[1,2]`, `[1,2,3]` | throw (차원 불일치) |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/rag/chunker.ts
export interface Chunk { source: string; heading: string; content: string; }
export interface ChunkOptions { maxChars?: number; overlapChars?: number; }
export function chunkMarkdown(markdown: string, source: string, options?: ChunkOptions): Chunk[];

// src/rag/cosine.ts
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number;
```

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify ✓
- [ ] DoD-02: `npm run typecheck` exit 0
- [ ] DoD-03: `npm test` 55 passed (기존 45 회귀 없음)
- [ ] DoD-04: 새 함수에 정상/에러/경계 테스트 동반
- [ ] DoD-05: 문서 갱신 불필요
- [ ] DoD-06: Phase 1 전제 조건 만족

## Observability plan

N/A — 운영 영향 없음 (순수 함수 모듈).

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 0 PASS"
```
