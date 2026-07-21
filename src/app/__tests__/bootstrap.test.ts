import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, Embedder, LlmClient } from '../../llm/types.js';
import { createApp } from '../bootstrap.js';

class FakeLlmClient implements LlmClient {
  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return '요약';
  }

  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string> {
    yield 'ok';
  }
}

class FakeEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0]);
  }
}

describe('createApp', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'a.md'), '# 제목\n본문', 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function envFor(): Record<string, string> {
    return {
      CHATBOT_SESSION_FILE: join(dir, 'session.json'),
      CHATBOT_INDEX_FILE: join(dir, 'index.json'),
      RAG_DOCS_DIR: join(dir, 'docs'),
    };
  }

  it('저장된 세션이 있으면 복원하고 notice를 남긴다 (정상)', async () => {
    const saved: ChatMessage[] = [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '답변' },
    ];
    await writeFile(
      join(dir, 'session.json'),
      JSON.stringify({ version: 1, history: saved, savedAt: 't' }),
      'utf8',
    );

    const app = await createApp(envFor(), {
      client: new FakeLlmClient(),
      embedder: new FakeEmbedder(),
    });

    expect(app.session.getHistory()).toEqual(saved);
    expect(app.startupNotices.join(' ')).toContain('이전 세션을 복원했습니다 — 1턴');
  });

  it('인덱스의 임베딩 모델이 다르면 무시하고 notice를 남긴다 (에러)', async () => {
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({ version: 2, model: '다른모델', createdAt: 't', sourceFingerprint: 'fp', chunks: [] }),
      'utf8',
    );

    const app = await createApp(envFor(), {
      client: new FakeLlmClient(),
      embedder: new FakeEmbedder(),
    });

    expect(app.startupNotices.join(' ')).toContain('달라 무시합니다');
  });

  it('rebuildIndex는 인덱스를 만들어 저장하고, 다음 createApp이 로드한다 (정상)', async () => {
    const app = await createApp(envFor(), {
      client: new FakeLlmClient(),
      embedder: new FakeEmbedder(),
    });

    const size = await app.rebuildIndex('2026-07-11');
    expect(size).toBe(1);

    const app2 = await createApp(envFor(), {
      client: new FakeLlmClient(),
      embedder: new FakeEmbedder(),
    });
    expect(app2.startupNotices.join(' ')).toContain('RAG 인덱스 로드: 1청크');
  });

  it('아무 파일도 없으면 notice 없이 빈 세션으로 시작한다 (경계값)', async () => {
    const app = await createApp(envFor(), {
      client: new FakeLlmClient(),
      embedder: new FakeEmbedder(),
    });

    expect(app.startupNotices).toEqual([]);
    expect(app.session.getHistory()).toEqual([]);
    expect(app.modelName).toBe('fake-llm');
  });

  it('문서가 index 저장 후 바뀌면 stale notice를 내고 load하지 않는다', async () => {
    const app = await createApp(envFor(), { client: new FakeLlmClient(), embedder: new FakeEmbedder() });
    await app.rebuildIndex('t0');
    await writeFile(join(dir, 'docs', 'a.md'), '# 제목\n변경됨');
    const stale = await createApp(envFor(), { client: new FakeLlmClient(), embedder: new FakeEmbedder() });
    expect(stale.startupNotices.join(' ')).toContain('문서보다 오래되어');
    expect(stale.startupNotices.join(' ')).not.toContain('RAG 인덱스 로드:');
  });

  it('구버전과 손상된 index는 서로 다른 notice를 남긴다', async () => {
    await writeFile(join(dir, 'index.json'), JSON.stringify({ version: 1, model: 'm', createdAt: 't', chunks: [] }));
    const old = await createApp(envFor(), { client: new FakeLlmClient(), embedder: new FakeEmbedder() });
    expect(old.startupNotices.join(' ')).toContain('구버전');
    await writeFile(join(dir, 'index.json'), '{broken');
    const invalid = await createApp(envFor(), { client: new FakeLlmClient(), embedder: new FakeEmbedder() });
    expect(invalid.startupNotices.join(' ')).toContain('손상');
  });

  it.each(['-1', '1.1', 'NaN'])('잘못된 RAG_MIN_VECTOR_SCORE=%s는 default notice를 낸다', async (value) => {
    const app = await createApp({ ...envFor(), RAG_MIN_VECTOR_SCORE: value }, {
      client: new FakeLlmClient(), embedder: new FakeEmbedder(),
    });
    expect(app.startupNotices.join(' ')).toContain('기본값(0.88)');
  });
});
