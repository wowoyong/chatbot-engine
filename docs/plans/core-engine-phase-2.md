# Phase 2: ChatSession + CLI REPL

@fidelity-check tokens: chatStream, getHistory, clear, SIGINT, LlmConnectionError

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
   - 위반: `import { x } from '../llm/types'`
   - 수정: `import { x } from '../llm/types.js'`
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
   - 위반: `catch (err: any)`
   - 수정: `catch (err)` 후 `err instanceof Error` 가드
3. 런타임 의존성 추가 금지 — readline은 `node:readline/promises` 내장 모듈 사용
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어
5. `noUncheckedIndexedAccess` 활성 — 인덱스 접근 결과는 `undefined` 가드 필수

## 전제 조건

Phase 1이 노출한 인터페이스 (그대로 복사):

```ts
// src/llm/types.ts
export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage { role: ChatRole; content: string; }
export interface ChatOptions { think?: boolean; timeoutMs?: number; }
export interface LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}

// src/llm/errors.ts
export class LlmConnectionError extends Error {
  constructor(baseUrl: string, cause?: unknown);
}
export class LlmResponseError extends Error {
  readonly status: number;
  constructor(status: number, detail: string);
}

// src/llm/ollama-client.ts
export interface OllamaClientConfig { baseUrl?: string; model?: string; fetchFn?: FetchLike; }
export class OllamaClient implements LlmClient {
  constructor(config?: OllamaClientConfig);
}
```

## 현재 상태

`src/llm/` 완성 (Phase 1). `src/chat/`, `src/cli/` 디렉토리 없음. ChatSession은 `LlmClient` 인터페이스에만 의존한다 — `OllamaClient` 직접 참조 금지 (구현 교체 가능성이 이 프로젝트의 핵심 경계선).

## Step 1: 대화 세션 (`src/chat/session.ts` — create)

### Context

멀티턴 히스토리 관리의 단일 지점. 설계 결정: **스트림이 정상 완료된 경우에만 히스토리에 기록**한다 — 중간 실패 시 반쪽 응답이 히스토리를 오염시켜 이후 턴의 컨텍스트를 왜곡하는 것을 방지 (사용자는 같은 입력을 재시도하면 됨). 컨텍스트 길이 제한(트리밍)은 Segment 2 범위 — 여기서는 무제한 누적.

### Code
```ts
import type { ChatMessage, ChatOptions, LlmClient } from '../llm/types.js';

export interface ChatSessionConfig {
  systemPrompt?: string;
}

export class ChatSession {
  private readonly client: LlmClient;
  private readonly systemPrompt: string | null;
  private history: ChatMessage[] = [];

  constructor(client: LlmClient, config: ChatSessionConfig = {}) {
    this.client = client;
    this.systemPrompt = config.systemPrompt ?? null;
  }

  /**
   * 사용자 입력을 보내고 assistant 응답 조각을 스트리밍으로 yield.
   * 스트림이 끝까지 성공한 경우에만 히스토리에 (user, assistant) 쌍을 기록한다.
   */
  async *send(userInput: string, options?: ChatOptions): AsyncGenerator<string> {
    const messages: ChatMessage[] = [];
    if (this.systemPrompt !== null) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }
    messages.push(...this.history);
    messages.push({ role: 'user', content: userInput });

    let assistantContent = '';
    for await (const piece of this.client.chatStream(messages, options)) {
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
echo "N/A: 테스트는 Step 2에서 동반 작성 후 npm test로 검증"
# 3. 의미 검증
grep -c "OllamaClient" src/chat/session.ts
  # 기대: 0 (LlmClient 인터페이스에만 의존 — 경계선 준수)
```

### 동반 변경 (Side Effects)

새 추상화/export → 호출처(Step 3 CLI)와 단위 테스트(Step 2)를 같은 Phase에서 작성.

### Do Not Touch

`src/llm/**` 전체 (Phase 1 완료본).

## Step 2: 세션 테스트 (`src/chat/__tests__/session.test.ts` — create)

### Code

### 검증 대상

- spy: `FakeLlmClient.calls` — 각 send가 client에 전달한 messages 배열 (system 위치, 히스토리 포함 여부)
- branch: 스트림 중간 실패 시 히스토리 미기록, systemPrompt 유/무, clear()
- state: `getHistory()` 내용이 (user, assistant) 쌍으로 정확히 누적

```ts
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, LlmClient } from '../../llm/types.js';
import { ChatSession } from '../session.js';

class FakeLlmClient implements LlmClient {
  readonly calls: ChatMessage[][] = [];
  pieces: string[] = [];
  failAfter: number | null = null;

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    let result = '';
    for await (const piece of this.chatStream(messages, options)) {
      result += piece;
    }
    return result;
  }

  async *chatStream(
    messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string> {
    this.calls.push(messages);
    let index = 0;
    for (const piece of this.pieces) {
      if (this.failAfter !== null && index >= this.failAfter) {
        throw new Error('stream broken');
      }
      index += 1;
      yield piece;
    }
  }
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of iter) {
    out.push(piece);
  }
  return out;
}

describe('ChatSession', () => {
  it('응답 완료 후 (user, assistant) 쌍을 히스토리에 기록하고, 다음 턴에 히스토리를 포함해 보낸다 (정상)', async () => {
    const fake = new FakeLlmClient();
    fake.pieces = ['안녕', '하세요'];
    const session = new ChatSession(fake, { systemPrompt: 'SYS' });

    const pieces = await collect(session.send('인사해'));

    expect(pieces).toEqual(['안녕', '하세요']);
    expect(session.getHistory()).toEqual([
      { role: 'user', content: '인사해' },
      { role: 'assistant', content: '안녕하세요' },
    ]);

    fake.pieces = ['네'];
    await collect(session.send('한 번 더'));

    const secondCall = fake.calls[1];
    expect(secondCall).toBeDefined();
    expect(secondCall).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '인사해' },
      { role: 'assistant', content: '안녕하세요' },
      { role: 'user', content: '한 번 더' },
    ]);
  });

  it('systemPrompt가 있으면 매 요청의 첫 메시지로 포함된다 (정상)', async () => {
    const fake = new FakeLlmClient();
    fake.pieces = ['ok'];
    const session = new ChatSession(fake, { systemPrompt: 'SYS' });

    await collect(session.send('hi'));

    expect(fake.calls[0]?.[0]).toEqual({ role: 'system', content: 'SYS' });
  });

  it('systemPrompt가 없으면 system 메시지를 보내지 않는다 (경계값)', async () => {
    const fake = new FakeLlmClient();
    fake.pieces = ['ok'];
    const session = new ChatSession(fake);

    await collect(session.send('hi'));

    expect(fake.calls[0]?.[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('스트림이 중간에 실패하면 히스토리를 기록하지 않는다 (에러)', async () => {
    const fake = new FakeLlmClient();
    fake.pieces = ['조각1', '조각2'];
    fake.failAfter = 1;
    const session = new ChatSession(fake, { systemPrompt: 'SYS' });

    const received: string[] = [];
    let caught: unknown = null;
    try {
      for await (const piece of session.send('질문')) {
        received.push(piece);
      }
    } catch (err) {
      caught = err;
    }

    expect(received).toEqual(['조각1']);
    expect(caught).toBeInstanceOf(Error);
    expect(session.getHistory()).toEqual([]);
  });

  it('clear()는 히스토리를 비우고 다음 요청은 히스토리 없이 보낸다 (경계값)', async () => {
    const fake = new FakeLlmClient();
    fake.pieces = ['ok'];
    const session = new ChatSession(fake);

    await collect(session.send('첫 질문'));
    expect(session.getHistory()).toHaveLength(2);

    session.clear();
    expect(session.getHistory()).toEqual([]);

    fake.pieces = ['ok2'];
    await collect(session.send('새 질문'));
    expect(fake.calls[1]).toEqual([{ role: 'user', content: '새 질문' }]);
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
  # 기대: 3개 테스트 파일, 19 passed
# 3. 의미 검증
grep -c "getHistory()).toEqual(\[\])" src/chat/__tests__/session.test.ts
  # 기대: 2 (실패 시 미기록 + clear 검증)
```

### 동반 변경 (Side Effects)

N/A (Step 1의 동반 테스트가 본 Step)

### Do Not Touch

`src/chat/session.ts` (테스트 실패 시 계획의 Code 재확인).

## Step 3: CLI REPL (`src/cli/main.ts` — create)

### Context

얇은 I/O 레이어 — 모든 로직은 ChatSession/OllamaClient에 있다. 명령: `/exit` 종료, `/clear` 히스토리 초기화. Ctrl-C(SIGINT)는 정상 종료, Ctrl-D(입력 스트림 종료)는 question reject로 감지해 종료. `LlmConnectionError`는 안내 후 exit 1 (AC3).

**테스트 면제 (사유 명시)**: 본 파일은 stdin/stdout 바인딩만 담당하는 얇은 I/O 레이어로, 분기 로직(히스토리/스트리밍/에러 분류)은 Step 1~2와 Phase 1 테스트가 커버한다. readline 모킹 비용이 변경 위험 대비 명백히 크므로 단위 테스트 대신 아래 최종 검증의 수동 AC 시나리오로 갈음한다 (전역 지침 Test-Driven Quality 예외 조항 적용).

### Code
```ts
import * as readline from 'node:readline/promises';
import { env, exit, stdin, stdout } from 'node:process';
import { ChatSession } from '../chat/session.js';
import { LlmConnectionError } from '../llm/errors.js';
import { OllamaClient } from '../llm/ollama-client.js';

const SYSTEM_PROMPT =
  '당신은 간결하고 정확하게 답하는 한국어 어시스턴트입니다.';

async function main(): Promise<void> {
  const client = new OllamaClient({
    baseUrl: env['OLLAMA_BASE_URL'],
    model: env['OLLAMA_MODEL'],
  });
  const session = new ChatSession(client, { systemPrompt: SYSTEM_PROMPT });
  const rl = readline.createInterface({ input: stdin, output: stdout });

  rl.on('SIGINT', () => {
    rl.close();
    stdout.write('\n');
    exit(0);
  });

  stdout.write(
    `chatbot-engine — ${env['OLLAMA_MODEL'] ?? 'qwen3:8b'} (명령: /exit 종료, /clear 히스토리 초기화)\n`,
  );

  while (true) {
    let line: string;
    try {
      line = (await rl.question('you> ')).trim();
    } catch {
      break; // Ctrl-D 등 입력 스트림 종료
    }
    if (line.length === 0) {
      continue;
    }
    if (line === '/exit') {
      break;
    }
    if (line === '/clear') {
      session.clear();
      stdout.write('(히스토리를 초기화했습니다)\n');
      continue;
    }

    stdout.write('bot> ');
    try {
      for await (const piece of session.send(line)) {
        stdout.write(piece);
      }
      stdout.write('\n');
    } catch (err) {
      if (err instanceof LlmConnectionError) {
        stdout.write(`\n오류: ${err.message}\n`);
        rl.close();
        exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(`\n오류: ${message} — 히스토리는 보존되었으니 다시 시도하세요.\n`);
    }
  }

  rl.close();
}

main().catch((err: unknown) => {
  console.error(err);
  exit(1);
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
  # 기대: 19 passed (본 Step은 테스트 면제 — Context의 사유 참조)
# 3. 의미 검증
printf '/exit\n' | npx tsx src/cli/main.ts
  # 기대: 배너 출력 후 정상 종료 (exit 0) — Ollama 호출 없이 종료 경로 확인
```

### 동반 변경 (Side Effects)

- `package.json`의 `dev` 스크립트(`tsx src/cli/main.ts`)가 Phase 0에서 이미 이 경로를 가리킴 — 추가 변경 없음
- CLAUDE.md 갱신 불필요 (명령/컨벤션 변화 없음)

### Do Not Touch

`src/llm/**`, `src/chat/session.ts`, 설정 파일 전체.

## 실행 순서

Step 1 → 2 → 3 (세션 → 테스트 → CLI 순 의존).

## 입출력 예제

| 입력 (REPL) | 기대 동작 |
|------------|----------|
| `안녕` | `bot> ` 뒤에 응답이 토큰 단위로 스트리밍 출력 |
| (빈 줄) | 무시하고 다시 프롬프트 |
| `/clear` | `(히스토리를 초기화했습니다)` 출력 |
| `/exit` | 정상 종료 (exit 0) |
| Ctrl-C | 개행 출력 후 정상 종료 (exit 0) |
| Ollama 미기동 + `안녕` | `오류: Ollama 서버(...)에 연결할 수 없습니다...` 출력 후 exit 1 |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/chat/session.ts
export interface ChatSessionConfig { systemPrompt?: string; }
export class ChatSession {
  constructor(client: LlmClient, config?: ChatSessionConfig);
  send(userInput: string, options?: ChatOptions): AsyncGenerator<string>;
  getHistory(): readonly ChatMessage[];
  clear(): void;
}

// src/cli/main.ts — 실행 엔트리 (export 없음, npm run dev로 실행)
```

## Definition of Done

- [ ] DoD-21: 모든 Step 통과 + Verify 명령 ✓
- [ ] DoD-22: `npm run typecheck` exit 0
- [ ] DoD-23: `npm test` — 19 테스트 전체 통과
- [ ] DoD-24: ChatSession에 단위 테스트 동반 (Step 2), CLI는 면제 사유 명시됨
- [ ] DoD-25: 문서 갱신 불필요 확인
- [ ] DoD-26: 수동 AC 시나리오 통과 (아래 최종 검증)

## Observability plan

N/A — 운영 영향 없음. CLI stdout이 유일한 출력 채널.

## 최종 검증

```bash
# 자동 검증
npm run typecheck && npm test && npm run build && echo "PHASE 2 PASS (자동)"

# 수동 AC 시나리오 (Ollama 실행 상태에서)
npm run dev
# AC1: "안녕하세요" 입력 → 응답이 토큰 단위로 점진 출력되는지 확인
# AC2: "방금 내가 뭐라고 인사했지?" 입력 → 이전 발화를 참조해 답하는지 확인
# AC5: /clear 입력 → 안내 출력, "방금 질문 기억나?" → 기억 못 하는지 확인, /exit → 종료

# AC3: Ollama 중지 후 (ollama serve 중단 또는 OLLAMA_BASE_URL=http://localhost:9 지정)
OLLAMA_BASE_URL=http://localhost:9 npm run dev
# "안녕" 입력 → 연결 안내 오류 출력 + exit code 1 확인 (echo $?)
```
