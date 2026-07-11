import type { Embedder } from '../llm/types.js';
import type { VectorIndex } from '../rag/vector-index.js';
import type { KnowledgeCandidate } from './extractor.js';

export interface NoveltyVerdict {
  candidate: KnowledgeCandidate;
  /** 기존 인덱스와의 최고 유사도 (인덱스 없으면 0) */
  maxScore: number;
  isNew: boolean;
}

// 실측(2026-07-11, LangChain 비교 실험에서 발견): nomic 임베딩 공간에서 무관한
// 한국어 문장끼리도 0.77~0.87이 나온다 — 0.75는 인덱스가 비어있지 않으면 전부 스킵.
// 거의 동일한 중복은 0.96+ — 중복만 걸러내도록 0.95로 설정 (유실보다 중복이 낫다).
export const DEFAULT_NOVELTY_THRESHOLD = 0.95;

/**
 * 후보별 기존 인덱스 최고 유사도로 신규 여부를 판정한다.
 * threshold 이상 → 이미 아는 지식(스킵 대상). 인덱스 없음/빈 인덱스 → 전부 신규.
 */
export async function judgeNovelty(
  embedder: Embedder,
  index: VectorIndex | null,
  candidates: readonly KnowledgeCandidate[],
  threshold: number = DEFAULT_NOVELTY_THRESHOLD,
): Promise<NoveltyVerdict[]> {
  if (candidates.length === 0) {
    return [];
  }
  if (index === null || index.size === 0) {
    return candidates.map((candidate) => ({
      candidate,
      maxScore: 0,
      isNew: true,
    }));
  }
  const embeddings = await embedder.embed(
    candidates.map((c) => `${c.title}\n${c.content}`),
  );
  return candidates.map((candidate, i) => {
    const embedding = embeddings.at(i) ?? [];
    const top = embedding.length > 0 ? index.search(embedding, 1, 0) : [];
    const maxScore = top.at(0)?.score ?? 0;
    return { candidate, maxScore, isNew: maxScore < threshold };
  });
}
