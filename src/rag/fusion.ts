import type { IndexedChunk } from './vector-index.js';

export const RRF_K = 60;

/** 청크 식별 키 (source + heading + content 앞부분) — 동일 청크 판별 */
function chunkKey(chunk: IndexedChunk): string {
  return `${chunk.source} ${chunk.heading} ${chunk.content.slice(0, 64)}`;
}

/**
 * 여러 순위 목록을 RRF로 결합해 상위 topK 청크를 반환한다.
 * 각 목록은 순위 순(0=최상위) 청크 배열. 점수 스케일 무관.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly IndexedChunk[])[],
  topK: number,
): IndexedChunk[] {
  const scores = new Map<string, number>();
  const byKey = new Map<string, IndexedChunk>();
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank += 1) {
      const chunk = ranking[rank];
      if (chunk === undefined) {
        continue;
      }
      const key = chunkKey(chunk);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
      if (!byKey.has(key)) {
        byKey.set(key, chunk);
      }
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([key]) => byKey.get(key))
    .filter((c): c is IndexedChunk => c !== undefined);
}
