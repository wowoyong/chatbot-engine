import type { IndexedChunk, SearchHit } from './vector-index.js';

const K1 = 1.5;
const B = 0.75;

/** 유니코드 단어 런(한글/영문/숫자)으로 토큰화 + 소문자화 */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ?? [];
}

/** BM25 IDF (음수 방지 변형): log(1 + (N - df + 0.5) / (df + 0.5)) */
export function idf(totalDocs: number, docFreq: number): number {
  return Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
}

interface DocStats {
  chunk: IndexedChunk;
  termFreq: Map<string, number>;
  length: number;
}

/** 청크 배열로 BM25 검색 수행 (편의 함수) */
export function bm25Search(chunks: readonly IndexedChunk[], query: string, topK: number): SearchHit[] {
  const index = new Bm25Index(chunks);
  return index.search(query, topK);
}

export class Bm25Index {
  private readonly docs: DocStats[];
  private readonly docFreq: Map<string, number>;
  private readonly avgLength: number;

  constructor(chunks: readonly IndexedChunk[]) {
    this.docs = chunks.map((chunk) => {
      const tokens = tokenize(`${chunk.heading} ${chunk.content}`);
      const termFreq = new Map<string, number>();
      for (const token of tokens) {
        termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
      }
      return { chunk, termFreq, length: tokens.length };
    });
    this.docFreq = new Map();
    for (const doc of this.docs) {
      for (const term of doc.termFreq.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
    const totalLength = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgLength = this.docs.length > 0 ? totalLength / this.docs.length : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  /** 질의 토큰의 BM25 점수 합으로 상위 topK 청크 반환 (점수 0 제외) */
  search(query: string, topK: number): SearchHit[] {
    const queryTerms = tokenize(query);
    const totalDocs = this.docs.length;
    const hits: SearchHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.termFreq.get(term) ?? 0;
        if (tf === 0) {
          continue;
        }
        const df = this.docFreq.get(term) ?? 0;
        const norm =
          tf * (K1 + 1) /
          (tf + K1 * (1 - B + (B * doc.length) / (this.avgLength || 1)));
        score += idf(totalDocs, df) * norm;
      }
      if (score > 0) {
        hits.push({ chunk: doc.chunk, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }
}
