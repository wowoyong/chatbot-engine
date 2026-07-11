import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../llm/types.js';
import { estimateMessagesTokens } from '../token-estimate.js';
import { trimToBudget } from '../trim.js';

function pair(n: number): ChatMessage[] {
  return [
    { role: 'user', content: `질문${n}` },
    { role: 'assistant', content: `답변${n}` },
  ];
}

describe('trimToBudget', () => {
  it('예산이 충분하면 전부 kept, dropped는 빈 배열 (정상)', () => {
    const history = [...pair(1), ...pair(2)];
    const result = trimToBudget(history, estimateMessagesTokens(history));
    expect(result.kept).toEqual(history);
    expect(result.dropped).toEqual([]);
  });

  it('예산 초과 시 오래된 쌍부터 제외하고 최신 쌍을 유지한다 (정상)', () => {
    const history = [...pair(1), ...pair(2), ...pair(3)];
    const lastTwoPairs = [...pair(2), ...pair(3)];
    const result = trimToBudget(history, estimateMessagesTokens(lastTwoPairs));
    expect(result.kept).toEqual(lastTwoPairs);
    expect(result.dropped).toEqual(pair(1));
  });

  it('쌍 중간까지만 담을 수 있는 예산이면 그 쌍 전체를 제외한다 (경계값)', () => {
    const history = [...pair(1), ...pair(2)];
    const budget = estimateMessagesTokens(pair(2)) +
      estimateMessagesTokens(pair(1)) - 1; // pair(1)을 온전히 못 담는 예산
    const result = trimToBudget(history, budget);
    expect(result.kept).toEqual(pair(2));
    expect(result.dropped).toEqual(pair(1));
  });

  it('예산 0이면 전부 dropped, kept는 빈 배열 (경계값)', () => {
    const history = [...pair(1)];
    const result = trimToBudget(history, 0);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual(history);
  });

  it('빈 히스토리는 양쪽 다 빈 배열 (경계값)', () => {
    const result = trimToBudget([], 100);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('반환 배열은 원본과 다른 객체다 — 입력 불변 (경계값)', () => {
    const history = [...pair(1)];
    const result = trimToBudget(history, 1000);
    expect(result.kept.at(0)).not.toBe(history.at(0));
    expect(result.kept.at(0)).toEqual(history.at(0));
  });
});
