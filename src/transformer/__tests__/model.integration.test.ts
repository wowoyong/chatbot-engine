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
