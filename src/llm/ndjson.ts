import { LlmResponseError } from './errors.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * ndjson 한 라인에서 content 조각을 추출한다.
 * - error 라인이면 LlmResponseError(0) throw
 * - content 없는 라인(done 마커 등)이면 null
 */
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

/**
 * ReadableStream<Uint8Array>를 ndjson으로 파싱해 content 조각을 yield.
 * 청크가 라인/멀티바이트 문자 경계와 무관하게 잘려도 안전하다.
 */
export async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
    }
  } finally {
    reader.releaseLock();
  }
}
