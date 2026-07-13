/**
 * RoPE를 벡터에 in-place 적용 (HF Qwen2 rotate_half 규약).
 * vec은 nHeads×headDim 연속 배열. head h의 dim i(<half)와 i+half를 회전.
 */
export function applyRope(
  vec: Float32Array,
  pos: number,
  nHeads: number,
  headDim: number,
  freqBase: number,
): void {
  const half = headDim >> 1;
  for (let h = 0; h < nHeads; h += 1) {
    const base = h * headDim;
    for (let i = 0; i < half; i += 1) {
      const invFreq = Math.pow(freqBase, (-2 * i) / headDim);
      const angle = pos * invFreq;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const a = vec[base + i]!;
      const b = vec[base + i + half]!;
      vec[base + i] = a * cos - b * sin;
      vec[base + i + half] = b * cos + a * sin;
    }
  }
}
