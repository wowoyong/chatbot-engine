import { LlmConnectionError, LlmResponseError } from './errors.js';
import { parseNdjsonStream } from './ndjson.js';
import type { NdjsonStats } from './ndjson.js';
import type { ChatMessage, ChatOptions, LlmClient } from './types.js';

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OllamaClientConfig {
  /** 기본 http://localhost:11434 */
  baseUrl?: string;
  /** 기본 qwen3:8b */
  model?: string;
  /** 테스트 주입용. 기본 globalThis.fetch */
  fetchFn?: FetchLike;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen3:8b';
const DEFAULT_TIMEOUT_MS = 120_000;

export class OllamaClient implements LlmClient {
  private readonly baseUrl: string;
  readonly model: string;
  private readonly fetchFn: FetchLike;

  constructor(config: OllamaClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.model = config.model ?? DEFAULT_MODEL;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    let result = '';
    for await (const piece of this.chatStream(messages, options)) {
      result += piece;
    }
    return result;
  }

  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<string, NdjsonStats> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`요청이 ${timeoutMs}ms 안에 완료되지 않았습니다`));
    }, timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          think: options.think ?? false,
          ...(options.format !== undefined ? { format: options.format } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new LlmConnectionError(this.baseUrl, err);
    }

    try {
      if (!response.ok) {
        const detail = await response.text();
        throw new LlmResponseError(response.status, detail);
      }
      if (response.body === null) {
        throw new LlmResponseError(response.status, '응답 본문이 비어 있습니다');
      }
      return yield* parseNdjsonStream(response.body);
    } finally {
      clearTimeout(timer);
    }
  }
}
