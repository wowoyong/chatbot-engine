import type { ChatMessage, LlmClient } from '../llm/types.js';
import { estimateMessagesTokens } from './token-estimate.js';
import { summarizeMessages } from './summarizer.js';
import { trimToBudget } from './trim.js';

export interface ContextManagerConfig {
  /** 모델 컨텍스트 창 크기(토큰). 기본 4096 (Ollama 기본 num_ctx) */
  maxContextTokens?: number;
  /** 응답 생성용 여유분(토큰). 기본 1024 */
  reserveTokens?: number;
}

export interface PreparedContext {
  messages: ChatMessage[];
  /** 이번 준비에 요약 메시지가 포함됐는지 */
  summarized: boolean;
}

const DEFAULT_MAX_CONTEXT = 4096;
const DEFAULT_RESERVE = 1024;
/** 요약 메시지가 차지할 것으로 예약하는 토큰 */
export const SUMMARY_ALLOWANCE = 256;

export class ContextManager {
  private readonly client: LlmClient;
  private readonly maxContextTokens: number;
  private readonly reserveTokens: number;
  private summary: string | null = null;
  private summaryCoveredCount = 0;

  constructor(client: LlmClient, config: ContextManagerConfig = {}) {
    this.client = client;
    this.maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT;
    this.reserveTokens = config.reserveTokens ?? DEFAULT_RESERVE;
  }

  /** 요약 캐시 초기화 (세션 clear/restore 시 호출) */
  reset(): void {
    this.summary = null;
    this.summaryCoveredCount = 0;
  }

  /**
   * [system?, 검색 발췌?, 요약?, 최근 히스토리, 새 질문] 형태로 예산에 맞는 메시지 배열을 만든다.
   * 요약 실패 시: 이전 캐시가 dropped 범위 일부라도 덮으면 재사용, 없으면 트리밍만.
   */
  async prepare(
    systemPrompt: string | null,
    history: readonly ChatMessage[],
    userInput: string,
    contextBlock: string | null = null,
  ): Promise<PreparedContext> {
    const fixed: ChatMessage[] = [];
    if (systemPrompt !== null) {
      fixed.push({ role: 'system', content: systemPrompt });
    }
    if (contextBlock !== null) {
      fixed.push({ role: 'system', content: contextBlock });
    }
    const userMessage: ChatMessage = { role: 'user', content: userInput };

    const overhead = estimateMessagesTokens([...fixed, userMessage]);
    const historyBudget = Math.max(
      this.maxContextTokens - this.reserveTokens - overhead - SUMMARY_ALLOWANCE,
      0,
    );

    const { kept, dropped } = trimToBudget(history, historyBudget);

    if (dropped.length > 0) {
      if (this.summary === null || this.summaryCoveredCount !== dropped.length) {
        try {
          this.summary = await summarizeMessages(this.client, dropped);
          this.summaryCoveredCount = dropped.length;
        } catch {
          // 요약 실패 — 이전 캐시(있으면) 재사용, 없으면 트리밍만으로 진행
        }
      }
    }

    const messages: ChatMessage[] = [...fixed];
    const useSummary = dropped.length > 0 && this.summary !== null;
    if (useSummary && this.summary !== null) {
      messages.push({ role: 'system', content: `이전 대화 요약: ${this.summary}` });
    }
    messages.push(...kept);
    messages.push(userMessage);
    return { messages, summarized: useSummary };
  }
}
