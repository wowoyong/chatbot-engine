import { LlmResponseError } from './errors.js';

export interface NdjsonStats {
  promptTokens?: number;
  responseTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** ndjson 한 라인에서 content 조각을 추출. error면 throw, content 없으면 null */
function extractContent(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new LlmResponseError(0, `잘못된 ndjson 라인: ${line}`);
  }
  if (!isRecord(parsed)) {
    throw new LlmResponseError(0, `객체가 아닌 ndjson 라인: ${line}`);
  }
  const errorField = parsed['error'];
  if (typeof errorField === 'string') {
    throw new LlmResponseError(0, errorField);
  }
  const message = parsed['message'];
  if (!isRecord(message)) {
    return null;
  }
  const content = message['content'];
  return typeof content === 'string' && content.length > 0 ? content : null;
}

/** ndjson 한 라인에서 done 통계를 추출 (없으면 빈 객체) */
function extractStats(line: string): NdjsonStats {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  return {
    promptTokens: numberOrUndefined(parsed['prompt_eval_count']),
    responseTokens: numberOrUndefined(parsed['eval_count']),
  };
}

/**
 * ReadableStream을 ndjson으로 파싱해 content 조각을 yield하고, 완료 시 토큰 통계를 return.
 * 청크가 라인/멀티바이트 경계와 무관하게 잘려도 안전.
 */
export async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, NdjsonStats> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stats: NdjsonStats = {};
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          const piece = extractContent(line);
          if (piece !== null) {
            yield piece;
          }
          const lineStats = extractStats(line);
          if (lineStats.promptTokens !== undefined) {
            stats = lineStats;
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest.length > 0) {
      const piece = extractContent(rest);
      if (piece !== null) {
        yield piece;
      }
      const restStats = extractStats(rest);
      if (restStats.promptTokens !== undefined) {
        stats = restStats;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return stats;
}
