import * as readline from 'node:readline/promises';
import { env, exit, stdin, stdout } from 'node:process';
import { ChatSession } from '../chat/session.js';
import { LlmConnectionError } from '../llm/errors.js';
import { OllamaClient } from '../llm/ollama-client.js';
import { OllamaEmbedder } from '../llm/ollama-embedder.js';
import { buildIndex } from '../rag/indexer.js';
import { Retriever } from '../rag/retriever.js';
import { VectorIndex } from '../rag/vector-index.js';
import { SessionStore } from '../store/session-store.js';

const SYSTEM_PROMPT =
  '당신은 간결하고 정확하게 답하는 한국어 어시스턴트입니다.';
const DEFAULT_SESSION_FILE = '.chatbot/session.json';
const DEFAULT_INDEX_FILE = '.chatbot/rag-index.json';
const DEFAULT_DOCS_DIR = 'docs';

async function main(): Promise<void> {
  const client = new OllamaClient({
    baseUrl: env['OLLAMA_BASE_URL'],
    model: env['OLLAMA_MODEL'],
  });
  const embedder = new OllamaEmbedder({ baseUrl: env['OLLAMA_BASE_URL'] });
  const store = new SessionStore(
    env['CHATBOT_SESSION_FILE'] ?? DEFAULT_SESSION_FILE,
  );
  const indexFile = env['CHATBOT_INDEX_FILE'] ?? DEFAULT_INDEX_FILE;
  const docsDir = env['RAG_DOCS_DIR'] ?? DEFAULT_DOCS_DIR;

  let retriever: Retriever | null = null;
  const loadedIndex = await VectorIndex.load(indexFile);
  if (loadedIndex !== null) {
    if (loadedIndex.model === embedder.model) {
      retriever = new Retriever(embedder, loadedIndex);
      stdout.write(
        `(RAG 인덱스 로드: ${loadedIndex.size}청크, 생성 ${loadedIndex.createdAt})\n`,
      );
    } else {
      stdout.write(
        `(RAG 인덱스의 임베딩 모델(${loadedIndex.model})이 현재(${embedder.model})와 달라 무시합니다 — /index로 재구축하세요)\n`,
      );
    }
  }

  const session = new ChatSession(client, {
    systemPrompt: SYSTEM_PROMPT,
    retriever: {
      retrieve: async (query: string) =>
        retriever !== null ? retriever.retrieve(query) : { block: null },
    },
  });

  const restored = await store.load();
  if (restored !== null && restored.length > 0) {
    session.restore(restored);
    stdout.write(
      `(이전 세션을 복원했습니다 — ${Math.floor(restored.length / 2)}턴)\n`,
    );
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  rl.on('SIGINT', () => {
    rl.close();
    stdout.write('\n');
    exit(0);
  });

  stdout.write(
    `chatbot-engine — ${env['OLLAMA_MODEL'] ?? 'qwen3:8b'} (명령: /exit 종료, /clear 히스토리 초기화, /index RAG 인덱스 구축)\n`,
  );

  while (true) {
    let line: string;
    try {
      line = (await rl.question('you> ')).trim();
    } catch {
      break; // Ctrl-D 등 입력 스트림 종료
    }
    if (line.length === 0) {
      continue;
    }
    if (line === '/exit') {
      break;
    }
    if (line === '/clear') {
      session.clear();
      await store.clear();
      stdout.write('(히스토리를 초기화했습니다)\n');
      continue;
    }
    if (line === '/index') {
      try {
        stdout.write(`(${docsDir}/ 문서를 인덱싱합니다...)\n`);
        const built = await buildIndex(embedder, docsDir, {
          model: embedder.model,
          createdAt: new Date().toISOString(),
        });
        await built.save(indexFile);
        retriever = new Retriever(embedder, built);
        stdout.write(`(인덱스 구축 완료: ${built.size}청크 → ${indexFile})\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stdout.write(`인덱싱 오류: ${message}\n`);
      }
      continue;
    }

    stdout.write('bot> ');
    try {
      for await (const piece of session.send(line)) {
        stdout.write(piece);
      }
      stdout.write('\n');
      await store.save(session.getHistory());
    } catch (err) {
      if (err instanceof LlmConnectionError) {
        stdout.write(`\n오류: ${err.message}\n`);
        rl.close();
        exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(
        `\n오류: ${message} — 히스토리는 보존되었으니 다시 시도하세요.\n`,
      );
    }
  }

  rl.close();
}

main().catch((err: unknown) => {
  console.error(err);
  exit(1);
});
