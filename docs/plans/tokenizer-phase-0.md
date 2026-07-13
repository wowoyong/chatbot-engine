# Phase 0: byte-level BPE 토크나이저

@fidelity-check tokens: bytesToUnicode, BpeTokenizer, encode, decode, mergeRanks

## 코드 예시 적용 규칙

1. ESM 상대 import에 `.js` 확장자 필수 (NodeNext)
2. `any` 금지 → `unknown` + 타입 가드
3. 런타임 의존성 추가 금지 (Node 내장 Buffer만)
4. 미사용 변수 금지
5. `noUncheckedIndexedAccess` 활성 — Map/배열 접근 가드

## 전제 조건

Segment 1이 노출한 인터페이스 (그대로 복사):

```ts
// src/gguf/model.ts
export class GgufModel {
  static fromBuffer(buffer: Buffer): GgufModel;
  static load(filePath: string): Promise<GgufModel>;
  hyperparams(): Hyperparams;
  // metadata 접근을 위해 본 Phase에서 tokenizerData() 추가 필요
}
```

**본 Phase는 GgufModel에 메타 접근자를 추가하지 않고**, 토크나이저를 `tokens/merges/tokenType` 배열을 직접 받는 순수 클래스로 설계 — GgufModel 무변경(Do Not Touch 유지). 호출측(Segment 4)이 메타에서 배열을 꺼내 생성자에 전달.

## 현재 상태

`src/tokenizer/` 없음. Qwen2 byte-level BPE: UTF-8 바이트 → GPT-2 byte-to-unicode 문자 → pretokenizer 정규식 분할 → merge rank로 BPE 병합 → vocab ID. 특수토큰은 정규식 이전에 분리.

## Testability Review

| 의존성 | 주입 가능 | mock/stub | 대안 |
|--------|----------|-----------|------|
| BpeTokenizer (tokens/merges 배열 주입) | ✓ (생성자) | ✓ (소형 vocab) | 실 vocab 불필요(단위) |
| 실 vocab 통합 | ✓ (GGUF에서 배열) | — | env `GGUF_TEST_FILE` 게이트 |

## Step 1: byte-level 매핑 (`src/tokenizer/bytes.ts` — create)

### Context

GPT-2 표준 bytes_to_unicode — 256 바이트를 유일 유니코드 문자로 매핑(출력 가능 바이트는 자기 자신, 나머지는 256+n). encode/decode 양방향.

### Code
```ts
/** GPT-2 byte→unicode 매핑 (256 바이트 → 유일 유니코드 문자) */
export function bytesToUnicode(): Map<number, string> {
  const bs: number[] = [];
  for (let i = 0x21; i <= 0x7e; i += 1) bs.push(i);
  for (let i = 0xa1; i <= 0xac; i += 1) bs.push(i);
  for (let i = 0xae; i <= 0xff; i += 1) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b += 1) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n += 1;
    }
  }
  const map = new Map<number, string>();
  for (let i = 0; i < bs.length; i += 1) {
    const byte = bs[i] ?? 0;
    const code = cs[i] ?? 0;
    map.set(byte, String.fromCodePoint(code));
  }
  return map;
}

/** unicode 문자 → byte 역매핑 */
export function unicodeToBytes(): Map<string, number> {
  const rev = new Map<string, number>();
  for (const [byte, ch] of bytesToUnicode()) {
    rev.set(ch, byte);
  }
  return rev;
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
grep -c "256 + n" src/tokenizer/bytes.ts
  # 기대: 1 (비출력 바이트 매핑)
```

### 동반 변경 (Side Effects)

새 export → 소비자 Step 2 BpeTokenizer + 테스트 Step 3.

### Do Not Touch

`src/gguf/**`, 기존 src.

## Step 2: BPE 토크나이저 (`src/tokenizer/bpe.ts` — create)

### Context

vocab/merges 배열로 encode/decode. pretokenizer 정규식(GPT-2/qwen2 계열, JS 호환), merge rank(배열 순서=우선), 특수토큰 선분리. decode는 control 특수토큰 skip.

### Code
```ts
import { bytesToUnicode, unicodeToBytes } from './bytes.js';

/** GPT-2/qwen2 계열 pretokenizer 정규식 (JS 호환) */
const PRETOKEN_RE =
  /(?:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface TokenizerConfig {
  tokens: string[];
  merges: string[];
  /** token_type 배열 (1=normal, 3=control) */
  tokenType?: number[];
}

export class BpeTokenizer {
  private readonly tokenToId = new Map<string, number>();
  private readonly idToToken: string[];
  private readonly mergeRanks = new Map<string, number>();
  private readonly byteEncoder = bytesToUnicode();
  private readonly byteDecoder = unicodeToBytes();
  private readonly specialTokens: string[];
  private readonly specialRe: RegExp | null;

  constructor(config: TokenizerConfig) {
    this.idToToken = config.tokens;
    for (let i = 0; i < config.tokens.length; i += 1) {
      const tok = config.tokens[i];
      if (tok !== undefined) this.tokenToId.set(tok, i);
    }
    for (let i = 0; i < config.merges.length; i += 1) {
      const m = config.merges[i];
      if (m !== undefined) this.mergeRanks.set(m, i);
    }
    // control 타입 토큰을 특수토큰으로 (선분리 대상)
    this.specialTokens = [];
    if (config.tokenType !== undefined) {
      for (let i = 0; i < config.tokens.length; i += 1) {
        if (config.tokenType[i] === 3) {
          const tok = config.tokens[i];
          if (tok !== undefined) this.specialTokens.push(tok);
        }
      }
    }
    this.specialRe =
      this.specialTokens.length > 0
        ? new RegExp(`(${this.specialTokens.map(escapeRegex).join('|')})`)
        : null;
  }

  /** 문자열을 (일반|특수) 조각으로 분리 */
  private splitSpecial(text: string): { text: string; special: boolean }[] {
    if (this.specialRe === null) {
      return [{ text, special: false }];
    }
    const out: { text: string; special: boolean }[] = [];
    for (const part of text.split(this.specialRe)) {
      if (part.length === 0) continue;
      out.push({ text: part, special: this.specialTokens.includes(part) });
    }
    return out;
  }

  /** byte-encoded 문자열에 merge를 반복 적용해 토큰 배열 반환 */
  private bpe(token: string): string[] {
    let word = Array.from(token);
    if (word.length < 2) return word;
    while (word.length >= 2) {
      let minRank = Infinity;
      let minIdx = -1;
      for (let i = 0; i < word.length - 1; i += 1) {
        const rank = this.mergeRanks.get(`${word[i]} ${word[i + 1]}`);
        if (rank !== undefined && rank < minRank) {
          minRank = rank;
          minIdx = i;
        }
      }
      if (minIdx === -1) break;
      word = [
        ...word.slice(0, minIdx),
        `${word[minIdx]}${word[minIdx + 1]}`,
        ...word.slice(minIdx + 2),
      ];
    }
    return word;
  }

  /** 텍스트 → 토큰 ID 배열 */
  encode(text: string): number[] {
    const ids: number[] = [];
    for (const seg of this.splitSpecial(text)) {
      if (seg.special) {
        const id = this.tokenToId.get(seg.text);
        if (id !== undefined) ids.push(id);
        continue;
      }
      for (const match of seg.text.matchAll(PRETOKEN_RE)) {
        const piece = match[0];
        const bytes = Buffer.from(piece, 'utf8');
        let encoded = '';
        for (const b of bytes) {
          encoded += this.byteEncoder.get(b) ?? '';
        }
        for (const tok of this.bpe(encoded)) {
          const id = this.tokenToId.get(tok);
          if (id !== undefined) ids.push(id);
        }
      }
    }
    return ids;
  }

  /** 토큰 ID 배열 → 텍스트 (control 특수토큰은 skip) */
  decode(ids: readonly number[]): string {
    const bytes: number[] = [];
    for (const id of ids) {
      const tok = this.idToToken[id];
      if (tok === undefined) continue;
      if (this.specialTokens.includes(tok)) continue; // 특수토큰 skip
      for (const ch of tok) {
        const b = this.byteDecoder.get(ch);
        if (b !== undefined) bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }

  tokenId(token: string): number | undefined {
    return this.tokenToId.get(token);
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
grep -c "splitSpecial\|specialTokens.includes" src/tokenizer/bpe.ts
  # 기대: 4 이상 (특수토큰 선분리·skip)
```

### 동반 변경 (Side Effects)

새 export → 테스트 Step 3, 소비자 Segment 3~4.

### Do Not Touch

`src/tokenizer/bytes.ts`.

## Step 3: 단위 테스트 (`src/tokenizer/__tests__/bpe.test.ts` — create)

### Code

### 검증 대상
- spy: N/A (순수)
- branch: byte 매핑 유일성, encode→decode 왕복(영/한/특수문자), 특수토큰 단일 ID, 빈 문자열, merge 적용
- state: 매핑 크기, 왕복 결과, 토큰 ID

```ts
import { describe, expect, it } from 'vitest';
import { bytesToUnicode, unicodeToBytes } from '../bytes.js';
import { BpeTokenizer } from '../bpe.js';

describe('bytesToUnicode', () => {
  it('256 바이트를 유일 유니코드로 매핑한다 (정상)', () => {
    const map = bytesToUnicode();
    expect(map.size).toBe(256);
    expect(new Set(map.values()).size).toBe(256);
  });

  it('역매핑이 왕복한다 (경계값)', () => {
    const fwd = bytesToUnicode();
    const rev = unicodeToBytes();
    for (const [b, ch] of fwd) expect(rev.get(ch)).toBe(b);
  });
});

/** 소형 vocab: byte 문자 전부 + 병합 몇 개 */
function smallTokenizer(): BpeTokenizer {
  const enc = bytesToUnicode();
  const tokens: string[] = [...enc.values()]; // 256 byte 문자
  const merges: string[] = [];
  // "hi" 병합 예시: h(byte) i(byte) 는 자기자신 문자 — merge "h i" 추가
  const h = enc.get('h'.charCodeAt(0))!;
  const i = enc.get('i'.charCodeAt(0))!;
  merges.push(`${h} ${i}`);
  tokens.push(`${h}${i}`); // 병합 토큰 = id 256
  // 특수토큰
  const special = '<|im_end|>';
  tokens.push(special); // id 257
  const tokenType = tokens.map((_, idx) => (idx === tokens.length - 1 ? 3 : 1));
  return new BpeTokenizer({ tokens, merges, tokenType });
}

describe('BpeTokenizer', () => {
  it('영어 왕복이 원문과 일치한다 (정상)', () => {
    const t = smallTokenizer();
    expect(t.decode(t.encode('hi there'))).toBe('hi there');
  });

  it('한글(멀티바이트) 왕복이 원문과 일치한다 (정상)', () => {
    const t = smallTokenizer();
    expect(t.decode(t.encode('안녕하세요'))).toBe('안녕하세요');
  });

  it('merge가 적용되어 "hi"가 단일 토큰이 된다 (정상)', () => {
    const t = smallTokenizer();
    const ids = t.encode('hi');
    expect(ids).toHaveLength(1); // 병합됨
  });

  it('특수토큰은 단일 ID로 encode되고 decode 시 skip된다 (경계값)', () => {
    const t = smallTokenizer();
    const ids = t.encode('a<|im_end|>b');
    expect(ids).toContain(t.tokenId('<|im_end|>'));
    expect(t.decode(ids)).toBe('ab'); // 특수토큰 skip
  });

  it('빈 문자열은 빈 배열 (경계값)', () => {
    const t = smallTokenizer();
    expect(t.encode('')).toEqual([]);
    expect(t.decode([])).toBe('');
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
  # 기대: 전체 164 passed (157 + 7)
# 3. 의미 검증
grep -c "decode(t.encode" src/tokenizer/__tests__/bpe.test.ts
  # 기대: 2 이상 (왕복 검증)
```

### 동반 변경 (Side Effects)

N/A (Step 1·2의 동반 테스트)

### Do Not Touch

`src/tokenizer/bpe.ts`, `src/tokenizer/bytes.ts`.

## Step 4: 실파일 통합 테스트 (`src/tokenizer/__tests__/bpe.integration.test.ts` — create)

### Context

실 vocab(GGUF)로 특수토큰 단일 ID(AC3)·한글 왕복·알려진 문자열 spot-check(AC4). env `GGUF_TEST_FILE` 게이트로 CI 무영향.

### Code

### 검증 대상
- spy: N/A
- branch: 실 vocab 특수토큰, 한글 왕복, 알려진 토큰
- state: 토큰 ID, 왕복 결과

```ts
import { describe, expect, it } from 'vitest';
import { env } from 'node:process';
import { GgufModel } from '../../gguf/model.js';
import { BpeTokenizer } from '../bpe.js';

const FILE = env['GGUF_TEST_FILE'];

async function realTokenizer(): Promise<BpeTokenizer> {
  const model = await GgufModel.load(FILE as string);
  const meta = (model as unknown as { gguf: { metadata: Map<string, unknown> } }).gguf.metadata;
  return new BpeTokenizer({
    tokens: meta.get('tokenizer.ggml.tokens') as string[],
    merges: meta.get('tokenizer.ggml.merges') as string[],
    tokenType: meta.get('tokenizer.ggml.token_type') as number[],
  });
}

describe.skipIf(FILE === undefined)('BpeTokenizer 통합 (실 vocab)', () => {
  it('특수토큰 <|im_end|>가 단일 ID 151645로 encode (정상)', async () => {
    const t = await realTokenizer();
    expect(t.encode('<|im_end|>')).toEqual([151645]);
  });

  it('한글 문장이 왕복한다 (정상)', async () => {
    const t = await realTokenizer();
    const s = '안녕하세요, 반갑습니다!';
    expect(t.decode(t.encode(s))).toBe(s);
  });

  it('영어 문장이 왕복한다 (정상)', async () => {
    const t = await realTokenizer();
    const s = 'Hello, world! This is a test.';
    expect(t.decode(t.encode(s))).toBe(s);
  });
});
```

> **참고**: 통합 테스트가 GgufModel private `gguf` 필드에 접근한다. 본 Phase에서 GgufModel을 수정하지 않기 위한 임시 접근 — Segment 4에서 GgufModel에 `metadataArray(key)` 공개 접근자를 추가하고 이 테스트를 정리한다 (해당 Segment의 Do Not Touch에 명시). 지금은 캐스팅으로 통합 검증만 수행.

### Anchor

N/A — 새 파일

### Verify
```bash
# 1. 빌드
npm run typecheck 2>&1 | tail -3
  # 기대: 에러 없음
# 2. 테스트
npm test 2>&1 | tail -3
  # 기대: 164 passed (통합 skip — 회귀 없음)
# 3. 의미 검증
BLOB="$HOME/.ollama/models/blobs/sha256-6f96e01a3f550ca08aea1e5725bb8d5a7eccc6f281c30417e9d380b8c46467bd"
GGUF_TEST_FILE="$BLOB" npx vitest run src/tokenizer/__tests__/bpe.integration.test.ts 2>&1 | grep -E "Tests|✓" | tail -4
  # 기대: 통합 3 테스트 통과 (특수토큰 151645, 한글·영어 왕복)
```

### 동반 변경 (Side Effects)

N/A (Step 2의 동반 통합 테스트)

### Do Not Touch

`src/tokenizer/bpe.ts`, `src/gguf/**`.

## 실행 순서

Step 1 → 2 → 3 → 4.

## 입출력 예제

| 함수 | 입력 | 출력 |
|------|------|------|
| `bytesToUnicode` | — | Map size 256, 유일 값 |
| `encode` | `'<|im_end|>'` (실 vocab) | `[151645]` |
| `encode`+`decode` | `'안녕하세요'` | `'안녕하세요'` (왕복) |
| `encode` | `''` | `[]` |

## 이 Phase 완료 후 노출 인터페이스

```ts
// src/tokenizer/bytes.ts
export function bytesToUnicode(): Map<number, string>;
export function unicodeToBytes(): Map<string, number>;

// src/tokenizer/bpe.ts
export interface TokenizerConfig { tokens: string[]; merges: string[]; tokenType?: number[]; }
export class BpeTokenizer {
  constructor(config: TokenizerConfig);
  encode(text: string): number[];
  decode(ids: readonly number[]): string;
  tokenId(token: string): number | undefined;
}
```

## Definition of Done

- [ ] DoD-01: 모든 Step 통과 + Verify ✓
- [ ] DoD-02: typecheck exit 0
- [ ] DoD-03: `npm test` 164 passed (기존 157 회귀 없음)
- [ ] DoD-04: byte 매핑·왕복·특수토큰·빈입력 테스트 동반
- [ ] DoD-05: 실 vocab 통합(특수토큰 ID·한글 왕복)으로 AC3/AC4 검증
- [ ] DoD-06: Segment 3 전제 만족 (encode/decode 노출)

## Observability plan

N/A — 순수 변환 모듈.

## 최종 검증

```bash
npm run typecheck && npm test && echo "PHASE 0 PASS"
GGUF_TEST_FILE="$HOME/.ollama/models/blobs/sha256-6f96e01a3f550ca08aea1e5725bb8d5a7eccc6f281c30417e9d380b8c46467bd" npx vitest run src/tokenizer 2>&1 | tail -3
```
