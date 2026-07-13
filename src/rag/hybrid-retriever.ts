import type { Embedder } from '../llm/types.js';
import { Bm25Index } from './bm25.js';
import { reciprocalRankFusion } from './fusion.js';
import type { RetrievedContext } from './retriever.js';
import type { IndexedChunk, VectorIndex } from './vector-index.js';

export interface HybridConfig {
  /** 최종 발췌 수. 기본 4 */
  topK?: number;
  /** 각 검색기에서 뽑는 후보 수. 기본 20 */
  candidateDepth?: number;
}

const DEFAULT_TOP_K = 4;
const DEFAULT_DEPTH = 20;

function labelOf(chunk: IndexedChunk): string {
  return chunk.heading.length > 0
    ? `${chunk.source} > ${chunk.heading}`
    : chunk.source;
}

export class HybridRetriever {
  private readonly embedder: Embedder;
  private readonly index: VectorIndex;
  private readonly bm25: Bm25Index;
  private readonly topK: number;
  private readonly depth: number;

  constructor(embedder: Embedder, index: VectorIndex, config: HybridConfig = {}) {
    this.embedder = embedder;
    this.index = index;
    this.bm25 = new Bm25Index(index.allChunks());
    this.topK = config.topK ?? DEFAULT_TOP_K;
    this.depth = config.candidateDepth ?? DEFAULT_DEPTH;
  }

  async retrieve(query: string): Promise<RetrievedContext> {
    const [embedding] = await this.embedder.embed([query]);
    const vectorHits =
      embedding && embedding.length > 0
        ? this.index.search(embedding, this.depth, 0)
        : [];
    const bm25Hits = this.bm25.search(query, this.depth);

    const fused = reciprocalRankFusion(
      [vectorHits.map((h) => h.chunk), bm25Hits.map((h) => h.chunk)],
      this.topK,
    );
    if (fused.length === 0) {
      return { block: null, hits: [] };
    }
    const sections = fused.map((c) => `[${labelOf(c)}]\n${c.content}`);
    const block =
      '다음은 질문과 관련된 문서 발췌다. 답변에 활용하되, 관련이 없으면 무시하라.\n\n' +
      sections.join('\n\n---\n\n');
    return { block, hits: fused.map((chunk) => ({ chunk, score: 0 })) };
  }
}
