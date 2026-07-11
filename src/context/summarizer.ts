import type { ChatMessage, LlmClient } from '../llm/types.js';

const SUMMARY_SYSTEM_PROMPT =
  '다음 대화를 이후 대화의 문맥으로 쓸 수 있게 한국어 한 문단으로 요약하라. ' +
  '사용자가 알려준 사실·선호·결정 사항을 우선 보존하라.';

/**
 * 제외된 대화를 한 문단으로 요약한다.
 * LLM 호출 실패 시 예외를 그대로 전파 — 호출측에서 fallback 처리.
 */
export async function summarizeMessages(
  client: LlmClient,
  messages: readonly ChatMessage[],
): Promise<string> {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? '사용자' : '어시스턴트'}: ${m.content}`)
    .join('\n');
  return client.chat([
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: transcript },
  ]);
}
