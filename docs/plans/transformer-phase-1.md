# Phase 1: 트랜스포머 forward (GQA 어텐션 + SwiGLU + tied logits)

@fidelity-check tokens: attention, TransformerModel, forward, kCache, gqaGroup

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 금지
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지
5. 핫패스 배열 접근은 `!` 허용 (성능, 의미 검증으로 대체 — Phase 0 규칙과 동일)

## 전제 조건

Phase 0 커널 (그대로 복사):

```ts
// src/transformer/kernels.ts
export function linear(weight, x, inDim, outDim, bias?): Float32Array;
export function rmsNorm(x, weight, eps): Float32Array;
export function softmaxInPlace(arr, len): void;
export function silu(x: number): number;
// src/transformer/rope.ts
export function applyRope(vec, pos, nHeads, headDim, freqBase): void;
```

Segment 1:
```ts
// src/gguf/model.ts
export class GgufModel { hyperparams(): Hyperparams; getTensor(name): { dims; data: Float32Array }; }
export interface Hyperparams { arch; nLayers; hiddenSize; ffnSize; nHeads; nKvHeads; headDim; ropeFreqBase; rmsEps; vocabSize; }
```

## 현재 상태

커널만 있고 조립(어텐션·층·forward)이 없다. 실측 텐서명(층당 attn_q/k/v.weight+bias, attn_output, ffn_gate/up/down, attn_norm, ffn_norm; 전역 token_embd, output_norm)으로 forward를 조립. tied embeddings(token_embd로 logits).

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| attention (순수 함수) | ✓ | ✓ | 소형 q/k/v로 GQA·causal 검증 |
| TransformerModel (GgufModel 주입) | ✓ | ✗ (실 가중치 필요) | 통합 테스트(env 게이트) + Ollama 교차검증 |

## Step 1: 어텐션 (`src/transformer/attention.ts` — create)

### Context

GQA 인과 어텐션 순수 함수(R3/R4). q(nHeads×headDim), KV 캐시(pos+1개×kvDim). q head → kv head = floor(qh/gqaGroup). 인과: p<=pos만. softmax는 커널 재사용.

### Code
```ts
import { softmaxInPlace } from './kernels.js';

/**
 * GQA 인과 어텐션. q는 nHeads×headDim, kCache/vCache는 (maxSeq)×kvDim에서
 * 앞 (pos+1) 위치가 유효. 반환은 nHeads×headDim.
 */
export function attention(
  q: Float32Array,
  kCache: Float32Array,
  vCache: Float32Array,
  pos: number,
  nHeads: number,
  nKvHeads: number,
  headDim: number,
): Float32Array {
  const kvDim = nKvHeads * headDim;
  const gqaGroup = nHeads / nKvHeads;
  const scale = 1 / Math.sqrt(headDim);
  const out = new Float32Array(nHeads * headDim);
  const scores = new Float32Array(pos + 1);
  for (let qh = 0; qh < nHeads; qh += 1) {
    const kvh = Math.floor(qh / gqaGroup);
    const qOff = qh * headDim;
    for (let p = 0; p <= pos; p += 1) {
      const kOff = p * kvDim + kvh * headDim;
      let dot = 0;
      for (let d = 0; d < headDim; d += 1) {
        dot += q[qOff + d]! * kCache[kOff + d]!;
      }
      scores[p] = dot * scale;
    }
    softmaxInPlace(scores, pos + 1);
    const outOff = qh * headDim;
    for (let p = 0; p <= pos; p += 1) {
      const w = scores[p]!;
      const vOff = p * kvDim + kvh * headDim;
      for (let d = 0; d < headDim; d += 1) {
        out[outOff + d]! += w * vCache[vOff + d]!;
      }
    }
  }
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
echo "N/A: 테스트는 Step 3에서 동반 작성"
# 3. 의미 검증
grep -c "Math.floor(qh / gqaGroup)" src/transformer/attention.ts
  # 기대: 1 (GQA head 매핑 — R3)
```

### 동반 변경 (Side Effects)

새 export → 테스트 Step 3, 소비자 Step 2.

### Do Not Touch

`src/transformer/kernels.ts`, `src/transformer/rope.ts`.

## Step 2: TransformerModel (`src/transformer/model.ts` — create)

### Context

가중치를 GgufModel에서 dequant 로드(생성자), KV 캐시 보유, `forward(tokenId, pos)`가 다음 토큰 logits 반환. 층: pre-norm 잔차(x += attn(rmsnorm); x += mlp(rmsnorm)). tied lm head(token_embd로 logits). qDim=nHeads·headDim, kvDim=nKvHeads·headDim.

### Code
```ts
import { GgufModel } from '../gguf/model.js';
import type { Hyperparams } from '../gguf/model.js';
import { attention } from './attention.js';
import { linear, rmsNorm, silu } from './kernels.js';
import { applyRope } from './rope.js';

interface LayerWeights {
  attnNorm: Float32Array;
  qW: Float32Array;
  qB: Float32Array;
  kW: Float32Array;
  kB: Float32Array;
  vW: Float32Array;
  vB: Float32Array;
  oW: Float32Array;
  ffnNorm: Float32Array;
  gateW: Float32Array;
  upW: Float32Array;
  downW: Float32Array;
}

export class TransformerModel {
  private readonly hp: Hyperparams;
  private readonly tokenEmbd: Float32Array;
  private readonly outputNorm: Float32Array;
  private readonly layers: LayerWeights[];
  private readonly kCache: Float32Array[];
  private readonly vCache: Float32Array[];
  private readonly maxSeq: number;

  constructor(model: GgufModel, maxSeq = 2048) {
    this.hp = model.hyperparams();
    this.maxSeq = maxSeq;
    this.tokenEmbd = model.getTensor('token_embd.weight').data;
    this.outputNorm = model.getTensor('output_norm.weight').data;
    this.layers = [];
    for (let l = 0; l < this.hp.nLayers; l += 1) {
      this.layers.push({
        attnNorm: model.getTensor(`blk.${l}.attn_norm.weight`).data,
        qW: model.getTensor(`blk.${l}.attn_q.weight`).data,
        qB: model.getTensor(`blk.${l}.attn_q.bias`).data,
        kW: model.getTensor(`blk.${l}.attn_k.weight`).data,
        kB: model.getTensor(`blk.${l}.attn_k.bias`).data,
        vW: model.getTensor(`blk.${l}.attn_v.weight`).data,
        vB: model.getTensor(`blk.${l}.attn_v.bias`).data,
        oW: model.getTensor(`blk.${l}.attn_output.weight`).data,
        ffnNorm: model.getTensor(`blk.${l}.ffn_norm.weight`).data,
        gateW: model.getTensor(`blk.${l}.ffn_gate.weight`).data,
        upW: model.getTensor(`blk.${l}.ffn_up.weight`).data,
        downW: model.getTensor(`blk.${l}.ffn_down.weight`).data,
      });
    }
    const kvDim = this.hp.nKvHeads * this.hp.headDim;
    this.kCache = this.layers.map(() => new Float32Array(maxSeq * kvDim));
    this.vCache = this.layers.map(() => new Float32Array(maxSeq * kvDim));
  }

  get hyperparams(): Hyperparams {
    return this.hp;
  }

  /** 위치 pos의 토큰 tokenId를 처리해 다음 토큰 logits[vocab] 반환. KV 캐시에 기록 */
  forward(tokenId: number, pos: number): Float32Array {
    const hp = this.hp;
    const hidden = hp.hiddenSize;
    const qDim = hp.nHeads * hp.headDim;
    const kvDim = hp.nKvHeads * hp.headDim;
    if (pos >= this.maxSeq) {
      throw new Error(`위치 ${pos}가 maxSeq ${this.maxSeq} 초과`);
    }
    const x = this.tokenEmbd.slice(tokenId * hidden, tokenId * hidden + hidden);

    for (let l = 0; l < this.layers.length; l += 1) {
      const L = this.layers[l]!;
      const h = rmsNorm(x, L.attnNorm, hp.rmsEps);
      const q = linear(L.qW, h, hidden, qDim, L.qB);
      const k = linear(L.kW, h, hidden, kvDim, L.kB);
      const v = linear(L.vW, h, hidden, kvDim, L.vB);
      applyRope(q, pos, hp.nHeads, hp.headDim, hp.ropeFreqBase);
      applyRope(k, pos, hp.nKvHeads, hp.headDim, hp.ropeFreqBase);
      this.kCache[l]!.set(k, pos * kvDim);
      this.vCache[l]!.set(v, pos * kvDim);
      const attnOut = attention(
        q,
        this.kCache[l]!,
        this.vCache[l]!,
        pos,
        hp.nHeads,
        hp.nKvHeads,
        hp.headDim,
      );
      const o = linear(L.oW, attnOut, qDim, hidden);
      for (let i = 0; i < hidden; i += 1) {
        x[i]! += o[i]!;
      }
      const h2 = rmsNorm(x, L.ffnNorm, hp.rmsEps);
      const gate = linear(L.gateW, h2, hidden, hp.ffnSize);
      const up = linear(L.upW, h2, hidden, hp.ffnSize);
      for (let i = 0; i < hp.ffnSize; i += 1) {
        gate[i] = silu(gate[i]!) * up[i]!;
      }
      const down = linear(L.downW, gate, hp.ffnSize, hidden);
      for (let i = 0; i < hidden; i += 1) {
        x[i]! += down[i]!;
      }
    }

    const normed = rmsNorm(x, this.outputNorm, hp.rmsEps);
    const logits = new Float32Array(hp.vocabSize);
    for (let t = 0; t < hp.vocabSize; t += 1) {
      const base = t * hidden;
      let dot = 0;
      for (let d = 0; d < hidden; d += 1) {
        dot += normed[d]! * this.tokenEmbd[base + d]!;
      }
      logits[t] = dot;
    }
    return logits;
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
echo "N/A: 테스트는 Step 3(어텐션)·4(통합)에서"
# 3. 의미 검증
grep -c "tokenEmbd\[base + d\]" src/transformer/model.ts
  # 기대: 1 (tied lm head — token_embd로 logits)
```

### 동반 변경 (Side Effects)

- 새 가드(maxSeq 초과 throw) → 통합/경계 테스트
- 파일/메모리: 가중치 전량 dequant(~2GB F32) 상주 — 설계 허용(16GB)
- 새 export → 소비자 Segment 4

### Do Not Touch

`src/transformer/attention.ts`, `kernels.ts`, `rope.ts`, `src/gguf/**`.

## Step 3: 어텐션 테스트 (`src/transformer/__tests__/attention.test.ts` — create)

### Code

### 검증 대상
- spy: N/A (순수)
- branch: 단일 위치(자기 자신만), GQA(q head가 올바른 kv head 참조), 인과(과거만)
- state: 어텐션 출력값

```ts
import { describe, expect, it } from 'vitest';
import { attention } from '../attention.js';

describe('attention', () => {
  it('pos=0이면 자기 자신 v를 그대로 반환한다 (경계값)', () => {
    // 1 head, headDim 2, 1 kv head. q·k softmax(단일) = 1 → out = v
    const q = new Float32Array([1, 0]);
    const k = new Float32Array([1, 0]); // pos0
    const v = new Float32Array([5, 7]);
    const out = attention(q, k, v, 0, 1, 1, 2);
    expect(Array.from(out)).toEqual([5, 7]);
  });

  it('GQA: 2 q head가 1 kv head를 공유한다 (정상)', () => {
    // nHeads 2, nKvHeads 1, headDim 2 → gqaGroup 2, 둘 다 kvh 0
    const q = new Float32Array([1, 0, 0, 1]); // head0=[1,0], head1=[0,1]
    const k = new Float32Array([1, 0]);
    const v = new Float32Array([3, 4]);
    const out = attention(q, k, v, 0, 2, 1, 2);
    // 둘 다 단일 위치 → out = v 반복
    expect(Array.from(out)).toEqual([3, 4, 3, 4]);
  });

  it('인과: 최신 위치가 과거 v의 가중합이다 (정상)', () => {
    // 1 head, headDim 1, kvDim 1, pos1. q=[1]; k=[0(p0),0(p1)] → 스코어 동일 → 균등
    const q = new Float32Array([1]);
    const k = new Float32Array([0, 0]);
    const v = new Float32Array([2, 4]);
    const out = attention(q, k, v, 1, 1, 1, 1);
    expect(out[0]).toBeCloseTo(3, 6); // (2+4)/2
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
  # 기대: 전체 175 passed (172 + 3)
# 3. 의미 검증
grep -c "toEqual(\[3, 4, 3, 4\])" src/transformer/__tests__/attention.test.ts
  # 기대: 1 (GQA 공유 검증)
```

### 동반 변경 (Side Effects)

N/A (Step 1의 동반 테스트)

### Do Not Touch

`src/transformer/attention.ts`.

## Step 4: 실모델 통합 테스트 (`src/transformer/__tests__/model.integration.test.ts` — create)

### Context

실 모델 forward가 유한 logits·올바른 shape 반환(AC3), KV 캐시 증분이 일관(AC5). AC4(Ollama argmax 일치)는 최종 검증에서 메인 세션이 수동 교차검증(vitest에서 Ollama 호출은 fragile). env `GGUF_TEST_FILE` 게이트.

### Code

### 검증 대상
- spy: N/A
- branch: 실 forward 유한성, shape, 2토큰 증분 일관
- state: logits 유한·길이

```ts
import { describe, expect, it } from 'vitest';
import { env } from 'node:process';
import { GgufModel } from '../../gguf/model.js';
import { TransformerModel } from '../model.js';

const FILE = env['GGUF_TEST_FILE'];

describe.skipIf(FILE === undefined)('TransformerModel 통합 (실 qwen2.5-0.5b)', () => {
  it('forward가 유한 logits[vocab]을 반환한다 (정상)', async () => {
    const gguf = await GgufModel.load(FILE as string);
    const model = new TransformerModel(gguf);
    // 임의 토큰(예: 40 = "e") 위치 0
    const logits = model.forward(40, 0);
    expect(logits.length).toBe(model.hyperparams.vocabSize);
    for (let i = 0; i < 500; i += 1) {
      expect(Number.isFinite(logits[i])).toBe(true);
    }
  }, 60000);

  it('2토큰 증분 forward가 진행된다 (정상)', async () => {
    const gguf = await GgufModel.load(FILE as string);
    const model = new TransformerModel(gguf);
    model.forward(9707, 0); // 임의 토큰
    const l2 = model.forward(11, 1);
    expect(Number.isFinite(l2[0])).toBe(true);
  }, 60000);
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
npm test 2>&1 | tail -3
  # 기대: 175 passed (통합 skip)
# 3. 의미 검증
BLOB="$HOME/.ollama/models/blobs/sha256-6f96e01a3f550ca08aea1e5725bb8d5a7eccc6f281c30417e9d380b8c46467bd"
GGUF_TEST_FILE="$BLOB" npx vitest run src/transformer/__tests__/model.integration.test.ts 2>&1 | grep -E "Tests|✓" | tail -4
  # 기대: 통합 2 테스트 통과 (유한 logits, 증분)
```

### 동반 변경 (Side Effects)

N/A (Step 2의 동반 통합 테스트)

### Do Not Touch

`src/transformer/model.ts`.

## 실행 순서

Step 1 → 2 → 3 → 4.

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `attention` | q[1,0] k[1,0] v[5,7] pos0 1head | `[5,7]` |
| `attention` | GQA 2head 1kv | `[3,4,3,4]` |
| `forward` | tokenId 40, pos 0 (실모델) | `Float32Array[151936]` 유한 |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/transformer/attention.ts
export function attention(q, kCache, vCache, pos, nHeads, nKvHeads, headDim): Float32Array;

// src/transformer/model.ts
export class TransformerModel {
  constructor(model: GgufModel, maxSeq?: number);
  get hyperparams(): Hyperparams;
  forward(tokenId: number, pos: number): Float32Array;
}
```

## Definition of Done

- [ ] DoD-11: 모든 Step 통과 + Verify ✓
- [ ] DoD-12: typecheck exit 0
- [ ] DoD-13: `npm test` 175 passed (기존 164 회귀 없음)
- [ ] DoD-14: GQA·인과·자기참조 어텐션 테스트 + 실모델 유한 logits 통합
- [ ] DoD-15: **AC4 Ollama 교차검증** — 최종 검증에서 메인 세션 수동 수행 (argmax 다음 토큰 일치). 불일치 시 텐서 레이아웃/RoPE 재점검
- [ ] DoD-16: Segment 4 전제 만족 (forward 노출)

## Observability plan

N/A — 순수 수치 모듈.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 1 PASS (자동)"
BLOB="$HOME/.ollama/models/blobs/sha256-6f96e01a3f550ca08aea1e5725bb8d5a7eccc6f281c30417e9d380b8c46467bd"
GGUF_TEST_FILE="$BLOB" npx vitest run src/transformer 2>&1 | tail -3

# AC4 수동 교차검증 (메인 세션): 짧은 프롬프트 토큰화 → 우리 forward argmax 다음 토큰
# vs Ollama(qwen2.5:0.5b-instruct-fp16) greedy 첫 토큰 비교. 일치해야 함.
```
