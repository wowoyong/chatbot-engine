import { softmaxInPlace } from './kernels.js';

/**
 * GQA 인과 어텐션. q는 nHeads×headDim, kCache/vCache는 (maxSeq)×kvDim에서
 * 앞 (pos+1) 위치가 유효. 반환은 nHeads×headDim.
 */
export function attention(
  q: Float32Array,
  kCache: Float32Array,
  vCache: Float32Array,
  pos: number,
  nHeads: number,
  nKvHeads: number,
  headDim: number,
): Float32Array {
  const kvDim = nKvHeads * headDim;
  const gqaGroup = nHeads / nKvHeads;
  const scale = 1 / Math.sqrt(headDim);
  const out = new Float32Array(nHeads * headDim);
  const scores = new Float32Array(pos + 1);
  for (let qh = 0; qh < nHeads; qh += 1) {
    const kvh = Math.floor(qh / gqaGroup);
    const qOff = qh * headDim;
    for (let p = 0; p <= pos; p += 1) {
      const kOff = p * kvDim + kvh * headDim;
      let dot = 0;
      for (let d = 0; d < headDim; d += 1) {
        dot += q[qOff + d]! * kCache[kOff + d]!;
      }
      scores[p] = dot * scale;
    }
    softmaxInPlace(scores, pos + 1);
    const outOff = qh * headDim;
    for (let p = 0; p <= pos; p += 1) {
      const w = scores[p]!;
      const vOff = p * kvDim + kvh * headDim;
      for (let d = 0; d < headDim; d += 1) {
        out[outOff + d]! += w * vCache[vOff + d]!;
      }
    }
  }
  return out;
}
