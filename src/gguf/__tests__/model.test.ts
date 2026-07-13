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
    else if (type === 6) {
      const b = Buffer.alloc(4);
      b.writeFloatLE(Number(value));
      parts.push(b);
    }
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
