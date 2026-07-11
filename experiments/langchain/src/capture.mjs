import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Document } from '@langchain/core/documents';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

// 실측(2026-07-11): nomic 임베딩은 무관한 한국어 문장도 0.77~0.87 — 거의 동일한 중복(0.96+)만 스킵
const NOVELTY_THRESHOLD = 0.95;

const schema = z.object({
  items: z.array(
    z.object({
      title: z.string(),
      category: z.enum(['concept', 'fact', 'preference', 'howto']),
      content: z.string(),
    }),
  ),
});

function slugify(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return slug || 'knowledge';
}

export async function capture({ model, store, messages, captureDir }) {
  if (!messages || messages.length === 0) {
    return { extracted: 0, saved: [], skipped: [] };
  }
  const transcript = messages
    .map((m) => `${m.getType()}: ${m.content}`)
    .join('\n');
  const structured = model.withStructuredOutput(schema);
  const out = await structured.invoke([
    new SystemMessage(
      '다음 대화에서 이후에도 재사용할 가치가 있는 지식을 추출하라. 각 항목은 대화 맥락 없이도 이해되는 자기완결적 설명으로 작성. 없으면 빈 items.',
    ),
    new HumanMessage(transcript),
  ]);

  const saved = [];
  const skipped = [];
  for (const item of out.items) {
    let maxScore = 0;
    if (store) {
      const hits = await store.similaritySearchWithScore(
        `${item.title}\n${item.content}`,
        1,
      );
      maxScore = hits.at(0)?.[1] ?? 0;
    }
    if (maxScore >= NOVELTY_THRESHOLD) {
      skipped.push(item.title);
      continue;
    }
    const dir = join(captureDir, item.category);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${slugify(item.title)}.md`);
    await writeFile(
      path,
      `# ${item.title}\n\n${item.content}\n\n> novelty 최고 유사도: ${maxScore.toFixed(3)}\n`,
      'utf8',
    );
    saved.push(path);
    if (store) {
      // 증분 갱신 — 재인덱싱 없이 다음 판정에 즉시 반영 (엔진의 전체 rebuild와 비교 포인트)
      await store.addDocuments([
        new Document({
          pageContent: `${item.title}\n${item.content}`,
          metadata: { source: path },
        }),
      ]);
    }
  }
  return { extracted: out.items.length, saved, skipped };
}
