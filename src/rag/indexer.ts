import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { Embedder } from '../llm/types.js';
import { parseMarkdownDocument } from '../okf/document.js';
import type { Chunk } from './chunker.js';
import { chunkMarkdown } from './chunker.js';
import type { IndexedChunk } from './vector-index.js';
import { VectorIndex } from './vector-index.js';

export async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sorted) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listMarkdownFiles(path)));
    else if (extname(entry.name) === '.md') files.push(path);
  }
  return files;
}

interface LoadedDocument {
  source: string;
  relativePath: string;
  raw: string;
}

async function loadMarkdownDocuments(docsDir: string): Promise<LoadedDocument[]> {
  const files = (await listMarkdownFiles(docsDir)).filter(
    (source) => relative(docsDir, source).split(sep).join('/') !== 'INSTRUCTIONS.md',
  );
  return Promise.all(
    files.map(async (source) => ({
      source,
      relativePath: relative(docsDir, source).split(sep).join('/'),
      raw: await readFile(source, 'utf8'),
    })),
  );
}

function fingerprintDocuments(documents: readonly LoadedDocument[]): string {
  const hash = createHash('sha256');
  for (const document of documents) {
    hash.update(document.relativePath);
    hash.update('\0');
    hash.update(document.raw);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function computeSourceFingerprint(docsDir: string): Promise<string> {
  return fingerprintDocuments(await loadMarkdownDocuments(docsDir));
}

export interface BuildIndexOptions {
  model: string;
  createdAt: string;
}

export async function buildIndex(
  embedder: Embedder,
  docsDir: string,
  options: BuildIndexOptions,
): Promise<VectorIndex> {
  const documents = await loadMarkdownDocuments(docsDir);
  const chunks: Chunk[] = [];
  for (const document of documents) {
    const parsed = parseMarkdownDocument(document.raw);
    chunks.push(...chunkMarkdown(parsed.body, document.source, {}, parsed.metadata));
  }
  const inputs = chunks.map((chunk) => {
    const metadataText = [
      chunk.metadata?.type,
      chunk.metadata?.title,
      chunk.metadata?.description,
      ...(chunk.metadata?.tags ?? []),
    ].filter((value): value is string => value !== undefined && value.length > 0);
    return [...metadataText, chunk.heading, chunk.content]
      .filter((value) => value.length > 0)
      .join('\n');
  });
  const embeddings = await embedder.embed(inputs);
  const indexed: IndexedChunk[] = chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings.at(index) ?? [],
  }));
  return VectorIndex.create(
    options.model,
    options.createdAt,
    fingerprintDocuments(documents),
    indexed,
  );
}
