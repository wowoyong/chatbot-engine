import { describe, expect, it } from 'vitest';
import { attention } from '../attention.js';

describe('attention', () => {
  it('pos=0이면 자기 자신 v를 그대로 반환한다 (경계값)', () => {
    // 1 head, headDim 2, 1 kv head. q·k softmax(단일) = 1 → out = v
    const q = new Float32Array([1, 0]);
    const k = new Float32Array([1, 0]); // pos0
    const v = new Float32Array([5, 7]);
    const out = attention(q, k, v, 0, 1, 1, 2);
    expect(Array.from(out)).toEqual([5, 7]);
  });

  it('GQA: 2 q head가 1 kv head를 공유한다 (정상)', () => {
    // nHeads 2, nKvHeads 1, headDim 2 → gqaGroup 2, 둘 다 kvh 0
    const q = new Float32Array([1, 0, 0, 1]); // head0=[1,0], head1=[0,1]
    const k = new Float32Array([1, 0]);
    const v = new Float32Array([3, 4]);
    const out = attention(q, k, v, 0, 2, 1, 2);
    // 둘 다 단일 위치 → out = v 반복
    expect(Array.from(out)).toEqual([3, 4, 3, 4]);
  });

  it('인과: 최신 위치가 과거 v의 가중합이다 (정상)', () => {
    // 1 head, headDim 1, kvDim 1, pos1. q=[1]; k=[0(p0),0(p1)] → 스코어 동일 → 균등
    const q = new Float32Array([1]);
    const k = new Float32Array([0, 0]);
    const v = new Float32Array([2, 4]);
    const out = attention(q, k, v, 1, 1, 1, 1);
    expect(out[0]).toBeCloseTo(3, 6); // (2+4)/2
  });
});
