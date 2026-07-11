import { describe, expect, it } from 'vitest';
import type { Embedder } from '../../llm/types.js';
import { VectorIndex } from '../../rag/vector-index.js';
import type { KnowledgeCandidate } from '../extractor.js';
import { DEFAULT_NOVELTY_THRESHOLD, judgeNovelty } from '../novelty.js';

class FakeEmbedder implements Embedder {
  readonly calls: string[][] = [];
  vectors: number[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return this.vectors;
  }
}

function candidate(title: string): KnowledgeCandidate {
  return { title, category: 'fact', content: `${title} 내용` };
}

const INDEX = VectorIndex.create('m', 't', [
  { source: 'a.md', heading: '기존', content: '기존 지식', embedding: [1, 0] },
]);

describe('judgeNovelty', () => {
  it('인덱스가 없으면 전부 신규다 (경계값)', async () => {
    const embedder = new FakeEmbedder();
    const verdicts = await judgeNovelty(embedder, null, [candidate('새것')]);
    expect(verdicts).toEqual([
      { candidate: candidate('새것'), maxScore: 0, isNew: true },
    ]);
    expect(embedder.calls).toHaveLength(0);
  });

  it('기존과 유사하면 스킵, 다르면 신규로 판정한다 (정상)', async () => {
    const embedder = new FakeEmbedder();
    embedder.vectors = [
      [1, 0],
      [0, 1],
    ];

    const verdicts = await judgeNovelty(embedder, INDEX, [
      candidate('중복'),
      candidate('신규'),
    ]);

    expect(verdicts.at(0)?.isNew).toBe(false);
    expect(verdicts.at(0)?.maxScore).toBeCloseTo(1, 10);
    expect(verdicts.at(1)?.isNew).toBe(true);
    expect(embedder.calls.at(0)?.at(0)).toBe('중복\n중복 내용');
  });

  it('threshold 자체는 스킵, 그 미만은 신규다 — 경계 포함 (경계값)', async () => {
    const embedder = new FakeEmbedder();
    embedder.vectors = [[1, 0]];
    const exactly = await judgeNovelty(embedder, INDEX, [candidate('c')], 1.0);
    expect(exactly.at(0)?.isNew).toBe(false); // maxScore 1 >= threshold 1

    const embedder2 = new FakeEmbedder();
    embedder2.vectors = [[1, 0]];
    const below = await judgeNovelty(embedder2, INDEX, [candidate('c')], 1.01);
    expect(below.at(0)?.isNew).toBe(true);
    expect(DEFAULT_NOVELTY_THRESHOLD).toBeGreaterThan(0);
  });

  it('빈 후보면 embed 없이 빈 배열 (경계값)', async () => {
    const embedder = new FakeEmbedder();
    expect(await judgeNovelty(embedder, INDEX, [])).toEqual([]);
    expect(embedder.calls).toHaveLength(0);
  });
});
