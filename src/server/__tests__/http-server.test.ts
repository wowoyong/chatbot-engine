import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app/bootstrap.js';
import type { ChatMessage, ChatOptions, Embedder, LlmClient } from '../../llm/types.js';
import { createChatServer } from '../http-server.js';

class FakeLlmClient implements LlmClient {
  pieces: string[] = ['안녕', '하세요'];
  delayMs = 0;
  fail = false;

  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return '요약';
  }

  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string> {
    for (const piece of this.pieces) {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.fail) {
        throw new Error('llm down');
      }
      yield piece;
    }
  }
}

class FakeEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0]);
  }
}

describe('createChatServer', () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;
  let fake: FakeLlmClient;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'a.md'), '# 제목\n본문', 'utf8');
    fake = new FakeLlmClient();
    const app = await createApp(
      {
        CHATBOT_SESSION_FILE: join(dir, 'session.json'),
        CHATBOT_INDEX_FILE: join(dir, 'index.json'),
        RAG_DOCS_DIR: join(dir, 'docs'),
      },
      { client: fake, embedder: new FakeEmbedder() },
    );
    server = createChatServer({ app, indexHtmlPath: join(dir, 'index.html') });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  function postChat(message: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  }

  it('SSE로 조각을 스트리밍하고 done 이벤트로 끝나며 세션을 저장한다 (정상)', async () => {
    const res = await postChat('질문');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data: {"piece":"안녕"}');
    expect(text).toContain('data: {"piece":"하세요"}');
    expect(text.indexOf('event: done')).toBeGreaterThan(text.indexOf('하세요'));

    const saved: unknown = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'));
    expect((saved as { history: ChatMessage[] }).history).toHaveLength(2);
  });

  it('message가 없거나 빈 문자열이면 400 (에러)', async () => {
    expect((await postChat('')).status).toBe(400);
    expect((await postChat(123)).status).toBe(400);
  });

  it('응답 생성 중 새 채팅 요청은 409 (에러)', async () => {
    fake.delayMs = 40;
    const first = postChat('느린 질문');
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await postChat('끼어들기');
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
    await (await first).text();
  });

  it('스트림 실패 시 error 이벤트를 보내고 서버는 살아있다 (에러)', async () => {
    fake.fail = true;
    const res = await postChat('질문');
    const text = await res.text();
    expect(text).toContain('event: error');
    expect(text).toContain('llm down');

    fake.fail = false;
    const retry = await postChat('재시도');
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('event: done');
  });

  it('GET /api/history가 대화 후 히스토리를 반환한다 (정상)', async () => {
    await (await postChat('질문')).text();
    const res = await fetch(`${baseUrl}/api/history`);
    const data = (await res.json()) as { history: ChatMessage[] };
    expect(data.history).toHaveLength(2);
    expect(data.history.at(1)?.content).toBe('안녕하세요');
  });

  it('POST /api/clear가 히스토리와 세션 파일을 비운다 (정상)', async () => {
    await (await postChat('질문')).text();
    const res = await fetch(`${baseUrl}/api/clear`, { method: 'POST' });
    expect(res.status).toBe(200);
    const history = (await (await fetch(`${baseUrl}/api/history`)).json()) as {
      history: ChatMessage[];
    };
    expect(history.history).toEqual([]);
  });

  it('POST /api/index가 재인덱싱하고 청크 수를 반환한다 (정상)', async () => {
    const res = await fetch(`${baseUrl}/api/index`, { method: 'POST' });
    const data = (await res.json()) as { chunks: number };
    expect(data.chunks).toBe(1);
  });

  it('GET /는 UI 파일을 서빙하고, 없으면 404, 미지정 경로도 404 (경계값)', async () => {
    expect((await fetch(`${baseUrl}/`)).status).toBe(404);
    await writeFile(join(dir, 'index.html'), '<h1>ui</h1>', 'utf8');
    const ok = await fetch(`${baseUrl}/`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('<h1>ui</h1>');
    expect((await fetch(`${baseUrl}/none`)).status).toBe(404);
  });
});
