import type { Embedder } from '../llm/types.js';
import type { SearchHit, VectorIndex } from './vector-index.js';
import { formatRetrievedContext } from './context-block.js';
import { isRetrievableChunk } from './visibility.js';

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
    const hits = this.index.search(
      queryEmbedding,
      this.topK,
      this.minScore,
      isRetrievableChunk,
    );
    return { block: formatRetrievedContext(hits), hits };
  }
}
