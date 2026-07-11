# Phase 0: 토큰 추정기 + 트리밍 (순수 로직)

@fidelity-check tokens: estimateTokens, trimToBudget, PER_MESSAGE_OVERHEAD

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
   - 위반: `import { x } from './trim'`
   - 수정: `import { x } from './trim.js'`
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지 — Node 내장 API만 사용
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어
5. `noUncheckedIndexedAccess` 활성 — 인덱스 접근 결과는 `undefined` 가드 필수 (배열은 `slice`/`at`/`for..of` 우선)

## 전제 조건

Segment 1이 노출한 인터페이스 중 본 Phase가 사용하는 것 (그대로 복사):

```ts
// src/llm/types.ts
export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage { role: ChatRole; content: string; }
```

## 현재 상태

`src/context/` 디렉토리 없음. `ChatSession`(src/chat/session.ts)은 히스토리를 무제한 누적해 매 턴 전량 전송한다 — 컨텍스트 예산 개념이 없다. 본 Phase는 **순수 함수만** 추가하며 기존 파일을 수정하지 않는다 (통합은 Phase 1).

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| (없음 — 순수 함수) | ✓ | ✓ | 입력/출력만으로 완전 검증 가능 |
| LlmClient (Phase 1 요약기에서 사용 예정) | ✓ (함수 인자) | ✓ (FakeLlmClient) | — |
| 파일 시스템 (Phase 2 store에서 사용 예정) | ✓ (생성자 filePath) | ✗ (실제 FS 사용) | 테스트별 고유 디렉토리(`.test-tmp/<uuid>`)로 격리 |

## Step 1: 토큰 추정기 (`src/context/token-estimate.ts` — create)

### Context

정확한 qwen 토크나이저는 외부 의존성이 필요해 원칙 위반. 문자 기반 보수적 추정을 사용한다: ASCII ≈ 4자/토큰(영어 평균), 그 외 문자(한글·한자·이모지) ≈ 1자/토큰(과대 추정 방향 — 예산 초과보다 조기 압축이 안전). 메시지당 채팅 템플릿 오버헤드 4토큰 가산.

### Code
```ts
import type { ChatMessage } from '../llm/types.js';

/** 채팅 템플릿(role 태그 등)이 메시지당 소비하는 토큰의 근사치 */
export const PER_MESSAGE_OVERHEAD = 4;

/**
 * 문자 기반 보수적 토큰 추정.
 * ASCII ≈ 4자/토큰, 그 외(한글 등) ≈ 1자/토큰 — 과대 추정 방향이라 예산 초과보다 안전.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

export function estimateMessageTokens(message: ChatMessage): number {
  return estimateTokens(message.content) + PER_MESSAGE_OVERHEAD;
}

export function estimateMessagesTokens(
  messages: readonly ChatMessage[],
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
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
grep -c "export const PER_MESSAGE_OVERHEAD" src/context/token-estimate.ts
  # 기대: 1 (테스트가 import할 단일 소스)
```

### 동반 변경 (Side Effects)

새 상수(`PER_MESSAGE_OVERHEAD`)/함수 export → 테스트(Step 3)가 src에서 import (단일 소스). 호출처(ContextManager)는 Phase 1에서 작성.

### Do Not Touch

`src/llm/**`, `src/chat/**`, `src/cli/**`.

## Step 2: 쌍 단위 트리밍 (`src/context/trim.ts` — create)

### Context

예산 초과 시 오래된 메시지부터 제외하되 **(user, assistant) 쌍 단위**로 자른다 — 짝이 깨진 히스토리는 모델이 문맥을 오해한다. 뒤(최신)에서부터 쌍을 채워 예산에 맞추는 방식. 순수 함수 — 입력을 변형하지 않고 복사본을 반환한다.

### Code
```ts
import type { ChatMessage } from '../llm/types.js';
import { estimateMessagesTokens } from './token-estimate.js';

export interface TrimResult {
  /** 예산 안에 들어가는 최근 메시지들 (원본 순서 유지) */
  kept: ChatMessage[];
  /** 예산 초과로 제외된 앞쪽 메시지들 (원본 순서 유지) */
  dropped: ChatMessage[];
}

/**
 * 히스토리를 뒤(최신)에서부터 (user, assistant) 쌍 단위로 채워 budgetTokens에 맞춘다.
 * - 마지막 쌍 하나도 못 담는 예산이면 kept는 빈 배열 (전부 dropped)
 * - 히스토리 길이가 홀수인 비정상 입력이면 앞쪽 잔여 1개는 dropped로 처리
 */
export function trimToBudget(
  history: readonly ChatMessage[],
  budgetTokens: number,
): TrimResult {
  let startIndex = history.length;
  let used = 0;
  while (startIndex >= 2) {
    const pair = history.slice(startIndex - 2, startIndex);
    const pairTokens = estimateMessagesTokens(pair);
    if (used + pairTokens > budgetTokens) {
      break;
    }
    used += pairTokens;
    startIndex -= 2;
  }
  return {
    kept: history.slice(startIndex).map((m) => ({ ...m })),
    dropped: history.slice(0, startIndex).map((m) => ({ ...m })),
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
grep -c "startIndex - 2" src/context/trim.ts
  # 기대: 1 (쌍 단위 이동 로직 존재)
```

### 동반 변경 (Side Effects)

새 추상화 export → 단위 테스트는 Step 4 (같은 Phase), 호출처(ContextManager)는 Phase 1.

### Do Not Touch

`src/context/token-estimate.ts` (Step 1 완료본), `src/llm/**`, `src/chat/**`.

## Step 3: 토큰 추정기 테스트 (`src/context/__tests__/token-estimate.test.ts` — create)

### Code

### 검증 대상

- spy: N/A (순수 함수)
- branch: ASCII 경로, non-ASCII 경로, 혼합, 빈 문자열
- state: 반환 토큰 수가 산식(ceil(ascii/4) + nonAscii [+ 4/메시지])과 일치

```ts
import { describe, expect, it } from 'vitest';
import {
  PER_MESSAGE_OVERHEAD,
  estimateMessagesTokens,
  estimateTokens,
} from '../token-estimate.js';

describe('estimateTokens', () => {
  it('ASCII 문자열은 4자당 1토큰으로 올림 추정한다 (정상)', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11자 → ceil(11/4)
  });

  it('한글은 1자당 1토큰으로 추정한다 (정상)', () => {
    expect(estimateTokens('안녕하세요')).toBe(5);
  });

  it('혼합 문자열은 두 산식의 합이다 (정상)', () => {
    expect(estimateTokens('hi 안녕')).toBe(3); // ascii 'hi '=3자→1 + 한글 2
  });

  it('빈 문자열은 0토큰이다 (경계값)', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('estimateMessagesTokens', () => {
  it('메시지마다 오버헤드를 가산하고, 빈 배열은 0이다 (경계값)', () => {
    expect(estimateMessagesTokens([])).toBe(0);
    expect(
      estimateMessagesTokens([
        { role: 'user', content: '' },
        { role: 'assistant', content: '안녕' },
      ]),
    ).toBe(PER_MESSAGE_OVERHEAD * 2 + 2);
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
  # 기대: token-estimate.test.ts 5 passed (전체 24)
# 3. 의미 검증
grep -c "PER_MESSAGE_OVERHEAD" src/context/__tests__/token-estimate.test.ts
  # 기대: 2 (src 상수를 import해 사용 — 단일 소스)
```

### 동반 변경 (Side Effects)

N/A (Step 1의 동반 테스트가 본 Step)

### Do Not Touch

`src/context/token-estimate.ts`.

## Step 4: 트리밍 테스트 (`src/context/__tests__/trim.test.ts` — create)

### Code

### 검증 대상

- spy: N/A (순수 함수)
- branch: 예산 충분(전부 kept), 초과(오래된 쌍 dropped), 예산 0(전부 dropped), 빈 히스토리, 쌍 중간에서 예산 소진 시 그 쌍 전체 제외
- state: kept/dropped 분할이 쌍 경계를 지키고 원본 순서를 유지

```ts
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../llm/types.js';
import { estimateMessagesTokens } from '../token-estimate.js';
import { trimToBudget } from '../trim.js';

function pair(n: number): ChatMessage[] {
  return [
    { role: 'user', content: `질문${n}` },
    { role: 'assistant', content: `답변${n}` },
  ];
}

describe('trimToBudget', () => {
  it('예산이 충분하면 전부 kept, dropped는 빈 배열 (정상)', () => {
    const history = [...pair(1), ...pair(2)];
    const result = trimToBudget(history, estimateMessagesTokens(history));
    expect(result.kept).toEqual(history);
    expect(result.dropped).toEqual([]);
  });

  it('예산 초과 시 오래된 쌍부터 제외하고 최신 쌍을 유지한다 (정상)', () => {
    const history = [...pair(1), ...pair(2), ...pair(3)];
    const lastTwoPairs = [...pair(2), ...pair(3)];
    const result = trimToBudget(history, estimateMessagesTokens(lastTwoPairs));
    expect(result.kept).toEqual(lastTwoPairs);
    expect(result.dropped).toEqual(pair(1));
  });

  it('쌍 중간까지만 담을 수 있는 예산이면 그 쌍 전체를 제외한다 (경계값)', () => {
    const history = [...pair(1), ...pair(2)];
    const budget = estimateMessagesTokens(pair(2)) +
      estimateMessagesTokens(pair(1)) - 1; // pair(1)을 온전히 못 담는 예산
    const result = trimToBudget(history, budget);
    expect(result.kept).toEqual(pair(2));
    expect(result.dropped).toEqual(pair(1));
  });

  it('예산 0이면 전부 dropped, kept는 빈 배열 (경계값)', () => {
    const history = [...pair(1)];
    const result = trimToBudget(history, 0);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual(history);
  });

  it('빈 히스토리는 양쪽 다 빈 배열 (경계값)', () => {
    const result = trimToBudget([], 100);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('반환 배열은 원본과 다른 객체다 — 입력 불변 (경계값)', () => {
    const history = [...pair(1)];
    const result = trimToBudget(history, 1000);
    expect(result.kept.at(0)).not.toBe(history.at(0));
    expect(result.kept.at(0)).toEqual(history.at(0));
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
  # 기대: 전체 30 passed (기존 19 + 본 Phase 11)
# 3. 의미 검증
grep -c "estimateMessagesTokens" src/context/__tests__/trim.test.ts
  # 기대: 4 (예산을 src 추정기로 산출 — 하드코딩 수치 없음)
```

### 동반 변경 (Side Effects)

N/A (Step 2의 동반 테스트가 본 Step)

### Do Not Touch

`src/context/trim.ts`.

## 실행 순서

Step 1 → 2 → 3 → 4 (trim이 token-estimate에 의존).

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `estimateTokens` | `'hello world'` (ASCII 11자) | `3` |
| `estimateTokens` | `'안녕하세요'` (한글 5자) | `5` |
| `trimToBudget` | 3쌍 히스토리, 최근 2쌍 크기의 예산 | kept=최근 2쌍, dropped=첫 쌍 |
| `trimToBudget` | 1쌍 히스토리, 예산 0 | kept=[], dropped=그 쌍 |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/context/token-estimate.ts
export const PER_MESSAGE_OVERHEAD = 4;
export function estimateTokens(text: string): number;
export function estimateMessageTokens(message: ChatMessage): number;
export function estimateMessagesTokens(messages: readonly ChatMessage[]): number;

// src/context/trim.ts
export interface TrimResult { kept: ChatMessage[]; dropped: ChatMessage[]; }
export function trimToBudget(history: readonly ChatMessage[], budgetTokens: number): TrimResult;
```

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify ✓
- [ ] DoD-02: `npm run typecheck` exit 0
- [ ] DoD-03: `npm test` 30 passed (기존 19 회귀 없음)
- [ ] DoD-04: 새 함수에 단위 테스트 동반 (정상/에러/경계 충족)
- [ ] DoD-05: 문서 갱신 불필요 (내부 모듈 추가)
- [ ] DoD-06: Phase 1 전제 조건 만족 (노출 인터페이스 일치)

## Observability plan

N/A — 운영 영향 없음 (순수 함수 모듈).

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 0 PASS"
```
