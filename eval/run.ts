import { env, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { OllamaEmbedder } from '../src/llm/ollama-embedder.js';
import { buildIndex } from '../src/rag/indexer.js';
import type { VectorIndex } from '../src/rag/vector-index.js';
import { GOLDEN_QUESTIONS } from './golden.js';
import { summarize } from './metric.js';

/** 질의 → 순위대로 정렬된 source 목록 (상위 K) */
export type SearchFn = (query: string, topK: number) => Promise<string[]>;

const RANK_DEPTH = 10;

/** 청크 source(전체 경로)를 golden expectedSource(파일명)와 맞추기 위해 basename으로 정규화 */
export function toSourceName(source: string): string {
  return basename(source);
}

export async function runEval(label: string, search: SearchFn): Promise<void> {
  const perQuestion: { ranked: string[]; expected: string }[] = [];
  for (const q of GOLDEN_QUESTIONS) {
    const ranked = await search(q.question, RANK_DEPTH);
    perQuestion.push({ ranked, expected: q.expectedSource });
  }
  const s = summarize(perQuestion);
  stdout.write(
    `[${label}] n=${s.count} recall@1=${s.recallAt1.toFixed(3)} recall@4=${s.recallAt4.toFixed(3)} MRR=${s.mrr.toFixed(3)}\n`,
  );
}

/** 벡터 검색기: 인덱스를 임베딩 검색해 source 순위 반환 */
export function vectorSearch(embedder: OllamaEmbedder, index: VectorIndex): SearchFn {
  return async (query: string, topK: number) => {
    const [embedding] = await embedder.embed([query]);
    const hits = index.search(embedding ?? [], topK, 0);
    return hits.map((h) => toSourceName(h.chunk.source));
  };
}

async function main(): Promise<void> {
  const corpusDir = join(dirname(fileURLToPath(import.meta.url)), 'corpus');
  const embedder = new OllamaEmbedder({ baseUrl: env['OLLAMA_BASE_URL'] });
  stdout.write('(corpus 인덱싱 중...)\n');
  const index = await buildIndex(embedder, corpusDir, {
    model: embedder.model,
    createdAt: 'eval',
  });
  await runEval('vector', vectorSearch(embedder, index));
}

main().catch((err: unknown) => {
  stdout.write(`eval 오류: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
