import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, LlmClient } from '../../llm/types.js';
import { ContextManager, SUMMARY_ALLOWANCE } from '../context-manager.js';
import { estimateMessagesTokens } from '../token-estimate.js';

class FakeLlmClient implements LlmClient {
  readonly chatCalls: ChatMessage[][] = [];
  summaryText = '요약문';
  failChat = false;

  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    this.chatCalls.push(messages);
    if (this.failChat) {
      throw new Error('summary failed');
    }
    return this.summaryText;
  }

  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string> {
    yield 'ok';
  }
}

function pair(n: number): ChatMessage[] {
  return [
    { role: 'user', content: `질문${n}` },
    { role: 'assistant', content: `답변${n}` },
  ];
}

const USER: ChatMessage = { role: 'user', content: '새 질문' };

/** pair(2)만 kept되고 pair(1)은 dropped되는 정확한 예산 구성 */
function budgetForLastPairOnly(): number {
  return (
    SUMMARY_ALLOWANCE +
    estimateMessagesTokens([USER]) +
    estimateMessagesTokens(pair(2))
  );
}

describe('ContextManager', () => {
  it('예산 내면 히스토리 전체를 그대로 보내고 요약하지 않는다 (정상)', async () => {
    const fake = new FakeLlmClient();
    const manager = new ContextManager(fake);
    const history = [...pair(1)];

    const result = await manager.prepare(null, history, USER.content);

    expect(result.summarized).toBe(false);
    expect(result.messages).toEqual([...pair(1), USER]);
    expect(fake.chatCalls).toHaveLength(0);
  });

  it('예산 초과 시 dropped를 요약해 system 메시지로 삽입한다 (정상)', async () => {
    const fake = new FakeLlmClient();
    const manager = new ContextManager(fake, {
      maxContextTokens: budgetForLastPairOnly(),
      reserveTokens: 0,
    });
    const history = [...pair(1), ...pair(2)];

    const result = await manager.prepare(null, history, USER.content);

    expect(result.summarized).toBe(true);
    expect(result.messages).toEqual([
      { role: 'system', content: '이전 대화 요약: 요약문' },
      ...pair(2),
      USER,
    ]);
    expect(fake.chatCalls).toHaveLength(1);
    expect(fake.chatCalls.at(0)?.at(1)?.content).toContain('질문1');
  });

  it('dropped 범위가 같으면 요약을 재호출하지 않는다 — 캐시 (정상)', async () => {
    const fake = new FakeLlmClient();
    const manager = new ContextManager(fake, {
      maxContextTokens: budgetForLastPairOnly(),
      reserveTokens: 0,
    });
    const history = [...pair(1), ...pair(2)];

    await manager.prepare(null, history, USER.content);
    await manager.prepare(null, history, USER.content);

    expect(fake.chatCalls).toHaveLength(1);
  });

  it('요약 실패 시 요약 없이 트리밍만으로 진행하고 예외를 내지 않는다 (에러)', async () => {
    const fake = new FakeLlmClient();
    fake.failChat = true;
    const manager = new ContextManager(fake, {
      maxContextTokens: budgetForLastPairOnly(),
      reserveTokens: 0,
    });
    const history = [...pair(1), ...pair(2)];

    const result = await manager.prepare(null, history, USER.content);

    expect(result.summarized).toBe(false);
    expect(result.messages).toEqual([...pair(2), USER]);
  });

  it('예산 0이면 히스토리 전체가 요약으로 대체된다 (경계값)', async () => {
    const fake = new FakeLlmClient();
    const manager = new ContextManager(fake, {
      maxContextTokens: 0,
      reserveTokens: 0,
    });
    const history = [...pair(1)];

    const result = await manager.prepare('SYS', history, USER.content);

    expect(result.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'system', content: '이전 대화 요약: 요약문' },
      USER,
    ]);
  });

  it('reset() 후에는 같은 범위라도 다시 요약한다 (경계값)', async () => {
    const fake = new FakeLlmClient();
    const manager = new ContextManager(fake, {
      maxContextTokens: budgetForLastPairOnly(),
      reserveTokens: 0,
    });
    const history = [...pair(1), ...pair(2)];

    await manager.prepare(null, history, USER.content);
    manager.reset();
    await manager.prepare(null, history, USER.content);

    expect(fake.chatCalls).toHaveLength(2);
  });
});
