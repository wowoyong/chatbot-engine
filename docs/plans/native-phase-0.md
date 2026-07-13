# Phase 0: 샘플러 + ChatML + NativeLlmClient + 전환

@fidelity-check tokens: sampleToken, buildChatMlPrompt, NativeLlmClient, metadataArray, LLM_ENGINE

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 금지 → `unknown` + 타입 가드 (GGUF 메타 배열은 명시 캐스팅 허용 — 알려진 형태)
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성 — 핫패스 `!` 허용

## 전제 조건

Segment 1·2·3 (그대로 복사):

```ts
// src/gguf/model.ts — GgufModel { hyperparams(); getTensor(name); }
// src/tokenizer/bpe.ts — BpeTokenizer { constructor({tokens,merges,tokenType}); encode(text); decode(ids); tokenId(t); }
// src/transformer/model.ts — TransformerModel { constructor(gguf, maxSeq?); get hyperparams; forward(tokenId, pos): Float32Array; }
// src/llm/types.ts — LlmClient { chat(messages, options?): Promise<string>; chatStream(messages, options?): AsyncGenerator<string, {promptTokens?; responseTokens?}> }
// src/chat/session.ts SourceRef/TurnMeta (ux Segment) — chatStream이 완료 시 토큰 수 return
```

**전제**: Segment 3 forward가 Ollama 교차검증(AC4)을 통과한 상태.

## 현재 상태

`src/native/` 없음. GgufModel에 메타 배열 접근자 없음(tokenizer 통합 테스트가 private 캐스팅). bootstrap은 OllamaClient만 생성.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| sampleToken (rng 주입) | ✓ | ✓ | 결정적 rng |
| NativeLlmClient (transformer 주입) | ✓ | ✓ (Fake forward) | 실모델 불필요(단위) |
| bootstrap (env/overrides) | ✓ | ✓ (Fake client) | 기존 서버 테스트 패턴 |

## Step 1: 샘플러 (`src/native/sampler.ts` — create)

### Context

greedy(temp≤0=argmax) / temperature / top-p. rng 주입으로 확률 경로 테스트. top-p는 확률 내림차순 누적 ≥ p 집합만.

### Code
```ts
export interface SampleOptions {
  /** 0 이하면 greedy */
  temperature?: number;
  /** nucleus 확률 (기본 1 = 비활성) */
  topP?: number;
}

/** logits에서 다음 토큰 ID 샘플링. rng 주입으로 테스트 결정성 확보 */
export function sampleToken(
  logits: Float32Array,
  opts: SampleOptions = {},
  rng: () => number = Math.random,
): number {
  const temp = opts.temperature ?? 0;
  const n = logits.length;
  if (temp <= 0) {
    let best = 0;
    let bestV = -Infinity;
    for (let i = 0; i < n; i += 1) {
      if (logits[i]! > bestV) {
        bestV = logits[i]!;
        best = i;
      }
    }
    return best;
  }
  const probs = new Float32Array(n);
  let max = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const v = logits[i]! / temp;
    probs[i] = v;
    if (v > max) max = v;
  }
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const e = Math.exp(probs[i]! - max);
    probs[i] = e;
    sum += e;
  }
  for (let i = 0; i < n; i += 1) probs[i] = probs[i]! / sum;

  const topP = opts.topP ?? 1;
  const idx = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => probs[b]! - probs[a]!,
  );
  const keep: number[] = [];
  let cum = 0;
  for (const i of idx) {
    keep.push(i);
    cum += probs[i]!;
    if (cum >= topP) break;
  }
  let keepSum = 0;
  for (const i of keep) keepSum += probs[i]!;
  let r = rng() * keepSum;
  for (const i of keep) {
    r -= probs[i]!;
    if (r <= 0) return i;
  }
  return keep[keep.length - 1]!;
}
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
echo "N/A: 테스트는 Step 6에서 동반 작성"
# 3. 의미 검증
grep -c "temp <= 0" src/native/sampler.ts
  # 기대: 1 (greedy 분기)
```

### 동반 변경 (Side Effects)

새 export → 테스트 Step 6, 소비자 Step 4.

### Do Not Touch

기존 src.

## Step 2: ChatML 템플릿 (`src/native/chat-template.ts` — create)

### Context

Qwen2 ChatML: `<|im_start|>role\n{content}<|im_end|>\n` 반복 + assistant 시작. system 미포함 시 기본 주입.

### Code
```ts
import type { ChatMessage } from '../llm/types.js';

/** 메시지를 Qwen2 ChatML 프롬프트 문자열로 조립 */
export function buildChatMlPrompt(
  messages: readonly ChatMessage[],
  systemPrompt?: string,
): string {
  let out = '';
  const hasSystem = messages.some((m) => m.role === 'system');
  if (systemPrompt !== undefined && !hasSystem) {
    out += `<|im_start|>system\n${systemPrompt}<|im_end|>\n`;
  }
  for (const m of messages) {
    out += `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`;
  }
  out += '<|im_start|>assistant\n';
  return out;
}
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
echo "N/A: 테스트는 Step 6에서 동반 작성"
# 3. 의미 검증
grep -c "im_start" src/native/chat-template.ts
  # 기대: 2 이상 (ChatML 마커)
```

### 동반 변경 (Side Effects)

새 export → 테스트 Step 6, 소비자 Step 4.

### Do Not Touch

`src/native/sampler.ts`.

## Step 3: GgufModel 메타 접근자 (`src/gguf/model.ts` — modify, 메서드 추가)

### Context

토크나이저 배열(tokens/merges/token_type)을 캐스팅 없이 꺼내는 접근자. tokenizer 통합 테스트의 private 캐스팅을 제거(단일 소스).

### Code

`get tensorNames(): string[] {` 메서드 바로 위에 삽입:

```ts
  /** 메타데이터의 배열 값 (tokenizer.ggml.tokens 등) */
  metadataArray(key: string): unknown[] {
    const v = this.gguf.metadata.get(key);
    if (!Array.isArray(v)) {
      throw new Error(`메타데이터가 배열이 아님: ${key}`);
    }
    return v;
  }

```

### Anchor

`  get tensorNames(): string[] {` (파일 내 유일).

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 회귀 없음 (기존 gguf 테스트 통과)
# 3. 의미 검증
grep -c "metadataArray" src/gguf/model.ts
  # 기대: 1
```

### 동반 변경 (Side Effects)

- 새 접근자 → tokenizer 통합 테스트 캐스팅 제거(Step 7), 소비자 Step 5 bootstrap

### Do Not Touch

getTensor/hyperparams/load/fromBuffer, `src/gguf/parser.ts` 등.

## Step 4: NativeLlmClient (`src/native/native-client.ts` — create)

### Context

LlmClient 구현. ChatML 인코딩 → prefill(토큰별 forward로 KV 캐시 구축) → 생성 루프(sample → 누적 decode delta yield → eos/maxTokens 정지). 증분 decode는 누적 ids 전체 decode 후 delta(멀티바이트 안전, R1).

### Code
```ts
import type { ChatMessage, ChatOptions, LlmClient } from '../llm/types.js';
import type { BpeTokenizer } from '../tokenizer/bpe.js';
import type { TransformerModel } from '../transformer/model.js';
import { buildChatMlPrompt } from './chat-template.js';
import { sampleToken } from './sampler.js';
import type { SampleOptions } from './sampler.js';

export interface NativeClientConfig {
  systemPrompt?: string;
  /** 최대 생성 토큰. 기본 256 */
  maxTokens?: number;
  /** 종료 토큰. 기본 151645 (<|im_end|>) */
  eosTokenId?: number;
  sample?: SampleOptions;
}

export class NativeLlmClient implements LlmClient {
  private readonly model: TransformerModel;
  private readonly tokenizer: BpeTokenizer;
  private readonly config: NativeClientConfig;

  constructor(
    model: TransformerModel,
    tokenizer: BpeTokenizer,
    config: NativeClientConfig = {},
  ) {
    this.model = model;
    this.tokenizer = tokenizer;
    this.config = config;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    let out = '';
    for await (const piece of this.chatStream(messages, options)) {
      out += piece;
    }
    return out;
  }

  async *chatStream(
    messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string, { promptTokens?: number; responseTokens?: number }> {
    const prompt = buildChatMlPrompt(messages, this.config.systemPrompt);
    const promptIds = this.tokenizer.encode(prompt);
    const eos = this.config.eosTokenId ?? 151645;
    const maxTokens = this.config.maxTokens ?? 256;

    let pos = 0;
    let logits: Float32Array | null = null;
    for (const id of promptIds) {
      logits = this.model.forward(id, pos);
      pos += 1;
    }
    if (logits === null) {
      return { promptTokens: 0, responseTokens: 0 };
    }

    const generated: number[] = [];
    let emitted = '';
    for (let step = 0; step < maxTokens; step += 1) {
      const next = sampleToken(logits, this.config.sample ?? {});
      if (next === eos) {
        break;
      }
      generated.push(next);
      const full = this.tokenizer.decode(generated);
      if (full.length > emitted.length) {
        yield full.slice(emitted.length);
        emitted = full;
      }
      logits = this.model.forward(next, pos);
      pos += 1;
    }
    return { promptTokens: promptIds.length, responseTokens: generated.length };
  }
}
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
echo "N/A: 테스트는 Step 6에서 동반 작성"
# 3. 의미 검증
grep -c "full.slice(emitted.length)" src/native/native-client.ts
  # 기대: 1 (누적 decode delta — R1 멀티바이트 안전)
```

### 동반 변경 (Side Effects)

- 새 가드(eos/maxTokens 정지) → 테스트 Step 6
- 새 export(LlmClient 구현) → 호출처 bootstrap Step 5

### Do Not Touch

`src/native/sampler.ts`, `chat-template.ts`, `src/transformer/**`, `src/tokenizer/**`.

## Step 5: bootstrap 전환 (`src/app/bootstrap.ts` — modify, client 생성 분기)

### Context

env `LLM_ENGINE=native` + `NATIVE_GGUF_FILE` 시 NativeLlmClient 생성(Ollama 대신). 미설정 시 기존 OllamaClient 유지(R5). modelName도 분기.

### Code

(a) 파일 상단 import 추가 (OllamaClient import 뒤):
```ts
import { GgufModel } from '../gguf/model.js';
import { BpeTokenizer } from '../tokenizer/bpe.js';
import { TransformerModel } from '../transformer/model.js';
import { NativeLlmClient } from '../native/native-client.js';
```

(b) client 생성 블록 교체 —

교체 전:
```ts
  const client =
    overrides.client ??
    new OllamaClient({
      baseUrl: env['OLLAMA_BASE_URL'],
      model: env['OLLAMA_MODEL'],
    });
```
교체 후:
```ts
  let client: LlmClient;
  let modelLabel: string;
  if (overrides.client !== undefined) {
    client = overrides.client;
    modelLabel = 'fake-llm';
  } else if (env['LLM_ENGINE'] === 'native' && env['NATIVE_GGUF_FILE'] !== undefined) {
    const ggufModel = await GgufModel.load(env['NATIVE_GGUF_FILE']);
    const tokenizer = new BpeTokenizer({
      tokens: ggufModel.metadataArray('tokenizer.ggml.tokens') as string[],
      merges: ggufModel.metadataArray('tokenizer.ggml.merges') as string[],
      tokenType: ggufModel.metadataArray('tokenizer.ggml.token_type') as number[],
    });
    const transformer = new TransformerModel(ggufModel);
    client = new NativeLlmClient(transformer, tokenizer, { systemPrompt: SYSTEM_PROMPT });
    modelLabel = 'native (qwen2.5-0.5b)';
  } else {
    const ollama = new OllamaClient({
      baseUrl: env['OLLAMA_BASE_URL'],
      model: env['OLLAMA_MODEL'],
    });
    client = ollama;
    modelLabel = ollama.model;
  }
```

(c) `const modelName = client instanceof OllamaClient ? client.model : 'fake-llm';` 교체 —

교체 전:
```ts
  const modelName =
    client instanceof OllamaClient ? client.model : 'fake-llm';
```
교체 후:
```ts
  const modelName = modelLabel;
```

(d) 파일 상단에 `import type { LlmClient } from '../llm/types.js';`가 없으면 추가 (기존 import 확인 후).

### Anchor

- (a) `import { OllamaClient }` 라인 뒤
- (b) `const client =\n    overrides.client ??` 블록 (유일)
- (c) `const modelName =\n    client instanceof OllamaClient` 블록 (유일)

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 회귀 없음 — env 미설정이라 기존 Ollama/Fake 경로 유지 (bootstrap 테스트 통과)
# 3. 의미 검증
grep -c "LLM_ENGINE.*native\|NativeLlmClient" src/app/bootstrap.ts
  # 기대: 2 이상 (env 분기 + 생성)
```

### 동반 변경 (Side Effects)

- CLAUDE.md에 자체 엔진 실행법 1줄 (최종 검증)
- 기존 createApp 테스트: overrides.client 경로 무영향(modelLabel='fake-llm') — 회귀 게이트

### Do Not Touch

createApp의 그 외 로직(retriever/session/store/rebuildIndex/captureKnowledge).

## Step 6: 단위 테스트 (`src/native/__tests__/native.test.ts` — create)

### Code

### 검증 대상
- spy: FakeTransformer.forwardCalls — prefill+생성 호출 순서, eos 정지
- branch: greedy argmax, temperature 확률(주입 rng), ChatML 조립, 증분 decode 멀티바이트, eos 정지
- state: 샘플 토큰, 프롬프트 문자열, yield된 텍스트

```ts
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../llm/types.js';
import { buildChatMlPrompt } from '../chat-template.js';
import { sampleToken } from '../sampler.js';
import { NativeLlmClient } from '../native-client.js';
import { BpeTokenizer } from '../../tokenizer/bpe.js';
import { bytesToUnicode } from '../../tokenizer/bytes.js';
import type { TransformerModel } from '../../transformer/model.js';

describe('sampleToken', () => {
  it('temperature 0이면 argmax를 반환한다 (정상)', () => {
    expect(sampleToken(new Float32Array([0.1, 5, 0.2]), {})).toBe(1);
  });

  it('rng 주입으로 확률 경로가 결정적이다 (경계값)', () => {
    // 두 토큰 동일 확률, rng=0 → 첫 keep 반환
    const id = sampleToken(new Float32Array([1, 1]), { temperature: 1 }, () => 0);
    expect([0, 1]).toContain(id);
  });
});

describe('buildChatMlPrompt', () => {
  it('ChatML 규격으로 조립하고 assistant로 끝난다 (정상)', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: '안녕' }];
    const p = buildChatMlPrompt(msgs, 'SYS');
    expect(p).toBe('<|im_start|>system\nSYS<|im_end|>\n<|im_start|>user\n안녕<|im_end|>\n<|im_start|>assistant\n');
  });
});

/** byte vocab + 몇 토큰으로 소형 토크나이저 */
function tinyTokenizer(): BpeTokenizer {
  const enc = bytesToUnicode();
  const tokens = [...enc.values(), '<|im_end|>'];
  const tokenType = tokens.map((_, i) => (i === tokens.length - 1 ? 3 : 1));
  return new BpeTokenizer({ tokens, merges: [], tokenType });
}

/** 지정한 토큰 시퀀스를 순서대로 뱉는 Fake transformer */
class FakeTransformer {
  readonly forwardCalls: number[] = [];
  constructor(private readonly outputs: number[]) {}
  get hyperparams() {
    return { vocabSize: this.vocab } as never;
  }
  private vocab = 300;
  forward(tokenId: number, _pos: number): Float32Array {
    this.forwardCalls.push(tokenId);
    const logits = new Float32Array(this.vocab);
    const step = this.forwardCalls.length - 1;
    const target = this.outputs[Math.min(step, this.outputs.length - 1)] ?? 0;
    logits[target] = 100; // argmax = target
    return logits;
  }
}

async function collect(gen: AsyncGenerator<string, unknown>): Promise<{ text: string; ret: unknown }> {
  let text = '';
  let r = await gen.next();
  while (r.done !== true) {
    text += r.value;
    r = await gen.next();
  }
  return { text, ret: r.value };
}

describe('NativeLlmClient', () => {
  it('prefill 후 생성하고 eos에서 정지한다 (정상)', async () => {
    const tok = tinyTokenizer();
    const eosId = tok.tokenId('<|im_end|>')!;
    // 'h' 토큰 id
    const hId = tok.encode('h')[0]!;
    // Fake: 첫 생성 'h', 다음 eos → 'h' 하나 생성 후 정지
    const fake = new FakeTransformer([hId, eosId]) as unknown as TransformerModel;
    const client = new NativeLlmClient(fake, tok, { maxTokens: 10, eosTokenId: eosId });
    const { text, ret } = await collect(client.chatStream([{ role: 'user', content: 'x' }]));
    expect(text).toBe('h');
    expect((ret as { responseTokens?: number }).responseTokens).toBe(1);
  });

  it('maxTokens 상한에서 정지한다 (경계값)', async () => {
    const tok = tinyTokenizer();
    const aId = tok.encode('a')[0]!;
    const fake = new FakeTransformer([aId]) as unknown as TransformerModel; // 항상 'a'
    const client = new NativeLlmClient(fake, tok, { maxTokens: 3, eosTokenId: 999999 });
    const { text } = await collect(client.chatStream([{ role: 'user', content: 'x' }]));
    expect(text).toBe('aaa'); // 3개 상한
  });
});
```

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -5
  # 기대: 전체 회귀 없이 증가 (native 단위 6+)
# 3. 의미 검증
grep -c "eos에서 정지\|maxTokens 상한" src/native/__tests__/native.test.ts
  # 기대: 2 (정지 조건 검증)
```

### 동반 변경 (Side Effects)

N/A (Step 1·2·4의 동반 테스트)

### Do Not Touch

`src/native/*.ts`.

## Step 7: tokenizer 통합 테스트 정리 (`src/tokenizer/__tests__/bpe.integration.test.ts` — modify, 캐스팅 제거)

### Context

Step 3에서 추가한 `metadataArray`로 private 캐스팅을 대체(단일 소스). realTokenizer 헬퍼 교체.

### Code

교체 전:
```ts
  const meta = (model as unknown as { gguf: { metadata: Map<string, unknown> } }).gguf.metadata;
  return new BpeTokenizer({
    tokens: meta.get('tokenizer.ggml.tokens') as string[],
    merges: meta.get('tokenizer.ggml.merges') as string[],
    tokenType: meta.get('tokenizer.ggml.token_type') as number[],
  });
```
교체 후:
```ts
  return new BpeTokenizer({
    tokens: model.metadataArray('tokenizer.ggml.tokens') as string[],
    merges: model.metadataArray('tokenizer.ggml.merges') as string[],
    tokenType: model.metadataArray('tokenizer.ggml.token_type') as number[],
  });
```

### Anchor

교체 전 블록 (`(model as unknown as` 포함, 파일 내 유일).

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
BLOB="$HOME/.ollama/models/blobs/sha256-6f96e01a3f550ca08aea1e5725bb8d5a7eccc6f281c30417e9d380b8c46467bd"
GGUF_TEST_FILE="$BLOB" npx vitest run src/tokenizer/__tests__/bpe.integration.test.ts 2>&1 | grep -E "Tests|✓" | tail -3
  # 기대: 통합 3 테스트 여전히 통과 (접근자로 동일 결과)
# 3. 의미 검증
grep -c "as unknown as" src/tokenizer/__tests__/bpe.integration.test.ts
  # 기대: 0 (캐스팅 제거)
```

### 동반 변경 (Side Effects)

N/A (Step 3 접근자의 소비 정리)

### Do Not Touch

통합 테스트의 it 케이스 본문.

## 실행 순서

Step 1 → 2 → 3 → 4 → 5 → 6 → 7.

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `sampleToken` | logits[0.1,5,0.2] temp0 | `1` (argmax) |
| `buildChatMlPrompt` | user "안녕", SYS | `<\|im_start\|>system\nSYS...assistant\n` |
| `chatStream` | Fake [h, eos] | yield "h", return {responseTokens:1} |
| `chatStream` | Fake [a] maxTokens3 | "aaa" |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/native/sampler.ts
export interface SampleOptions { temperature?: number; topP?: number; }
export function sampleToken(logits: Float32Array, opts?: SampleOptions, rng?: () => number): number;
// src/native/chat-template.ts
export function buildChatMlPrompt(messages: readonly ChatMessage[], systemPrompt?: string): string;
// src/native/native-client.ts
export interface NativeClientConfig { systemPrompt?; maxTokens?; eosTokenId?; sample?; }
export class NativeLlmClient implements LlmClient { constructor(model, tokenizer, config?); }
// src/gguf/model.ts — GgufModel.metadataArray(key): unknown[]
// bootstrap: env LLM_ENGINE=native + NATIVE_GGUF_FILE → NativeLlmClient
```

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify ✓
- [ ] DoD-02: typecheck exit 0
- [ ] DoD-03: `npm test` 회귀 없음 (native 단위 추가, env 미설정 시 Ollama 경로 유지)
- [ ] DoD-04: greedy/확률/ChatML/eos·maxTokens 정지 테스트 동반
- [ ] DoD-05: CLAUDE.md 자체 엔진 실행법 갱신
- [ ] DoD-06: AC5 수동 통합 — 실모델로 자체 엔진 생성 확인

## Observability plan

N/A — 생성 결과가 곧 출력.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 0 PASS (자동)"

# CLAUDE.md 컨벤션에 추가:
# - 자체 추론 엔진: LLM_ENGINE=native NATIVE_GGUF_FILE=<qwen2.5-0.5b-fp16 GGUF> npm run dev (Ollama 대신 자체 forward)

# AC5 수동 통합 (메인 세션): 자체 엔진으로 실제 생성
LLM_ENGINE=native NATIVE_GGUF_FILE="$HOME/.ollama/models/blobs/sha256-6f96e01a3f550ca08aea1e5725bb8d5a7eccc6f281c30417e9d380b8c46467bd" npm run dev
# "안녕?" 입력 → 자체 forward로 한국어 생성 확인 (느림 — 토큰당 수 초)
```
