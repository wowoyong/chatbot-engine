import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

const TOP_K = 4;
const MIN_SCORE = 0.35;

async function listMarkdown(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdown(path)));
    } else if (extname(entry.name) === '.md') {
      files.push(path);
    }
  }
  return files;
}

export async function buildStore(embeddings, docsDir) {
  const splitter = RecursiveCharacterTextSplitter.fromLanguage('markdown', {
    chunkSize: 1500,
    chunkOverlap: 200,
  });
  const docs = [];
  for (const file of await listMarkdown(docsDir)) {
    const text = await readFile(file, 'utf8');
    docs.push(...(await splitter.createDocuments([text], [{ source: file }])));
  }
  const store = new MemoryVectorStore(embeddings);
  if (docs.length > 0) {
    await store.addDocuments(docs);
  }
  return store;
}

export async function saveStore(store, path) {
  await writeFile(path, JSON.stringify(store.memoryVectors), 'utf8');
}

export async function loadStore(embeddings, path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(raw)) return null;
    const store = new MemoryVectorStore(embeddings);
    store.memoryVectors = raw;
    return store;
  } catch {
    return null;
  }
}

export function makeRetriever(store) {
  return {
    async retrieve(query) {
      if (!query) return null;
      const hits = await store.similaritySearchWithScore(query, TOP_K);
      const kept = hits.filter(([, score]) => score >= MIN_SCORE);
      if (kept.length === 0) return null;
      const sections = kept.map(
        ([doc]) => `[${doc.metadata.source ?? '문서'}]\n${doc.pageContent}`,
      );
      return (
        '다음은 질문과 관련된 문서 발췌다. 답변에 활용하되, 관련이 없으면 무시하라.\n\n' +
        sections.join('\n\n---\n\n')
      );
    },
  };
}
