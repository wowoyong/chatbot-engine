/** GGUF 선형: weight ne=[inDim,outDim], y[o] = bias[o] + Σⱼ weight[o*inDim+j]·x[j] */
export function linear(
  weight: Float32Array,
  x: Float32Array,
  inDim: number,
  outDim: number,
  bias?: Float32Array,
): Float32Array {
  const out = new Float32Array(outDim);
  for (let o = 0; o < outDim; o += 1) {
    let sum = bias === undefined ? 0 : bias[o]!;
    const base = o * inDim;
    for (let j = 0; j < inDim; j += 1) {
      sum += weight[base + j]! * x[j]!;
    }
    out[o] = sum;
  }
  return out;
}

/** RMSNorm: y[i] = x[i] / √(mean(x²)+eps) · weight[i] */
export function rmsNorm(
  x: Float32Array,
  weight: Float32Array,
  eps: number,
): Float32Array {
  let ss = 0;
  for (let i = 0; i < x.length; i += 1) {
    ss += x[i]! * x[i]!;
  }
  const scale = 1 / Math.sqrt(ss / x.length + eps);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 1) {
    out[i] = x[i]! * scale * weight[i]!;
  }
  return out;
}

/** in-place softmax (max 빼기로 overflow 방지) */
export function softmaxInPlace(arr: Float32Array, len: number): void {
  let max = -Infinity;
  for (let i = 0; i < len; i += 1) {
    if (arr[i]! > max) max = arr[i]!;
  }
  let sum = 0;
  for (let i = 0; i < len; i += 1) {
    const e = Math.exp(arr[i]! - max);
    arr[i] = e;
    sum += e;
  }
  for (let i = 0; i < len; i += 1) {
    arr[i] = arr[i]! / sum;
  }
}

/** SiLU (swish): x·σ(x) */
export function silu(x: number): number {
  return x / (1 + Math.exp(-x));
}
