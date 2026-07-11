import { describe, expect, it } from 'vitest';
import { LlmResponseError } from '../errors.js';
import { parseNdjsonStream } from '../ndjson.js';

function bytesStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function textStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return bytesStream(chunks.map((c) => encoder.encode(c)));
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of iter) {
    out.push(piece);
  }
  return out;
}

describe('parseNdjsonStream', () => {
  it('완전한 라인들에서 content 조각을 순서대로 yield한다 (정상)', async () => {
    const stream = textStream([
      '{"message":{"content":"Hel"}}\n{"message":{"content":"lo"}}\n{"done":true}\n',
    ]);
    expect(await collect(parseNdjsonStream(stream))).toEqual(['Hel', 'lo']);
  });

  it('청크가 라인 중간에서 잘려도 버퍼링으로 복원한다 (경계값)', async () => {
    const stream = textStream([
      '{"message":{"con',
      'tent":"Hel"}}\n{"message',
      '":{"content":"lo"}}\n{"done":true}\n',
    ]);
    expect(await collect(parseNdjsonStream(stream))).toEqual(['Hel', 'lo']);
  });

  it('멀티바이트 문자(UTF-8 3바이트) 중간에서 잘려도 복원한다 (경계값)', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('{"message":{"content":"안녕"}}\n');
    // '{"message":{"content":"' 는 ASCII 23바이트, 그 다음 3바이트가 '안' — 24에서 자르면 문자 중간
    const splitAt = 24;
    const stream = bytesStream([bytes.slice(0, splitAt), bytes.slice(splitAt)]);
    expect(await collect(parseNdjsonStream(stream))).toEqual(['안녕']);
  });

  it('마지막 라인에 개행이 없어도 잔여 버퍼를 파싱한다 (경계값)', async () => {
    const stream = textStream(['{"message":{"content":"tail"}}']);
    expect(await collect(parseNdjsonStream(stream))).toEqual(['tail']);
  });

  it('error 라인을 만나면 LlmResponseError를 던진다 (에러)', async () => {
    const stream = textStream(['{"error":"model not found"}\n']);
    await expect(collect(parseNdjsonStream(stream))).rejects.toThrow(
      LlmResponseError,
    );
    const stream2 = textStream(['{"error":"model not found"}\n']);
    await expect(collect(parseNdjsonStream(stream2))).rejects.toThrow(
      'model not found',
    );
  });

  it('JSON이 아닌 라인을 만나면 LlmResponseError를 던진다 (에러)', async () => {
    const stream = textStream(['not-json\n']);
    await expect(collect(parseNdjsonStream(stream))).rejects.toThrow(
      LlmResponseError,
    );
  });

  it('content 없는 done 라인은 yield하지 않는다 (경계값)', async () => {
    const stream = textStream([
      '{"message":{"content":""},"done":false}\n{"done":true}\n',
    ]);
    expect(await collect(parseNdjsonStream(stream))).toEqual([]);
  });

  it('빈 스트림이면 아무것도 yield하지 않는다 (경계값)', async () => {
    const stream = textStream([]);
    expect(await collect(parseNdjsonStream(stream))).toEqual([]);
  });
});
