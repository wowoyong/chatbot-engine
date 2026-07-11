import { describe, expect, it } from 'vitest';
import {
  PER_MESSAGE_OVERHEAD,
  estimateMessagesTokens,
  estimateTokens,
} from '../token-estimate.js';

describe('estimateTokens', () => {
  it('ASCII 문자열은 4자당 1토큰으로 올림 추정한다 (정상)', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11자 → ceil(11/4)
  });

  it('한글은 1자당 1토큰으로 추정한다 (정상)', () => {
    expect(estimateTokens('안녕하세요')).toBe(5);
  });

  it('혼합 문자열은 두 산식의 합이다 (정상)', () => {
    expect(estimateTokens('hi 안녕')).toBe(3); // ascii 'hi '=3자→1 + 한글 2
  });

  it('빈 문자열은 0토큰이다 (경계값)', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('estimateMessagesTokens', () => {
  it('메시지마다 오버헤드를 가산하고, 빈 배열은 0이다 (경계값)', () => {
    expect(estimateMessagesTokens([])).toBe(0);
    expect(
      estimateMessagesTokens([
        { role: 'user', content: '' },
        { role: 'assistant', content: '안녕' },
      ]),
    ).toBe(PER_MESSAGE_OVERHEAD * 2 + 2);
  });
});
