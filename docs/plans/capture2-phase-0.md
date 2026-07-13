# Phase 0: 구조화 출력 + 프롬프트 개선 + /captured 목록

@fidelity-check tokens: EXTRACT_SCHEMA, format, looseParse, listCaptured, api/captured

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수
2. `any` 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성

## 전제 조건

```ts
// src/llm/types.ts — ChatOptions { think?; timeoutMs? }
// src/llm/ollama-client.ts — body: { model, messages, stream:true, think }
// src/knowledge/extractor.ts — KNOWLEDGE_CATEGORIES, KnowledgeCandidate, parseCandidates, extractKnowledge
// src/knowledge/capture-store.ts — slugify, saveCaptured
// src/app/bootstrap.ts — App { captureKnowledge, docsDir, ... }
```

## 현재 상태

extractor는 프롬프트로만 JSON을 유도(형식 오류 가능)하고 어시스턴트 맞장구도 추출한다. `/captured` 목록 없음. Ollama `format`(JSON 스키마)로 형식 강제 + 프롬프트로 노이즈 필터 + 목록 추가.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| extractor (LlmClient) | ✓ | ✓ (Fake chatResult) | — |
| capture-store (FS) | ✓ (baseDir) | ✗ | `.test-tmp/<uuid>/` 격리 |
| OllamaClient (fetchFn) | ✓ | ✓ | body 검증 |

## Step 1: ChatOptions.format (`src/llm/types.ts` — modify, 필드 추가)

### Context

구조화 출력용 JSON 스키마 전달 채널. optional이라 기존 호출자 무영향.

### Code

`export interface ChatOptions {` 블록에 필드 추가 —

교체 전:
```ts
export interface ChatOptions {
  /** 모델의 thinking(chain-of-thought) 활성 여부. 기본 false — CLI 대화 UX 보호 */
  think?: boolean;
  /** 요청 타임아웃(ms). 기본 120_000 */
  timeoutMs?: number;
}
```
교체 후:
```ts
export interface ChatOptions {
  /** 모델의 thinking(chain-of-thought) 활성 여부. 기본 false — CLI 대화 UX 보호 */
  think?: boolean;
  /** 요청 타임아웃(ms). 기본 120_000 */
  timeoutMs?: number;
  /** 구조화 출력 JSON 스키마 (Ollama format). 지정 시 응답이 스키마를 따름 */
  format?: unknown;
}
```

### Anchor

`export interface ChatOptions {` 블록 (유일).

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 139 passed
# 3. 의미 검증
grep -c "format?: unknown" src/llm/types.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

새 optional 필드 → OllamaClient 전달(Step 2), extractor 사용(Step 3).

### Do Not Touch

ChatMessage/LlmClient/Embedder.

## Step 2: OllamaClient가 format 전달 (`src/llm/ollama-client.ts` — modify, body)

### Context

body에 format 조건부 포함. `/api/chat`은 `format`을 지원(JSON 스키마 시 구조화 출력).

### Code

교체 전:
```ts
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          think: options.think ?? false,
        }),
```
교체 후:
```ts
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          think: options.think ?? false,
          ...(options.format !== undefined ? { format: options.format } : {}),
        }),
```

### Anchor

`body: JSON.stringify({` 블록 (유일).

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 139 passed (기존 body 검증 테스트 — format 없으면 미포함이라 무영향)
# 3. 의미 검증
grep -c "options.format !== undefined" src/llm/ollama-client.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

format 전달 경로 → extractor 스키마 사용(Step 3), body 검증 테스트(Step 6).

### Do Not Touch

chatStream 스트리밍/에러 로직, chat 메서드.

## Step 3: extractor 구조화 + 프롬프트 (`src/knowledge/extractor.ts` — modify, 전체 교체)

### Context

(D-1) EXTRACT_SCHEMA(object-wrapper, enum은 KNOWLEDGE_CATEGORIES 참조 — 단일 소스) + extractKnowledge가 format 전달. (D-2) 프롬프트에 "어시스턴트 맞장구 제외" 추가. parseCandidates는 `looseParse`로 array·{items} 양쪽 수용(format 미지원 fallback + 기존 테스트 호환).

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

/** Ollama format용 JSON 스키마 — enum은 KNOWLEDGE_CATEGORIES 단일 소스 참조 */
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          category: { type: 'string', enum: [...KNOWLEDGE_CATEGORIES] },
          content: { type: 'string' },
        },
        required: ['title', 'category', 'content'],
      },
    },
  },
  required: ['items'],
};

const EXTRACT_SYSTEM_PROMPT = [
  '다음 대화에서 이후에도 재사용할 가치가 있는 지식을 추출하라.',
  '- 각 항목은 대화 맥락 없이도 이해되는 자기완결적 설명으로 작성하라',
  '- 어시스턴트의 맞장구·확인 발화(예: "알겠습니다", "기억했어요")는 지식이 아니다. 사용자가 제공한 정보나 확립된 사실·개념만 추출하라',
  '- category는 다음 중 하나만: concept(개념/원리), fact(사실/수치), preference(사용자 선호/결정), howto(방법/절차)',
  '- 추출할 것이 없으면 items를 빈 배열로',
  '- JSON만 출력: {"items":[{"title":"...","category":"...","content":"..."}]}',
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

/** LLM 출력에서 첫 JSON 값(객체 또는 배열)을 관대하게 파싱 (코드펜스/부가 텍스트 방어) */
function looseParse(raw: string): unknown {
  const objStart = raw.indexOf('{');
  const arrStart = raw.indexOf('[');
  let start: number;
  let end: number;
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    start = objStart;
    end = raw.lastIndexOf('}');
  } else if (arrStart >= 0) {
    start = arrStart;
    end = raw.lastIndexOf(']');
  } else {
    throw new Error(
      `지식 추출 응답에서 JSON을 찾지 못했습니다: ${raw.slice(0, 80)}`,
    );
  }
  if (end <= start) {
    throw new Error(
      `지식 추출 응답에서 JSON을 찾지 못했습니다: ${raw.slice(0, 80)}`,
    );
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('지식 추출 응답의 JSON 파싱에 실패했습니다');
  }
}

/** LLM 출력을 후보 배열로 파싱. array 또는 {items:[...]} 양쪽 수용 */
export function parseCandidates(raw: string): KnowledgeCandidate[] {
  const parsed = looseParse(raw);
  const array = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed['items'])
      ? parsed['items']
      : null;
  if (array === null) {
    throw new Error('지식 추출 응답이 배열/items 형식이 아닙니다');
  }
  const candidates: KnowledgeCandidate[] = [];
  for (const item of array) {
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

/** 대화 히스토리에서 지식 후보를 추출. 빈 히스토리면 LLM 호출 없이 빈 배열 */
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
  const raw = await client.chat(
    [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
    { format: EXTRACT_SCHEMA },
  );
  return parseCandidates(raw);
}
```

### Anchor

파일 전체 교체.

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 기존 extractor 테스트 — array 입력 여전히 파싱(회귀 없음), Step 6에서 items 케이스 추가
# 3. 의미 검증
grep -c "EXTRACT_SCHEMA\|맞장구" src/knowledge/extractor.ts
  # 기대: 3 이상 (스키마 정의+전달, 프롬프트 노이즈 필터)
```

### 동반 변경 (Side Effects)

extractKnowledge가 format 전달 → OllamaEmbedder 아님(chat). 기존 extractor 테스트가 array를 넘기므로 parseCandidates 하위호환 필수(looseParse가 보장). items 케이스·프롬프트 테스트는 Step 6.

### Do Not Touch

`src/knowledge/novelty.ts`, `src/knowledge/capture-store.ts`.

## Step 4: capture-store 목록 (`src/knowledge/capture-store.ts` — modify, listCaptured 추가)

### Context

캡처 디렉토리를 스캔해 저장된 지식 목록 반환. 카테고리 디렉토리별 .md, 제목은 첫 `# ` 라인.

### Code

파일 끝에 추가:
```ts

export interface CapturedEntry {
  path: string;
  title: string;
  category: string;
}

/** 캡처 디렉토리의 저장 지식 목록 (카테고리/파일 순). 디렉토리 없으면 빈 배열 */
export async function listCaptured(baseDir: string): Promise<CapturedEntry[]> {
  let categories: string[];
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    categories = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  const result: CapturedEntry[] = [];
  for (const category of categories) {
    const dir = join(baseDir, category);
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      const path = join(dir, file);
      const text = await readFile(path, 'utf8');
      const match = text.match(/^#\s+(.+)$/m);
      result.push({
        path,
        title: match?.[1]?.trim() ?? file.replace(/\.md$/, ''),
        category,
      });
    }
  }
  return result;
}
```

### Anchor

파일 끝 (마지막 함수 뒤).

### Code (추가 import)

파일 상단 import 교체 —

교체 전:
```ts
import { access } from 'node:fs/promises';
import { join } from 'node:path';
```
교체 후:
```ts
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
```

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 139 passed (신규 함수 — 테스트는 Step 6)
# 3. 의미 검증
grep -c "export async function listCaptured" src/knowledge/capture-store.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

새 export → App 노출(Step 5) + 테스트(Step 6).

### Do Not Touch

slugify/saveCaptured 본문.

## Step 5: App.listCaptured + CLI/서버 노출 (`src/app/bootstrap.ts`, `src/cli/main.ts`, `src/server/http-server.ts` — modify)

### Context

App에 목록 메서드 추가 → CLI `/captured` 명령, 서버 `GET /api/captured` 라우트.

### Code

(a) `src/app/bootstrap.ts` — import 추가 (extractKnowledge import 라인 뒤):
```ts
import { listCaptured } from '../knowledge/capture-store.js';
```
그리고 App 인터페이스에 (`captureKnowledge(capturedAt: string): Promise<CaptureResult>;` 라인 뒤):
```ts
  /** 저장된 지식 목록 (<docsDir>/captured) */
  listCaptured(): Promise<import('../knowledge/capture-store.js').CapturedEntry[]>;
```
그리고 return 객체에 (`captureKnowledge` 프로퍼티 뒤, `}` 전):
```ts
    listCaptured(): Promise<
      import('../knowledge/capture-store.js').CapturedEntry[]
    > {
      return listCaptured(join(docsDir, 'captured'));
    },
```

(b) `src/cli/main.ts` — `/capture` 블록 뒤에 `/captured` 명령 추가 (`if (line === '/capture') { ... continue; }` 블록 닫힘 뒤, `stdout.write('bot> ');` 전):
```ts
    if (line === '/captured') {
      const entries = await app.listCaptured();
      if (entries.length === 0) {
        stdout.write('(저장된 지식이 없습니다)\n');
      } else {
        stdout.write(`(저장된 지식 ${entries.length}건)\n`);
        for (const e of entries) {
          stdout.write(`  [${e.category}] ${e.title}\n`);
        }
      }
      continue;
    }

```
배너에 명령 추가 — `/capture 지식 저장)` 를 `/capture 지식 저장, /captured 목록)` 로 교체.

(c) `src/server/http-server.ts` — `POST /api/capture` 라우트 뒤에 추가:
```ts
    if (route === 'GET /api/captured') {
      const items = await app.listCaptured();
      sendJson(res, 200, { items });
      return;
    }
```

### Anchor

- (a) bootstrap: `import { extractKnowledge }` 라인 / `captureKnowledge(capturedAt: string): Promise<CaptureResult>;` / return의 captureKnowledge 프로퍼티
- (b) CLI: `/capture` 블록 닫힘 뒤 / 배너 `/capture 지식 저장)` 문자열
- (c) 서버: `if (route === 'POST /api/capture') {` 블록 뒤

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 139 passed
# 3. 의미 검증
grep -c "GET /api/captured" src/server/http-server.ts && grep -c "/captured" src/cli/main.ts
  # 기대: 1 그리고 2 이상
```

### 동반 변경 (Side Effects)

새 라우트 → 서버 테스트(Step 6). CLI는 테스트 면제(얇은 레이어).

### Do Not Touch

기존 라우트/명령 본문.

## Step 6: 테스트 (`src/knowledge/__tests__/extractor.test.ts` 수정 + `src/knowledge/__tests__/capture-store.test.ts` 수정 + `src/server/__tests__/http-server.test.ts` 수정)

### Code

(a) extractor.test.ts — describe 닫기 전에 케이스 추가:

### 검증 대상
- spy: N/A
- branch: {items:[]} 형식 파싱, 프롬프트 노이즈 필터 문구, format 전달
- state: 파싱 결과, 프롬프트 문자열

```ts
  it('object-wrapper {items:[...]} 형식을 파싱한다 (정상)', () => {
    const raw = '{"items":[{"title":"t","category":"fact","content":"c"}]}';
    expect(parseCandidates(raw)).toEqual([
      { title: 't', category: 'fact', content: 'c' },
    ]);
  });

  it('extractKnowledge가 format 스키마를 전달한다 (정상)', async () => {
    let capturedOptions: unknown;
    const client = {
      async chat(_m: ChatMessage[], options?: unknown): Promise<string> {
        capturedOptions = options;
        return '{"items":[]}';
      },
      async *chatStream(): AsyncGenerator<string> {
        yield 'ok';
      },
    };
    await extractKnowledge(client as never, [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'y' },
    ]);
    expect(capturedOptions).toHaveProperty('format');
  });
```
(파일 상단 import에 `extractKnowledge`가 이미 있으면 그대로, 없으면 추가)

(b) capture-store.test.ts — describe 닫기 전에 추가:

### 검증 대상
- spy: N/A (실제 FS)
- branch: 목록 반환, 빈 디렉토리
- state: CapturedEntry 필드

```ts
  it('listCaptured가 카테고리별 저장 지식을 제목과 함께 반환한다 (정상)', async () => {
    await saveCaptured(dir, verdict('첫 지식'), 't');
    const entries = await listCaptured(dir);
    expect(entries).toHaveLength(1);
    expect(entries.at(0)).toMatchObject({ title: '첫 지식', category: 'fact' });
  });

  it('디렉토리가 없으면 빈 배열 (경계값)', async () => {
    expect(await listCaptured(join(dir, 'none'))).toEqual([]);
  });
```
(파일 상단 import에 `listCaptured` 추가)

(c) http-server.test.ts — describe 닫기 전에 추가:

### 검증 대상
- spy: 응답 JSON
- branch: captured 목록 라우트
- state: items 배열

```ts
  it('GET /api/captured가 목록을 반환한다 (정상)', async () => {
    const res = await fetch(`${baseUrl}/api/captured`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(data.items)).toBe(true);
  });
```

### Anchor

각 파일 describe 닫는 `});` 바로 위 (기존 케이스 수정 금지).

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 전체 144 passed (139 + 5)
# 3. 의미 검증
grep -c "items:\[\]\|toHaveProperty..format\|listCaptured" src/knowledge/__tests__/extractor.test.ts src/knowledge/__tests__/capture-store.test.ts
  # 기대: 3 이상
```

### 동반 변경 (Side Effects)

N/A (Step 1~5의 동반 테스트)

### Do Not Touch

기존 케이스 본문.

## 실행 순서

Step 1 → 2 → 3 → 4 → 5 → 6.

## 입출력 예제

| 항목 | 입력 | 출력 |
|------|------|------|
| `parseCandidates` | `{"items":[{...}]}` | 후보 1건 |
| `extractKnowledge` | 히스토리 | chat에 `{format:스키마}` 전달 |
| `listCaptured` | captured/fact/x.md | `[{path,title,category:'fact'}]` |
| `GET /api/captured` | — | `{items:[...]}` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/llm/types.ts — ChatOptions.format?: unknown
// src/knowledge/extractor.ts — parseCandidates(array·{items} 수용), extractKnowledge(format 전달)
// src/knowledge/capture-store.ts — interface CapturedEntry {path;title;category}; listCaptured(baseDir): Promise<CapturedEntry[]>
// src/app/bootstrap.ts — App.listCaptured(): Promise<CapturedEntry[]>
// CLI /captured, HTTP GET /api/captured
```

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify ✓
- [ ] DoD-02: typecheck exit 0
- [ ] DoD-03: `npm test` 144 passed (기존 139 회귀 없음)
- [ ] DoD-04: {items} 파싱·format 전달·목록 테스트 동반
- [ ] DoD-05: CLAUDE.md 갱신 (`/captured`)
- [ ] DoD-06: 완료

## Observability plan

N/A — 캡처 결과·목록이 관찰 노출.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 0 PASS"

# CLAUDE.md 캡처 라인에 추가: `/captured`로 저장 지식 목록 조회
# 수동: 새 사실 대화 → /capture → /captured 목록 확인 (Ollama format으로 형식 안정)
```
