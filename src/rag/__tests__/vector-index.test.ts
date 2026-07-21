import { rm, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IndexedChunk } from '../vector-index.js';
import { VectorIndex } from '../vector-index.js';

function chunk(id: string, embedding: number[]): IndexedChunk {
  return { source: `${id}.md`, heading: id, content: `본문 ${id}`, metadata: null, embedding };
}

describe('VectorIndex', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('유사도 내림차순으로 최대 topK개를 반환한다 (정상)', () => {
    const index = VectorIndex.create('m', 't', 'fp', [
      chunk('a', [1, 0]),
      chunk('b', [0.9, 0.1]),
      chunk('c', [0, 1]),
    ]);
    const hits = index.search([1, 0], 2, 0);
    expect(hits.map((h) => h.chunk.heading)).toEqual(['a', 'b']);
    expect(hits.at(0)?.score).toBeCloseTo(1, 10);
  });

  it('minScore 미만은 결과에서 제외한다 (정상)', () => {
    const index = VectorIndex.create('m', 't', 'fp', [
      chunk('관련', [1, 0]),
      chunk('무관', [0, 1]),
    ]);
    const hits = index.search([1, 0], 10, 0.5);
    expect(hits.map((h) => h.chunk.heading)).toEqual(['관련']);
  });

  it('save 후 load하면 model/createdAt/청크가 보존된다 (정상)', async () => {
    const path = join(dir, 'index.json');
    const index = VectorIndex.create('nomic-embed-text', '2026-07-11', 'sha256', [
      chunk('a', [1, 0]),
    ]);
    await index.save(path);

    const loaded = await VectorIndex.load(path);
    expect(loaded?.model).toBe('nomic-embed-text');
    expect(loaded?.createdAt).toBe('2026-07-11');
    expect(loaded?.sourceFingerprint).toBe('sha256');
    expect(loaded?.size).toBe(1);
    expect(loaded?.search([1, 0], 1, 0).at(0)?.chunk.heading).toBe('a');
  });

  it('손상된 파일은 null을 반환한다 (에러)', async () => {
    const path = join(dir, 'index.json');
    await writeFile(path, '{ 깨짐', 'utf8');
    expect(await VectorIndex.load(path)).toBeNull();
    await writeFile(path, JSON.stringify({ version: 2 }), 'utf8');
    expect(await VectorIndex.load(path)).toBeNull();
  });

  it('파일이 없으면 null을 반환한다 (경계값)', async () => {
    expect(await VectorIndex.load(join(dir, 'none.json'))).toBeNull();
  });

  it('metadata를 v2로 왕복하고 predicate로 검색 대상을 제한한다', async () => {
    const path = join(dir, 'v2.json');
    const index = VectorIndex.create('m', 't', 'fp', [
      { source: 'draft.md', heading: '', content: 'x', metadata: { tags: [], status: 'draft' }, embedding: [1, 0] },
      { source: 'verified.md', heading: '', content: 'x', metadata: { tags: ['rag'], status: 'verified' }, embedding: [1, 0] },
    ]);
    await index.save(path);
    const loaded = await VectorIndex.load(path);
    expect(loaded?.allChunks().at(1)?.metadata?.tags).toEqual(['rag']);
    expect(loaded?.search([1, 0], 10, 0, (item) => item.metadata?.status !== 'draft')
      .map((hit) => hit.chunk.source)).toEqual(['verified.md']);
  });

  it('persisted version 1은 재색인이 필요하므로 load하지 않는다', async () => {
    const path = join(dir, 'v1.json');
    await writeFile(path, JSON.stringify({ version: 1, model: 'm', createdAt: 't', chunks: [] }));
    expect(await VectorIndex.load(path)).toBeNull();
    expect(await VectorIndex.loadWithStatus(path)).toEqual({ status: 'unsupported-version' });
  });

  it('known metadata field 타입이나 status가 잘못되면 load하지 않는다', async () => {
    const path = join(dir, 'bad-metadata.json');
    await writeFile(path, JSON.stringify({
      version: 2, model: 'm', createdAt: 't', sourceFingerprint: 'fp',
      chunks: [{ source: 'a.md', heading: '', content: 'x', embedding: [1, 0], metadata: { tags: [], title: {}, status: 'pending' } }],
    }));
    expect(await VectorIndex.load(path)).toBeNull();
  });
});
