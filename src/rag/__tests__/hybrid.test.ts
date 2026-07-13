import { describe, expect, it } from 'vitest';
import type { IndexedChunk } from '../vector-index.js';
import { reciprocalRankFusion, RRF_K } from '../fusion.js';
import { HybridRetriever } from '../hybrid-retriever.js';
import { VectorIndex } from '../vector-index.js';
import type { Embedder } from '../../llm/types.js';

function chunk(source: string, content: string, embedding: number[] = []): IndexedChunk {
  return { source, heading: '', content, embedding };
}

describe('reciprocalRankFusion', () => {
  it('양쪽 순위에 오른 청크가 상위로 결합된다 (정상)', () => {
    const a = chunk('a.md', '알파');
    const b = chunk('b.md', '베타');
    const c = chunk('c.md', '감마');
    // 벡터: [a, b], BM25: [b, c] → b가 양쪽 → 최상위
    const fused = reciprocalRankFusion([[a, b], [b, c]], 3);
    expect(fused.at(0)?.source).toBe('b.md');
  });

  it('한쪽만 있는 순위도 결합한다 (경계값)', () => {
    const a = chunk('a.md', '알파');
    const fused = reciprocalRankFusion([[a], []], 3);
    expect(fused).toHaveLength(1);
    expect(fused.at(0)?.source).toBe('a.md');
  });

  it('빈 순위들은 빈 결과 (경계값)', () => {
    expect(reciprocalRankFusion([[], []], 3)).toEqual([]);
    expect(RRF_K).toBeGreaterThan(0);
  });
});

class FakeEmbedder implements Embedder {
  readonly calls: string[][] = [];
  vectors: number[][] = [[1, 0]];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return this.vectors;
  }
}

describe('HybridRetriever', () => {
  const index = VectorIndex.create('m', 't', [
    chunk('vec.md', '양자화 메모리 절감', [1, 0]),
    chunk('kw.md', '치지직 네이버 스트리밍', [0, 1]),
  ]);

  it('벡터와 키워드 결과를 함께 블록으로 만든다 (정상)', async () => {
    const embedder = new FakeEmbedder();
    embedder.vectors = [[1, 0]]; // vec.md와 유사
    const retriever = new HybridRetriever(embedder, index, { topK: 2 });

    const result = await retriever.retrieve('치지직 양자화');

    expect(embedder.calls.at(0)).toEqual(['치지직 양자화']);
    const sources = result.hits.map((h) => h.chunk.source);
    expect(sources).toContain('kw.md'); // BM25가 키워드로 회수
    expect(result.block).toContain('[');
  });

  it('빈 인덱스면 block은 null (경계값)', async () => {
    const empty = VectorIndex.create('m', 't', []);
    const retriever = new HybridRetriever(new FakeEmbedder(), empty);
    const result = await retriever.retrieve('아무거나');
    expect(result.block).toBeNull();
    expect(result.hits).toEqual([]);
  });

  it('질의 임베딩이 비어도 BM25로 회수한다 (에러/경계)', async () => {
    const embedder = new FakeEmbedder();
    embedder.vectors = []; // 임베딩 실패 시뮬레이션
    const retriever = new HybridRetriever(embedder, index);
    const result = await retriever.retrieve('양자화');
    expect(result.hits.map((h) => h.chunk.source)).toContain('vec.md');
  });
});
