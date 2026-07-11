import type { ChatMessage, ChatOptions, LlmClient } from '../llm/types.js';

export interface ChatSessionConfig {
  systemPrompt?: string;
}

export class ChatSession {
  private readonly client: LlmClient;
  private readonly systemPrompt: string | null;
  private history: ChatMessage[] = [];

  constructor(client: LlmClient, config: ChatSessionConfig = {}) {
    this.client = client;
    this.systemPrompt = config.systemPrompt ?? null;
  }

  /**
   * 사용자 입력을 보내고 assistant 응답 조각을 스트리밍으로 yield.
   * 스트림이 끝까지 성공한 경우에만 히스토리에 (user, assistant) 쌍을 기록한다.
   */
  async *send(userInput: string, options?: ChatOptions): AsyncGenerator<string> {
    const messages: ChatMessage[] = [];
    if (this.systemPrompt !== null) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }
    messages.push(...this.history);
    messages.push({ role: 'user', content: userInput });

    let assistantContent = '';
    for await (const piece of this.client.chatStream(messages, options)) {
      assistantContent += piece;
      yield piece;
    }

    this.history.push({ role: 'user', content: userInput });
    this.history.push({ role: 'assistant', content: assistantContent });
  }

  getHistory(): readonly ChatMessage[] {
    return this.history;
  }

  clear(): void {
    this.history = [];
  }
}
