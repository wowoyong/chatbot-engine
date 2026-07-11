import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '../cosine.js';

describe('cosineSimilarity', () => {
  it('같은 방향 벡터는 1에 수렴한다 (정상)', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('직교 벡터는 0이다 (정상)', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('차원이 다르면 throw한다 (에러)', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow('차원 불일치');
  });

  it('영벡터는 0을 반환한다 (경계값)', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});
