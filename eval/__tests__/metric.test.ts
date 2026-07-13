import { describe, expect, it } from 'vitest';
import { mean, meanReciprocalRank, recallAtK, reciprocalRank, summarize } from '../metric.js';

describe('recallAtK', () => {
  it('정답이 topK 안에 있으면 1, 밖이면 0 (정상/경계)', () => {
    expect(recallAtK(['a', 'b', 'c'], 'b', 1)).toBe(0);
    expect(recallAtK(['a', 'b', 'c'], 'b', 2)).toBe(1);
    expect(recallAtK(['a', 'b', 'c'], 'z', 4)).toBe(0);
  });
});

describe('reciprocalRank', () => {
  it('정답 순위의 역수를 반환하고 없으면 0이다 (정상/에러)', () => {
    expect(reciprocalRank(['a', 'b', 'c'], 'a')).toBe(1);
    expect(reciprocalRank(['a', 'b', 'c'], 'c')).toBeCloseTo(1 / 3, 10);
    expect(reciprocalRank(['a', 'b'], 'z')).toBe(0);
  });
});

describe('mean', () => {
  it('빈 배열은 0이다 (경계값)', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 0, 1, 0])).toBe(0.5);
  });
});

describe('meanReciprocalRank', () => {
  it('여러 순위의 역수 평균을 계산한다 (정상)', () => {
    const ranked = [['x.md', 'y.md'], ['y.md', 'x.md']];
    const expected = ['x.md', 'x.md'];
    expect(meanReciprocalRank(ranked, expected)).toBeCloseTo(0.75, 10);
  });
});

describe('summarize', () => {
  it('질문별 순위를 집계 지표로 변환한다 (정상)', () => {
    const result = summarize([
      { ranked: ['x.md', 'y.md'], expected: 'x.md' }, // r@1=1, rr=1
      { ranked: ['y.md', 'x.md'], expected: 'x.md' }, // r@1=0, r@4=1, rr=0.5
    ]);
    expect(result.count).toBe(2);
    expect(result.recallAt1).toBe(0.5);
    expect(result.recallAt4).toBe(1);
    expect(result.mrr).toBeCloseTo(0.75, 10);
  });

  it('빈 세트는 모두 0이다 (경계값)', () => {
    expect(summarize([])).toEqual({ count: 0, recallAt1: 0, recallAt4: 0, mrr: 0 });
  });
});
