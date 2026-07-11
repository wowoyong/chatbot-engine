import type { ChatMessage } from '../llm/types.js';
import { estimateMessagesTokens } from './token-estimate.js';

export interface TrimResult {
  /** 예산 안에 들어가는 최근 메시지들 (원본 순서 유지) */
  kept: ChatMessage[];
  /** 예산 초과로 제외된 앞쪽 메시지들 (원본 순서 유지) */
  dropped: ChatMessage[];
}

/**
 * 히스토리를 뒤(최신)에서부터 (user, assistant) 쌍 단위로 채워 budgetTokens에 맞춘다.
 * - 마지막 쌍 하나도 못 담는 예산이면 kept는 빈 배열 (전부 dropped)
 * - 히스토리 길이가 홀수인 비정상 입력이면 앞쪽 잔여 1개는 dropped로 처리
 */
export function trimToBudget(
  history: readonly ChatMessage[],
  budgetTokens: number,
): TrimResult {
  let startIndex = history.length;
  let used = 0;
  while (startIndex >= 2) {
    const pair = history.slice(startIndex - 2, startIndex);
    const pairTokens = estimateMessagesTokens(pair);
    if (used + pairTokens > budgetTokens) {
      break;
    }
    used += pairTokens;
    startIndex -= 2;
  }
  return {
    kept: history.slice(startIndex).map((m) => ({ ...m })),
    dropped: history.slice(0, startIndex).map((m) => ({ ...m })),
  };
}
