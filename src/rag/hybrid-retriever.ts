import type { Embedder } from '../llm/types.js';
import { Bm25Index, tokenize } from './bm25.js';
import { formatRetrievedContext } from './context-block.js';
import { chunkIdentity, prioritizeSourceDiversity, reciprocalRankFusion } from './fusion.js';
import type { RetrievedContext } from './retriever.js';
import { isRetrievableChunk } from './visibility.js';
import type { IndexedChunk, SearchHit, VectorIndex } from './vector-index.js';

export interface HybridConfig {
  topK?: number;
  candidateDepth?: number;
  minVectorScore?: number;
}

const DEFAULT_TOP_K = 4;
const DEFAULT_DEPTH = 20;
export const DEFAULT_MIN_VECTOR_SCORE = 0.88;

function containsTitlePhrase(query: string, title: string): boolean {
  const queryTokens = tokenize(query);
  const titleTokens = tokenize(title);
  if (titleTokens.length === 0) return false;
  return queryTokens.some((_, start) =>
    titleTokens.every((token, offset) => queryTokens[start + offset] === token),
  );
}

function metadataSearch(
  chunks: readonly IndexedChunk[],
  query: string,
  topK: number,
): SearchHit[] {
  const queryTokens = new Set(tokenize(query));
  const hits: SearchHit[] = [];
  for (const chunk of chunks) {
    const metadata = chunk.metadata;
    if (metadata === null) continue;
    let score = 0;
    const title = metadata.title?.trim();
    if (title !== undefined && title.length >= 2 && containsTitlePhrase(query, title)) score += 4;
    const metadataText = [metadata.type, metadata.title, metadata.description, ...metadata.tags]
      .filter((value): value is string => value !== undefined)
      .join(' ');
    for (const token of tokenize(metadataText)) {
      if (queryTokens.has(token)) score += 1;
    }
    if (score > 0) hits.push({ chunk, score });
  }
  hits.sort((left, right) => right.score - left.score);
  return hits.slice(0, topK);
}

function exactTitleKeys(
  chunks: readonly IndexedChunk[],
  query: string,
): Set<string> {
  return new Set(
    chunks
      .filter((chunk) => {
        const title = chunk.metadata?.title?.trim();
        return title !== undefined && title.length >= 2 && containsTitlePhrase(query, title);
      })
      .map(chunkIdentity),
  );
}

export class HybridRetriever {
  private readonly embedder: Embedder;
  private readonly index: VectorIndex;
  private readonly visibleChunks: IndexedChunk[];
  private readonly bm25: Bm25Index;
  private readonly topK: number;
  private readonly depth: number;
  private readonly minVectorScore: number;

  constructor(embedder: Embedder, index: VectorIndex, config: HybridConfig = {}) {
    this.embedder = embedder;
    this.index = index;
    this.visibleChunks = index.allChunks().filter(isRetrievableChunk);
    this.bm25 = new Bm25Index(this.visibleChunks);
    this.topK = config.topK ?? DEFAULT_TOP_K;
    this.depth = config.candidateDepth ?? DEFAULT_DEPTH;
    this.minVectorScore = config.minVectorScore ?? DEFAULT_MIN_VECTOR_SCORE;
  }

  async retrieve(query: string): Promise<RetrievedContext> {
    const [embedding] = await this.embedder.embed([query]);
    const vectorHits = embedding !== undefined && embedding.length > 0
      ? this.index.search(embedding, this.depth, this.minVectorScore, isRetrievableChunk)
      : [];
    const bm25Hits = this.bm25.search(query, this.depth);
    const metadataHits = metadataSearch(this.visibleChunks, query, this.depth);
    const exactMetadataKeys = exactTitleKeys(this.visibleChunks, query);
    const strongEvidenceKeys = new Set([
      ...vectorHits.map((hit) => chunkIdentity(hit.chunk)),
      ...exactMetadataKeys,
    ]);
    const confident = reciprocalRankFusion([metadataHits, bm25Hits, vectorHits])
      .filter((hit) => strongEvidenceKeys.has(chunkIdentity(hit.chunk)));
    const hits = prioritizeSourceDiversity(confident, this.topK);
    return { block: formatRetrievedContext(hits), hits };
  }
}
