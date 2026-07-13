import { describe, expect, it } from 'vitest';
import { linear, rmsNorm, silu, softmaxInPlace } from '../kernels.js';
import { applyRope } from '../rope.js';

describe('linear', () => {
  it('y[o] = Σ W[o*in+j]·x[j] + bias (정상)', () => {
    // W [in=2, out=2]: row0=[1,2], row1=[3,4]; x=[1,1]; bias=[10,20]
    const W = new Float32Array([1, 2, 3, 4]);
    const x = new Float32Array([1, 1]);
    const b = new Float32Array([10, 20]);
    expect(Array.from(linear(W, x, 2, 2, b))).toEqual([13, 27]);
  });

  it('bias 없이도 동작 (경계값)', () => {
    const W = new Float32Array([2, 0, 0, 2]);
    expect(Array.from(linear(W, new Float32Array([3, 5]), 2, 2))).toEqual([6, 10]);
  });
});

describe('rmsNorm', () => {
  it('정규화 후 weight를 곱한다 (정상)', () => {
    // x=[3,4] → ss=(9+16)/2=12.5, scale=1/√(12.5+0)=0.2828..
    const y = rmsNorm(new Float32Array([3, 4]), new Float32Array([1, 1]), 0);
    expect(y[0]).toBeCloseTo(3 / Math.sqrt(12.5), 5);
    expect(y[1]).toBeCloseTo(4 / Math.sqrt(12.5), 5);
  });
});

describe('softmaxInPlace', () => {
  it('합이 1이고 큰 값에서 overflow하지 않는다 (경계값)', () => {
    const a = new Float32Array([1000, 1000, 1000]);
    softmaxInPlace(a, 3);
    expect(a[0]).toBeCloseTo(1 / 3, 6);
    expect(a[0]! + a[1]! + a[2]!).toBeCloseTo(1, 6);
  });
});

describe('silu', () => {
  it('silu(0)=0, silu는 x·σ(x) (정상)', () => {
    expect(silu(0)).toBe(0);
    expect(silu(1)).toBeCloseTo(1 / (1 + Math.exp(-1)), 6);
  });
});

describe('applyRope', () => {
  it('pos=0이면 항등(회전 없음) (경계값)', () => {
    const v = new Float32Array([1, 2, 3, 4]);
    applyRope(v, 0, 1, 4, 10000);
    expect(Array.from(v)).toEqual([1, 2, 3, 4]);
  });

  it('pos>0이면 앞/뒤 절반이 회전한다 (정상)', () => {
    const v = new Float32Array([1, 0, 0, 0]); // head_dim 2, half 1
    applyRope(v, 1, 1, 2, 10000);
    // i=0: invFreq=1, angle=1, a=1,b=0 → [cos1, sin1]
    expect(v[0]).toBeCloseTo(Math.cos(1), 5);
    expect(v[1]).toBeCloseTo(Math.sin(1), 5);
  });
});
