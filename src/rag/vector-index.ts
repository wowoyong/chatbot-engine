import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../store/atomic-file.js';
import { cosineSimilarity } from './cosine.js';

export interface IndexedChunk {
  source: string;
  heading: string;
  content: string;
  embedding: number[];
}

export interface PersistedIndex {
  version: 1;
  model: string;
  createdAt: string;
  chunks: IndexedChunk[];
}

export interface SearchHit {
  chunk: IndexedChunk;
  score: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIndexedChunk(value: unknown): value is IndexedChunk {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['source'] === 'string' &&
    typeof value['heading'] === 'string' &&
    typeof value['content'] === 'string' &&
    Array.isArray(value['embedding']) &&
    value['embedding'].every((n) => typeof n === 'number')
  );
}

function isPersistedIndex(value: unknown): value is PersistedIndex {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value['version'] === 1 &&
    typeof value['model'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    Array.isArray(value['chunks']) &&
    value['chunks'].every(isIndexedChunk)
  );
}

export class VectorIndex {
  private constructor(
    readonly model: string,
    readonly createdAt: string,
    private readonly chunks: IndexedChunk[],
  ) {}

  static create(
    model: string,
    createdAt: string,
    chunks: IndexedChunk[],
  ): VectorIndex {
    return new VectorIndex(model, createdAt, chunks);
  }

  get size(): number {
    return this.chunks.length;
  }

  /** 질의 벡터와 유사한 청크를 점수 내림차순 최대 topK개 반환 (minScore 미만 제외) */
  search(
    queryEmbedding: readonly number[],
    topK: number,
    minScore: number,
  ): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const chunk of this.chunks) {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (score >= minScore) {
        hits.push({ chunk, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  async save(filePath: string): Promise<void> {
    const data: PersistedIndex = {
      version: 1,
      model: this.model,
      createdAt: this.createdAt,
      chunks: this.chunks,
    };
    await writeFileAtomic(filePath, JSON.stringify(data));
  }

  /** 파일 없음/손상/스키마 불일치 → null (인덱스는 /index로 재생성 가능한 파생물) */
  static async load(filePath: string): Promise<VectorIndex | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedIndex(parsed)) {
        return null;
      }
      return new VectorIndex(parsed.model, parsed.createdAt, parsed.chunks);
    } catch {
      return null;
    }
  }
}
