import { describe, expect, it, vi } from 'vitest';
import { LlmConnectionError, LlmResponseError } from '../errors.js';
import { OllamaClient } from '../ollama-client.js';
import type { ChatMessage } from '../types.js';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: '안녕' }];

function ndjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe('OllamaClient', () => {
  it('스트림 조각을 합쳐 전체 응답을 반환하고 올바른 요청을 보낸다 (정상)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      ndjsonResponse([
        '{"message":{"content":"안녕"}}',
        '{"message":{"content":"하세요"}}',
        '{"done":true}',
      ]),
    );
    const client = new OllamaClient({ fetchFn });

    const result = await client.chat(MESSAGES);

    expect(result).toBe('안녕하세요');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls[0];
    expect(call).toBeDefined();
    expect(String(call?.[0])).toBe('http://localhost:11434/api/chat');
    const body: unknown = JSON.parse(String(call?.[1]?.body));
    expect(body).toMatchObject({
      model: 'qwen3:8b',
      stream: true,
      think: false,
      messages: [{ role: 'user', content: '안녕' }],
    });
  });

  it('think 옵션이 body에 그대로 전달된다 (정상)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      ndjsonResponse(['{"done":true}']),
    );
    const client = new OllamaClient({ fetchFn });

    await client.chat(MESSAGES, { think: true });

    const body: unknown = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ think: true });
  });

  it('연결이 거부되면 LlmConnectionError로 감싸 던진다 (에러)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      throw new TypeError('fetch failed');
    });
    const client = new OllamaClient({ fetchFn, baseUrl: 'http://localhost:9' });

    await expect(client.chat(MESSAGES)).rejects.toThrow(LlmConnectionError);
    await expect(client.chat(MESSAGES)).rejects.toThrow('연결할 수 없습니다');
  });

  it('HTTP 에러 상태면 LlmResponseError에 status를 담아 던진다 (에러)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response('model "x" not found', { status: 404 }),
    );
    const client = new OllamaClient({ fetchFn });

    const error = await client.chat(MESSAGES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmResponseError);
    expect((error as LlmResponseError).status).toBe(404);
  });

  it('응답 본문이 null이면 LlmResponseError를 던진다 (경계값)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
    );
    const client = new OllamaClient({ fetchFn });

    await expect(client.chat(MESSAGES)).rejects.toThrow(LlmResponseError);
  });

  it('baseUrl과 model 설정이 요청에 반영된다 (경계값)', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      ndjsonResponse(['{"done":true}']),
    );
    const client = new OllamaClient({
      fetchFn,
      baseUrl: 'http://mac-mini:11434',
      model: 'qwen3:14b',
    });

    await client.chat(MESSAGES);

    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      'http://mac-mini:11434/api/chat',
    );
    const body: unknown = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ model: 'qwen3:14b' });
  });
});
