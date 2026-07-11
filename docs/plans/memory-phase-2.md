# Phase 2: 세션 영속화 (JSON 자동 저장/복원)

@fidelity-check tokens: SessionStore, restore, rename, force

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 타입 사용 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지 — `node:fs/promises` 내장 모듈만 사용
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어
5. `noUncheckedIndexedAccess` 활성
6. 테스트의 파일 시스템 사용은 프로젝트 내부 `.test-tmp/<uuid>/`만 허용 (시스템 temp 디렉토리 금지 — 보안 정책)

## 전제 조건

Phase 1이 노출한 인터페이스 (그대로 복사):

```ts
// src/context/context-manager.ts
export interface ContextManagerConfig { maxContextTokens?: number; reserveTokens?: number; }
export class ContextManager {
  constructor(client: LlmClient, config?: ContextManagerConfig);
  reset(): void;
  prepare(systemPrompt: string | null, history: readonly ChatMessage[], userInput: string): Promise<PreparedContext>;
}

// src/chat/session.ts
export interface ChatSessionConfig { systemPrompt?: string; context?: ContextManagerConfig; }
export class ChatSession {
  constructor(client: LlmClient, config?: ChatSessionConfig);
  send(userInput: string, options?: ChatOptions): AsyncGenerator<string>;
  getHistory(): readonly ChatMessage[];
  clear(): void;
}

// src/llm/types.ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
```

## 현재 상태

세션은 프로세스 메모리에만 존재 — CLI 종료 시 대화가 사라진다. `src/store/` 디렉토리 없음. `.gitignore`는 4줄(node_modules/, dist/, *.log, .DS_Store).

## Step 1: 세션 스토어 (`src/store/session-store.ts` — create)

### Context

JSON 파일 저장/복원. 원자적 쓰기(`.tmp`에 쓴 뒤 rename — 쓰기 도중 강제 종료돼도 원본 무손상). 손상 파일은 `.bak`으로 보존 후 새 세션 시작 — 사용자 데이터를 삭제하지 않는다. 신뢰 경계(파일 시스템)의 입력은 타입 가드로 전체 검증.

### Code
```ts
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChatMessage } from '../llm/types.js';

export interface PersistedSession {
  version: 1;
  history: ChatMessage[];
  savedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) {
    return false;
  }
  const role = value['role'];
  const content = value['content'];
  return (
    (role === 'system' || role === 'user' || role === 'assistant') &&
    typeof content === 'string'
  );
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value['version'] === 1 &&
    Array.isArray(value['history']) &&
    value['history'].every(isChatMessage) &&
    typeof value['savedAt'] === 'string'
  );
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export class SessionStore {
  constructor(private readonly filePath: string) {}

  /**
   * 저장된 히스토리를 읽는다.
   * - 파일 없음 → null (새 세션)
   * - 손상/스키마 불일치 → `<파일>.bak`으로 보존 후 null (데이터 삭제 안 함)
   */
  async load(): Promise<ChatMessage[] | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedSession(parsed)) {
        throw new Error('세션 파일 스키마 불일치');
      }
      return parsed.history;
    } catch {
      await rename(this.filePath, `${this.filePath}.bak`);
      return null;
    }
  }

  /** 원자적 저장: `<파일>.tmp`에 쓴 뒤 rename */
  async save(history: readonly ChatMessage[]): Promise<void> {
    const data: PersistedSession = {
      version: 1,
      history: history.map((m) => ({ ...m })),
      savedAt: new Date().toISOString(),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmpPath, this.filePath);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
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
echo "N/A: 테스트는 Step 2에서 동반 작성"
# 3. 의미 검증
grep -c "rename(tmpPath, this.filePath)" src/store/session-store.ts
  # 기대: 1 (원자적 쓰기 — write 후 rename)
```

### 동반 변경 (Side Effects)

- 새 가드(`isPersistedSession` 실패 경로) → 손상/스키마 불일치 테스트를 Step 2에서 동반
- 파일 IO 실패 설계: ENOENT는 null(정상 흐름), 그 외 read 오류는 전파(호출자 crash-report), 손상은 .bak 보존 — 본 Step Code에 명시

### Do Not Touch

`src/llm/**`, `src/context/**`, `src/chat/**`.

## Step 2: 스토어 테스트 (`src/store/__tests__/session-store.test.ts` — create)

### Context

실제 파일 시스템 사용 — 테스트별 `.test-tmp/<uuid>/` 고유 디렉토리로 격리(병렬 안전), afterEach에서 정리. 시스템 temp 디렉토리는 보안 정책상 사용 금지.

### Code

### 검증 대상

- spy: N/A (파일 시스템 실제 사용 — 결과 파일로 검증)
- branch: 왕복(save→load), 파일 없음(ENOENT), 손상 JSON(.bak 보존), 스키마 불일치(.bak 보존), clear, tmp 파일 잔존 없음
- state: load 결과가 save 입력과 동일, .bak/.tmp 파일 존재 여부

```ts
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../llm/types.js';
import { SessionStore } from '../session-store.js';

const HISTORY: ChatMessage[] = [
  { role: 'user', content: '안녕' },
  { role: 'assistant', content: '안녕하세요' },
];

describe('SessionStore', () => {
  let dir: string;
  let filePath: string;
  let store: SessionStore;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(dir, { recursive: true });
    filePath = join(dir, 'session.json');
    store = new SessionStore(filePath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('save 후 load하면 동일한 히스토리를 반환한다 (정상)', async () => {
    await store.save(HISTORY);
    expect(await store.load()).toEqual(HISTORY);
  });

  it('저장 완료 후 .tmp 중간 파일이 남지 않는다 (정상)', async () => {
    await store.save(HISTORY);
    const files = await readdir(dir);
    expect(files).toEqual(['session.json']);
  });

  it('파일이 없으면 null을 반환한다 (경계값)', async () => {
    expect(await store.load()).toBeNull();
  });

  it('손상된 JSON이면 .bak으로 보존하고 null을 반환한다 (에러)', async () => {
    await writeFile(filePath, '{ 깨진 json', 'utf8');
    expect(await store.load()).toBeNull();
    const files = await readdir(dir);
    expect(files).toContain('session.json.bak');
    expect(files).not.toContain('session.json');
  });

  it('JSON이지만 스키마가 다르면 .bak으로 보존하고 null을 반환한다 (에러)', async () => {
    await writeFile(filePath, JSON.stringify({ version: 1, history: [{ role: 'alien' }] }), 'utf8');
    expect(await store.load()).toBeNull();
    expect(await readdir(dir)).toContain('session.json.bak');
  });

  it('clear는 파일을 삭제하고, 없는 파일에 호출해도 오류가 없다 (경계값)', async () => {
    await store.save(HISTORY);
    await store.clear();
    expect(await store.load()).toBeNull();
    await store.clear();
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
  # 기대: 전체 44 passed (38 + 6)
# 3. 의미 검증
grep -c "randomUUID" src/store/__tests__/session-store.test.ts
  # 기대: 2 (테스트별 고유 디렉토리 격리)
```

### 동반 변경 (Side Effects)

`.test-tmp/` 산출물 → Step 4에서 .gitignore에 등재 (같은 Phase).

### Do Not Touch

`src/store/session-store.ts`.

## Step 3: ChatSession restore + CLI 통합 (`src/chat/session.ts` — modify, 메서드 추가 / `src/cli/main.ts` — modify, 전체 교체)

### Context

두 변경이 한 기능(복원)의 양면이라 한 Step으로 묶는다.
(a) `ChatSession.restore()` — 저장된 히스토리로 교체 + 요약 캐시 리셋.
(b) CLI — 시작 시 `store.load()`로 복원, 매 턴 완료 후 `store.save()`, `/clear` 시 파일도 삭제. 저장 경로는 `CHATBOT_SESSION_FILE` env로 재정의 가능 (기본 `.chatbot/session.json`).

### Code

(a) `src/chat/session.ts` — `getHistory()` 메서드 바로 위에 삽입:

```ts
  /** 저장된 히스토리로 교체하고 요약 캐시를 리셋한다 (세션 복원용) */
  restore(history: readonly ChatMessage[]): void {
    this.history = history.map((m) => ({ ...m }));
    this.contextManager.reset();
  }

```

(b) `src/cli/main.ts` — 파일 전체를 다음으로 교체:

```ts
import * as readline from 'node:readline/promises';
import { env, exit, stdin, stdout } from 'node:process';
import { ChatSession } from '../chat/session.js';
import { LlmConnectionError } from '../llm/errors.js';
import { OllamaClient } from '../llm/ollama-client.js';
import { SessionStore } from '../store/session-store.js';

const SYSTEM_PROMPT =
  '당신은 간결하고 정확하게 답하는 한국어 어시스턴트입니다.';
const DEFAULT_SESSION_FILE = '.chatbot/session.json';

async function main(): Promise<void> {
  const client = new OllamaClient({
    baseUrl: env['OLLAMA_BASE_URL'],
    model: env['OLLAMA_MODEL'],
  });
  const session = new ChatSession(client, { systemPrompt: SYSTEM_PROMPT });
  const store = new SessionStore(
    env['CHATBOT_SESSION_FILE'] ?? DEFAULT_SESSION_FILE,
  );

  const restored = await store.load();
  if (restored !== null && restored.length > 0) {
    session.restore(restored);
    stdout.write(
      `(이전 세션을 복원했습니다 — ${Math.floor(restored.length / 2)}턴)\n`,
    );
  }

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
      await store.clear();
      stdout.write('(히스토리를 초기화했습니다)\n');
      continue;
    }

    stdout.write('bot> ');
    try {
      for await (const piece of session.send(line)) {
        stdout.write(piece);
      }
      stdout.write('\n');
      await store.save(session.getHistory());
    } catch (err) {
      if (err instanceof LlmConnectionError) {
        stdout.write(`\n오류: ${err.message}\n`);
        rl.close();
        exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(
        `\n오류: ${message} — 히스토리는 보존되었으니 다시 시도하세요.\n`,
      );
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

- (a) `src/chat/session.ts`: `  getHistory(): readonly ChatMessage[] {` 라인 바로 위에 삽입 (이 텍스트는 파일 내 유일)
- (b) `src/cli/main.ts`: 파일 전체 교체

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 44 passed (회귀 없음 — restore 테스트는 Step 4에서 추가)
# 3. 의미 검증
printf '/exit\n' | npx tsx src/cli/main.ts
  # 기대: 배너 출력 후 정상 종료 (복원 파일 없음 → 복원 메시지 없음)
```

### 동반 변경 (Side Effects)

- 새 메서드 `restore` → 단위 테스트를 Step 4에서 동반 (같은 Phase)
- CLI가 `.chatbot/` 디렉토리 산출 → Step 4에서 .gitignore 등재

### Do Not Touch

`src/chat/session.ts`의 기존 메서드 본문(send/getHistory/clear — 추가만), `src/llm/**`, `src/context/**`.

## Step 4: restore 테스트 + gitignore (`src/chat/__tests__/session.test.ts` — modify / `.gitignore` — modify, 전체 교체)

### Code

(a) `src/chat/__tests__/session.test.ts` — describe 블록 마지막 it 뒤(닫는 `});` 직전)에 추가:

### 검증 대상

- spy: fake의 호출 메시지 — restore된 히스토리가 다음 send에 포함되는지
- branch: restore 후 전송 경로
- state: `getHistory()`가 복원 내용과 일치

```ts
  it('restore()로 복원한 히스토리가 다음 send에 포함된다 (정상)', async () => {
    const fake = new FakeLlmClient();
    fake.pieces = ['ok'];
    const session = new ChatSession(fake);
    const saved: ChatMessage[] = [
      { role: 'user', content: '이전 질문' },
      { role: 'assistant', content: '이전 답변' },
    ];

    session.restore(saved);
    expect(session.getHistory()).toEqual(saved);

    await collect(session.send('새 질문'));
    expect(fake.calls.at(0)).toEqual([...saved, { role: 'user', content: '새 질문' }]);
  });
```

(b) `.gitignore` — 파일 전체를 다음으로 교체:

```
node_modules/
dist/
*.log
.DS_Store
.chatbot/
.test-tmp/
```

### Anchor

- (a) Phase 1 Step 5와 동일 앵커 규칙: describe를 닫는 `});` 바로 위
- (b) 파일 전체 교체

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음, exit 0
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 전체 45 passed (44 + 1)
# 3. 의미 검증
git check-ignore .chatbot .test-tmp && echo "OK: ignored"
  # 기대: 두 경로 출력 + "OK: ignored"
```

### 동반 변경 (Side Effects)

N/A (Step 3의 동반 테스트/등재가 본 Step)

### Do Not Touch

기존 테스트 케이스 본문.

## 실행 순서

Step 1 → 2 → 3 → 4 (스토어 → 스토어 테스트 → 통합 → 통합 테스트+정리).

## 입출력 예제

| 시나리오 | 동작 |
|---------|------|
| 첫 실행 (파일 없음) | 복원 메시지 없이 시작, 첫 턴 후 `.chatbot/session.json` 생성 |
| 재실행 (파일 있음) | `(이전 세션을 복원했습니다 — N턴)` 출력, 이전 문맥으로 대화 |
| `/clear` | 메모리 + 파일 모두 삭제 |
| 손상 파일로 실행 | `.bak` 보존 후 새 세션으로 시작 (크래시 없음) |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/store/session-store.ts
export interface PersistedSession { version: 1; history: ChatMessage[]; savedAt: string; }
export class SessionStore {
  constructor(filePath: string);
  load(): Promise<ChatMessage[] | null>;
  save(history: readonly ChatMessage[]): Promise<void>;
  clear(): Promise<void>;
}

// src/chat/session.ts — 추가분
// restore(history: readonly ChatMessage[]): void
```

## Definition of Done

- [ ] DoD-21: 모든 Step 통과 + Verify ✓
- [ ] DoD-22: `npm run typecheck` exit 0
- [ ] DoD-23: `npm test` 45 passed (기존 38 회귀 없음)
- [ ] DoD-24: 새 가드(스키마 검증)·새 메서드(restore)에 테스트 동반
- [ ] DoD-25: CLAUDE.md 갱신 — 세션 파일 경로/env 1줄 추가 (아래 최종 검증에 포함)
- [ ] DoD-26: 수동 AC 시나리오 통과

## Observability plan

N/A — 운영 영향 없음. 복원/초기화는 CLI stdout 안내 메시지로 사용자에게 노출.

## 최종 검증

```bash
# 자동 검증
npm run typecheck && npm test && npm run build && echo "PHASE 2 PASS (자동)"

# CLAUDE.md에 세션 저장 안내 1줄 추가 (컨벤션 섹션 끝):
# - 세션 자동 저장: `.chatbot/session.json` (env `CHATBOT_SESSION_FILE`로 변경 가능)

# 수동 AC 시나리오 (Ollama 실행 상태)
npm run dev   # "내가 좋아하는 색은 파란색이야" 입력 후 /exit
npm run dev   # 재실행 → "(이전 세션을 복원했습니다 — 1턴)" 확인 → "내가 좋아하는 색은?" → 파란색 답변 확인
# /clear 후 /exit → 재실행 → 복원 메시지 없음 확인
```
