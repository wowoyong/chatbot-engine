import { readFile } from 'node:fs/promises';
import type { DocumentMetadata } from '../okf/document.js';
import { writeFileAtomic } from '../store/atomic-file.js';
import { cosineSimilarity } from './cosine.js';

export interface IndexedChunk {
  source: string;
  heading: string;
  content: string;
  metadata: DocumentMetadata | null;
  embedding: number[];
}

export interface PersistedIndex {
  version: 2;
  model: string;
  createdAt: string;
  sourceFingerprint: string;
  chunks: IndexedChunk[];
}

export interface SearchHit {
  chunk: IndexedChunk;
  score: number;
}

export type ChunkPredicate = (chunk: IndexedChunk) => boolean;
export type IndexLoadResult =
  | { status: 'loaded'; index: VectorIndex }
  | { status: 'missing' | 'invalid' | 'unsupported-version' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isMetadata(value: unknown): value is DocumentMetadata | null {
  if (value === null) return true;
  if (!isRecord(value) || !Array.isArray(value['tags'])) return false;
  const optionalStrings = [
    'type', 'title', 'description', 'resource', 'timestamp', 'category', 'provenance', 'reviewedAt',
  ] as const;
  if (!value['tags'].every((tag) => typeof tag === 'string')) return false;
  if (!optionalStrings.every((key) => value[key] === undefined || typeof value[key] === 'string')) {
    return false;
  }
  const status = value['status'];
  return status === undefined || status === 'draft' || status === 'verified' || status === 'deprecated';
}

function isIndexedChunk(value: unknown): value is IndexedChunk {
  if (!isRecord(value)) return false;
  return (
    typeof value['source'] === 'string' &&
    typeof value['heading'] === 'string' &&
    typeof value['content'] === 'string' &&
    isMetadata(value['metadata']) &&
    Array.isArray(value['embedding']) &&
    value['embedding'].every((number) => typeof number === 'number')
  );
}

function isPersistedIndex(value: unknown): value is PersistedIndex {
  if (!isRecord(value)) return false;
  return (
    value['version'] === 2 &&
    typeof value['model'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['sourceFingerprint'] === 'string' &&
    Array.isArray(value['chunks']) &&
    value['chunks'].every(isIndexedChunk)
  );
}

export class VectorIndex {
  private constructor(
    readonly model: string,
    readonly createdAt: string,
    readonly sourceFingerprint: string,
    private readonly chunks: IndexedChunk[],
  ) {}

  static create(
    model: string,
    createdAt: string,
    sourceFingerprint: string,
    chunks: IndexedChunk[],
  ): VectorIndex {
    return new VectorIndex(model, createdAt, sourceFingerprint, chunks);
  }

  get size(): number {
    return this.chunks.length;
  }

  allChunks(): IndexedChunk[] {
    return this.chunks.map((chunk) => ({
      ...chunk,
      metadata: chunk.metadata === null
        ? null
        : { ...chunk.metadata, tags: [...chunk.metadata.tags] },
      embedding: [...chunk.embedding],
    }));
  }

  search(
    queryEmbedding: readonly number[],
    topK: number,
    minScore: number,
    predicate: ChunkPredicate = () => true,
  ): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const chunk of this.chunks) {
      if (!predicate(chunk)) continue;
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (score >= minScore) hits.push({ chunk, score });
    }
    hits.sort((left, right) => right.score - left.score);
    return hits.slice(0, topK);
  }

  async save(filePath: string): Promise<void> {
    const data: PersistedIndex = {
      version: 2,
      model: this.model,
      createdAt: this.createdAt,
      sourceFingerprint: this.sourceFingerprint,
      chunks: this.chunks,
    };
    await writeFileAtomic(filePath, JSON.stringify(data));
  }

  static async loadWithStatus(filePath: string): Promise<IndexLoadResult> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      return isNodeError(error) && error.code === 'ENOENT'
        ? { status: 'missing' }
        : { status: 'invalid' };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && parsed['version'] !== 2) {
        return { status: 'unsupported-version' };
      }
      if (!isPersistedIndex(parsed)) return { status: 'invalid' };
      return {
        status: 'loaded',
        index: new VectorIndex(
          parsed.model,
          parsed.createdAt,
          parsed.sourceFingerprint,
          parsed.chunks,
        ),
      };
    } catch {
      return { status: 'invalid' };
    }
  }

  static async load(filePath: string): Promise<VectorIndex | null> {
    const result = await VectorIndex.loadWithStatus(filePath);
    return result.status === 'loaded' ? result.index : null;
  }
}
