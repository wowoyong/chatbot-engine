import type { IndexedChunk, SearchHit } from './vector-index.js';

export const RRF_K = 60;

export function chunkIdentity(chunk: IndexedChunk): string {
  return `${chunk.source}\0${chunk.heading}\0${chunk.content}`;
}

export function reciprocalRankFusion(
  rankings: readonly (readonly SearchHit[])[],
): SearchHit[] {
  const scores = new Map<string, number>();
  const byKey = new Map<string, IndexedChunk>();
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank += 1) {
      const hit = ranking[rank];
      if (hit === undefined) continue;
      const key = chunkIdentity(hit.chunk);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
      if (!byKey.has(key)) byKey.set(key, hit.chunk);
    }
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([key, score]) => ({ chunk: byKey.get(key), score }))
    .filter((hit): hit is SearchHit => hit.chunk !== undefined);
}

export function prioritizeSourceDiversity(
  hits: readonly SearchHit[],
  topK: number,
): SearchHit[] {
  const selected: SearchHit[] = [];
  const deferred: SearchHit[] = [];
  const seenSources = new Set<string>();
  for (const hit of hits) {
    if (seenSources.has(hit.chunk.source)) deferred.push(hit);
    else {
      selected.push(hit);
      seenSources.add(hit.chunk.source);
    }
    if (selected.length === topK) return selected;
  }
  for (const hit of deferred) {
    selected.push(hit);
    if (selected.length === topK) break;
  }
  return selected;
}
