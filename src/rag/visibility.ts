import type { IndexedChunk } from './vector-index.js';

export function isRetrievableChunk(chunk: IndexedChunk): boolean {
  const status = chunk.metadata?.status;
  return status !== 'draft' && status !== 'deprecated';
}
