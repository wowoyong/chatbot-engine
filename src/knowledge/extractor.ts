import type { ChatMessage, LlmClient } from '../llm/types.js';

export const KNOWLEDGE_CATEGORIES = [
  'concept',
  'fact',
  'preference',
  'howto',
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export interface KnowledgeCandidate {
  title: string;
  category: KnowledgeCategory;
  content: string;
}

const EXTRACT_SYSTEM_PROMPT = [
  '다음 대화에서 이후에도 재사용할 가치가 있는 지식을 추출하라.',
  '- 각 항목은 대화 맥락 없이도 이해되는 자기완결적 설명으로 작성하라',
  '- category는 다음 중 하나만: concept(개념/원리), fact(사실/수치), preference(사용자 선호/결정), howto(방법/절차)',
  '- 추출할 것이 없으면 빈 배열 []',
  '- 다른 텍스트 없이 JSON 배열만 출력: [{"title":"...","category":"...","content":"..."}]',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toCategory(value: unknown): KnowledgeCategory {
  return typeof value === 'string' &&
    (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value)
    ? (value as KnowledgeCategory)
    : 'concept';
}

/** LLM 출력에서 JSON 배열을 관대하게 파싱한다 (코드펜스/부가 텍스트 방어) */
export function parseCandidates(raw: string): KnowledgeCandidate[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) {
    throw new Error(
      `지식 추출 응답에서 JSON 배열을 찾지 못했습니다: ${raw.slice(0, 80)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('지식 추출 응답의 JSON 파싱에 실패했습니다');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('지식 추출 응답이 배열이 아닙니다');
  }
  const candidates: KnowledgeCandidate[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue; // 불량 항목은 드롭 — 전체 실패 방지
    }
    const title = item['title'];
    const content = item['content'];
    if (typeof title !== 'string' || title.trim().length === 0) {
      continue;
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      continue;
    }
    candidates.push({
      title: title.trim(),
      category: toCategory(item['category']),
      content: content.trim(),
    });
  }
  return candidates;
}

/** 대화 히스토리에서 지식 후보를 추출한다. 빈 히스토리면 LLM 호출 없이 빈 배열 */
export async function extractKnowledge(
  client: LlmClient,
  history: readonly ChatMessage[],
): Promise<KnowledgeCandidate[]> {
  if (history.length === 0) {
    return [];
  }
  const transcript = history
    .map((m) => `${m.role === 'user' ? '사용자' : '어시스턴트'}: ${m.content}`)
    .join('\n');
  const raw = await client.chat([
    { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
    { role: 'user', content: transcript },
  ]);
  return parseCandidates(raw);
}
