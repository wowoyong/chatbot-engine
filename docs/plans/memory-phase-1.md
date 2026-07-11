# Phase 1: 요약 압축 + ChatSession 통합

@fidelity-check tokens: ContextManager, summarizeMessages, prepare, SUMMARY_ALLOWANCE, reset

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어
5. `noUncheckedIndexedAccess` 활성 — 테스트에서 배열 인덱스는 `.at(n)` 또는 옵셔널 체인 사용

## 전제 조건

Phase 0이 노출한 인터페이스 (그대로 복사):

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

Segment 1 인터페이스 중 사용하는 것:

```ts
// src/llm/types.ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatOptions { think?: boolean; timeoutMs?: number; }
export interface LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}
```

## 현재 상태

`src/chat/session.ts`의 `send()`는 `[system?, ...전체 history, user]`를 무조건 전송한다 (26행 `messages.push(...this.history)`). 생성자 호출처는 `src/cli/main.ts` 1곳 + 테스트 5곳 — 본 Phase는 `ChatSessionConfig`에 **선택 필드만 추가**하므로 기존 호출처는 수정 없이 컴파일된다 (기본 예산 4096은 기존 테스트의 짧은 대화에 영향 없음 — 기존 19 테스트 회귀 없음이 검증 조건).

## Step 1: 요약기 (`src/context/summarizer.ts` — create)

### Context

제외된 대화를 같은 LLM으로 한 문단 요약. 실패 시 예외를 그대로 전파 — fallback 판단은 호출측(ContextManager) 책임으로 단일화.

### Code
```ts
import type { ChatMessage, LlmClient } from '../llm/types.js';

const SUMMARY_SYSTEM_PROMPT =
  '다음 대화를 이후 대화의 문맥으로 쓸 수 있게 한국어 한 문단으로 요약하라. ' +
  '사용자가 알려준 사실·선호·결정 사항을 우선 보존하라.';

/**
 * 제외된 대화를 한 문단으로 요약한다.
 * LLM 호출 실패 시 예외를 그대로 전파 — 호출측에서 fallback 처리.
 */
export async function summarizeMessages(
  client: LlmClient,
  messages: readonly ChatMessage[],
): Promise<string> {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? '사용자' : '어시스턴트'}: ${m.content}`)
    .join('\n');
  return client.chat([
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: transcript },
  ]);
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
echo "N/A: 요약 경로 테스트는 Step 3(ContextManager 테스트)에서 동반"
# 3. 의미 검증
grep -c "client.chat(" src/context/summarizer.ts
  # 기대: 1 (LlmClient 인터페이스 경유 — OllamaClient 직접 참조 없음)
```

### 동반 변경 (Side Effects)

새 export → 호출처(Step 2)와 실패 경로 포함 테스트(Step 3)를 같은 Phase에서 작성.

### Do Not Touch

`src/llm/**`, `src/context/token-estimate.ts`, `src/context/trim.ts`.

## Step 2: ContextManager (`src/context/context-manager.ts` — create)

### Context

트리밍 + 요약 + 캐시를 묶는 조율자. 예산 산식: `historyBudget = maxContextTokens − reserveTokens − (system+user 추정) − SUMMARY_ALLOWANCE(요약 메시지 자리)`. 요약은 dropped 개수 기준으로 캐시해 같은 범위 재요약을 방지. 요약 실패 시 이전 캐시를 재사용하거나(있으면) 트리밍만으로 진행 — 대화는 절대 중단되지 않는다.

### Code
```ts
import type { ChatMessage, LlmClient } from '../llm/types.js';
import { estimateMessagesTokens } from './token-estimate.js';
import { summarizeMessages } from './summarizer.js';
import { trimToBudget } from './trim.js';

export interface ContextManagerConfig {
  /** 모델 컨텍스트 창 크기(토큰). 기본 4096 (Ollama 기본 num_ctx) */
  maxContextTokens?: number;
  /** 응답 생성용 여유분(토큰). 기본 1024 */
  reserveTokens?: number;
}

export interface PreparedContext {
  messages: ChatMessage[];
  /** 이번 준비에 요약 메시지가 포함됐는지 */
  summarized: boolean;
}

const DEFAULT_MAX_CONTEXT = 4096;
const DEFAULT_RESERVE = 1024;
/** 요약 메시지가 차지할 것으로 예약하는 토큰 */
export const SUMMARY_ALLOWANCE = 256;

export class ContextManager {
  private readonly client: LlmClient;
  private readonly maxContextTokens: number;
  private readonly reserveTokens: number;
  private summary: string | null = null;
  private summaryCoveredCount = 0;

  constructor(client: LlmClient, config: ContextManagerConfig = {}) {
    this.client = client;
    this.maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT;
    this.reserveTokens = config.reserveTokens ?? DEFAULT_RESERVE;
  }

  /** 요약 캐시 초기화 (세션 clear/restore 시 호출) */
  reset(): void {
    this.summary = null;
    this.summaryCoveredCount = 0;
  }

  /**
   * [system?, 요약?, 최근 히스토리, 새 질문] 형태로 예산에 맞는 메시지 배열을 만든다.
   * 요약 실패 시: 이전 캐시가 dropped 범위 일부라도 덮으면 재사용, 없으면 트리밍만.
   */
  async prepare(
    systemPrompt: string | null,
    history: readonly ChatMessage[],
    userInput: string,
  ): Promise<PreparedContext> {
    const fixed: ChatMessage[] = [];
    if (systemPrompt !== null) {
      fixed.push({ role: 'system', content: systemPrompt });
    }
    const userMessage: ChatMessage = { role: 'user', content: userInput };

    const overhead = estimateMessagesTokens([...fixed, userMessage]);
    const historyBudget = Math.max(
      this.maxContextTokens - this.reserveTokens - overhead - SUMMARY_ALLOWANCE,
      0,
    );

    const { kept, dropped } = trimToBudget(history, historyBudget);

    if (dropped.length > 0) {
      if (this.summary === null || this.summaryCoveredCount !== dropped.length) {
        try {
          this.summary = await summarizeMessages(this.client, dropped);
          this.summaryCoveredCount = dropped.length;
        } catch {
          // 요약 실패 — 이전 캐시(있으면) 재사용, 없으면 트리밍만으로 진행
        }
      }
    }

    const messages: ChatMessage[] = [...fixed];
    const useSummary = dropped.length > 0 && this.summary !== null;
    if (useSummary && this.summary !== null) {
      messages.push({ role: 'system', content: `이전 대화 요약: ${this.summary}` });
    }
    messages.push(...kept);
    messages.push(userMessage);
    return { messages, summarized: useSummary };
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
grep -c "export const SUMMARY_ALLOWANCE" src/context/context-manager.ts
  # 기대: 1 (테스트가 import할 단일 소스)
```

### 동반 변경 (Side Effects)

- 새 상수 `SUMMARY_ALLOWANCE` export → 테스트(Step 3)가 src에서 import (단일 소스)
- 새 추상화 → 호출처(Step 4 ChatSession) + 테스트(Step 3, 5)를 같은 Phase에서 작성
- 외부 호출(LLM 요약)의 실패 설계: try/catch로 흡수, 재시도 없음(다음 턴에 자연 재시도됨), 이전 캐시 재사용 — 본 Step Code에 명시

### Do Not Touch

`src/llm/**`, `src/context/token-estimate.ts`, `src/context/trim.ts`, `src/context/summarizer.ts`.

## Step 3: ContextManager 테스트 (`src/context/__tests__/context-manager.test.ts` — create)

### Code

### 검증 대상

- spy: `FakeLlmClient.chatCalls` — 요약 LLM 호출 횟수(캐시 동작), 요약 입력에 dropped 대화 포함 여부
- branch: 예산 내(요약 없음), 초과(요약 포함), 캐시 재사용, 요약 실패 fallback, 예산 0
- state: `prepare()` 반환 messages의 구성([system?, 요약?, kept, user])과 `summarized` 플래그

```ts
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, LlmClient } from '../../llm/types.js';
import { ContextManager, SUMMARY_ALLOWANCE } from '../context-manager.js';
import { estimateMessagesTokens } from '../token-estimate.js';

class FakeLlmClient implements LlmClient {
  readonly chatCalls: ChatMessage[][] = [];
  summaryText = '요약문';
  failChat = false;

  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    this.chatCalls.push(messages);
    if (this.failChat) {
      throw new Error('summary failed');
    }
    return this.summaryText;
  }

  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string> {
    yield 'ok';
  }
}

function pair(n: number): ChatMessage[] {
  return [
    { role: 'user', content: `질문${n}` },
    { role: 'assistant', content: `답변${n}` },
  ];
}

const USER: ChatMessage = { role: 'user', content: '새 질문' };

/** pair(2)만 kept되고 pair(1)은 dropped되는 정확한 예산 구성 */
function budgetForLastPairOnly(): number {
  return (
    SUMMARY_ALLOWANCE +
    estimateMessagesTokens([USER]) +
    estimateMessagesTokens(pair(2))
  );
}

describe('ContextManager', () => {
  it('예산 내면 히스토리 전체를 그대로 보내고 요약하지 않는다 (정상)', async () => {
    const fake = new FakeLlmClient();
    const manager = new ContextManager(fake);
    const history = [...pair(1)];

    const result = await manager.prepare(null, history, USER.content);

    expect(result.summarized).toBe(false);
    expect(result.messages).toEqual([...pair(1), USER]);
    expect(fake.chatCalls).toHaveLength(0);
  });

  it('예산 초과 시 dropped를 요약해 system 메시지로 삽입한다 (정상)', async () => {
    const fake = new FakeLlmClient();
    const manager = new ContextManager(fake, {
      maxContextTokens: budgetForLastPairOnly(),
      reserveTokens: 0,
    });
    const history = [...pair(1), ...pair(2)];

    const result = await manager.prepare(null, history, USER.content);

    expect(result.summarized).toBe(true);
    expect(result.messages).toEqual([
      { role: 'system', content: '이전 대화 요약: 요약문' },
      ...pair(2),
      USER,
    ]);
    expect(fake.chatCalls).toHaveLength(1);
    expect(fake.chatCalls.at(0)?.at(1)?.content).toContain('질문1');
  });

  it('dropped 범위가 같으면 요약을 재호출하지 않는다 — 캐시 (정상)', async () => {
    const fake = new FakeLlmClient();
    const manager = new ContextManager(fake, {
      maxContextTokens: budgetForLastPairOnly(),
      reserveTokens: 0,
    });
    const history = [...pair(1), ...pair(2)];

    await manager.prepare(null, history, USER.content);
    await manager.prepare(null, history, USER.content);

    expect(fake.chatCalls).toHaveLength(1);
  });

  it('요약 실패 시 요약 없이 트리밍만으로 진행하고 예외를 내지 않는다 (에러)', async () => {
    const fake = new FakeLlmClient();
    fake.failChat = true;
    const manager = new ContextManager(fake, {
      maxContextTokens: budgetForLastPairOnly(),
      reserveTokens: 0,
    });
    const history = [...pair(1), ...pair(2)];

    const result = await manager.prepare(null, history, USER.content);

    expect(result.summarized).toBe(false);
    expect(result.messages).toEqual([...pair(2), USER]);
  });

  it('예산 0이면 히스토리 전체가 요약으로 대체된다 (경계값)', async () => {
    const fake = new FakeLlmClient();
    const manager = new ContextManager(fake, {
      maxContextTokens: 0,
      reserveTokens: 0,
    });
    const history = [...pair(1)];

    const result = await manager.prepare('SYS', history, USER.content);

    expect(result.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'system', content: '이전 대화 요약: 요약문' },
      USER,
    ]);
  });

  it('reset() 후에는 같은 범위라도 다시 요약한다 (경계값)', async () => {
    const fake = new FakeLlmClient();
    const manager = new ContextManager(fake, {
      maxContextTokens: budgetForLastPairOnly(),
      reserveTokens: 0,
    });
    const history = [...pair(1), ...pair(2)];

    await manager.prepare(null, history, USER.content);
    manager.reset();
    await manager.prepare(null, history, USER.content);

    expect(fake.chatCalls).toHaveLength(2);
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
  # 기대: 전체 36 passed (30 + 본 Step 6)
# 3. 의미 검증
grep -c "SUMMARY_ALLOWANCE" src/context/__tests__/context-manager.test.ts
  # 기대: 2 (src 상수 import — 예산을 산식으로 구성, 하드코딩 없음)
```

### 동반 변경 (Side Effects)

N/A (Step 1~2의 동반 테스트가 본 Step)

### Do Not Touch

`src/context/context-manager.ts`, `src/context/summarizer.ts`.

## Step 4: ChatSession 통합 (`src/chat/session.ts` — modify, 전체 교체)

### Context

`send()`의 메시지 조립을 ContextManager.prepare()로 위임. `ChatSessionConfig.context`는 **선택 필드** — 기존 호출처 6곳(main.ts 1 + 테스트 5)은 무수정 컴파일. `clear()`가 요약 캐시도 리셋.

### Code
```ts
import { ContextManager } from '../context/context-manager.js';
import type { ContextManagerConfig } from '../context/context-manager.js';
import type { ChatMessage, ChatOptions, LlmClient } from '../llm/types.js';

export interface ChatSessionConfig {
  systemPrompt?: string;
  /** 컨텍스트 예산 설정 (기본: maxContextTokens 4096, reserveTokens 1024) */
  context?: ContextManagerConfig;
}

export class ChatSession {
  private readonly client: LlmClient;
  private readonly systemPrompt: string | null;
  private readonly contextManager: ContextManager;
  private history: ChatMessage[] = [];

  constructor(client: LlmClient, config: ChatSessionConfig = {}) {
    this.client = client;
    this.systemPrompt = config.systemPrompt ?? null;
    this.contextManager = new ContextManager(client, config.context ?? {});
  }

  /**
   * 사용자 입력을 보내고 assistant 응답 조각을 스트리밍으로 yield.
   * 히스토리가 컨텍스트 예산을 넘으면 오래된 대화를 요약으로 압축해 보낸다.
   * 스트림이 끝까지 성공한 경우에만 히스토리에 (user, assistant) 쌍을 기록한다.
   */
  async *send(userInput: string, options?: ChatOptions): AsyncGenerator<string> {
    const prepared = await this.contextManager.prepare(
      this.systemPrompt,
      this.history,
      userInput,
    );

    let assistantContent = '';
    for await (const piece of this.client.chatStream(prepared.messages, options)) {
      assistantContent += piece;
      yield piece;
    }

    this.history.push({ role: 'user', content: userInput });
    this.history.push({ role: 'assistant', content: assistantContent });
  }

  getHistory(): readonly ChatMessage[] {
    return this.history;
  }

  clear(): void {
    this.history = [];
    this.contextManager.reset();
  }
}
```

### Anchor

파일 전체를 위 Code로 교체 (기존 45행 전문 대체).

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 전체 36 passed — 기존 session 테스트 5개 회귀 없음
# 3. 의미 검증
grep -c "contextManager.prepare" src/chat/session.ts
  # 기대: 1 (메시지 조립이 ContextManager로 위임됨)
```

### 동반 변경 (Side Effects)

- 시그니처 변경 아님(선택 필드 추가) — 호출처 6곳 무수정, 기존 테스트 통과가 이를 검증
- send의 동작 변경(요약 경로) → 통합 테스트는 Step 5에서 동반

### Do Not Touch

`src/cli/main.ts` (Phase 2에서 교체), `src/llm/**`, 기존 테스트 파일의 기존 케이스.

## Step 5: 세션 요약 경로 테스트 (`src/chat/__tests__/session.test.ts` — modify, 케이스 추가)

### Context

기존 파일 끝(마지막 `});` 닫힘 직전, 마지막 it 블록 뒤)에 2개 케이스 추가. 기존 FakeLlmClient에 `chat()` 스텁이 이미 있으나 요약문 제어가 필요하므로 케이스 내부에서 전용 fake를 정의한다.

### Code

### 검증 대상

- spy: 전용 fake의 `streamCalls` — send가 client에 전달한 messages에 요약 메시지 포함 여부
- branch: 예산 극소(전체 요약 대체) 경로, clear 후 요약 없는 경로
- state: 전송 메시지 첫 요소가 `이전 대화 요약: ...`, clear 후에는 미포함

```ts
  it('컨텍스트 예산 초과 시 이전 대화가 요약 메시지로 압축되어 전송된다 (정상)', async () => {
    const streamCalls: ChatMessage[][] = [];
    const tinyClient: LlmClient = {
      async chat() {
        return '파란색 선호';
      },
      async *chatStream(messages: ChatMessage[]) {
        streamCalls.push(messages);
        yield 'ok';
      },
    };
    const session = new ChatSession(tinyClient, {
      context: { maxContextTokens: 0, reserveTokens: 0 },
    });

    await collect(session.send('첫 질문'));
    await collect(session.send('둘째 질문'));

    expect(streamCalls.at(1)).toEqual([
      { role: 'system', content: '이전 대화 요약: 파란색 선호' },
      { role: 'user', content: '둘째 질문' },
    ]);
  });

  it('clear() 후에는 요약 메시지 없이 전송된다 (경계값)', async () => {
    const streamCalls: ChatMessage[][] = [];
    const tinyClient: LlmClient = {
      async chat() {
        return '요약';
      },
      async *chatStream(messages: ChatMessage[]) {
        streamCalls.push(messages);
        yield 'ok';
      },
    };
    const session = new ChatSession(tinyClient, {
      context: { maxContextTokens: 0, reserveTokens: 0 },
    });

    await collect(session.send('첫 질문'));
    session.clear();
    await collect(session.send('새 질문'));

    expect(streamCalls.at(1)).toEqual([{ role: 'user', content: '새 질문' }]);
  });
```

### Anchor

`src/chat/__tests__/session.test.ts`에서 `describe('ChatSession', () => {` 블록의 마지막 it 블록(`it('clear()는 히스토리를 비우고...`)이 닫힌 뒤, describe를 닫는 `});` 바로 위에 삽입. (앵커 유일성: 파일 끝에서 역방향으로 첫 `});` 두 개 — 마지막 it의 닫힘과 describe의 닫힘 — 사이)

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 전체 38 passed (36 + 2)
# 3. 의미 검증
grep -c "이전 대화 요약" src/chat/__tests__/session.test.ts
  # 기대: 2 (요약 경로 assertion 존재)
```

### 동반 변경 (Side Effects)

N/A (Step 4의 동반 테스트가 본 Step)

### Do Not Touch

기존 5개 it 케이스와 FakeLlmClient 클래스 본문 (수정 금지 — 추가만).

## 실행 순서

Step 1 → 2 → 3 → 4 → 5 (요약기 → 조율자 → 조율자 테스트 → 통합 → 통합 테스트).

## 입출력 예제

| 시나리오 | prepare() 입력 | 출력 messages |
|---------|---------------|--------------|
| 예산 내 | system=null, 1쌍, 예산 기본 | `[...히스토리 1쌍, user]`, summarized=false |
| 예산 초과 | system=null, 2쌍, 최근 1쌍 예산 | `[요약 system, 최근 쌍, user]`, summarized=true |
| 요약 실패 | 위와 동일 + chat 실패 | `[최근 쌍, user]`, summarized=false |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/context/summarizer.ts
export function summarizeMessages(client: LlmClient, messages: readonly ChatMessage[]): Promise<string>;

// src/context/context-manager.ts
export const SUMMARY_ALLOWANCE = 256;
export interface ContextManagerConfig { maxContextTokens?: number; reserveTokens?: number; }
export interface PreparedContext { messages: ChatMessage[]; summarized: boolean; }
export class ContextManager {
  constructor(client: LlmClient, config?: ContextManagerConfig);
  reset(): void;
  prepare(systemPrompt: string | null, history: readonly ChatMessage[], userInput: string): Promise<PreparedContext>;
}

// src/chat/session.ts — 변경분
export interface ChatSessionConfig {
  systemPrompt?: string;
  context?: ContextManagerConfig; // 추가된 선택 필드
}
// ChatSession의 public 메서드 시그니처는 변경 없음 (send/getHistory/clear)
```

## Definition of Done

- [ ] DoD-11: 모든 Step 통과 + Verify ✓
- [ ] DoD-12: `npm run typecheck` exit 0
- [ ] DoD-13: `npm test` 38 passed — 기존 30(그중 session 5) 회귀 없음
- [ ] DoD-14: 새 함수/클래스에 단위 테스트 동반 (요약 실패 경로 포함)
- [ ] DoD-15: 문서 갱신 불필요
- [ ] DoD-16: Phase 2 전제 조건 만족

## Observability plan

N/A — 운영 영향 없음. 요약 발생 여부는 `PreparedContext.summarized`로 노출되어 있어 CLI 안내가 필요해지면 후속 Segment에서 소비 가능.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 1 PASS"
```
