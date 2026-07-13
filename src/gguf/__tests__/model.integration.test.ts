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
  }, 30000);
});
