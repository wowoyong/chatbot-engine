import * as readline from 'node:readline/promises';
import { env, exit, stdin, stdout } from 'node:process';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { ChatOllama, OllamaEmbeddings } from '@langchain/ollama';
import { capture } from './capture.mjs';
import { createGraph } from './graph.mjs';
import { buildStore, loadStore, makeRetriever, saveStore } from './rag.mjs';

const DOCS_DIR = env.RAG_DOCS_DIR ?? '../../docs';
const STORE_FILE = env.LC_STORE_FILE ?? '.lc-store.json';
const DB_PATH = env.LC_CHECKPOINT_DB ?? '.lc-checkpoint.db';
const THREAD = { configurable: { thread_id: env.LC_THREAD ?? 'main' } };
const MODEL = env.OLLAMA_MODEL ?? 'qwen3:8b';

const model = new ChatOllama({ model: MODEL, baseUrl: env.OLLAMA_BASE_URL });
const embeddings = new OllamaEmbeddings({
  model: 'nomic-embed-text',
  baseUrl: env.OLLAMA_BASE_URL,
});

let store = await loadStore(embeddings, STORE_FILE);
if (store) {
  stdout.write(`(벡터스토어 로드: ${store.memoryVectors.length}청크)\n`);
}

const retriever = {
  async retrieve(query) {
    return store ? makeRetriever(store).retrieve(query) : null;
  },
};
const graph = createGraph({ model, retriever, dbPath: DB_PATH });

const existing = await graph.getState(THREAD);
const restored = existing.values.messages?.length ?? 0;
if (restored > 0) {
  stdout.write(`(체크포인트 복원: 메시지 ${restored}개)\n`);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
rl.on('SIGINT', () => {
  rl.close();
  stdout.write('\n');
  exit(0);
});

stdout.write(
  `chatbot-engine/langchain — ${MODEL} (명령: /exit 종료, /clear 새 스레드, /index RAG 인덱스, /capture 지식 저장)\n`,
);

while (true) {
  let line;
  try {
    line = (await rl.question('you> ')).trim();
  } catch {
    break;
  }
  if (!line) continue;
  if (line === '/exit') break;
  if (line === '/clear') {
    // checkpointer 모델에서는 스레드 전환이 자연스러운 초기화 방식 (비교 포인트)
    THREAD.configurable.thread_id = `main-${Date.now()}`;
    stdout.write(`(새 스레드로 전환: ${THREAD.configurable.thread_id})\n`);
    continue;
  }
  if (line === '/index') {
    try {
      stdout.write(`(${DOCS_DIR} 인덱싱...)\n`);
      store = await buildStore(embeddings, DOCS_DIR);
      await saveStore(store, STORE_FILE);
      stdout.write(`(완료: ${store.memoryVectors.length}청크 → ${STORE_FILE})\n`);
    } catch (err) {
      stdout.write(`인덱싱 오류: ${err.message}\n`);
    }
    continue;
  }
  if (line === '/capture') {
    try {
      stdout.write('(대화에서 지식을 추출합니다...)\n');
      const state = await graph.getState(THREAD);
      const result = await capture({
        model,
        store,
        messages: state.values.messages ?? [],
        captureDir: join(DOCS_DIR, 'captured'),
      });
      if (store && result.saved.length > 0) {
        await saveStore(store, STORE_FILE);
      }
      stdout.write(
        `(추출 ${result.extracted}건 → 저장 ${result.saved.length}건, 기존 지식 ${result.skipped.length}건)\n`,
      );
      for (const path of result.saved) stdout.write(`  + ${path}\n`);
      for (const title of result.skipped) stdout.write(`  = ${title} (이미 알고 있음)\n`);
    } catch (err) {
      stdout.write(`지식 추출 오류: ${err.message} — 다시 시도하세요.\n`);
    }
    continue;
  }

  stdout.write('bot> ');
  try {
    const stream = await graph.stream(
      { messages: [new HumanMessage(line)] },
      { ...THREAD, streamMode: 'messages' },
    );
    for await (const [chunk, meta] of stream) {
      if (meta.langgraph_node === 'model') {
        stdout.write(String(chunk.content ?? ''));
      }
    }
    stdout.write('\n');
  } catch (err) {
    stdout.write(`\n오류: ${err.message}\n`);
  }
}
rl.close();
