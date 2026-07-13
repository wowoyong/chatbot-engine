import { describe, expect, it } from 'vitest';
import { env } from 'node:process';
import { GgufModel } from '../../gguf/model.js';
import { BpeTokenizer } from '../bpe.js';

const FILE = env['GGUF_TEST_FILE'];

async function realTokenizer(): Promise<BpeTokenizer> {
  const model = await GgufModel.load(FILE as string);
  return new BpeTokenizer({
    tokens: model.metadataArray('tokenizer.ggml.tokens') as string[],
    merges: model.metadataArray('tokenizer.ggml.merges') as string[],
    tokenType: model.metadataArray('tokenizer.ggml.token_type') as number[],
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
