import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app/bootstrap.js';
import type { App } from '../../app/bootstrap.js';
import type { ChatMessage, ChatOptions, Embedder, LlmClient } from '../../llm/types.js';
import { createChatServer, isLoopbackAddress } from '../http-server.js';

class FakeLlmClient implements LlmClient {
  pieces: string[] = ['안녕', '하세요'];
  delayMs = 0;
  fail = false;

  chatResult = '요약';

  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return this.chatResult;
  }

  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string, { promptTokens?: number; responseTokens?: number }> {
    for (const piece of this.pieces) {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.fail) {
        throw new Error('llm down');
      }
      yield piece;
    }
    return { promptTokens: 11, responseTokens: 22 };
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
  let app: App;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'a.md'), '# 제목\n본문', 'utf8');
    fake = new FakeLlmClient();
    app = await createApp(
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

  function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function postRaw(path: string, body: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
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

  it('POST /api/capture가 새 지식을 저장하고 결과를 반환한다 (정상)', async () => {
    await (await postChat('질문')).text(); // 히스토리 생성
    fake.chatResult =
      '[{"title":"캡처 지식","category":"fact","content":"새 내용"}]';

    const res = await fetch(`${baseUrl}/api/capture`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      extracted: number;
      saved: string[];
      skipped: string[];
      indexUpdated: boolean;
    };
    expect(data.extracted).toBe(1);
    expect(data.saved).toHaveLength(1);
    expect(data.indexUpdated).toBe(true);
    expect(data.saved.at(0)).toContain(join('captured', 'fact'));
  });

  it('추출 출력이 불량이면 500을 반환하고 서버는 살아있다 (에러)', async () => {
    await (await postChat('질문')).text();
    fake.chatResult = '지식 없음';

    const res = await fetch(`${baseUrl}/api/capture`, { method: 'POST' });
    expect(res.status).toBe(500);

    expect((await fetch(`${baseUrl}/api/history`)).status).toBe(200);
  });

  it('done 이벤트에 토큰 usage를 담는다 (정상)', async () => {
    const res = await postChat('질문');
    const text = await res.text();
    expect(text).toContain('event: done');
    expect(text).toContain('"promptTokens":11');
    expect(text).toContain('"responseTokens":22');
  });

  it('retriever가 없으면 sources 이벤트를 보내지 않는다 (경계값)', async () => {
    const res = await postChat('질문');
    const text = await res.text();
    expect(text).not.toContain('event: sources');
  });

  it('GET /api/captured가 목록을 반환한다 (정상)', async () => {
    const res = await fetch(`${baseUrl}/api/captured`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(data.items)).toBe(true);
  });

  it('sources SSE에 OKF title/resource를 포함한다', async () => {
    await writeFile(
      join(dir, 'docs', 'a.md'),
      '---\ntype: Reference\ntitle: "설치 가이드"\nresource: "https://example.com/install"\ntags: [install]\n---\n\n# 설치\n본문',
    );
    await app.rebuildIndex('t');
    const text = await (await postChat('설치 본문')).text();
    expect(text).toContain('event: sources');
    expect(text).toContain('"title":"설치 가이드"');
    expect(text).toContain('"resource":"https://example.com/install"');
  });

  it('draft id를 승인하고 index 결과를 반환한다', async () => {
    await (await postChat('질문')).text();
    fake.chatResult = '[{"title":"승인 항목","category":"fact","content":"새 내용"}]';
    await (await fetch(`${baseUrl}/api/capture`, { method: 'POST' })).json();
    const list = (await (await fetch(`${baseUrl}/api/captured`)).json()) as {
      items: { id: string; status: string }[];
    };
    const draft = list.items.find((entry) => entry.status === 'draft');
    if (draft === undefined) throw new Error('expected draft');
    const response = await postJson('/api/captured/approve', { id: draft.id });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      entry: { id: draft.id, status: 'verified' }, indexUpdated: true,
    });
  });

  it.each([
    ['../secret.md', 400, 'INVALID_ID'],
    ['concept/missing.md', 404, 'NOT_FOUND'],
  ] as const)('approve id=%s를 %i로 매핑한다', async (id, status, code) => {
    const response = await postJson('/api/captured/approve', { id });
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code });
  });

  it('legacy verified 항목 승인은 409 NOT_DRAFT다', async () => {
    await mkdir(join(dir, 'docs', 'captured', 'concept'), { recursive: true });
    await writeFile(join(dir, 'docs', 'captured', 'concept', 'legacy.md'), '# Legacy');
    const response = await postJson('/api/captured/approve', { id: 'concept/legacy.md' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'NOT_DRAFT' });
  });

  it('malformed JSON과 empty id는 400이다', async () => {
    expect((await postRaw('/api/captured/approve', '{')).status).toBe(400);
    expect((await postJson('/api/captured/approve', { id: '' })).status).toBe(400);
  });
});

describe('isLoopbackAddress', () => {
  it('IPv4/IPv6 loopback만 승인한다', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.0.10')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
