# Phase 1: F16 dequant + GgufModel

@fidelity-check tokens: f16ToF32, GgufModel, hyperparams, getTensor, Hyperparams

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지 (Node 내장 `Buffer`/`fs`만)
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성

## 전제 조건

Phase 0이 노출한 인터페이스 (그대로 복사):

```ts
// src/gguf/types.ts
export enum GgmlType { F32 = 0, F16 = 1 }
export interface TensorInfo { name: string; dims: number[]; type: GgmlType; offset: number; }
export interface GgufFile { version: number; metadata: Map<string, unknown>; tensors: Map<string, TensorInfo>; dataStart: number; }

// src/gguf/parser.ts
export function parseGguf(buffer: Buffer): GgufFile;
```

실측 하이퍼파라미터 키 (qwen2.5-0.5b-fp16): `general.architecture`="qwen2", `qwen2.block_count`=24, `qwen2.embedding_length`=896, `qwen2.feed_forward_length`=4864, `qwen2.attention.head_count`=14, `qwen2.attention.head_count_kv`=2, `qwen2.rope.freq_base`=1000000, `qwen2.attention.layer_norm_rms_epsilon`≈1e-6, vocab=`tokenizer.ggml.tokens` 배열 길이.

## 현재 상태

Phase 0 파서는 텐서 info(offset/type/dims)까지 파싱하나 텐서 데이터(F16 바이트)는 미해석. F16→F32 dequant과 하이퍼파라미터 추출이 없다.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| f16ToF32 (순수) | ✓ | ✓ | 알려진 half 비트값 |
| GgufModel (Buffer 주입) | ✓ (fromBuffer) | ✓ (크래프트 버퍼 + 텐서 데이터) | 실제 파일 불필요 (단위) |
| 파일 로드 (load) | ✓ (filePath) | ✗ | 통합 테스트는 env `GGUF_TEST_FILE`로 게이트 (CI 무영향) |

## Step 1: F16→F32 변환 (`src/gguf/f16.ts` — create)

### Context

IEEE754 half precision(sign1·exp5·mant10) → f32. exp=0(0/subnormal), exp=31(inf/nan), 그 외(정규값) 3분기(R2).

### Code
```ts
const SUBNORMAL_SCALE = Math.pow(2, -24);

/** IEEE754 half(16bit) → f32 number. subnormal/inf/nan 처리 포함 */
export function f16ToF32(half: number): number {
  const sign = (half & 0x8000) !== 0 ? -1 : 1;
  const exp = (half & 0x7c00) >> 10;
  const mant = half & 0x03ff;
  if (exp === 0) {
    return sign * mant * SUBNORMAL_SCALE;
  }
  if (exp === 0x1f) {
    return mant === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + mant / 1024) * Math.pow(2, exp - 15);
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
grep -c "exp === 0x1f" src/gguf/f16.ts
  # 기대: 1 (inf/nan 분기 — R2)
```

### 동반 변경 (Side Effects)

새 export → 테스트 Step 3, 소비자 Step 2 GgufModel.

### Do Not Touch

`src/gguf/**` Phase 0 파일.

## Step 2: GgufModel (`src/gguf/model.ts` — create)

### Context

파싱 결과 + 원본 Buffer를 묶어 하이퍼파라미터와 dequant 텐서를 노출. 텐서는 요청 시(lazy) F32화(R4). `load`는 전체 파일을 Buffer로 읽음(F16 ~1GB 허용). 하이퍼파라미터 키는 arch 접두어(`qwen2.*`) 사용.

### Code
```ts
import { readFile } from 'node:fs/promises';
import { f16ToF32 } from './f16.js';
import { parseGguf } from './parser.js';
import { GgmlType } from './types.js';
import type { GgufFile } from './types.js';

export interface Hyperparams {
  arch: string;
  nLayers: number;
  hiddenSize: number;
  ffnSize: number;
  nHeads: number;
  nKvHeads: number;
  headDim: number;
  ropeFreqBase: number;
  rmsEps: number;
  vocabSize: number;
}

export interface Tensor {
  dims: number[];
  data: Float32Array;
}

export class GgufModel {
  private constructor(
    private readonly gguf: GgufFile,
    private readonly buffer: Buffer,
  ) {}

  static fromBuffer(buffer: Buffer): GgufModel {
    return new GgufModel(parseGguf(buffer), buffer);
  }

  static async load(filePath: string): Promise<GgufModel> {
    const buffer = await readFile(filePath);
    return GgufModel.fromBuffer(buffer);
  }

  get tensorNames(): string[] {
    return [...this.gguf.tensors.keys()];
  }

  private num(key: string): number {
    const v = this.gguf.metadata.get(key);
    if (typeof v !== 'number') {
      throw new Error(`메타데이터 누락/타입 오류: ${key} (${typeof v})`);
    }
    return v;
  }

  hyperparams(): Hyperparams {
    const arch = this.gguf.metadata.get('general.architecture');
    if (typeof arch !== 'string') {
      throw new Error('general.architecture 누락');
    }
    const nHeads = this.num(`${arch}.attention.head_count`);
    const hiddenSize = this.num(`${arch}.embedding_length`);
    const tokens = this.gguf.metadata.get('tokenizer.ggml.tokens');
    const vocabSize = Array.isArray(tokens) ? tokens.length : 0;
    return {
      arch,
      nLayers: this.num(`${arch}.block_count`),
      hiddenSize,
      ffnSize: this.num(`${arch}.feed_forward_length`),
      nHeads,
      nKvHeads: this.num(`${arch}.attention.head_count_kv`),
      headDim: Math.floor(hiddenSize / nHeads),
      ropeFreqBase: this.num(`${arch}.rope.freq_base`),
      rmsEps: this.num(`${arch}.attention.layer_norm_rms_epsilon`),
      vocabSize,
    };
  }

  /** 텐서를 F32 배열로 반환 (F16이면 dequant, F32면 복사) */
  getTensor(name: string): Tensor {
    const info = this.gguf.tensors.get(name);
    if (info === undefined) {
      throw new Error(`텐서 없음: ${name}`);
    }
    let count = 1;
    for (const d of info.dims) {
      count *= d;
    }
    const start = this.gguf.dataStart + info.offset;
    const out = new Float32Array(count);
    if (info.type === GgmlType.F32) {
      const need = start + count * 4;
      if (need > this.buffer.length) {
        throw new Error(`텐서 "${name}" 데이터가 버퍼를 벗어남`);
      }
      for (let i = 0; i < count; i += 1) {
        out[i] = this.buffer.readFloatLE(start + i * 4);
      }
    } else {
      const need = start + count * 2;
      if (need > this.buffer.length) {
        throw new Error(`텐서 "${name}" 데이터가 버퍼를 벗어남`);
      }
      for (let i = 0; i < count; i += 1) {
        out[i] = f16ToF32(this.buffer.readUInt16LE(start + i * 2));
      }
    }
    return { dims: info.dims, data: out };
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
echo "N/A: 테스트는 Step 3·4에서 동반 작성"
# 3. 의미 검증
grep -c "데이터가 버퍼를 벗어남" src/gguf/model.ts
  # 기대: 2 (F32·F16 경로 모두 경계 가드)
```

### 동반 변경 (Side Effects)

- 새 가드(텐서 없음/버퍼 초과 throw) → throw 경로 테스트 Step 3
- 파일 IO(load): readFile 실패 시 예외 전파 — 호출측(Segment 4) 책임, 본 Phase는 fromBuffer 단위 테스트로 검증
- 새 export → 통합 테스트 Step 4, 소비자 Segment 2~3

### Do Not Touch

`src/gguf/f16.ts`, `src/gguf/parser.ts`, `src/gguf/reader.ts`, `src/gguf/types.ts`.

## Step 3: f16 + GgufModel 단위 테스트 (`src/gguf/__tests__/model.test.ts` — create)

### Code

### 검증 대상
- spy: N/A (순수)
- branch: f16 알려진 값(0/1/-2/0.5/inf/nan/subnormal), 텐서 dequant(F16/F32), 텐서 없음 throw, 하이퍼파라미터 추출
- state: 변환값, Tensor.data 내용, Hyperparams 필드

```ts
import { describe, expect, it } from 'vitest';
import { f16ToF32 } from '../f16.js';
import { GgufModel } from '../model.js';
import { GgmlType } from '../types.js';

/** 헤더+메타+텐서info를 alignment 정렬 후 텐서 데이터까지 붙인 GGUF 버퍼 */
function buildGgufWithData(
  kv: [string, number, unknown][],
  tensor: { name: string; dims: number[]; type: number; f16?: number[]; f32?: number[] },
): Buffer {
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (s: string) => { const body = Buffer.from(s, 'utf8'); return Buffer.concat([u64(body.length), body]); };
  const parts: Buffer[] = [Buffer.from('GGUF', 'ascii'), u32(3), u64(1), u64(kv.length)];
  for (const [key, type, value] of kv) {
    parts.push(str(key), u32(type));
    if (type === 8) parts.push(str(String(value)));
    else if (type === 4) parts.push(u32(Number(value)));
    else if (type === 9) {
      const items = value as string[];
      parts.push(u32(8), u64(items.length));
      for (const it of items) parts.push(str(it));
    }
  }
  parts.push(str(tensor.name), u32(tensor.dims.length));
  for (const d of tensor.dims) parts.push(u64(d));
  parts.push(u32(tensor.type), u64(0));
  let head = Buffer.concat(parts);
  const pad = (32 - (head.length % 32)) % 32;
  head = Buffer.concat([head, Buffer.alloc(pad)]);
  let data: Buffer;
  if (tensor.type === GgmlType.F16) {
    data = Buffer.alloc((tensor.f16 ?? []).length * 2);
    (tensor.f16 ?? []).forEach((h, i) => data.writeUInt16LE(h, i * 2));
  } else {
    data = Buffer.alloc((tensor.f32 ?? []).length * 4);
    (tensor.f32 ?? []).forEach((v, i) => data.writeFloatLE(v, i * 4));
  }
  return Buffer.concat([head, data]);
}

describe('f16ToF32', () => {
  it('알려진 half 비트값을 정확히 변환한다 (정상)', () => {
    expect(f16ToF32(0x0000)).toBe(0);
    expect(f16ToF32(0x3c00)).toBe(1);
    expect(f16ToF32(0xc000)).toBe(-2);
    expect(f16ToF32(0x3800)).toBe(0.5);
  });

  it('inf/nan/subnormal을 처리한다 (경계값)', () => {
    expect(f16ToF32(0x7c00)).toBe(Infinity);
    expect(f16ToF32(0xfc00)).toBe(-Infinity);
    expect(Number.isNaN(f16ToF32(0x7e00))).toBe(true);
    expect(f16ToF32(0x0001)).toBeCloseTo(Math.pow(2, -24), 30);
  });
});

describe('GgufModel', () => {
  it('F16 텐서를 dequant해 F32 배열로 반환한다 (정상)', () => {
    const buf = buildGgufWithData(
      [['general.architecture', 8, 'qwen2']],
      { name: 'w', dims: [3], type: GgmlType.F16, f16: [0x3c00, 0xc000, 0x3800] },
    );
    const model = GgufModel.fromBuffer(buf);
    expect(Array.from(model.getTensor('w').data)).toEqual([1, -2, 0.5]);
  });

  it('F32 텐서는 그대로 복사한다 (정상)', () => {
    const buf = buildGgufWithData(
      [['general.architecture', 8, 'qwen2']],
      { name: 'n', dims: [2], type: GgmlType.F32, f32: [1.5, -0.25] },
    );
    expect(Array.from(GgufModel.fromBuffer(buf).getTensor('n').data)).toEqual([1.5, -0.25]);
  });

  it('없는 텐서 요청 시 throw (에러)', () => {
    const buf = buildGgufWithData(
      [['general.architecture', 8, 'qwen2']],
      { name: 'w', dims: [1], type: GgmlType.F16, f16: [0x3c00] },
    );
    expect(() => GgufModel.fromBuffer(buf).getTensor('missing')).toThrow('텐서 없음');
  });

  it('하이퍼파라미터를 메타데이터에서 추출한다 (정상)', () => {
    const buf = buildGgufWithData(
      [
        ['general.architecture', 8, 'qwen2'],
        ['qwen2.block_count', 4, 24],
        ['qwen2.embedding_length', 4, 896],
        ['qwen2.feed_forward_length', 4, 4864],
        ['qwen2.attention.head_count', 4, 14],
        ['qwen2.attention.head_count_kv', 4, 2],
        ['qwen2.rope.freq_base', 4, 1000000],
        ['qwen2.attention.layer_norm_rms_epsilon', 6, 0.000001],
        ['tokenizer.ggml.tokens', 9, ['a', 'b', 'c']],
      ],
      { name: 'w', dims: [1], type: GgmlType.F16, f16: [0x3c00] },
    );
    const hp = GgufModel.fromBuffer(buf).hyperparams();
    expect(hp).toMatchObject({
      arch: 'qwen2',
      nLayers: 24,
      hiddenSize: 896,
      nHeads: 14,
      nKvHeads: 2,
      headDim: 64,
      vocabSize: 3,
    });
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
  # 기대: 전체 158 passed (151 + 7)
# 3. 의미 검증
grep -c "toEqual(\[1, -2, 0.5\])\|headDim: 64" src/gguf/__tests__/model.test.ts
  # 기대: 2 (dequant·하이퍼파라미터 검증)
```

### 동반 변경 (Side Effects)

N/A (Step 1·2의 동반 테스트)

### Do Not Touch

`src/gguf/model.ts`, `src/gguf/f16.ts`.

## Step 4: 실제 파일 통합 테스트 (`src/gguf/__tests__/model.integration.test.ts` — create)

### Context

실제 qwen2.5-0.5b-fp16 GGUF로 하이퍼파라미터·텐서 dequant 검증(AC3/AC4). CI에는 파일이 없으므로 env `GGUF_TEST_FILE` 미설정 시 skip — 기존 테스트 무영향. 수동 실행: `GGUF_TEST_FILE=<blob경로> npm test`.

### Code

### 검증 대상
- spy: N/A
- branch: 실제 파일 하이퍼파라미터, token_embd dequant 유한값
- state: Hyperparams 실측값, 텐서 shape·유한성

```ts
import { describe, expect, it } from 'vitest';
import { env } from 'node:process';
import { GgufModel } from '../model.js';

const FILE = env['GGUF_TEST_FILE'];

describe.skipIf(FILE === undefined)('GgufModel 통합 (실제 qwen2.5-0.5b-fp16)', () => {
  it('하이퍼파라미터가 실측값과 일치한다 (정상)', async () => {
    const model = await GgufModel.load(FILE as string);
    const hp = model.hyperparams();
    expect(hp.arch).toBe('qwen2');
    expect(hp.nLayers).toBe(24);
    expect(hp.hiddenSize).toBe(896);
    expect(hp.nHeads).toBe(14);
    expect(hp.nKvHeads).toBe(2);
    expect(hp.headDim).toBe(64);
    expect(hp.vocabSize).toBe(151936);
  });

  it('token_embd 텐서를 dequant하면 shape·유한값이 맞다 (정상)', async () => {
    const model = await GgufModel.load(FILE as string);
    const t = model.getTensor('token_embd.weight');
    expect(t.dims).toEqual([896, 151936]);
    expect(t.data.length).toBe(896 * 151936);
    // 앞 100개 유한값 확인 (dequant 정상)
    for (let i = 0; i < 100; i += 1) {
      expect(Number.isFinite(t.data[i])).toBe(true);
    }
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
  # 기대: 158 passed (통합은 GGUF_TEST_FILE 미설정 시 skip — 회귀 없음)
# 3. 의미 검증
BLOB="$HOME/.ollama/models/blobs/sha256-6f96e01a3f550ca08aea1e5725bb8d5a7eccc6f281c30417e9d380b8c46467bd"
GGUF_TEST_FILE="$BLOB" npm test 2>&1 | grep -E "통합|passed" | tail -3
  # 기대: 실제 파일로 통합 2 테스트 통과 (AC3/AC4)
```

### 동반 변경 (Side Effects)

N/A (Step 2의 동반 통합 테스트)

### Do Not Touch

`src/gguf/model.ts`.

## 실행 순서

Step 1 → 2 → 3 → 4.

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `f16ToF32` | `0x3c00` | `1` |
| `f16ToF32` | `0x7c00` | `Infinity` |
| `getTensor` | F16 [0x3c00,0xc000,0x3800] | `Float32Array [1,-2,0.5]` |
| `hyperparams` | qwen2 메타 | `{nLayers:24, hiddenSize:896, headDim:64, ...}` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/gguf/f16.ts
export function f16ToF32(half: number): number;

// src/gguf/model.ts
export interface Hyperparams { arch; nLayers; hiddenSize; ffnSize; nHeads; nKvHeads; headDim; ropeFreqBase; rmsEps; vocabSize; }
export interface Tensor { dims: number[]; data: Float32Array; }
export class GgufModel {
  static fromBuffer(buffer: Buffer): GgufModel;
  static load(filePath: string): Promise<GgufModel>;
  get tensorNames(): string[];
  hyperparams(): Hyperparams;
  getTensor(name: string): Tensor;
}
```

## Definition of Done

- [ ] DoD-11: 모든 Step 통과 + Verify ✓
- [ ] DoD-12: typecheck exit 0
- [ ] DoD-13: `npm test` 158 passed (기존 144 회귀 없음)
- [ ] DoD-14: f16 알려진값·텐서 dequant·throw·하이퍼파라미터 테스트 동반
- [ ] DoD-15: 실제 파일 통합 테스트(GGUF_TEST_FILE 게이트)로 AC3/AC4 검증
- [ ] DoD-16: Segment 2 전제 만족 (GgufModel·Hyperparams 노출, tokenizer 메타 접근 가능)

## Observability plan

N/A — 순수 로딩 모듈.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 1 PASS"
# 실제 파일 검증:
GGUF_TEST_FILE="$HOME/.ollama/models/blobs/sha256-6f96e01a3f550ca08aea1e5725bb8d5a7eccc6f281c30417e9d380b8c46467bd" npm test 2>&1 | tail -3
```
