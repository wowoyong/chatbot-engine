import { ChatSession } from '../chat/session.js';
import type { Embedder, LlmClient } from '../llm/types.js';
import { OllamaClient } from '../llm/ollama-client.js';
import { OllamaEmbedder } from '../llm/ollama-embedder.js';
import { buildIndex } from '../rag/indexer.js';
import { Retriever } from '../rag/retriever.js';
import { VectorIndex } from '../rag/vector-index.js';
import { SessionStore } from '../store/session-store.js';

export type AppEnv = Record<string, string | undefined>;

export interface AppOverrides {
  /** 테스트 주입용 */
  client?: LlmClient;
  embedder?: Embedder;
}

export interface App {
  session: ChatSession;
  store: SessionStore;
  docsDir: string;
  indexFile: string;
  /** 배너 표시용 채팅 모델명 */
  modelName: string;
  /** 시작 시 상태 안내 (인덱스 로드/모델 불일치/세션 복원) */
  startupNotices: string[];
  /** docsDir를 재인덱싱하고 retriever를 교체. 청크 수 반환 */
  rebuildIndex(createdAt: string): Promise<number>;
}

const SYSTEM_PROMPT =
  '당신은 간결하고 정확하게 답하는 한국어 어시스턴트입니다.';
const DEFAULT_SESSION_FILE = '.chatbot/session.json';
const DEFAULT_INDEX_FILE = '.chatbot/rag-index.json';
const DEFAULT_DOCS_DIR = 'docs';

export async function createApp(
  env: AppEnv,
  overrides: AppOverrides = {},
): Promise<App> {
  const client =
    overrides.client ??
    new OllamaClient({
      baseUrl: env['OLLAMA_BASE_URL'],
      model: env['OLLAMA_MODEL'],
    });
  const embedder =
    overrides.embedder ?? new OllamaEmbedder({ baseUrl: env['OLLAMA_BASE_URL'] });
  const embedderModel =
    embedder instanceof OllamaEmbedder ? embedder.model : 'fake-embedder';
  const modelName =
    client instanceof OllamaClient ? client.model : 'fake-llm';

  const store = new SessionStore(
    env['CHATBOT_SESSION_FILE'] ?? DEFAULT_SESSION_FILE,
  );
  const indexFile = env['CHATBOT_INDEX_FILE'] ?? DEFAULT_INDEX_FILE;
  const docsDir = env['RAG_DOCS_DIR'] ?? DEFAULT_DOCS_DIR;
  const startupNotices: string[] = [];

  let retriever: Retriever | null = null;
  const loadedIndex = await VectorIndex.load(indexFile);
  if (loadedIndex !== null) {
    if (loadedIndex.model === embedderModel) {
      retriever = new Retriever(embedder, loadedIndex);
      startupNotices.push(
        `RAG 인덱스 로드: ${loadedIndex.size}청크, 생성 ${loadedIndex.createdAt}`,
      );
    } else {
      startupNotices.push(
        `RAG 인덱스의 임베딩 모델(${loadedIndex.model})이 현재(${embedderModel})와 달라 무시합니다 — 재인덱싱하세요`,
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
    startupNotices.push(
      `이전 세션을 복원했습니다 — ${Math.floor(restored.length / 2)}턴`,
    );
  }

  return {
    session,
    store,
    docsDir,
    indexFile,
    modelName,
    startupNotices,
    async rebuildIndex(createdAt: string): Promise<number> {
      const built = await buildIndex(embedder, docsDir, {
        model: embedderModel,
        createdAt,
      });
      await built.save(indexFile);
      retriever = new Retriever(embedder, built);
      return built.size;
    },
  };
}
