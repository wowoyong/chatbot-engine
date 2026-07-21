import { env, stdout } from 'node:process';
import { relative, resolve, sep } from 'node:path';
import { OllamaEmbedder } from '../src/llm/ollama-embedder.js';
import { buildIndex } from '../src/rag/indexer.js';
import { DEFAULT_MIN_VECTOR_SCORE, HybridRetriever } from '../src/rag/hybrid-retriever.js';
import { summarizeWithAbstention } from './metric.js';
import { WIKI_GOLDEN_QUESTIONS } from './wiki-golden.js';

const MIN_RECALL_AT_4 = 0.75;
const MIN_MRR = 0.55;
const MIN_NO_ANSWER_ACCURACY = 0.66;

async function main(): Promise<void> {
  const openwikiRoot = resolve('openwiki');
  const embedder = new OllamaEmbedder({ baseUrl: env['OLLAMA_BASE_URL'] });
  const index = await buildIndex(embedder, openwikiRoot, {
    model: embedder.model,
    createdAt: 'wiki-eval',
  });
  const retriever = new HybridRetriever(embedder, index, {
    topK: 4,
    minVectorScore: DEFAULT_MIN_VECTOR_SCORE,
  });
  const perQuestion = [];
  for (const item of WIKI_GOLDEN_QUESTIONS) {
    const hits = (await retriever.retrieve(item.question)).hits;
    perQuestion.push({
      ranked: hits.map((hit) => relative(openwikiRoot, hit.chunk.source).split(sep).join('/')),
      expected: item.expectedSource,
    });
  }
  console.table(perQuestion);
  const summary = summarizeWithAbstention(perQuestion);
  stdout.write(`${JSON.stringify(summary)}\n`);
  if (
    summary.recallAt4 < MIN_RECALL_AT_4 ||
    summary.mrr < MIN_MRR ||
    summary.noAnswerAccuracy < MIN_NO_ANSWER_ACCURACY
  ) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  stdout.write(`wiki eval 오류: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
