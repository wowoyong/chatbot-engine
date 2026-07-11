export interface Chunk {
  /** 원본 파일 경로 */
  source: string;
  /** 청크가 속한 헤딩 텍스트 (헤딩 이전 본문이면 '') */
  heading: string;
  content: string;
}

export interface ChunkOptions {
  /** 청크 최대 길이(문자). 기본 1500 */
  maxChars?: number;
  /** 재분할 시 앞 조각 꼬리를 겹치는 길이(문자). 기본 200 */
  overlapChars?: number;
}

const DEFAULT_MAX_CHARS = 1500;
const DEFAULT_OVERLAP = 200;

interface Section {
  heading: string;
  content: string;
}

function splitByHeading(markdown: string): Section[] {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  let heading = '';
  let buffer: string[] = [];
  let inCodeFence = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeFence = !inCodeFence;
    }
    if (!inCodeFence && line.match(/^#{1,6}\s/) !== null) {
      sections.push({ heading, content: buffer.join('\n') });
      heading = line.replace(/^#{1,6}\s+/, '').trim();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  sections.push({ heading, content: buffer.join('\n') });
  return sections;
}

function splitLong(
  text: string,
  maxChars: number,
  overlapChars: number,
): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    pieces.push(text.slice(start, end));
    if (end >= text.length) {
      break;
    }
    start = end - overlapChars;
  }
  return pieces;
}

/**
 * 마크다운을 헤딩 단위 섹션으로 나누고, 긴 섹션은 maxChars 이하로 재분할한다.
 * overlapChars는 maxChars - 1로 클램프 — 전진량 0 이하(무한 루프) 방지.
 */
export function chunkMarkdown(
  markdown: string,
  source: string,
  options: ChunkOptions = {},
): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = Math.min(
    options.overlapChars ?? DEFAULT_OVERLAP,
    maxChars - 1,
  );

  const chunks: Chunk[] = [];
  for (const section of splitByHeading(markdown)) {
    const body = section.content.trim();
    if (body.length === 0) {
      continue;
    }
    for (const piece of splitLong(body, maxChars, overlapChars)) {
      chunks.push({ source, heading: section.heading, content: piece });
    }
  }
  return chunks;
}
