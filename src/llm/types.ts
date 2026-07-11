export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  /** 모델의 thinking(chain-of-thought) 활성 여부. 기본 false — CLI 대화 UX 보호 */
  think?: boolean;
  /** 요청 타임아웃(ms). 기본 120_000 */
  timeoutMs?: number;
}

export interface LlmClient {
  /** 전체 응답을 한 번에 반환 */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  /** 응답 content 조각을 도착 순서대로 yield */
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}

export interface Embedder {
  /** 각 입력 텍스트의 임베딩 벡터를 같은 순서로 반환 */
  embed(texts: string[]): Promise<number[][]>;
}
