import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, LlmClient } from '../../llm/types.js';
import { ChatSession } from '../session.js';

class StatsClient implements LlmClient {
  async chat(): Promise<string> {
    return 'x';
  }
  async *chatStream(
    _m: ChatMessage[],
    _o?: ChatOptions,
  ): AsyncGenerator<string, { promptTokens?: number; responseTokens?: number }> {
    yield '안';
    yield '녕';
    return { promptTokens: 5, responseTokens: 2 };
  }
}

async function drainSend(gen: AsyncGenerator<string, unknown>) {
  const pieces: string[] = [];
  let r = await gen.next();
  while (r.done !== true) {
    pieces.push(r.value);
    r = await gen.next();
  }
  return { pieces, meta: r.value };
}

describe('ChatSession TurnMeta', () => {
  it('완료 시 출처와 토큰 수를 return한다 (정상)', async () => {
    const session = new ChatSession(new StatsClient(), {
      retriever: {
        retrieve: async () => ({
          block: '[doc.md]\n발췌',
          hits: [{ chunk: { source: 'doc.md', heading: '설치' } }],
        }),
      },
    });
    const { pieces, meta } = await drainSend(session.send('질문'));
    expect(pieces).toEqual(['안', '녕']);
    expect(meta).toEqual({
      sources: [{ source: 'doc.md', heading: '설치' }],
      promptTokens: 5,
      responseTokens: 2,
    });
  });

  it('retriever가 없으면 출처는 빈 배열 (경계값)', async () => {
    const session = new ChatSession(new StatsClient());
    const { meta } = await drainSend(session.send('질문'));
    expect((meta as { sources: unknown[] }).sources).toEqual([]);
  });

  it('retrieved metadata title/resource를 TurnMeta로 반환한다', async () => {
    const session = new ChatSession(new StatsClient(), {
      retriever: {
        async retrieve() {
          return {
            block: 'context',
            hits: [{ chunk: { source: 'doc.md', heading: '설치', metadata: {
              title: '설치 가이드', resource: 'https://example.com/docs/install',
            } } }],
          };
        },
      },
    });
    const { meta } = await drainSend(session.send('질문'));
    expect((meta as { sources: unknown[] }).sources).toEqual([{
      source: 'doc.md', heading: '설치', title: '설치 가이드', resource: 'https://example.com/docs/install',
    }]);
  });
});
