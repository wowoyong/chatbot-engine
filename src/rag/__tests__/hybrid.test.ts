import { describe, expect, it } from 'vitest';
import type { Embedder } from '../../llm/types.js';
import { chunkIdentity, reciprocalRankFusion } from '../fusion.js';
import { HybridRetriever } from '../hybrid-retriever.js';
import type { IndexedChunk, SearchHit } from '../vector-index.js';
import { VectorIndex } from '../vector-index.js';

function chunk(source: string, content: string, embedding: number[] = []): IndexedChunk {
  return { source, heading: '', content, metadata: null, embedding };
}

function hit(item: IndexedChunk): SearchHit {
  return { chunk: item, score: 1 };
}

class FakeEmbedder implements Embedder {
  readonly calls: string[][] = [];
  constructor(private readonly vector: number[] = [1, 0]) {}
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return this.vector.length === 0 ? [] : [this.vector];
  }
}

describe('reciprocalRankFusion', () => {
  it('양쪽 순위에 오른 청크가 상위로 결합되고 score를 보존한다', () => {
    const a = chunk('a.md', '알파');
    const b = chunk('b.md', '베타');
    const c = chunk('c.md', '감마');
    const fused = reciprocalRankFusion([[hit(a), hit(b)], [hit(b), hit(c)]]);
    expect(fused.at(0)?.chunk.source).toBe('b.md');
    expect(fused.at(0)?.score).toBeGreaterThan(0);
    expect(chunkIdentity(b)).toContain('b.md');
  });

  it('빈 순위들은 빈 결과다', () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe('HybridRetriever', () => {
  it('vector strong evidence와 keyword 순위를 결합한다', async () => {
    const index = VectorIndex.create('m', 't', 'fp', [
      chunk('vec.md', '양자화 메모리 절감', [1, 0]),
      chunk('kw.md', '치지직 네이버 스트리밍', [0.9, 0.1]),
    ]);
    const result = await new HybridRetriever(new FakeEmbedder(), index, { topK: 2 })
      .retrieve('치지직 양자화');
    expect(result.hits.map((item) => item.chunk.source)).toEqual(expect.arrayContaining(['vec.md', 'kw.md']));
    expect(result.block).toContain('<retrieved_context>');
  });

  it('lexical hit가 없고 vector score가 0.88 미만이면 abstain한다', async () => {
    const score = 0.87;
    const index = VectorIndex.create('m', 't', 'fp', [
      chunk('unrelated.md', '전혀 다른 본문', [score, Math.sqrt(1 - score ** 2)]),
    ]);
    await expect(new HybridRetriever(new FakeEmbedder(), index).retrieve('일치하지 않는 질문'))
      .resolves.toEqual({ block: null, hits: [] });
  });

  it('부분 lexical token만 겹치고 vector가 threshold 미만이면 abstain한다', async () => {
    const score = 0.87;
    const item = chunk('deploy.md', '배포 절차 설명', [score, Math.sqrt(1 - score ** 2)]);
    item.metadata = { type: 'How-to', title: '배포 구성', tags: ['배포'] };
    const index = VectorIndex.create('m', 't', 'fp', [item]);
    await expect(new HybridRetriever(new FakeEmbedder(), index).retrieve('달 배포 세금'))
      .resolves.toEqual({ block: null, hits: [] });
  });

  it('full title metadata match는 vector threshold 미만이어도 검색한다', async () => {
    const score = 0.87;
    const item = chunk('deploy.md', '배포 절차 설명', [score, Math.sqrt(1 - score ** 2)]);
    item.metadata = { type: 'How-to', title: '배포 구성', tags: ['배포'] };
    const index = VectorIndex.create('m', 't', 'fp', [item]);
    const result = await new HybridRetriever(new FakeEmbedder(), index).retrieve('배포 구성 알려줘');
    expect(result.hits.map((item) => item.chunk.source)).toEqual(['deploy.md']);
  });

  it('일반 metadata token 4개가 겹쳐도 full title이 아니면 gate를 열지 않는다', async () => {
    const score = 0.87;
    const item = chunk('moon.md', 'moon 배포 설명', [score, Math.sqrt(1 - score ** 2)]);
    item.metadata = { type: 'moon', title: 'moon configuration', description: 'moon', tags: ['moon'] };
    const index = VectorIndex.create('m', 't', 'fp', [item]);
    await expect(new HybridRetriever(new FakeEmbedder(), index).retrieve('moon tax'))
      .resolves.toEqual({ block: null, hits: [] });
  });

  it('짧은 title이 다른 단어의 부분 문자열이면 exact match로 보지 않는다', async () => {
    const score = 0.87;
    const item = chunk('rag.md', 'RAG 설명', [score, Math.sqrt(1 - score ** 2)]);
    item.metadata = { type: 'Reference', title: 'RAG', tags: [] };
    const index = VectorIndex.create('m', 't', 'fp', [item]);
    await expect(new HybridRetriever(new FakeEmbedder(), index).retrieve('storage tax'))
      .resolves.toEqual({ block: null, hits: [] });
  });

  it('draft와 deprecated chunk는 검색 결과에서 제외한다', async () => {
    const draft = { ...chunk('draft.md', '승인 전 지식', [1, 0]), metadata: { tags: ['승인'], status: 'draft' as const } };
    const deprecated = { ...chunk('deprecated.md', '폐기 지식', [1, 0]), metadata: { tags: ['폐기'], status: 'deprecated' as const } };
    const verified = { ...chunk('verified.md', '검증 지식', [1, 0]), metadata: { tags: ['검증'], status: 'verified' as const } };
    const index = VectorIndex.create('m', 't', 'fp', [draft, deprecated, verified]);
    const result = await new HybridRetriever(new FakeEmbedder(), index).retrieve('지식');
    expect(result.hits.map((item) => item.chunk.source)).toEqual(['verified.md']);
  });

  it('topK를 채울 때 서로 다른 source를 먼저 선택한다', async () => {
    const index = VectorIndex.create('m', 't', 'fp', [
      chunk('a.md', '검색 첫째', [1, 0]),
      chunk('a.md', '검색 둘째', [0.99, 0.01]),
      chunk('b.md', '검색 셋째', [0.98, 0.02]),
    ]);
    const result = await new HybridRetriever(new FakeEmbedder(), index, { topK: 2 }).retrieve('검색');
    expect(new Set(result.hits.map((item) => item.chunk.source)).size).toBe(2);
  });

  it('질의 임베딩이 비고 exact title도 없으면 BM25 단독으로 context를 열지 않는다', async () => {
    const index = VectorIndex.create('m', 't', 'fp', [chunk('a.md', '양자화 설명')]);
    await expect(new HybridRetriever(new FakeEmbedder([]), index).retrieve('양자화'))
      .resolves.toEqual({ block: null, hits: [] });
  });
});
