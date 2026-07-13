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
