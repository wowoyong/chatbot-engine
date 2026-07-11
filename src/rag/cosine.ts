/** 두 벡터의 코사인 유사도. 차원 불일치는 throw, 영벡터는 0 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length) {
    throw new Error(`벡터 차원 불일치: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
