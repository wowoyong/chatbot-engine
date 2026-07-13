import { join } from 'node:path';
import { ChatSession } from '../chat/session.js';
import { extractKnowledge } from '../knowledge/extractor.js';
import { listCaptured } from '../knowledge/capture-store.js';
import { judgeNovelty } from '../knowledge/novelty.js';
import { saveCaptured } from '../knowledge/capture-store.js';
import type { Embedder, LlmClient } from '../llm/types.js';
import { OllamaClient } from '../llm/ollama-client.js';
import { OllamaEmbedder } from '../llm/ollama-embedder.js';
import { GgufModel } from '../gguf/model.js';
import { BpeTokenizer } from '../tokenizer/bpe.js';
import { TransformerModel } from '../transformer/model.js';
import { NativeLlmClient } from '../native/native-client.js';
import { buildIndex } from '../rag/indexer.js';
import { HybridRetriever } from '../rag/hybrid-retriever.js';
import { VectorIndex } from '../rag/vector-index.js';
import { SessionStore } from '../store/session-store.js';

export type AppEnv = Record<string, string | undefined>;

export interface AppOverrides {
  /** 테스트 주입용 */
  client?: LlmClient;
  embedder?: Embedder;
}

export interface CaptureResult {
  /** 추출된 후보 수 */
  extracted: number;
  /** 저장된 파일 경로들 */
  saved: string[];
  /** 기존 지식으로 판정되어 스킵된 제목들 */
  skipped: string[];
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
  /** 대화에서 새 지식을 추출·novelty 판정·저장하고, 저장분이 있으면 재인덱싱 */
  captureKnowledge(capturedAt: string): Promise<CaptureResult>;
  /** 저장된 지식 목록 (<docsDir>/captured) */
  listCaptured(): Promise<import('../knowledge/capture-store.js').CapturedEntry[]>;
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
  let client: LlmClient;
  let modelLabel: string;
  if (overrides.client !== undefined) {
    client = overrides.client;
    modelLabel = 'fake-llm';
  } else if (env['LLM_ENGINE'] === 'native' && env['NATIVE_GGUF_FILE'] !== undefined) {
    const ggufModel = await GgufModel.load(env['NATIVE_GGUF_FILE']);
    const tokenizer = new BpeTokenizer({
      tokens: ggufModel.metadataArray('tokenizer.ggml.tokens') as string[],
      merges: ggufModel.metadataArray('tokenizer.ggml.merges') as string[],
      tokenType: ggufModel.metadataArray('tokenizer.ggml.token_type') as number[],
    });
    const transformer = new TransformerModel(ggufModel);
    client = new NativeLlmClient(transformer, tokenizer, { systemPrompt: SYSTEM_PROMPT });
    modelLabel = 'native (qwen2.5-0.5b)';
  } else {
    const ollama = new OllamaClient({
      baseUrl: env['OLLAMA_BASE_URL'],
      model: env['OLLAMA_MODEL'],
    });
    client = ollama;
    modelLabel = ollama.model;
  }
  const embedder =
    overrides.embedder ?? new OllamaEmbedder({ baseUrl: env['OLLAMA_BASE_URL'] });
  const embedderModel =
    embedder instanceof OllamaEmbedder ? embedder.model : 'fake-embedder';
  const modelName = modelLabel;

  const store = new SessionStore(
    env['CHATBOT_SESSION_FILE'] ?? DEFAULT_SESSION_FILE,
  );
  const indexFile = env['CHATBOT_INDEX_FILE'] ?? DEFAULT_INDEX_FILE;
  const docsDir = env['RAG_DOCS_DIR'] ?? DEFAULT_DOCS_DIR;
  const startupNotices: string[] = [];

  let currentIndex: VectorIndex | null = null;
  let retriever: HybridRetriever | null = null;

  const loadedIndex = await VectorIndex.load(indexFile);
  if (loadedIndex !== null) {
    if (loadedIndex.model === embedderModel) {
      currentIndex = loadedIndex;
      retriever = new HybridRetriever(embedder, loadedIndex);
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

  async function rebuild(createdAt: string): Promise<number> {
    const built = await buildIndex(embedder, docsDir, {
      model: embedderModel,
      createdAt,
    });
    await built.save(indexFile);
    currentIndex = built;
    retriever = new HybridRetriever(embedder, built);
    return built.size;
  }

  return {
    session,
    store,
    docsDir,
    indexFile,
    modelName,
    startupNotices,
    rebuildIndex: rebuild,
    async captureKnowledge(capturedAt: string): Promise<CaptureResult> {
      const candidates = await extractKnowledge(client, session.getHistory());
      const verdicts = await judgeNovelty(embedder, currentIndex, candidates);
      const captureDir = join(docsDir, 'captured');
      const saved: string[] = [];
      const skipped: string[] = [];
      for (const verdict of verdicts) {
        if (verdict.isNew) {
          saved.push(await saveCaptured(captureDir, verdict, capturedAt));
        } else {
          skipped.push(verdict.candidate.title);
        }
      }
      if (saved.length > 0) {
        await rebuild(capturedAt);
      }
      return { extracted: candidates.length, saved, skipped };
    },
    listCaptured(): Promise<
      import('../knowledge/capture-store.js').CapturedEntry[]
    > {
      return listCaptured(join(docsDir, 'captured'));
    },
  };
}
