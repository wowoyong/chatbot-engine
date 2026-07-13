import type { ChatMessage } from '../llm/types.js';

/** 메시지를 Qwen2 ChatML 프롬프트 문자열로 조립 */
export function buildChatMlPrompt(
  messages: readonly ChatMessage[],
  systemPrompt?: string,
): string {
  let out = '';
  const hasSystem = messages.some((m) => m.role === 'system');
  if (systemPrompt !== undefined && !hasSystem) {
    out += `<|im_start|>system\n${systemPrompt}<|im_end|>\n`;
  }
  for (const m of messages) {
    out += `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`;
  }
  out += '<|im_start|>assistant\n';
  return out;
}
