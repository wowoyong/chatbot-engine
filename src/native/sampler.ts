export interface SampleOptions {
  /** 0 이하면 greedy */
  temperature?: number;
  /** nucleus 확률 (기본 1 = 비활성) */
  topP?: number;
}

/** logits에서 다음 토큰 ID 샘플링. rng 주입으로 테스트 결정성 확보 */
export function sampleToken(
  logits: Float32Array,
  opts: SampleOptions = {},
  rng: () => number = Math.random,
): number {
  const temp = opts.temperature ?? 0;
  const n = logits.length;
  if (temp <= 0) {
    let best = 0;
    let bestV = -Infinity;
    for (let i = 0; i < n; i += 1) {
      if (logits[i]! > bestV) {
        bestV = logits[i]!;
        best = i;
      }
    }
    return best;
  }
  const probs = new Float32Array(n);
  let max = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const v = logits[i]! / temp;
    probs[i] = v;
    if (v > max) max = v;
  }
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const e = Math.exp(probs[i]! - max);
    probs[i] = e;
    sum += e;
  }
  for (let i = 0; i < n; i += 1) probs[i] = probs[i]! / sum;

  const topP = opts.topP ?? 1;
  const idx = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => probs[b]! - probs[a]!,
  );
  const keep: number[] = [];
  let cum = 0;
  for (const i of idx) {
    keep.push(i);
    cum += probs[i]!;
    if (cum >= topP) break;
  }
  let keepSum = 0;
  for (const i of keep) keepSum += probs[i]!;
  let r = rng() * keepSum;
  for (const i of keep) {
    r -= probs[i]!;
    if (r <= 0) return i;
  }
  return keep[keep.length - 1]!;
}
