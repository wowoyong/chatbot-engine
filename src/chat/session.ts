import { ContextManager } from '../context/context-manager.js';
import type { ContextManagerConfig } from '../context/context-manager.js';
import type { ChatMessage, ChatOptions, LlmClient } from '../llm/types.js';

/** 검색 컨텍스트 공급자 — rag의 Retriever가 구조적으로 만족 (chat→rag 의존 없음) */
export interface ContextRetriever {
  retrieve(query: string): Promise<{ block: string | null }>;
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
   */
  async *send(userInput: string, options?: ChatOptions): AsyncGenerator<string> {
    let contextBlock: string | null = null;
    if (this.retriever !== null) {
      try {
        contextBlock = (await this.retriever.retrieve(userInput)).block;
      } catch {
        contextBlock = null; // 검색 실패는 대화를 막지 않는다
      }
    }

    const prepared = await this.contextManager.prepare(
      this.systemPrompt,
      this.history,
      userInput,
      contextBlock,
    );

    let assistantContent = '';
    for await (const piece of this.client.chatStream(prepared.messages, options)) {
      assistantContent += piece;
      yield piece;
    }

    this.history.push({ role: 'user', content: userInput });
    this.history.push({ role: 'assistant', content: assistantContent });
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
