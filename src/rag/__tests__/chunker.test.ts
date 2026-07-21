import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../chunker.js';

describe('chunkMarkdown', () => {
  it('헤딩 단위로 섹션을 나누고 heading을 기록한다 (정상)', () => {
    const md = '서문\n\n# 제목A\n본문A\n\n## 제목B\n본문B';
    const chunks = chunkMarkdown(md, 'doc.md');
    expect(chunks).toEqual([
      { source: 'doc.md', heading: '', content: '서문', metadata: null },
      { source: 'doc.md', heading: '제목A', content: '본문A', metadata: null },
      { source: 'doc.md', heading: '제목B', content: '본문B', metadata: null },
    ]);
  });

  it('maxChars를 넘는 섹션은 겹침을 두고 재분할한다 (정상)', () => {
    const body = 'a'.repeat(30);
    const chunks = chunkMarkdown(`# 긴글\n${body}`, 'doc.md', {
      maxChars: 20,
      overlapChars: 5,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks.at(0)?.content).toBe('a'.repeat(20));
    expect(chunks.at(1)?.content).toBe('a'.repeat(15)); // 15~30 구간 (겹침 5)
  });

  it('코드펜스 안의 #은 헤딩으로 취급하지 않는다 (경계값)', () => {
    const md = '# 실제 헤딩\n```\n# 주석이지 헤딩 아님\n```\n본문';
    const chunks = chunkMarkdown(md, 'doc.md');
    expect(chunks).toHaveLength(1);
    expect(chunks.at(0)?.heading).toBe('실제 헤딩');
    expect(chunks.at(0)?.content).toContain('# 주석이지 헤딩 아님');
  });

  it('빈 문서는 빈 배열을 반환한다 (경계값)', () => {
    expect(chunkMarkdown('', 'doc.md')).toEqual([]);
    expect(chunkMarkdown('\n\n\n', 'doc.md')).toEqual([]);
  });

  it('overlapChars가 maxChars 이상이어도 무한 루프 없이 종료한다 (경계값)', () => {
    const chunks = chunkMarkdown(`# t\n${'b'.repeat(50)}`, 'doc.md', {
      maxChars: 10,
      overlapChars: 99,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(60);
  });

  it('헤딩이 전혀 없는 문서는 heading 빈 문자열 청크가 된다 (경계값)', () => {
    const chunks = chunkMarkdown('그냥 본문', 'doc.md');
    expect(chunks).toEqual([{ source: 'doc.md', heading: '', content: '그냥 본문', metadata: null }]);
  });
});
