import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, LlmClient } from '../../llm/types.js';
import { KNOWLEDGE_CATEGORIES, extractKnowledge, parseCandidates } from '../extractor.js';

class FakeLlmClient implements LlmClient {
  readonly calls: ChatMessage[][] = [];
  chatResult = '[]';

  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    this.calls.push(messages);
    return this.chatResult;
  }

  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncGenerator<string> {
    yield 'ok';
  }
}

const HISTORY: ChatMessage[] = [
  { role: 'user', content: '파란색이 좋아' },
  { role: 'assistant', content: '기억할게요' },
];

describe('parseCandidates', () => {
  it('정상 JSON 배열을 파싱한다 (정상)', () => {
    const raw = '[{"title":"선호 색","category":"preference","content":"사용자는 파란색을 선호한다"}]';
    expect(parseCandidates(raw)).toEqual([
      { title: '선호 색', category: 'preference', content: '사용자는 파란색을 선호한다' },
    ]);
  });

  it('코드펜스와 부가 텍스트가 섞여도 배열 부분만 파싱한다 (경계값)', () => {
    const raw = '추출 결과입니다:\n```json\n[{"title":"t","category":"fact","content":"c"}]\n```\n끝';
    expect(parseCandidates(raw)).toHaveLength(1);
  });

  it('JSON 배열이 없으면 throw한다 (에러)', () => {
    expect(() => parseCandidates('추출할 지식이 없습니다.')).toThrow('찾지 못했습니다');
    expect(() => parseCandidates('[깨진 json')).toThrow();
  });

  it('불량 항목은 드롭하고 잘못된 category는 concept으로 정규화한다 (경계값)', () => {
    const raw = JSON.stringify([
      { title: 't1', category: 'invalid-cat', content: 'c1' },
      { title: '', category: 'fact', content: 'c2' },
      { notitle: true },
      { title: 't3', category: 'howto', content: 'c3' },
    ]);
    const result = parseCandidates(raw);
    expect(result).toEqual([
      { title: 't1', category: 'concept', content: 'c1' },
      { title: 't3', category: 'howto', content: 'c3' },
    ]);
  });

  it('빈 배열 출력은 빈 결과다 (경계값)', () => {
    expect(parseCandidates('[]')).toEqual([]);
  });
});

describe('extractKnowledge', () => {
  it('빈 히스토리면 LLM을 호출하지 않고 빈 배열을 반환한다 (경계값)', async () => {
    const fake = new FakeLlmClient();
    expect(await extractKnowledge(fake, [])).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('시스템 프롬프트에 모든 카테고리가 정의되고 대화가 전달된다 (정상)', async () => {
    const fake = new FakeLlmClient();
    fake.chatResult = '[]';

    await extractKnowledge(fake, HISTORY);

    const sysContent = fake.calls.at(0)?.at(0)?.content ?? '';
    for (const category of KNOWLEDGE_CATEGORIES) {
      expect(sysContent).toContain(category);
    }
    expect(fake.calls.at(0)?.at(1)?.content).toContain('파란색이 좋아');
  });

  it('object-wrapper {items:[...]} 형식을 파싱한다 (정상)', () => {
    const raw = '{"items":[{"title":"t","category":"fact","content":"c"}]}';
    expect(parseCandidates(raw)).toEqual([
      { title: 't', category: 'fact', content: 'c' },
    ]);
  });

  it('extractKnowledge가 format 스키마를 전달한다 (정상)', async () => {
    let capturedOptions: unknown;
    const client = {
      async chat(_m: ChatMessage[], options?: unknown): Promise<string> {
        capturedOptions = options;
        return '{"items":[]}';
      },
      async *chatStream(): AsyncGenerator<string> {
        yield 'ok';
      },
    };
    await extractKnowledge(client as never, [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'y' },
    ]);
    expect(capturedOptions).toHaveProperty('format');
  });
});
