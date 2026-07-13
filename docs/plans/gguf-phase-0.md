# Phase 0: 바이너리 리더 + GGUF 파서

@fidelity-check tokens: ByteReader, parseGguf, GgufValueType, readValue, ensure

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지 (Node 내장 `Buffer`만 — npm dep 아님)
4. 미사용 변수 금지 — 의도적 무시는 `_` 접두어
5. `noUncheckedIndexedAccess` 활성 — 배열/인덱스 접근은 가드

## 전제 조건

없음 (신규 모듈).

## 현재 상태

`src/gguf/` 디렉토리 없음. 바이너리 파싱 코드 기존 없음. GGUF v3 포맷(리틀엔디언): magic `GGUF` + version(u32) + tensorCount(u64) + kvCount(u64) + 메타데이터 KV + 텐서 info. 값 타입 13종(0=u8..12=f64, 9=array).

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| Buffer (입력) | ✓ (함수 인자) | ✓ (크래프트한 GGUF 버퍼) | 실제 파일 불필요 — 최소 GGUF 인메모리 생성 |
| 파일 시스템 | ✗ (Phase 0 미사용) | — | Phase 1에서 fd 주입 |

## Step 1: GGUF 타입 정의 (`src/gguf/types.ts` — create)

### Context

GGUF 값 타입 enum과 파싱 결과 구조. 메타데이터는 임의 타입이라 `unknown` 값 맵.

### Code
```ts
export enum GgufValueType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

/** GGML 텐서 데이터 타입 (본 로더는 F32/F16만 지원) */
export enum GgmlType {
  F32 = 0,
  F16 = 1,
}

export interface TensorInfo {
  name: string;
  /** 차원 (GGUF는 역순 저장 — 파서가 그대로 보존) */
  dims: number[];
  type: GgmlType;
  /** 텐서 데이터 영역 시작(dataStart) 기준 상대 오프셋 */
  offset: number;
}

export interface GgufFile {
  version: number;
  metadata: Map<string, unknown>;
  tensors: Map<string, TensorInfo>;
  /** 텐서 데이터 영역의 파일 절대 오프셋 (alignment 정렬됨) */
  dataStart: number;
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
echo "N/A: 타입 정의 — 테스트는 Step 4"
# 3. 의미 검증
grep -c "FLOAT64 = 12" src/gguf/types.ts
  # 기대: 1 (13 타입 전부 정의)
```

### 동반 변경 (Side Effects)

새 타입 → 소비자(Step 2 reader, Step 3 parser).

### Do Not Touch

기존 src/** 전체.

## Step 2: 바이트 리더 (`src/gguf/reader.ts` — create)

### Context

리틀엔디언 프리미티브를 순차 읽는 커서. 매 읽기 전 `ensure`로 남은 바이트를 검사해 버퍼 초과를 throw(R1). u64/i64는 `Number`로 좁힘(안전 범위 — GGUF 오프셋·길이는 2^53 미만).

### Code
```ts
/** 리틀엔디언 순차 리더 — 매 읽기마다 경계 검사 */
export class ByteReader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  get offset(): number {
    return this.pos;
  }

  set offset(value: number) {
    this.ensure(0, value);
    this.pos = value;
  }

  private ensure(bytes: number, at: number = this.pos): void {
    if (at < 0 || at + bytes > this.buf.length) {
      throw new Error(
        `버퍼 경계 초과: offset ${at} + ${bytes}바이트 > 길이 ${this.buf.length}`,
      );
    }
  }

  u8(): number {
    this.ensure(1);
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  i8(): number {
    this.ensure(1);
    const v = this.buf.readInt8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    this.ensure(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.ensure(2);
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.ensure(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  /** u64 → Number (GGUF 오프셋/길이는 2^53 미만이므로 안전) */
  u64(): number {
    this.ensure(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return Number(v);
  }

  i64(): number {
    this.ensure(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return Number(v);
  }

  f32(): number {
    this.ensure(4);
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.ensure(8);
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  /** GGUF string: u64 길이 + UTF-8 바이트 */
  str(): string {
    const n = this.u64();
    this.ensure(n);
    const s = this.buf.toString('utf8', this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  /** magic 등 고정 ASCII 태그 */
  ascii(n: number): string {
    this.ensure(n);
    const s = this.buf.toString('ascii', this.pos, this.pos + n);
    this.pos += n;
    return s;
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
echo "N/A: 테스트는 Step 4에서 동반 작성"
# 3. 의미 검증
grep -c "버퍼 경계 초과" src/gguf/reader.ts
  # 기대: 1 (경계 가드 존재 — R1)
```

### 동반 변경 (Side Effects)

새 가드(경계 초과 throw) → throw 경로 테스트 Step 4. 소비자 parser Step 3.

### Do Not Touch

`src/gguf/types.ts`.

## Step 3: GGUF 파서 (`src/gguf/parser.ts` — create)

### Context

헤더 → 메타데이터 KV → 텐서 info 순으로 파싱. 값 타입 13종 전부(array 재귀 포함, R5). 텐서 데이터 시작은 마지막 텐서 info 뒤를 `general.alignment`(기본 32, R3)로 정렬. F32/F16 외 텐서 타입은 throw(미지원 명시).

### Code
```ts
import { ByteReader } from './reader.js';
import { GgmlType, GgufValueType } from './types.js';
import type { GgufFile, TensorInfo } from './types.js';

const GGUF_MAGIC = 'GGUF';
const SUPPORTED_VERSION = 3;
const DEFAULT_ALIGNMENT = 32;

/** GGUF 값 하나를 타입에 따라 읽는다 (array는 재귀) */
function readValue(reader: ByteReader, type: number): unknown {
  switch (type) {
    case GgufValueType.UINT8:
      return reader.u8();
    case GgufValueType.INT8:
      return reader.i8();
    case GgufValueType.UINT16:
      return reader.u16();
    case GgufValueType.INT16:
      return reader.i16();
    case GgufValueType.UINT32:
      return reader.u32();
    case GgufValueType.INT32:
      return reader.i32();
    case GgufValueType.FLOAT32:
      return reader.f32();
    case GgufValueType.BOOL:
      return reader.bool();
    case GgufValueType.STRING:
      return reader.str();
    case GgufValueType.UINT64:
      return reader.u64();
    case GgufValueType.INT64:
      return reader.i64();
    case GgufValueType.FLOAT64:
      return reader.f64();
    case GgufValueType.ARRAY: {
      const elemType = reader.u32();
      const count = reader.u64();
      const arr: unknown[] = [];
      for (let i = 0; i < count; i += 1) {
        arr.push(readValue(reader, elemType));
      }
      return arr;
    }
    default:
      throw new Error(`알 수 없는 GGUF 값 타입: ${type}`);
  }
}

/** 다음 alignment 배수로 올림 */
function alignUp(offset: number, alignment: number): number {
  const rem = offset % alignment;
  return rem === 0 ? offset : offset + (alignment - rem);
}

/** GGUF v3 버퍼를 파싱해 메타데이터 + 텐서 info를 반환 */
export function parseGguf(buffer: Buffer): GgufFile {
  const reader = new ByteReader(buffer);
  const magic = reader.ascii(4);
  if (magic !== GGUF_MAGIC) {
    throw new Error(`GGUF magic 불일치: "${magic}"`);
  }
  const version = reader.u32();
  if (version !== SUPPORTED_VERSION) {
    throw new Error(`지원하지 않는 GGUF 버전: ${version} (지원: ${SUPPORTED_VERSION})`);
  }
  const tensorCount = reader.u64();
  const kvCount = reader.u64();

  const metadata = new Map<string, unknown>();
  for (let i = 0; i < kvCount; i += 1) {
    const key = reader.str();
    const valueType = reader.u32();
    metadata.set(key, readValue(reader, valueType));
  }

  const tensors = new Map<string, TensorInfo>();
  for (let i = 0; i < tensorCount; i += 1) {
    const name = reader.str();
    const nDims = reader.u32();
    const dims: number[] = [];
    for (let d = 0; d < nDims; d += 1) {
      dims.push(reader.u64());
    }
    const type = reader.u32();
    if (type !== GgmlType.F32 && type !== GgmlType.F16) {
      throw new Error(
        `지원하지 않는 텐서 타입: ${type} (텐서 "${name}", 지원: F32/F16만)`,
      );
    }
    const offset = reader.u64();
    tensors.set(name, { name, dims, type, offset });
  }

  const alignmentRaw = metadata.get('general.alignment');
  const alignment =
    typeof alignmentRaw === 'number' && alignmentRaw > 0
      ? alignmentRaw
      : DEFAULT_ALIGNMENT;
  const dataStart = alignUp(reader.offset, alignment);

  return { version, metadata, tensors, dataStart };
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
echo "N/A: 테스트는 Step 4에서 동반 작성"
# 3. 의미 검증
grep -c "alignUp(reader.offset, alignment)" src/gguf/parser.ts
  # 기대: 1 (텐서 데이터 정렬 — R3)
```

### 동반 변경 (Side Effects)

- 새 가드(magic/버전/미지원 타입 throw) → throw 경로 테스트 Step 4
- 새 export → 소비자(Phase 1 GgufModel) + 테스트 Step 4

### Do Not Touch

`src/gguf/reader.ts`, `src/gguf/types.ts`.

## Step 4: 파서 테스트 (`src/gguf/__tests__/parser.test.ts` — create)

### Code

### 검증 대상
- spy: N/A (순수 파싱)
- branch: 정상 파싱(헤더/메타/텐서), magic 불일치 throw, 버전 불일치 throw, 미지원 텐서 타입 throw, array 메타 재귀, 버퍼 초과 throw, alignment 정렬
- state: metadata/tensors 내용, dataStart 값

```ts
import { describe, expect, it } from 'vitest';
import { parseGguf } from '../parser.js';
import { GgmlType } from '../types.js';

/** 최소 GGUF v3 버퍼를 조립하는 테스트 헬퍼 */
function buildGguf(opts: {
  version?: number;
  kv?: [string, number, unknown][];
  tensors?: { name: string; dims: number[]; type: number; offset: number }[];
  magic?: string;
}): Buffer {
  const parts: Buffer[] = [];
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const u64 = (v: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  };
  const str = (s: string) => {
    const body = Buffer.from(s, 'utf8');
    return Buffer.concat([u64(body.length), body]);
  };
  parts.push(Buffer.from(opts.magic ?? 'GGUF', 'ascii'));
  parts.push(u32(opts.version ?? 3));
  const tensors = opts.tensors ?? [];
  const kv = opts.kv ?? [];
  parts.push(u64(tensors.length));
  parts.push(u64(kv.length));
  for (const [key, type, value] of kv) {
    parts.push(str(key));
    parts.push(u32(type));
    if (type === 8) {
      parts.push(str(String(value)));
    } else if (type === 4) {
      parts.push(u32(Number(value)));
    } else if (type === 9) {
      // array of strings (elemType 8)
      const items = value as string[];
      parts.push(u32(8));
      parts.push(u64(items.length));
      for (const it of items) parts.push(str(it));
    }
  }
  for (const t of tensors) {
    parts.push(str(t.name));
    parts.push(u32(t.dims.length));
    for (const d of t.dims) parts.push(u64(d));
    parts.push(u32(t.type));
    parts.push(u64(t.offset));
  }
  return Buffer.concat(parts);
}

describe('parseGguf', () => {
  it('헤더·메타데이터·텐서 info를 파싱한다 (정상)', () => {
    const buf = buildGguf({
      kv: [['general.architecture', 8, 'qwen2']],
      tensors: [{ name: 'token_embd.weight', dims: [896, 151936], type: GgmlType.F16, offset: 0 }],
    });
    const gguf = parseGguf(buf);
    expect(gguf.version).toBe(3);
    expect(gguf.metadata.get('general.architecture')).toBe('qwen2');
    const t = gguf.tensors.get('token_embd.weight');
    expect(t?.dims).toEqual([896, 151936]);
    expect(t?.type).toBe(GgmlType.F16);
  });

  it('array 메타데이터를 재귀 파싱한다 (정상)', () => {
    const buf = buildGguf({
      kv: [['tokenizer.ggml.tokens', 9, ['!', '"', '#']]],
    });
    const gguf = parseGguf(buf);
    expect(gguf.metadata.get('tokenizer.ggml.tokens')).toEqual(['!', '"', '#']);
  });

  it('magic이 GGUF가 아니면 throw (에러)', () => {
    expect(() => parseGguf(buildGguf({ magic: 'XXXX' }))).toThrow('magic 불일치');
  });

  it('버전이 3이 아니면 throw (에러)', () => {
    expect(() => parseGguf(buildGguf({ version: 2 }))).toThrow('지원하지 않는 GGUF 버전');
  });

  it('F32/F16 외 텐서 타입이면 throw (에러)', () => {
    const buf = buildGguf({
      tensors: [{ name: 'q', dims: [4], type: 8, offset: 0 }], // 8 = Q8_0
    });
    expect(() => parseGguf(buf)).toThrow('지원하지 않는 텐서 타입');
  });

  it('잘린 버퍼는 경계 초과로 throw (경계값)', () => {
    const full = buildGguf({ kv: [['k', 8, 'v']] });
    expect(() => parseGguf(full.subarray(0, 10))).toThrow('버퍼 경계 초과');
  });

  it('dataStart가 alignment(32) 배수로 정렬된다 (경계값)', () => {
    const gguf = parseGguf(buildGguf({ kv: [['general.architecture', 8, 'x']] }));
    expect(gguf.dataStart % 32).toBe(0);
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
  # 기대: 전체 151 passed (144 + 7)
# 3. 의미 검증
grep -c "toThrow" src/gguf/__tests__/parser.test.ts
  # 기대: 4 (magic/버전/타입/경계 에러 경로)
```

### 동반 변경 (Side Effects)

N/A (Step 2·3의 동반 테스트)

### Do Not Touch

`src/gguf/parser.ts`, `src/gguf/reader.ts`.

## 실행 순서

Step 1 → 2 → 3 → 4.

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `parseGguf` | magic GGUF + kv{arch:qwen2} + 텐서 1 | `{version:3, metadata:{arch:qwen2}, tensors:{token_embd...}, dataStart}` |
| `parseGguf` | magic XXXX | throw "magic 불일치" |
| `parseGguf` | 잘린 버퍼 | throw "버퍼 경계 초과" |
| `ByteReader.str` | u64 len=5 + "hello" | `"hello"` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/gguf/types.ts
export enum GgufValueType { UINT8=0, ..., FLOAT64=12 }
export enum GgmlType { F32=0, F16=1 }
export interface TensorInfo { name: string; dims: number[]; type: GgmlType; offset: number; }
export interface GgufFile { version: number; metadata: Map<string, unknown>; tensors: Map<string, TensorInfo>; dataStart: number; }

// src/gguf/reader.ts
export class ByteReader {
  constructor(buf: Buffer);
  offset: number;
  u8/i8/u16/i16/u32/i32/u64/i64/f32/f64(): number;
  bool(): boolean;
  str(): string;
  ascii(n: number): string;
}

// src/gguf/parser.ts
export function parseGguf(buffer: Buffer): GgufFile;
```

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify ✓
- [ ] DoD-02: typecheck exit 0
- [ ] DoD-03: `npm test` 151 passed (기존 144 회귀 없음)
- [ ] DoD-04: 정상/에러(magic·버전·타입·경계)/array 재귀 테스트 동반
- [ ] DoD-05: 문서 갱신 불필요
- [ ] DoD-06: Phase 1 전제 만족 (parseGguf·GgufFile 노출)

## Observability plan

N/A — 순수 파싱 모듈.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 0 PASS"
```
