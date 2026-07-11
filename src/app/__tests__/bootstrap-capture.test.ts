import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, Embedder, LlmClient } from '../../llm/types.js';
import { createApp } from '../bootstrap.js';

class FakeLlmClient implements LlmClient {
  chatResult = '[]';

  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return this.chatResult;
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

const HISTORY: ChatMessage[] = [
  { role: 'user', content: '질문' },
  { role: 'assistant', content: '답변' },
];

const CANDIDATE_JSON =
  '[{"title":"새 지식","category":"fact","content":"완전히 새로운 내용"}]';

describe('App.captureKnowledge', () => {
  let dir: string;
  let fake: FakeLlmClient;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(join(dir, 'docs'), { recursive: true });
    fake = new FakeLlmClient();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeApp() {
    const app = await createApp(
      {
        CHATBOT_SESSION_FILE: join(dir, 'session.json'),
        CHATBOT_INDEX_FILE: join(dir, 'index.json'),
        RAG_DOCS_DIR: join(dir, 'docs'),
      },
      { client: fake, embedder: new FakeEmbedder() },
    );
    return app;
  }

  it('새 지식을 저장하고 재인덱싱한다 (정상)', async () => {
    fake.chatResult = CANDIDATE_JSON;
    const app = await makeApp();
    app.session.restore(HISTORY);

    const result = await app.captureKnowledge('2026-07-11');

    expect(result.extracted).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.saved).toEqual([join(dir, 'docs', 'captured', 'fact', '새-지식.md')]);
    await access(result.saved.at(0) ?? ''); // 파일 실재
    await access(join(dir, 'index.json')); // 재인덱싱 산출

    const app2 = await makeApp();
    expect(app2.startupNotices.join(' ')).toContain('RAG 인덱스 로드: 1청크');
  });

  it('기존 인덱스와 유사한 지식은 스킵하고 재인덱싱하지 않는다 (정상)', async () => {
    fake.chatResult = CANDIDATE_JSON;
    // 기존 지식이 담긴 인덱스 구성 (FakeEmbedder는 모든 텍스트를 [1,0]으로 — 유사도 1)
    await writeFile(join(dir, 'docs', 'existing.md'), '# 기존\n지식', 'utf8');
    const seed = await makeApp();
    await seed.rebuildIndex('t0');

    const app = await makeApp();
    app.session.restore(HISTORY);
    const result = await app.captureKnowledge('2026-07-11');

    expect(result.saved).toEqual([]);
    expect(result.skipped).toEqual(['새 지식']);
    let capturedExists = true;
    try {
      await access(join(dir, 'docs', 'captured'));
    } catch {
      capturedExists = false;
    }
    expect(capturedExists).toBe(false);
  });

  it('추출 출력이 불량이면 throw한다 — 호출측 안내 책임 (에러)', async () => {
    fake.chatResult = '추출할 지식이 없네요.';
    const app = await makeApp();
    app.session.restore(HISTORY);

    await expect(app.captureKnowledge('t')).rejects.toThrow('찾지 못했습니다');
  });

  it('빈 히스토리면 추출 0건으로 조용히 끝난다 (경계값)', async () => {
    const app = await makeApp();
    const result = await app.captureKnowledge('t');
    expect(result).toEqual({ extracted: 0, saved: [], skipped: [] });
  });
});
