import { describe, expect, it } from 'vitest';
import { parseNdjsonStream } from '../ndjson.js';

function textStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

async function drain(iter: AsyncGenerator<string, { promptTokens?: number; responseTokens?: number }>) {
  const pieces: string[] = [];
  let r = await iter.next();
  while (r.done !== true) {
    pieces.push(r.value);
    r = await iter.next();
  }
  return { pieces, stats: r.value };
}

describe('parseNdjsonStream 통계', () => {
  it('done 라인의 prompt_eval_count/eval_count를 return한다 (정상)', async () => {
    const stream = textStream([
      '{"message":{"content":"안녕"}}\n{"done":true,"prompt_eval_count":12,"eval_count":34}\n',
    ]);
    const { pieces, stats } = await drain(parseNdjsonStream(stream));
    expect(pieces).toEqual(['안녕']);
    expect(stats).toEqual({ promptTokens: 12, responseTokens: 34 });
  });

  it('통계가 없으면 빈 객체를 return한다 (경계값)', async () => {
    const stream = textStream(['{"message":{"content":"x"}}\n']);
    const { stats } = await drain(parseNdjsonStream(stream));
    expect(stats.promptTokens).toBeUndefined();
  });
});
