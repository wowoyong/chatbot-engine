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
