# Phase 0: 수학 커널

@fidelity-check tokens: linear, rmsNorm, softmaxInPlace, silu, applyRope

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 금지
3. 런타임 의존성 추가 금지
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성 — 배열 접근은 `?? 0` 가드 (핫패스라 최소화, 의미 검증으로 대체)

## 전제 조건

없음 (신규 모듈, Float32Array만 사용).

## 현재 상태

`src/transformer/` 없음. 트랜스포머의 5개 수학 연산(선형·RMSNorm·softmax·SiLU·RoPE)을 Float32Array 기반 순수 함수로 구현. GGUF weight 레이아웃: ne=[in,out], y[o]=bias[o]+Σⱼ W[o*in+j]·x[j].

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| 커널 (순수 함수) | ✓ | ✓ | 손계산 가능한 소형 입력 |

## Step 1: 선형 + 정규화 커널 (`src/transformer/kernels.ts` — create)

### Context

`linear`: GGUF 레이아웃(ne=[in,out])대로 y[o]=Σⱼ W[o*in+j]·x[j]+bias. `rmsNorm`: x/√(mean(x²)+eps)·weight. `softmaxInPlace`: max 빼고 exp/정규화(overflow 방지, R5). `silu`: x·σ(x).

### Code
```ts
/** GGUF 선형: weight ne=[inDim,outDim], y[o] = bias[o] + Σⱼ weight[o*inDim+j]·x[j] */
export function linear(
  weight: Float32Array,
  x: Float32Array,
  inDim: number,
  outDim: number,
  bias?: Float32Array,
): Float32Array {
  const out = new Float32Array(outDim);
  for (let o = 0; o < outDim; o += 1) {
    let sum = bias === undefined ? 0 : bias[o]!;
    const base = o * inDim;
    for (let j = 0; j < inDim; j += 1) {
      sum += weight[base + j]! * x[j]!;
    }
    out[o] = sum;
  }
  return out;
}

/** RMSNorm: y[i] = x[i] / √(mean(x²)+eps) · weight[i] */
export function rmsNorm(
  x: Float32Array,
  weight: Float32Array,
  eps: number,
): Float32Array {
  let ss = 0;
  for (let i = 0; i < x.length; i += 1) {
    ss += x[i]! * x[i]!;
  }
  const scale = 1 / Math.sqrt(ss / x.length + eps);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 1) {
    out[i] = x[i]! * scale * weight[i]!;
  }
  return out;
}

/** in-place softmax (max 빼기로 overflow 방지) */
export function softmaxInPlace(arr: Float32Array, len: number): void {
  let max = -Infinity;
  for (let i = 0; i < len; i += 1) {
    if (arr[i]! > max) max = arr[i]!;
  }
  let sum = 0;
  for (let i = 0; i < len; i += 1) {
    const e = Math.exp(arr[i]! - max);
    arr[i] = e;
    sum += e;
  }
  for (let i = 0; i < len; i += 1) {
    arr[i] = arr[i]! / sum;
  }
}

/** SiLU (swish): x·σ(x) */
export function silu(x: number): number {
  return x / (1 + Math.exp(-x));
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
grep -c "o \* inDim" src/transformer/kernels.ts
  # 기대: 1 (GGUF 레이아웃 — R1)
```

### 동반 변경 (Side Effects)

새 export → 테스트 Step 3, 소비자 Phase 1.

### Do Not Touch

기존 src.

## Step 2: RoPE (`src/transformer/rope.ts` — create)

### Context

HF Qwen2 rotate_half 규약(R2). head_dim의 앞/뒤 절반을 pos·inv_freq로 회전. inv_freq[i]=freqBase^(-2i/headDim). in-place, head별 반복.

### Code
```ts
/**
 * RoPE를 벡터에 in-place 적용 (HF Qwen2 rotate_half 규약).
 * vec은 nHeads×headDim 연속 배열. head h의 dim i(<half)와 i+half를 회전.
 */
export function applyRope(
  vec: Float32Array,
  pos: number,
  nHeads: number,
  headDim: number,
  freqBase: number,
): void {
  const half = headDim >> 1;
  for (let h = 0; h < nHeads; h += 1) {
    const base = h * headDim;
    for (let i = 0; i < half; i += 1) {
      const invFreq = Math.pow(freqBase, (-2 * i) / headDim);
      const angle = pos * invFreq;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const a = vec[base + i]!;
      const b = vec[base + i + half]!;
      vec[base + i] = a * cos - b * sin;
      vec[base + i + half] = b * cos + a * sin;
    }
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
echo "N/A: 테스트는 Step 3에서 동반 작성"
# 3. 의미 검증
grep -c "rotate_half\|i + half" src/transformer/rope.ts
  # 기대: 2 이상 (rotate_half 규약)
```

### 동반 변경 (Side Effects)

새 export → 테스트 Step 3, 소비자 Phase 1.

### Do Not Touch

`src/transformer/kernels.ts`.

## Step 3: 커널 테스트 (`src/transformer/__tests__/kernels.test.ts` — create)

### Code

### 검증 대상
- spy: N/A (순수)
- branch: linear(bias 유/무), rmsNorm 정규화, softmax 합=1·overflow, silu(0)=0, rope 회전(pos=0 항등)
- state: 손계산 값 일치

```ts
import { describe, expect, it } from 'vitest';
import { linear, rmsNorm, silu, softmaxInPlace } from '../kernels.js';
import { applyRope } from '../rope.js';

describe('linear', () => {
  it('y[o] = Σ W[o*in+j]·x[j] + bias (정상)', () => {
    // W [in=2, out=2]: row0=[1,2], row1=[3,4]; x=[1,1]; bias=[10,20]
    const W = new Float32Array([1, 2, 3, 4]);
    const x = new Float32Array([1, 1]);
    const b = new Float32Array([10, 20]);
    expect(Array.from(linear(W, x, 2, 2, b))).toEqual([13, 27]);
  });

  it('bias 없이도 동작 (경계값)', () => {
    const W = new Float32Array([2, 0, 0, 2]);
    expect(Array.from(linear(W, new Float32Array([3, 5]), 2, 2))).toEqual([6, 10]);
  });
});

describe('rmsNorm', () => {
  it('정규화 후 weight를 곱한다 (정상)', () => {
    // x=[3,4] → ss=(9+16)/2=12.5, scale=1/√(12.5+0)=0.2828..
    const y = rmsNorm(new Float32Array([3, 4]), new Float32Array([1, 1]), 0);
    expect(y[0]).toBeCloseTo(3 / Math.sqrt(12.5), 5);
    expect(y[1]).toBeCloseTo(4 / Math.sqrt(12.5), 5);
  });
});

describe('softmaxInPlace', () => {
  it('합이 1이고 큰 값에서 overflow하지 않는다 (경계값)', () => {
    const a = new Float32Array([1000, 1000, 1000]);
    softmaxInPlace(a, 3);
    expect(a[0]).toBeCloseTo(1 / 3, 6);
    expect(a[0]! + a[1]! + a[2]!).toBeCloseTo(1, 6);
  });
});

describe('silu', () => {
  it('silu(0)=0, silu는 x·σ(x) (정상)', () => {
    expect(silu(0)).toBe(0);
    expect(silu(1)).toBeCloseTo(1 / (1 + Math.exp(-1)), 6);
  });
});

describe('applyRope', () => {
  it('pos=0이면 항등(회전 없음) (경계값)', () => {
    const v = new Float32Array([1, 2, 3, 4]);
    applyRope(v, 0, 1, 4, 10000);
    expect(Array.from(v)).toEqual([1, 2, 3, 4]);
  });

  it('pos>0이면 앞/뒤 절반이 회전한다 (정상)', () => {
    const v = new Float32Array([1, 0, 0, 0]); // head_dim 2, half 1
    applyRope(v, 1, 1, 2, 10000);
    // i=0: invFreq=1, angle=1, a=1,b=0 → [cos1, sin1]
    expect(v[0]).toBeCloseTo(Math.cos(1), 5);
    expect(v[1]).toBeCloseTo(Math.sin(1), 5);
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
  # 기대: 전체 172 passed (164 + 8)
# 3. 의미 검증
grep -c "toEqual(\[13, 27\])\|toBeCloseTo(Math.cos(1)" src/transformer/__tests__/kernels.test.ts
  # 기대: 2 (linear·rope 손계산 검증)
```

### 동반 변경 (Side Effects)

N/A (Step 1·2의 동반 테스트)

### Do Not Touch

`src/transformer/kernels.ts`, `src/transformer/rope.ts`.

## 실행 순서

Step 1 → 2 → 3.

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `linear` | W[1,2,3,4] x[1,1] b[10,20] in2 out2 | `[13,27]` |
| `rmsNorm` | x[3,4] w[1,1] eps0 | `[3/√12.5, 4/√12.5]` |
| `softmaxInPlace` | [1000,1000,1000] | `[1/3,1/3,1/3]` |
| `applyRope` | [1,0,0,0] pos1 head1 dim2 | `[cos1, sin1, 0, 0]` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/transformer/kernels.ts
export function linear(weight: Float32Array, x: Float32Array, inDim: number, outDim: number, bias?: Float32Array): Float32Array;
export function rmsNorm(x: Float32Array, weight: Float32Array, eps: number): Float32Array;
export function softmaxInPlace(arr: Float32Array, len: number): void;
export function silu(x: number): number;

// src/transformer/rope.ts
export function applyRope(vec: Float32Array, pos: number, nHeads: number, headDim: number, freqBase: number): void;
```

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify ✓
- [ ] DoD-02: typecheck exit 0
- [ ] DoD-03: `npm test` 172 passed (기존 164 회귀 없음)
- [ ] DoD-04: 각 커널 손계산·경계(overflow/pos0) 테스트 동반
- [ ] DoD-05: 문서 갱신 불필요
- [ ] DoD-06: Phase 1 전제 만족 (5 커널 노출)

## Observability plan

N/A — 순수 수치 모듈.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 0 PASS"
```
