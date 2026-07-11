import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Embedder } from '../../llm/types.js';
import { buildIndex, listMarkdownFiles } from '../indexer.js';

class FakeEmbedder implements Embedder {
  readonly calls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((_, i) => [i + 1, 0]);
  }
}

describe('indexer', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join('.test-tmp', randomUUID());
    await mkdir(join(dir, 'sub'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('md 파일을 재귀·이름순으로 수집하고 다른 확장자는 제외한다 (정상)', async () => {
    await writeFile(join(dir, 'b.md'), '# B', 'utf8');
    await writeFile(join(dir, 'a.md'), '# A', 'utf8');
    await writeFile(join(dir, 'skip.txt'), 'x', 'utf8');
    await writeFile(join(dir, 'sub', 'c.md'), '# C', 'utf8');

    const files = await listMarkdownFiles(dir);
    expect(files).toEqual([join(dir, 'a.md'), join(dir, 'b.md'), join(dir, 'sub', 'c.md')]);
  });

  it('buildIndex는 헤딩을 임베딩 입력에 접두어로 포함한다 (정상)', async () => {
    await writeFile(join(dir, 'a.md'), '# 제목\n본문', 'utf8');
    const embedder = new FakeEmbedder();

    const index = await buildIndex(embedder, dir, { model: 'm', createdAt: 't' });

    expect(embedder.calls.at(0)).toEqual(['제목\n본문']);
    expect(index.size).toBe(1);
    expect(index.model).toBe('m');
    expect(index.createdAt).toBe('t');
  });

  it('청크와 임베딩이 순서대로 매핑된다 (정상)', async () => {
    await writeFile(join(dir, 'a.md'), '# 하나\n일\n# 둘\n이', 'utf8');
    const embedder = new FakeEmbedder();

    const index = await buildIndex(embedder, dir, { model: 'm', createdAt: 't' });

    // FakeEmbedder는 i번째 입력에 [i+1, 0]을 반환 — 첫 청크가 [1,0]과 정확히 일치해야 함
    const hits = index.search([1, 0], 2, 0);
    expect(hits.at(0)?.chunk.heading).toBe('하나');
  });

  it('md가 없는 디렉토리는 빈 인덱스를 만든다 (경계값)', async () => {
    const embedder = new FakeEmbedder();
    const index = await buildIndex(embedder, dir, { model: 'm', createdAt: 't' });
    expect(index.size).toBe(0);
  });
});
