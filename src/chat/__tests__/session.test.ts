import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, LlmClient } from '../../llm/types.js';
import { ChatSession } from '../session.js';

class FakeLlmClient implements LlmClient {
  readonly calls: ChatMessage[][] = [];
  pieces: string[] = [];
  failAfter: number | null = null;

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    let result = '';
    for await (const piece of this.chatStream(messages, options)) {
      result += piece;
    }
    return result;
  }

  async *chatStream(
    messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string> {
    this.calls.push(messages);
    let index = 0;
    for (const piece of this.pieces) {
      if (this.failAfter !== null && index >= this.failAfter) {
        throw new Error('stream broken');
      }
      index += 1;
      yield piece;
    }
  }
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of iter) {
    out.push(piece);
  }
  return out;
}

describe('ChatSession', () => {
  it('응답 완료 후 (user, assistant) 쌍을 히스토리에 기록하고, 다음 턴에 히스토리를 포함해 보낸다 (정상)', async () => {
    const fake = new FakeLlmClient();
    fake.pieces = ['안녕', '하세요'];
    const session = new ChatSession(fake, { systemPrompt: 'SYS' });

    const pieces = await collect(session.send('인사해'));

    expect(pieces).toEqual(['안녕', '하세요']);
    expect(session.getHistory()).toEqual([
      { role: 'user', content: '인사해' },
      { role: 'assistant', content: '안녕하세요' },
    ]);

    fake.pieces = ['네'];
    await collect(session.send('한 번 더'));

    const secondCall = fake.calls[1];
    expect(secondCall).toBeDefined();
    expect(secondCall).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '인사해' },
      { role: 'assistant', content: '안녕하세요' },
      { role: 'user', content: '한 번 더' },
    ]);
  });

  it('systemPrompt가 있으면 매 요청의 첫 메시지로 포함된다 (정상)', async () => {
    const fake = new FakeLlmClient();
    fake.pieces = ['ok'];
    const session = new ChatSession(fake, { systemPrompt: 'SYS' });

    await collect(session.send('hi'));

    expect(fake.calls[0]?.[0]).toEqual({ role: 'system', content: 'SYS' });
  });

  it('systemPrompt가 없으면 system 메시지를 보내지 않는다 (경계값)', async () => {
    const fake = new FakeLlmClient();
    fake.pieces = ['ok'];
    const session = new ChatSession(fake);

    await collect(session.send('hi'));

    expect(fake.calls[0]?.[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('스트림이 중간에 실패하면 히스토리를 기록하지 않는다 (에러)', async () => {
    const fake = new FakeLlmClient();
    fake.pieces = ['조각1', '조각2'];
    fake.failAfter = 1;
    const session = new ChatSession(fake, { systemPrompt: 'SYS' });

    const received: string[] = [];
    let caught: unknown = null;
    try {
      for await (const piece of session.send('질문')) {
        received.push(piece);
      }
    } catch (err) {
      caught = err;
    }

    expect(received).toEqual(['조각1']);
    expect(caught).toBeInstanceOf(Error);
    expect(session.getHistory()).toEqual([]);
  });

  it('clear()는 히스토리를 비우고 다음 요청은 히스토리 없이 보낸다 (경계값)', async () => {
    const fake = new FakeLlmClient();
    fake.pieces = ['ok'];
    const session = new ChatSession(fake);

    await collect(session.send('첫 질문'));
    expect(session.getHistory()).toHaveLength(2);

    session.clear();
    expect(session.getHistory()).toEqual([]);

    fake.pieces = ['ok2'];
    await collect(session.send('새 질문'));
    expect(fake.calls[1]).toEqual([{ role: 'user', content: '새 질문' }]);
  });

  it('컨텍스트 예산 초과 시 이전 대화가 요약 메시지로 압축되어 전송된다 (정상)', async () => {
    const streamCalls: ChatMessage[][] = [];
    const tinyClient: LlmClient = {
      async chat() {
        return '파란색 선호';
      },
      async *chatStream(messages: ChatMessage[]) {
        streamCalls.push(messages);
        yield 'ok';
      },
    };
    const session = new ChatSession(tinyClient, {
      context: { maxContextTokens: 0, reserveTokens: 0 },
    });

    await collect(session.send('첫 질문'));
    await collect(session.send('둘째 질문'));

    expect(streamCalls.at(1)).toEqual([
      { role: 'system', content: '이전 대화 요약: 파란색 선호' },
      { role: 'user', content: '둘째 질문' },
    ]);
  });

  it('clear() 후에는 요약 메시지 없이 전송된다 (경계값)', async () => {
    const streamCalls: ChatMessage[][] = [];
    const tinyClient: LlmClient = {
      async chat() {
        return '요약';
      },
      async *chatStream(messages: ChatMessage[]) {
        streamCalls.push(messages);
        yield 'ok';
      },
    };
    const session = new ChatSession(tinyClient, {
      context: { maxContextTokens: 0, reserveTokens: 0 },
    });

    await collect(session.send('첫 질문'));
    session.clear();
    await collect(session.send('새 질문'));

    expect(streamCalls.at(1)).toEqual([{ role: 'user', content: '새 질문' }]);
  });
});
