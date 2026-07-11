import { describe, expect, it, vi } from 'vitest';
import { LlmConnectionError, LlmResponseError } from '../errors.js';
import { OllamaEmbedder } from '../ollama-embedder.js';

function embedResponse(embeddings: number[][]): Response {
  return new Response(JSON.stringify({ embeddings }), { status: 200 });
}

describe('OllamaEmbedder', () => {
  it('입력 순서대로 임베딩을 반환하고 올바른 요청을 보낸다 (정상)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      embedResponse([[1, 0], [0, 1]]),
    );
    const embedder = new OllamaEmbedder({ fetchFn });

    const result = await embedder.embed(['하나', '둘']);

    expect(result).toEqual([[1, 0], [0, 1]]);
    expect(String(fetchFn.mock.calls.at(0)?.[0])).toBe(
      'http://localhost:11434/api/embed',
    );
    const body: unknown = JSON.parse(String(fetchFn.mock.calls.at(0)?.[1]?.body));
    expect(body).toEqual({ model: 'nomic-embed-text', input: ['하나', '둘'] });
  });

  it('batchSize 단위로 나눠 요청하고 결과를 이어붙인다 (정상)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body));
      const input = (body as { input: string[] }).input;
      return embedResponse(input.map((_, i) => [i]));
    });
    const embedder = new OllamaEmbedder({ fetchFn, batchSize: 2 });

    const result = await embedder.embed(['a', 'b', 'c']);

    expect(fetchFn).toHaveBeenCalledTimes(2); // [a,b] + [c]
    expect(result).toEqual([[0], [1], [0]]);
  });

  it('연결 실패는 LlmConnectionError로 감싼다 (에러)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      throw new TypeError('fetch failed');
    });
    const embedder = new OllamaEmbedder({ fetchFn });

    await expect(embedder.embed(['x'])).rejects.toThrow(LlmConnectionError);
  });

  it('HTTP 에러 상태는 LlmResponseError를 던진다 (에러)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response('boom', { status: 500 }),
    );
    const embedder = new OllamaEmbedder({ fetchFn });

    const error = await embedder.embed(['x']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmResponseError);
    expect((error as LlmResponseError).status).toBe(500);
  });

  it('응답 임베딩 수가 요청과 다르면 LlmResponseError를 던진다 (에러)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      embedResponse([[1]]),
    );
    const embedder = new OllamaEmbedder({ fetchFn });

    await expect(embedder.embed(['a', 'b'])).rejects.toThrow('임베딩 수 불일치');
  });

  it('빈 입력이면 fetch 없이 빈 배열을 반환한다 (경계값)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      embedResponse([]),
    );
    const embedder = new OllamaEmbedder({ fetchFn });

    expect(await embedder.embed([])).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
