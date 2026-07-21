import { ContextManager } from '../context/context-manager.js';
import type { ContextManagerConfig } from '../context/context-manager.js';
import type { ChatMessage, ChatOptions, LlmClient } from '../llm/types.js';

export interface SourceRef {
  source: string;
  heading: string;
  title?: string;
  resource?: string;
}

export interface TurnMeta {
  sources: SourceRef[];
  promptTokens?: number;
  responseTokens?: number;
}

/** 검색 컨텍스트 공급자 — rag의 Retriever가 구조적으로 만족 (chat→rag 의존 없음) */
export interface ContextRetriever {
  retrieve(query: string): Promise<{
    block: string | null;
    hits?: {
      chunk: {
        source: string;
        heading: string;
        metadata?: { title?: string; resource?: string } | null;
      };
    }[];
  }>;
}

export interface ChatSessionConfig {
  systemPrompt?: string;
  /** 컨텍스트 예산 설정 (기본: maxContextTokens 4096, reserveTokens 1024) */
  context?: ContextManagerConfig;
  /** 검색 컨텍스트 공급자 (없으면 검색 없이 동작) */
  retriever?: ContextRetriever;
}

export class ChatSession {
  private readonly client: LlmClient;
  private readonly systemPrompt: string | null;
  private readonly contextManager: ContextManager;
  private readonly retriever: ContextRetriever | null;
  private history: ChatMessage[] = [];

  constructor(client: LlmClient, config: ChatSessionConfig = {}) {
    this.client = client;
    this.systemPrompt = config.systemPrompt ?? null;
    this.contextManager = new ContextManager(client, config.context ?? {});
    this.retriever = config.retriever ?? null;
  }

  /**
   * 사용자 입력을 보내고 assistant 응답 조각을 스트리밍으로 yield.
   * retriever가 있으면 관련 문서 발췌를 검색해 함께 보낸다 (검색 실패는 무시).
   * 히스토리가 컨텍스트 예산을 넘으면 오래된 대화를 요약으로 압축해 보낸다.
   * 스트림이 끝까지 성공한 경우에만 히스토리에 (user, assistant) 쌍을 기록한다.
   * 완료 시 TurnMeta(출처·토큰)를 return한다.
   */
  async *send(userInput: string, options?: ChatOptions): AsyncGenerator<string, TurnMeta> {
    let contextBlock: string | null = null;
    let sources: SourceRef[] = [];
    if (this.retriever !== null) {
      try {
        const retrieved = await this.retriever.retrieve(userInput);
        contextBlock = retrieved.block;
        sources = (retrieved.hits ?? []).map((hit) => ({
          source: hit.chunk.source,
          heading: hit.chunk.heading,
          title: hit.chunk.metadata?.title,
          resource: hit.chunk.metadata?.resource,
        }));
      } catch {
        contextBlock = null;
      }
    }

    const prepared = await this.contextManager.prepare(
      this.systemPrompt,
      this.history,
      userInput,
      contextBlock,
    );

    let assistantContent = '';
    const stats = yield* this.streamContent(prepared.messages, options, (piece) => {
      assistantContent += piece;
    });

    this.history.push({ role: 'user', content: userInput });
    this.history.push({ role: 'assistant', content: assistantContent });
    return {
      sources,
      promptTokens: stats.promptTokens,
      responseTokens: stats.responseTokens,
    };
  }

  private async *streamContent(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    onPiece: (piece: string) => void,
  ): AsyncGenerator<string, { promptTokens?: number; responseTokens?: number }> {
    const iterator = this.client.chatStream(messages, options)[Symbol.asyncIterator]();
    let result = await iterator.next();
    while (result.done !== true) {
      onPiece(result.value);
      yield result.value;
      result = await iterator.next();
    }
    const ret: unknown = result.value;
    if (ret !== null && typeof ret === 'object') {
      const r = ret as { promptTokens?: number; responseTokens?: number };
      return { promptTokens: r.promptTokens, responseTokens: r.responseTokens };
    }
    return {};
  }

  /** 저장된 히스토리로 교체하고 요약 캐시를 리셋한다 (세션 복원용) */
  restore(history: readonly ChatMessage[]): void {
    this.history = history.map((m) => ({ ...m }));
    this.contextManager.reset();
  }

  getHistory(): readonly ChatMessage[] {
    return this.history;
  }

  clear(): void {
    this.history = [];
    this.contextManager.reset();
  }
}
