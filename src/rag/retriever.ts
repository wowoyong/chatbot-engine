import type { Embedder } from '../llm/types.js';
import type { SearchHit, VectorIndex } from './vector-index.js';

export interface RetrieverConfig {
  /** 반환할 최대 발췌 수. 기본 4 */
  topK?: number;
  /** 이 유사도 미만은 제외. 기본 0.35 */
  minScore?: number;
}

export interface RetrievedContext {
  /** 프롬프트에 주입할 발췌 블록 (관련 발췌 없으면 null) */
  block: string | null;
  hits: SearchHit[];
}

const DEFAULT_TOP_K = 4;
const DEFAULT_MIN_SCORE = 0.35;

export class Retriever {
  private readonly embedder: Embedder;
  private readonly index: VectorIndex;
  private readonly topK: number;
  private readonly minScore: number;

  constructor(
    embedder: Embedder,
    index: VectorIndex,
    config: RetrieverConfig = {},
  ) {
    this.embedder = embedder;
    this.index = index;
    this.topK = config.topK ?? DEFAULT_TOP_K;
    this.minScore = config.minScore ?? DEFAULT_MIN_SCORE;
  }

  async retrieve(query: string): Promise<RetrievedContext> {
    const embeddings = await this.embedder.embed([query]);
    const queryEmbedding = embeddings.at(0) ?? [];
    if (queryEmbedding.length === 0) {
      return { block: null, hits: [] };
    }
    const hits = this.index.search(queryEmbedding, this.topK, this.minScore);
    if (hits.length === 0) {
      return { block: null, hits: [] };
    }
    const sections = hits.map((h) => {
      const label =
        h.chunk.heading.length > 0
          ? `${h.chunk.source} > ${h.chunk.heading}`
          : h.chunk.source;
      return `[${label}]\n${h.chunk.content}`;
    });
    const block =
      '다음은 질문과 관련된 문서 발췌다. 답변에 활용하되, 관련이 없으면 무시하라.\n\n' +
      sections.join('\n\n---\n\n');
    return { block, hits };
  }
}
