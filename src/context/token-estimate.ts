import type { ChatMessage } from '../llm/types.js';

/** 채팅 템플릿(role 태그 등)이 메시지당 소비하는 토큰의 근사치 */
export const PER_MESSAGE_OVERHEAD = 4;

/**
 * 문자 기반 보수적 토큰 추정.
 * ASCII ≈ 4자/토큰, 그 외(한글 등) ≈ 1자/토큰 — 과대 추정 방향이라 예산 초과보다 안전.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

export function estimateMessageTokens(message: ChatMessage): number {
  return estimateTokens(message.content) + PER_MESSAGE_OVERHEAD;
}

export function estimateMessagesTokens(
  messages: readonly ChatMessage[],
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}
