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

/** Ollama format용 JSON 스키마 — enum은 KNOWLEDGE_CATEGORIES 단일 소스 참조 */
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          category: { type: 'string', enum: [...KNOWLEDGE_CATEGORIES] },
          content: { type: 'string' },
        },
        required: ['title', 'category', 'content'],
      },
    },
  },
  required: ['items'],
};

const EXTRACT_SYSTEM_PROMPT = [
  '다음 대화에서 이후에도 재사용할 가치가 있는 지식을 추출하라.',
  '- 각 항목은 대화 맥락 없이도 이해되는 자기완결적 설명으로 작성하라',
  '- 어시스턴트의 맞장구·확인 발화(예: "알겠습니다", "기억했어요")는 지식이 아니다. 사용자가 제공한 정보나 확립된 사실·개념만 추출하라',
  '- category는 다음 중 하나만: concept(개념/원리), fact(사실/수치), preference(사용자 선호/결정), howto(방법/절차)',
  '- 추출할 것이 없으면 items를 빈 배열로',
  '- JSON만 출력: {"items":[{"title":"...","category":"...","content":"..."}]}',
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

/** LLM 출력에서 첫 JSON 값(객체 또는 배열)을 관대하게 파싱 (코드펜스/부가 텍스트 방어) */
function looseParse(raw: string): unknown {
  const objStart = raw.indexOf('{');
  const arrStart = raw.indexOf('[');
  let start: number;
  let end: number;
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    start = objStart;
    end = raw.lastIndexOf('}');
  } else if (arrStart >= 0) {
    start = arrStart;
    end = raw.lastIndexOf(']');
  } else {
    throw new Error(
      `지식 추출 응답에서 JSON을 찾지 못했습니다: ${raw.slice(0, 80)}`,
    );
  }
  if (end <= start) {
    throw new Error(
      `지식 추출 응답에서 JSON을 찾지 못했습니다: ${raw.slice(0, 80)}`,
    );
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('지식 추출 응답의 JSON 파싱에 실패했습니다');
  }
}

/** LLM 출력을 후보 배열로 파싱. array 또는 {items:[...]} 양쪽 수용 */
export function parseCandidates(raw: string): KnowledgeCandidate[] {
  const parsed = looseParse(raw);
  const array = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed['items'])
      ? parsed['items']
      : null;
  if (array === null) {
    throw new Error('지식 추출 응답이 배열/items 형식이 아닙니다');
  }
  const candidates: KnowledgeCandidate[] = [];
  for (const item of array) {
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

/** 대화 히스토리에서 지식 후보를 추출. 빈 히스토리면 LLM 호출 없이 빈 배열 */
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
  const raw = await client.chat(
    [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
    { format: EXTRACT_SCHEMA },
  );
  return parseCandidates(raw);
}
