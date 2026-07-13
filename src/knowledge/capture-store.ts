import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../store/atomic-file.js';
import type { NoveltyVerdict } from './novelty.js';

/** 제목 → 파일명 슬러그 (한글 보존, 특수문자 '-', 최대 50자) */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : 'knowledge';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 신규 지식을 카테고리 디렉토리에 md로 저장하고 경로를 반환한다 (파일명 충돌 시 -2, -3…) */
export async function saveCaptured(
  baseDir: string,
  verdict: NoveltyVerdict,
  capturedAt: string,
): Promise<string> {
  const dir = join(baseDir, verdict.candidate.category);
  const base = slugify(verdict.candidate.title);
  let path = join(dir, `${base}.md`);
  let suffix = 2;
  while (await exists(path)) {
    path = join(dir, `${base}-${suffix}.md`);
    suffix += 1;
  }
  const body = [
    `# ${verdict.candidate.title}`,
    '',
    verdict.candidate.content,
    '',
    `> 수집: ${capturedAt} · 분류: ${verdict.candidate.category} · novelty 최고 유사도: ${verdict.maxScore.toFixed(3)}`,
    '',
  ].join('\n');
  await writeFileAtomic(path, body);
  return path;
}

export interface CapturedEntry {
  path: string;
  title: string;
  category: string;
}

/** 캡처 디렉토리의 저장 지식 목록 (카테고리/파일 순). 디렉토리 없으면 빈 배열 */
export async function listCaptured(baseDir: string): Promise<CapturedEntry[]> {
  let categories: string[];
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    categories = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  const result: CapturedEntry[] = [];
  for (const category of categories) {
    const dir = join(baseDir, category);
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      const path = join(dir, file);
      const text = await readFile(path, 'utf8');
      const match = text.match(/^#\s+(.+)$/m);
      result.push({
        path,
        title: match?.[1]?.trim() ?? file.replace(/\.md$/, ''),
        category,
      });
    }
  }
  return result;
}
