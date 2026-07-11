import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Embedder } from '../llm/types.js';
import type { Chunk } from './chunker.js';
import { chunkMarkdown } from './chunker.js';
import type { IndexedChunk } from './vector-index.js';
import { VectorIndex } from './vector-index.js';

/** dir 이하의 .md 파일 경로를 재귀 수집 (이름순 정렬 — 결정적 순서) */
export async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(path)));
    } else if (extname(entry.name) === '.md') {
      files.push(path);
    }
  }
  return files;
}

export interface BuildIndexOptions {
  /** 인덱스에 기록할 임베딩 모델명 */
  model: string;
  /** 인덱스 생성 시각 (ISO 문자열 — 호출측에서 주입) */
  createdAt: string;
}

/** docsDir의 md 전체를 청킹·임베딩해 VectorIndex를 만든다. md가 없으면 빈 인덱스 */
export async function buildIndex(
  embedder: Embedder,
  docsDir: string,
  options: BuildIndexOptions,
): Promise<VectorIndex> {
  const files = await listMarkdownFiles(docsDir);
  const chunks: Chunk[] = [];
  for (const file of files) {
    const markdown = await readFile(file, 'utf8');
    chunks.push(...chunkMarkdown(markdown, file));
  }
  const inputs = chunks.map((c) =>
    c.heading.length > 0 ? `${c.heading}\n${c.content}` : c.content,
  );
  const embeddings = await embedder.embed(inputs);
  const indexed: IndexedChunk[] = chunks.map((chunk, i) => ({
    ...chunk,
    embedding: embeddings.at(i) ?? [],
  }));
  return VectorIndex.create(options.model, options.createdAt, indexed);
}
