import { LlmConnectionError, LlmResponseError } from './errors.js';
import type { FetchLike } from './ollama-client.js';
import type { Embedder } from './types.js';

export interface OllamaEmbedderConfig {
  /** 기본 http://localhost:11434 */
  baseUrl?: string;
  /** 기본 nomic-embed-text */
  model?: string;
  /** 테스트 주입용. 기본 globalThis.fetch */
  fetchFn?: FetchLike;
  /** 한 요청에 담는 텍스트 수. 기본 16 */
  batchSize?: number;
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_BATCH_SIZE = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumberMatrix(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        Array.isArray(row) && row.every((n) => typeof n === 'number'),
    )
  );
}

export class OllamaEmbedder implements Embedder {
  private readonly baseUrl: string;
  readonly model: string;
  private readonly fetchFn: FetchLike;
  private readonly batchSize: number;

  constructor(config: OllamaEmbedderConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.model = config.model ?? DEFAULT_MODEL;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const result: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      result.push(...(await this.embedBatch(batch)));
    }
    return result;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (err) {
      throw new LlmConnectionError(this.baseUrl, err);
    }
    if (!response.ok) {
      throw new LlmResponseError(response.status, await response.text());
    }
    const parsed: unknown = await response.json();
    if (!isRecord(parsed)) {
      throw new LlmResponseError(response.status, '임베딩 응답 형식 불일치');
    }
    const embeddings = parsed['embeddings'];
    if (!isNumberMatrix(embeddings)) {
      throw new LlmResponseError(response.status, '임베딩 응답 형식 불일치');
    }
    if (embeddings.length !== texts.length) {
      throw new LlmResponseError(
        response.status,
        `임베딩 수 불일치: 요청 ${texts.length}, 응답 ${embeddings.length}`,
      );
    }
    return embeddings;
  }
}
